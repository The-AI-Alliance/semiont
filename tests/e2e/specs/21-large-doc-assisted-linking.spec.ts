import { test, expect } from '@playwright/test';
import { SemiontClient, resourceId as ridBrand } from '@semiont/sdk';
import { BACKEND_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';

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
 * ── WHICH STACK TO RUN THIS AGAINST ────────────────────────────────────────
 *
 * **Best run against the `ollama-gemma` config.** What this spec exercises
 * depends on the provider serving `reference-annotation`, and only one of the
 * two paths actually chunks at this size:
 *
 *   - **ollama-gemma (preferred):** a shared context window (Ollama publishes
 *     `maxOutputTokens === contextTokens`), so the derived budget splits it
 *     1:2 input:output and a 170 KB document is genuinely **chunked** — this
 *     spec then guards the per-chunk loop, the per-chunk fail-loud truncation
 *     guard, and the liveness heartbeat end to end.
 *   - **anthropic (what this was authored against):** 200K context / 64K
 *     output means 170 KB (~42K tokens) runs **unchunked**. Still a real
 *     guard — the derived output budget replacing the hardcoded 4000 is the
 *     half that actually resurrects the Evidence table — but the chunk loop
 *     is not exercised. Reaching Anthropic's chunk threshold would need
 *     roughly half a megabyte.
 *
 * Either way the assertion is the same and stays honest, which is why it
 * asserts the **outcome** and never chunk counts: whether chunking occurs is
 * provider-dependent by design, so a chunk-count assertion would be green on
 * one provider and meaningless on the other. The deterministic REDs for the
 * chunking machinery live in the P3 unit layer (151 tests).
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
 * Build an entity-DENSE document out of REAL technical concepts.
 *
 * **Two ways to get this wrong, both measured against a pre-fix stack:**
 *
 * 1. **Too sparse.** v1 drew from a fixed 40-term vocabulary; at 170 KB it
 *    produced 48 entities (~2.4K output tokens) — under the old 4000-token
 *    cap, so it PASSED pre-fix and guarded nothing. The bug is driven by
 *    entity COUNT, not document length (the Evidence table's 6 KB `rfc768`
 *    passed at ~60 entities; the 21 KB `rfc826` failed).
 * 2. **Not real prose.** v2 was dense but built from invented proper nouns
 *    ("the Kestrel-142 protocol") in a repeating template; the model returned
 *    `stopReason: 'refusal'` and 0 entities. That fails pre-fix for the WRONG
 *    reason and would keep failing post-fix.
 *
 * So the fixture must be dense in *genuine* concepts and read as real prose.
 * This composes hundreds of actual technical concepts (real modifier × real
 * head pairs — "speculative prefetching", "hierarchical scheduling", …) into
 * varied sentence shapes across many fields. Deterministic — no RNG, so a
 * flake reproduces.
 *
 * If you shrink the vocabulary or flatten the prose, you defang the guard.
 */
function buildLargeDocument(): string {
  const modifiers = [
    'adaptive', 'hierarchical', 'incremental', 'speculative', 'distributed', 'probabilistic',
    'asynchronous', 'concurrent', 'lock-free', 'append-only', 'copy-on-write', 'write-ahead',
    'content-addressed', 'log-structured', 'columnar', 'vectorized', 'just-in-time',
    'ahead-of-time', 'region-based', 'generational', 'reference-counted', 'transactional',
    'idempotent', 'eventually consistent', 'strongly consistent', 'quorum-based',
    'gossip-based', 'leaderless',
  ];
  const heads = [
    'caching', 'scheduling', 'replication', 'compression', 'indexing', 'checkpointing',
    'garbage collection', 'compaction', 'partitioning', 'deduplication', 'prefetching',
    'batching', 'failover', 'reconciliation', 'serialization', 'query planning',
    'load shedding', 'rate limiting', 'admission control', 'change capture',
    'consensus', 'sharding', 'materialization', 'invalidation',
  ];
  const fields = [
    'storage engines', 'stream processing', 'compiler design', 'operating systems',
    'distributed databases', 'network protocols', 'observability tooling', 'query engines',
  ];
  const shapes = [
    (x: string, y: string, f: string) =>
      `In modern ${f}, ${x} and ${y} are usually introduced together, because the failure ` +
      `modes each one hides tend to be the failure modes the other exposes.`,
    (x: string, y: string, f: string) =>
      `Practitioners in ${f} often reach for ${x} first; only when its overhead becomes ` +
      `measurable do they reconsider and adopt ${y} alongside it.`,
    (x: string, y: string, f: string) =>
      `A recurring result in ${f} is that ${x} degrades gracefully under load while ${y} ` +
      `degrades sharply, which is why production systems rarely rely on ${y} alone.`,
    (x: string, y: string, f: string) =>
      `Benchmarks comparing ${x} against ${y} in ${f} are notoriously sensitive to workload ` +
      `shape, and results rarely transfer between deployments without recalibration.`,
    (x: string, y: string, f: string) =>
      `The literature on ${f} treats ${x} as a special case of ${y}, though implementers ` +
      `usually keep them separate because their tuning parameters do not compose cleanly.`,
  ];

  const paragraphs: string[] = [];
  let i = 0;
  let total = 0;
  while (total < TARGET_BYTES) {
    const f = fields[i % fields.length]!;
    const c1 = `${modifiers[i % modifiers.length]} ${heads[i % heads.length]}`;
    const c2 = `${modifiers[(i + 5) % modifiers.length]} ${heads[(i + 7) % heads.length]}`;
    const c3 = `${modifiers[(i + 11) % modifiers.length]} ${heads[(i + 13) % heads.length]}`;
    const p =
      `${shapes[i % shapes.length]!(c1, c2, f)} ` +
      `${shapes[(i + 2) % shapes.length]!(c3, c1, f)} ` +
      `Teams that adopt ${c2} without first measuring the cost of ${c3} frequently discover ` +
      `that the bottleneck simply moved, and that the interaction between ${c1} and ${c3} ` +
      `now dominates the profile.\n\n`;
    paragraphs.push(p);
    total += p.length;
    i += 1;
  }
  return paragraphs.join('');
}

test.describe('large-document assisted linking', () => {
  test('a 170 KB document enriches — assisted linking persists annotations (the Evidence-table stress row)', async () => {
    // A large single call runs minutes; a chunked Ollama run is longer still.
    test.setTimeout(900_000);

    const client = await SemiontClient.signInHttp({
      baseUrl: BACKEND_URL,
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
      const distinctNames = new Set(
        content.match(/\b(?:adaptive|hierarchical|incremental|speculative|distributed|probabilistic|asynchronous|concurrent|lock-free|append-only|copy-on-write|write-ahead|content-addressed|log-structured|columnar|vectorized|just-in-time|ahead-of-time|region-based|generational|reference-counted|transactional|idempotent|eventually consistent|strongly consistent|quorum-based|gossip-based|leaderless) [a-z ]+?(?=\b(?:and|are|is|in|with|against|alongside|without|now|first|,|\.))/g) ?? [],
      ).size;
      // eslint-disable-next-line no-console
      console.log(`LARGE_DOC: ${distinctNames} distinct candidate entity names`);
      expect(
        distinctNames,
        'fixture must be entity-DENSE — see buildLargeDocument; a sparse fixture guards nothing',
      ).toBeGreaterThan(200);
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
});
