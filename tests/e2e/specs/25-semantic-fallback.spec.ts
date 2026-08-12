import { test, expect } from '@playwright/test';
import { SemiontClient, resourceId as ridBrand } from '@semiont/sdk';
import type { ResourceDescriptor } from '@semiont/core';
import { BACKEND_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';

/**
 * Live gate — SEMANTIC-FALLBACK.md: when a lexical search returns nothing, the
 * server embeds the query once and answers from the vector index instead.
 *
 * Pure **SDK round-trip** (no browser), per the spec-15/18 pattern.
 *
 * That used to be forced: `matchKind` had no consumer, so a semantic answer was
 * indistinguishable from a lexical one and there was nothing rendered to
 * assert. **No longer true as of P3b** — `ResourceDiscoveryPage` renders a
 * notice for a semantic result set, pinned by its own component test. What this
 * spec adds is the other half: that the label arriving over the real wire says
 * `semantic` for a semantic answer and `lexical` for a lexical one. A browser
 * leg would re-test the render this spec cannot make more trustworthy; the wire
 * value is what only a live stack can prove.
 *
 * ── What this pins that the unit tests cannot ──────────────────────────────
 *
 * Axioms S1–S8 are already `it` in `resource-context.test.ts` against a mocked
 * provider and a mocked `kb.vectors`. Re-asserting them here would buy
 * flakiness, not confidence. What a mock cannot reach:
 *
 *   1. A **real embedding provider** produces vectors that actually retrieve.
 *   2. The **real vector store** holds real chunks, and `mergeByResource` folds
 *      them into one entry per resource against real data.
 *   3. The answer survives the **whole wire** — Smelter → vector store →
 *      `ResourceContext.semanticFallback` → bus → HTTP → SDK.
 *   4. The **matched passage** reaches the caller as `content` (the honesty gap
 *      the plan closes: results advertise a content preview though lexical
 *      search never reads content).
 *
 * ── Why this is near-deterministic, not model-dependent ────────────────────
 *
 * **Lexical search is name-only** — `SEARCH_LIMIT = 20, filtered by name`
 * (`fixtures/discover.ts`; SEARCH-STORAGEURI.md §4 records that the content body
 * is never searched). So a query drawn from a resource's BODY, whose tokens
 * appear nowhere in its NAME, returns zero lexical hits by construction. Any
 * result at all can only have come from the fallback.
 *
 * That is what makes the assertion sound without `matchKind`: we are not asking
 * an embedding model to be clever, only to retrieve a passage that literally
 * contains the query. A test that leaned on paraphrase recall would be pinning
 * model behaviour and would rot on the next provider change.
 *
 * ── Not covered here, deliberately ─────────────────────────────────────────
 *
 * - **S1 (a non-empty lexical result never embeds).** The assertion is an
 *   absence — `expect(embed).not.toHaveBeenCalled()` — which is exact under a
 *   mock and would need log-scraping here. It stays a unit test.
 * - **S3/S4 (vectors or provider absent → empty lexical page).** The branch is
 *   defensive and stays load-bearing until MANDATORY-EMBEDDING.md lands, but
 *   every real KB is deployed with a vector store, so there is no live
 *   configuration for an e2e to exercise.
 * - **The 0.6 floor's value.** Tuning is what the per-fallback score-distribution
 *   debug line is for; a test that pinned a threshold would have to change every
 *   time the floor is tuned, which is the opposite of what the plan wants.
 */

/** Unique per run: the e2e KB persists, and seeding is not idempotent. */
const STAMP = `${Date.now().toString(36)}`;

/**
 * The name shares NO token with `BODY_QUERY` below — that disjointness is the
 * whole mechanism. Keep it topic-free if you edit it.
 */
const RESOURCE_NAME = `Ledger Entry ${STAMP}`;

/**
 * A phrase that appears verbatim in the body and nowhere in the name.
 * Lexical search (name-only) cannot match it; the vector index can.
 */
const BODY_QUERY = 'chlorophyll absorbs light within the thylakoid membrane';

/**
 * Leading boilerplate exists so T3 can prove `content` is the MATCHED PASSAGE
 * rather than the document's opening 200 characters. Same technique as spec
 * 21's #738 clip test: make the naive answer and the correct answer visibly
 * different, so a regression produces a failure rather than a coincidence.
 */
const BOILERPLATE =
  'This record is filed for archival purposes. The remainder of this document is ' +
  'organized as follows. Section headings are retained from the original filing and ' +
  'carry no substantive content. Routine administrative notes follow, and are of no ' +
  'analytical interest to the reader. ';

const BODY = [
  BOILERPLATE,
  'Photosynthesis converts light energy into chemical energy. ',
  `In the light-dependent reactions, ${BODY_QUERY}, exciting electrons that enter `,
  'the transport chain. The resulting gradient drives ATP synthase. ',
  'Carbon fixation then proceeds in the stroma, independent of direct illumination.',
].join('');

/** The Smelter chunks and embeds asynchronously; nothing is searchable until it has. */
const INDEXING_TIMEOUT = 120_000;

async function signIn() {
  return SemiontClient.signInHttp({
    baseUrl: BACKEND_URL,
    email: E2E_EMAIL,
    password: E2E_PASSWORD,
  });
}

/** Search by body phrase — zero lexical hits by construction, so this is the fallback's answer. */
async function semanticSearch(
  client: SemiontClient,
): Promise<Array<ResourceDescriptor & { content?: string }>> {
  return (await client.browse
    .resources({ search: BODY_QUERY })
    .fresh()).resources as Array<ResourceDescriptor & { content?: string }>;
}

test.describe.serial('semantic fallback answers what lexical search cannot', () => {
  let client: SemiontClient;
  let rid: ReturnType<typeof ridBrand>;

  test.beforeAll(async () => {
    client = await signIn();
    rid = ridBrand(
      (
        await client.yield.resource({
          name: RESOURCE_NAME,
          storageUri: `file://e2e/semantic-fallback-${STAMP}.txt`,
          file: Buffer.from(BODY, 'utf-8'),
          format: 'text/plain',
          language: 'en',
        })
      ).resourceId,
    );
    // eslint-disable-next-line no-console
    console.log(`SEMANTIC: seeded ${rid} as "${RESOURCE_NAME}" (${BODY.length} bytes)`);
  });

  test.afterAll(() => {
    client?.dispose();
  });

  /**
   * T2 — the lexical control, first because it is also the freshness gate.
   *
   * If this fails, the resource never landed and T1's empty result would be
   * indistinguishable from "the fallback is broken". Ordering makes the
   * diagnosis unambiguous rather than requiring a second debugging pass.
   */
  test('a name search still answers lexically (control)', async () => {
    await expect
      .poll(async () => (await client.browse.resources({ search: RESOURCE_NAME }).fresh()).resources.length, {
        timeout: INDEXING_TIMEOUT,
      })
      .toBeGreaterThan(0);

    const { resources: hits } = await client.browse.resources({ search: RESOURCE_NAME }).fresh();
    expect(
      hits.some((r) => r['@id'] === rid),
      'the seeded resource is findable by name — lexical search is intact and the fallback did not displace it',
    ).toBe(true);
  });

  /**
   * T1 — the product claim. A query drawn from the body, sharing no token with
   * any resource name, can only be answered by the fallback.
   */
  test('a body-only phrase returns the resource that discusses it', async () => {
    await expect
      .poll(async () => (await semanticSearch(client)).length, { timeout: INDEXING_TIMEOUT })
      .toBeGreaterThan(0);

    const hits = await semanticSearch(client);
    // eslint-disable-next-line no-console
    console.log(`SEMANTIC: "${BODY_QUERY}" -> ${hits.length} result(s)`);

    expect(
      hits.some((r) => r.id === rid),
      'a phrase present only in the BODY retrieved the resource; lexical search is name-only, ' +
        'so nothing but the semantic fallback could have produced this hit',
    ).toBe(true);
  });

  /**
   * T3 — the honesty gap the plan closes. `content` on a semantic hit is the
   * passage that matched, not `addContentPreviews`' first-200-characters slice.
   */
  test('the content field carries the matched passage, not the opening preview', async () => {
    const hits = await semanticSearch(client);
    const hit = hits.find((r) => r.id === rid);
    expect(hit, 'the seeded resource is among the semantic hits').toBeDefined();

    const content = hit?.content;
    expect(content, 'a semantic hit carries the passage that matched').toBeTruthy();

    expect(
      content,
      'the passage is the matching region of the document, not its opening boilerplate',
    ).not.toBe(BODY.slice(0, 200));

    expect(
      content?.includes('thylakoid') || content?.includes('Photosynthesis'),
      `content should be drawn from the matched region; got: ${content?.slice(0, 120)}`,
    ).toBe(true);
  });

  /**
   * T4 — the label, end to end (SEMANTIC-FALLBACK S11 / P3b). The UI's notice is
   * only as honest as the value it renders, and every layer between the vector
   * store and the SDK could mislabel it. Asserted in BOTH directions: a
   * one-sided check passes against a producer hardcoding `'semantic'`.
   */
  test('the answer is labelled by how it was produced', async () => {
    await expect
      .poll(async () => (await semanticSearch(client)).length, { timeout: INDEXING_TIMEOUT })
      .toBeGreaterThan(0);

    const semantic = await client.browse.resources({ search: BODY_QUERY }).fresh();
    expect(
      semantic.matchKind,
      'a body-only phrase can only have been answered by the fallback, and must say so',
    ).toBe('semantic');

    const lexical = await client.browse.resources({ search: RESOURCE_NAME }).fresh();
    expect(
      lexical.matchKind,
      'a name hit never reaches the fallback — labelling it semantic would make the notice a lie',
    ).toBe('lexical');
  });
});
