import { test, expect } from '@playwright/test';
import { SemiontClient, resourceId as ridBrand } from '@semiont/sdk';
import { GATEWAY_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';

/**
 * Phase 4 of `.plans/bugs/entity-extraction-truncates-large-docs.md` — the
 * system-level guard for the Evidence table.
 *
 * The bug: detection sent the WHOLE document in ONE call with a hardcoded
 * 4000-token output cap, so any document yielding more entities than that cap
 * failed the entire job — **zero** annotations, not partial. Six RFCs were
 * ingested; only the 6 KB one enriched. `rfc793` (170 KB) was the stress row.
 *
 * This spec reproduces that shape at the system level: ingest a large
 * document, run `mark.assist('linking')`, assert annotations **persisted**.
 * Pure SDK round-trip (no browser), per the spec-15/18 pattern — spec 06
 * already covers the browser path for the same flow at small size.
 *
 * ── DEFAULT OFF (@slow) ────────────────────────────────────────────────────
 *
 * Both tests here are tagged `@slow` and are **excluded from `npm test`**
 * (which runs `--grep-invert @slow`). Run them deliberately:
 *
 *     npm run test:slow                                  # both
 *     npm run test:slow -- -g "chunk-forcing"            # just the loop guard
 *
 * Why: measured 1.4–8 min (170 KB) and 7.8 min (chunk-forcing) — either one
 * roughly doubles a ~6-minute full suite, and their value is release-gate
 * verification, not per-change regression catching.
 *
 * ── WHICH PROVIDER, AND WHAT EACH ONE PROVES ───────────────────────────────
 *
 * Results here are **model-dependent**, because what the fix does depends on
 * the provider's window. Measured 2026-07-31 on both:
 *
 *   anthropic (sonnet-4-5): 200K context / 64K output.
 *     Input bound = 200K − 64K − scaffold ≈ 135K tokens ≈ ~540 KB.
 *     PROVES: the derived output budget — the half that was the proximate
 *     cause (the hardcoded 4000). This path produced the clean RED→GREEN:
 *     pre-fix `truncated (max_tokens) — increase max_tokens…`, post-fix
 *     completes. Also proves the fail-loud guard at the pathological tail
 *     (`truncated … on chunk 1/1 despite the derived output budget of 64000`).
 *     Does NOT prove chunking: at 170 KB it runs as chunk 1/1.
 *
 *   ollama (gemma4:26b): context_length 262,144 (read live from POST
 *     /api/show — NOT the ~8K the plan's worked example assumes), shared
 *     window, so the 1:2 split gives ≈ 87K tokens input ≈ ~340 KB per chunk.
 *     PROVES: the chunk loop, the per-chunk heartbeat, and overlap dedupe —
 *     but only above ~340 KB. At 170 KB this path ALSO runs as one chunk.
 *
 * Hence the two tests: the 170 KB one is the Evidence-table row (outcome
 * only, provider-agnostic); the ~750 KB one is sized past BOTH input bounds
 * so chunking is forced whichever provider serves `reference-annotation`.
 *
 * ── COST ───────────────────────────────────────────────────────────────────
 *
 * Slow by construction: a large single Anthropic call runs minutes; a
 * multi-chunk Ollama run is serialized and longer. Progress events now arrive
 * at every chunk boundary (the liveness heartbeat contract), so this spec
 * consumes them via `.run()` as a liveness signal — a stalled run is visible
 * in the log rather than as one long silence ending in a timeout.
 */

/** ≥ 170 KB — the `rfc793` stress row from the Evidence table. */
const TARGET_BYTES = 170_000;

/**
 * Build a large document whose entity yield lands BETWEEN the two caps.
 *
 * **Three ways to get this wrong, all measured against real stacks:**
 *
 * 1. **Too sparse.** v1 drew from a fixed 40-term vocabulary; at 170 KB it
 *    produced 48 entities (~2.4K output tokens) — under the OLD 4000-token
 *    cap, so it PASSED pre-fix and guarded nothing. The bug is driven by
 *    entity COUNT, not document length (the Evidence table's 6 KB `rfc768`
 *    passed at ~60 entities; the 21 KB `rfc826` failed).
 * 2. **Not real prose.** v2 was dense but built from invented proper nouns
 *    ("the Kestrel-142 protocol") in a repeating template; the model returned
 *    `stopReason: 'refusal'` and 0 entities — red for the wrong reason.
 * 3. **Too dense.** v3 mentioned 5–6 concepts per short paragraph — ~2,000+
 *    entity OCCURRENCES (every occurrence is its own span, so dedupe does not
 *    reduce them) ≈ 100K+ output tokens. That overflows even the DERIVED 64K
 *    budget: post-fix it still failed, with `truncated … on chunk 1/1 despite
 *    the derived output budget of 64000 tokens`. That is the plan's
 *    pathological tail failing honestly by design — correct behavior, useless
 *    as a regression guard.
 *
 * The guard must land in the window between the caps:
 *
 *   >  ~80 entities  → exceeds the old 4000-token cap  → RED pre-fix
 *   < ~1280 entities → fits the derived 64K budget     → GREEN post-fix
 *
 * So: ONE named concept per paragraph, embedded in ordinary narrative prose
 * that carries no further extractable terms. ~360 paragraphs at 170 KB gives
 * a few hundred occurrences — an order of magnitude past the old cap, and
 * comfortably inside the new one. That is also what a real RFC looks like:
 * large, genuinely technical, but not concept-saturated.
 *
 * Deterministic — no RNG, so a flake reproduces.
 */
function buildLargeDocument(targetBytes: number = TARGET_BYTES): string {
  const concepts = [
    'adaptive caching', 'hierarchical scheduling', 'incremental replication',
    'speculative prefetching', 'distributed consensus', 'probabilistic indexing',
    'asynchronous checkpointing', 'lock-free batching', 'append-only compaction',
    'copy-on-write partitioning', 'write-ahead logging', 'content-addressed storage',
    'log-structured merging', 'columnar compression', 'vectorized execution',
    'just-in-time compilation', 'generational collection', 'reference counting',
    'transactional memory', 'idempotent retry', 'quorum replication', 'gossip dissemination',
    'leaderless coordination', 'load shedding', 'admission control', 'change data capture',
    'query planning', 'cache invalidation', 'connection pooling', 'backpressure propagation',
  ];
  const fields = [
    'storage engines', 'stream processing', 'compiler design', 'operating systems',
    'distributed databases', 'network protocols', 'observability tooling', 'query engines',
  ];

  const paragraphs: string[] = [];
  let i = 0;
  let total = 0;
  while (total < targetBytes) {
    const c = concepts[i % concepts.length]!;
    const f = fields[i % fields.length]!;
    // ONE named concept, then filler narrative with no further technical terms.
    const p =
      `Section ${i + 1}. Teams working on ${f} eventually confront ${c}, usually after a ` +
      `quarter in which the system behaved acceptably right up until it did not. The first ` +
      `investigation rarely finds anything conclusive; the graphs look ordinary, the error ` +
      `rate is flat, and the only hint is that certain requests take longer than they used ` +
      `to for reasons nobody can articulate. Someone eventually reads the original design ` +
      `document and discovers that an assumption made years earlier no longer holds, though ` +
      `it held perfectly well at the time and the person who made it had good reasons. The ` +
      `discussion that follows tends to be less about what to change than about what the ` +
      `system was ever supposed to guarantee, which turns out to have been written down in ` +
      `two places that disagree. What finally settles it is usually a measurement nobody ` +
      `thought to take, produced by someone who joined recently enough to ask why things ` +
      `work the way they do rather than assuming there was a reason.\n\n`;
    paragraphs.push(p);
    total += p.length;
    i += 1;
  }
  return paragraphs.join('');
}

test.describe('large-document assisted linking', () => {
  test('a 170 KB document enriches — assisted linking persists annotations (the Evidence-table stress row)', { tag: ['@slow'] }, async () => {
    // Wall-clock is provider-shaped. Anthropic: ONE large streamed call, a few
    // minutes. ollama-gemma: the shared window forces ~17-20 chunks at this
    // size, each its own serialized local inference call — tens of minutes.
    // Budget for the slower path; the per-chunk progress events below are the
    // liveness signal, so a genuine stall shows up as a gap rather than as one
    // long silence ending here.
    test.setTimeout(2_700_000);

    const client = await SemiontClient.signInHttp({
      baseUrl: GATEWAY_URL,
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
    });

    try {
      const content = buildLargeDocument();
      expect(
        content.length,
        'fixture must reach the Evidence-table stress size',
      ).toBeGreaterThanOrEqual(TARGET_BYTES);
      // Density guard: the bug is driven by ENTITY COUNT, not length. A
      // low-vocabulary fixture of this size passes even pre-fix (measured:
      // 40 terms → 48 entities → ~2.4K tokens, under the old 4000 cap).
      // Occurrences, not distinct terms: every occurrence is its own span, so
      // occurrences drive output size. Pin the WINDOW between the two caps —
      // a fixture outside it guards nothing in one direction or the other.
      const occurrences = (content.match(/Section \d+\. Teams working on/g) ?? []).length;
      // eslint-disable-next-line no-console
      console.log(`LARGE_DOC: ${occurrences} concept occurrences (~${occurrences * 50} output tokens)`);
      expect(
        occurrences,
        'must exceed the OLD 4000-token cap (~80 entities) or it guards nothing — see buildLargeDocument',
      ).toBeGreaterThan(150);
      expect(
        occurrences,
        'must fit the DERIVED 64K budget (~1280 entities) or it fails post-fix too — v3 did exactly that',
      ).toBeLessThan(1000);
      // eslint-disable-next-line no-console
      console.log(`LARGE_DOC: fixture ${content.length} bytes (~${Math.round(content.length / 4)} tokens)`);

      const rid = ridBrand(
        (
          await client.yield.resource({
            name: `Large Doc Linking ${content.length}B`,
            storageUri: 'file://e2e/large-doc-linking.txt',
            file: Buffer.from(content, 'utf-8'),
            format: 'text/plain',
            language: 'en',
          })
        ).resourceId,
      );

      // Baseline is 0 — the resource was just created by this run.
      expect(
        (await client.browse.annotations(rid).fresh()).length,
        'a freshly created resource starts with no annotations',
      ).toBe(0);

      // Run the assist, consuming progress as the liveness signal. `.run()`
      // (not subscribe-and-await) — the stream is cold, so doing both would
      // fire the job twice.
      const t0 = Date.now();
      const final = await client.mark
        .assist(rid, 'linking', { entityTypes: ['Concept'] })
        .run((e) => {
          if (e.kind === 'progress') {
            // eslint-disable-next-line no-console
            console.log(`LARGE_DOC: +${Date.now() - t0}ms progress ${JSON.stringify(e.data)}`);
          }
        });

      // PRE-FIX this threw `/truncat/i` and failed the whole job — the
      // Evidence table's "0 annotations" rows.
      expect(
        final.kind,
        'linking assist completes (it failed the whole job pre-fix on documents this size)',
      ).toBe('complete');
      // eslint-disable-next-line no-console
      console.log(`LARGE_DOC: assist completed in ${Date.now() - t0}ms`);

      // The outcome, and the only thing this spec asserts about detection:
      // annotations actually persisted. Never chunk counts — see the header.
      await expect
        .poll(async () => (await client.browse.annotations(rid).fresh()).length, {
          timeout: 60_000,
        })
        .toBeGreaterThan(0);

      const persisted = await client.browse.annotations(rid).fresh();
      // eslint-disable-next-line no-console
      console.log(`LARGE_DOC: ${persisted.length} annotations persisted`);
      expect(
        persisted.some((a) => a.motivation === 'linking'),
        'the persisted annotations include the linking references the assist created',
      ).toBe(true);
    } finally {
      client.dispose();
    }
  });

  /**
   * Forces the CHUNK LOOP — the half the 170 KB case cannot reach.
   *
   * Per-chunk input bounds under the DURATION bound (ABANDONED-INFERENCE P4;
   * repointed from the pre-P4 capacity-only sizing, which needed ~750 KB):
   *   - ollama `gemma4:26b`: unchanged — no published rate, capacity governs:
   *     context 262,144 (`/api/show`), shared window, 1:2 split →
   *     ~87K tokens of input per chunk ≈ ~340 KB of text.
   *   - anthropic sonnet-4-5 (200K context): capacity would allow ~135K
   *     tokens ≈ ~540 KB, but the duration bound scales it by
   *     21,333/64,000 (the SDK's 128K-tokens/hour rate × the worker's
   *     10-minute call bound) → ~45K tokens ≈ ~180 KB.
   *
   * ~400 KB exceeds BOTH, so chunking is forced regardless of which provider
   * serves `reference-annotation` — on Anthropic via the DURATION bound (the
   * bound that actually fires in production), on Ollama via capacity. That is
   * what makes the assertion below legitimate: the plan says never to assert
   * chunk counts *because* chunking is provider-dependent at e2e-realistic
   * sizes — true at 170 KB, where this spec's first test correctly asserts
   * outcome only. Sized deliberately past both bounds, "chunking occurred"
   * stops being provider-dependent, so this asserts it as a DELIBERATE,
   * reasoned deviation rather than an oversight.
   *
   * Caveat, recorded so a model swap doesn't silently re-inert this test: on
   * a 1M-context Anthropic model the duration-scaled input bound is ~312K
   * tokens ≈ ~1.25 MB, and 400 KB would go as one call there. The CHUNKED
   * log line below prints the fixture size against the live budget — check
   * it when the fleet's detection model changes.
   *
   * The signal: Phase 3's `onChunk` emits N−1 boundary events, surfaced as
   * interpolated progress strictly between the 20% and 100% milestones. A
   * single-chunk run emits none (measured on both providers at 170 KB), so
   * ≥1 such event means the loop genuinely ran.
   */
  test('a chunk-forcing document exercises the per-chunk loop and still persists annotations', { tag: ['@slow'] }, async () => {
    test.setTimeout(2_700_000);

    const client = await SemiontClient.signInHttp({
      baseUrl: GATEWAY_URL,
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
    });

    try {
      // ~400 KB — past both providers' per-chunk input bounds (duration-scaled
      // ~180 KB on anthropic sonnet-4-5/200K, capacity ~340 KB on ollama).
      const content = buildLargeDocument(400_000);
      // eslint-disable-next-line no-console
      console.log(`CHUNKED: fixture ${content.length} bytes (~${Math.round(content.length / 4)} tokens)`);

      const rid = ridBrand(
        (
          await client.yield.resource({
            name: `Chunk Forcing Doc ${content.length}B`,
            storageUri: 'file://e2e/chunk-forcing-doc.txt',
            file: Buffer.from(content, 'utf-8'),
            format: 'text/plain',
            language: 'en',
          })
        ).resourceId,
      );

      const t0 = Date.now();
      const midBandEvents: number[] = [];
      const final = await client.mark
        .assist(rid, 'linking', { entityTypes: ['Concept'] })
        .run((e) => {
          if (e.kind !== 'progress') return;
          const pct = (e.data as { percentage?: number }).percentage;
          // eslint-disable-next-line no-console
          console.log(`CHUNKED: +${Date.now() - t0}ms progress ${pct}%`);
          if (typeof pct === 'number' && pct > 20 && pct < 100) midBandEvents.push(pct);
        });

      expect(final.kind, 'chunked linking assist completes').toBe('complete');
      // eslint-disable-next-line no-console
      console.log(`CHUNKED: ${midBandEvents.length} chunk-boundary events in ${Date.now() - t0}ms`);

      expect(
        midBandEvents.length,
        'a document past both providers\' per-chunk input bound must produce chunk-boundary ' +
          'progress events (Phase 3 onChunk: N chunks → N−1 events); zero means it ran as one ' +
          'chunk and the loop was never exercised',
      ).toBeGreaterThan(0);

      await expect
        .poll(async () => (await client.browse.annotations(rid).fresh()).length, { timeout: 60_000 })
        .toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(`CHUNKED: ${(await client.browse.annotations(rid).fresh()).length} annotations persisted`);
    } finally {
      client.dispose();
    }
  });

  /**
   * Live-stack gate item 4, second half — the #738 input clip is really gone.
   *
   * `motivation-prompts.ts` used to hard-code `content.substring(0, 8000)` at
   * six sites, silently capping the input for **highlight / comment /
   * assessment** (reference/linking and tagging always passed full content —
   * which is why the other tests in this file, all `linking`, prove NOTHING
   * about this). Phase 3b deleted all six.
   *
   * The fixture is built so a surviving clip produces ZERO annotations rather
   * than merely fewer: the first ~10 KB is deliberately low-salience
   * boilerplate ("the remainder of this document is organized as follows…"),
   * and every substantive, annotation-worthy claim lives beyond char 8,000.
   * With the clip present the model would see only the barren prefix; with it
   * gone, annotations anchor past the old boundary.
   *
   * Asserts on `TextPositionSelector.start` — the persisted whole-document
   * offset, which is exactly what "reconcile against the full document"
   * guarantees.
   */
  test('formerly-clipped motivations annotate beyond char 8,000 (#738 input clip deleted)', { tag: ['@slow'] }, async () => {
    test.setTimeout(2_700_000);

    const client = await SemiontClient.signInHttp({
      baseUrl: GATEWAY_URL,
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
    });

    try {
      // ── barren prefix: >10 KB with nothing worth annotating ──
      let content = '';
      let n = 0;
      while (content.length < 10_000) {
        n += 1;
        content +=
          `The remainder of this document is organized as follows. Section ${n} restates the ` +
          `structure described in the preceding section and introduces no new material. ` +
          `Readers already familiar with the organization of this document may proceed. ` +
          `Section ${n + 1} continues in the same manner.\n\n`;
      }
      const boundary = content.length;

      // ── substantive content, ALL of it past the old 8,000-char clip ──
      const claims = [
        'Write amplification is the ratio of bytes physically written to bytes logically written; it is the single most important number when sizing an LSM tree.',
        'A read-your-writes guarantee is strictly weaker than linearizability, and conflating the two is the most common source of correctness bugs in replicated stores.',
        'Backpressure is not rate limiting: rate limiting sheds load at the edge, whereas backpressure propagates scarcity upstream so producers slow down.',
        'The cost of a cache miss is not the miss itself but the tail latency it introduces once the miss rate exceeds the downstream service\'s headroom.',
        'Idempotency keys must be scoped to the operation AND the actor; a globally scoped key silently collapses distinct requests from different callers.',
        'Compaction debt accumulates invisibly: a store can appear healthy for weeks and then degrade sharply once the merge scheduler falls behind arrivals.',
      ];
      for (let i = 0; i < 24; i++) {
        content += `Finding ${i + 1}. ${claims[i % claims.length]} This matters in practice because ` +
          `systems that ignore it fail in ways their dashboards do not show.\n\n`;
      }
      // eslint-disable-next-line no-console
      console.log(`CLIP: ${content.length} bytes, substantive content starts at char ${boundary}`);
      expect(boundary, 'the barren prefix must extend past the old 8,000-char clip').toBeGreaterThan(8_000);

      const rid = ridBrand(
        (
          await client.yield.resource({
            name: `Clip Boundary Doc ${content.length}B`,
            storageUri: 'file://e2e/clip-boundary-doc.txt',
            file: Buffer.from(content, 'utf-8'),
            format: 'text/plain',
            language: 'en',
          })
        ).resourceId,
      );

      // All three formerly-clipped motivations — one at a time, same resource.
      for (const motivation of ['highlighting', 'commenting', 'assessing'] as const) {
        const t0 = Date.now();
        const final = await client.mark.assist(rid, motivation, { language: 'en' }).run(() => {});
        expect(final.kind, `${motivation} assist completes`).toBe('complete');

        const anns = await client.browse.annotations(rid).fresh();
        const mine = anns.filter((a) => a.motivation === motivation);
        const starts = mine
          .map((a) => {
            const t = Array.isArray(a.target) ? a.target[0] : a.target;
            const sels: Array<{ type?: string; start?: number } | undefined> =
              Array.isArray(t?.selector) ? t.selector : [t?.selector];
            const pos = sels.find((x) => x?.type === 'TextPositionSelector');
            return pos?.start;
          })
          .filter((x): x is number => typeof x === 'number');

        // eslint-disable-next-line no-console
        console.log(
          `CLIP: ${motivation} → ${mine.length} annotations in ${Date.now() - t0}ms; ` +
            `offsets ${starts.length ? `${Math.min(...starts)}..${Math.max(...starts)}` : '(none)'}`,
        );

        expect(
          starts.some((start) => start > 8_000),
          `${motivation} must anchor at least one annotation beyond char 8,000 — everything ` +
            `worth annotating in this fixture lives past ${boundary}, so a surviving ` +
            `content.substring(0, 8000) clip in motivation-prompts.ts yields none (#738)`,
        ).toBe(true);
      }
    } finally {
      client.dispose();
    }
  });
});
