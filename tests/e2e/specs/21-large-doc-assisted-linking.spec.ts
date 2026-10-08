import { test, expect } from '@playwright/test';
import { resourceId as ridBrand } from '@semiont/sdk';
import { signInSession } from '../fixtures/sdk-session';

/**
 * The system-level guard against entity extraction truncating a large document.
 *
 * Detection that sends the WHOLE document in ONE call under a fixed output
 * cap fails the entire job on any document yielding more entities than the
 * cap holds — **zero** annotations, not partial. A 170 KB RFC (`rfc793`) is
 * the stress case.
 *
 * This spec holds that shape at the system level: ingest a large
 * document, delegate a linking job (`mark.delegate`), assert annotations **persisted**.
 * Pure SDK round-trip (no browser), per the spec-15/18 pattern — spec 06
 * already covers the browser path for the same flow at small size.
 *
 * ── DEFAULT OFF (@slow) ────────────────────────────────────────────────────
 *
 * Every test here is tagged `@slow` and is **excluded from `npm test`**
 * (which runs `--grep-invert @slow`). Run them deliberately:
 *
 *     npm run test:slow                                  # every @slow test
 *     npm run test:slow -- -g "chunk-forcing"            # just the loop guard
 *
 * Why: measured 1.4–8 min (170 KB) and 7.8 min (chunk-forcing) — either one
 * roughly doubles a ~6-minute full suite, and their value is release-gate
 * verification, not a per-change check.
 *
 * ── HOW A RUN IS SIZED, PER PROVIDER ───────────────────────────────────────
 *
 * What a run exercises follows from `deriveDetectionBudget`
 * (`packages/jobs/src/workers/detection/detection-chunking.ts`), which sizes
 * every call from the provider's limits:
 *
 *   - OUTPUT per call is capped at what the provider's output rate produces
 *     in HALF the worker's 10-minute call bound: the published rate where
 *     there is one (anthropic, 128K tokens/hour → 10,666 tokens), an assumed
 *     108K tokens/hour where there is none (ollama → 9,000 tokens).
 *   - INPUT opens at no more than half that output budget, whatever the
 *     context size: at most ~21 KB per chunk on anthropic and ~18 KB on
 *     ollama, at ~4 chars/token.
 *   - The chunk size then follows measured output — up toward the window fit
 *     while calls leave the budget under-used, down after a truncation — so
 *     the chunk COUNT is document- and model-dependent.
 *
 * Both fixtures are many times the opening chunk on either provider, so both
 * runs walk the chunk loop. Hence the two tests: the 170 KB one is the
 * `rfc793` stress case (outcome only); the ~400 KB one also watches the
 * progress stream.
 *
 * ── COST ───────────────────────────────────────────────────────────────────
 *
 * Slow by construction: every chunk is its own inference call, made one after
 * another. Progress events arrive at every chunk boundary and while a call is
 * in flight (the liveness heartbeat contract), so this spec consumes them via
 * `.run()` as a liveness signal — a stalled run is visible in the log rather
 * than as one long silence ending in a timeout.
 */

/** ≥ 170 KB — the size of `rfc793`, the stress case. */
const TARGET_BYTES = 170_000;

/**
 * Build a large document whose entity yield lands inside the WINDOW the
 * density guard in the first test pins (150 < occurrences < 1000): dense
 * enough to produce real output, short of the pathological tail.
 *
 * Truncation is driven by entity COUNT, not document length. **Three ways to
 * get the fixture wrong, all measured against real stacks:**
 *
 * 1. **Too sparse.** A fixed 40-term vocabulary yields 48 entities at 170 KB
 *    (~2.4K output tokens) — too little to truncate anywhere, so it guards
 *    nothing.
 * 2. **Not real prose.** Dense text built from invented proper nouns
 *    ("the Kestrel-142 protocol") in a repeating template gets
 *    `stopReason: 'refusal'` and 0 entities — a failure for the wrong reason.
 * 3. **Too dense.** 5–6 concepts per short paragraph is ~2,000+
 *    entity OCCURRENCES (every occurrence is its own span, so dedupe does not
 *    reduce them) ≈ 100K+ output tokens: the pathological tail, useless as a
 *    guard.
 *
 * So: ONE named concept per paragraph, embedded in ordinary narrative prose
 * that carries no further extractable terms. A paragraph is about 1 KB, so
 * 170 KB gives about 170 occurrences. That is also what a real RFC looks
 * like: large, genuinely technical, but not concept-saturated.
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

test.describe('large-document delegated linking', () => {
  test('a 170 KB document enriches — delegated linking persists annotations', { tag: ['@slow'] }, async () => {
    // Wall-clock is provider-shaped: the document is walked in chunks, each its
    // own inference call at the model's own pace. The budget is for the slowest
    // provider the suite runs against; the progress events below are the
    // liveness signal, so a genuine stall shows up as a gap rather than as one
    // long silence ending here.
    test.setTimeout(2_700_000);

    const session = await signInSession();

    const client = session.client;

    try {
      const content = buildLargeDocument();
      expect(
        content.length,
        'fixture must reach the 170 KB stress size',
      ).toBeGreaterThanOrEqual(TARGET_BYTES);
      // Density guard: truncation is driven by ENTITY COUNT, not length. A
      // low-vocabulary fixture of this size guards nothing (measured:
      // 40 terms → 48 entities → ~2.4K output tokens).
      // Occurrences, not distinct terms: every occurrence is its own span, so
      // occurrences drive output size. Pin the WINDOW —
      // a fixture outside it guards nothing in one direction or the other.
      const occurrences = (content.match(/Section \d+\. Teams working on/g) ?? []).length;
      // eslint-disable-next-line no-console
      console.log(`LARGE_DOC: ${occurrences} concept occurrences (~${occurrences * 50} output tokens)`);
      expect(
        occurrences,
        'the fixture must carry more than 150 concept occurrences: output size follows entity count, so a sparser one guards nothing — see buildLargeDocument',
      ).toBeGreaterThan(150);
      expect(
        occurrences,
        'the fixture must carry fewer than 1000 concept occurrences: a denser one is the pathological tail, useless as a guard — see buildLargeDocument',
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

      // Run the delegated job, consuming progress as the liveness signal. `.run()`
      // (not subscribe-and-await) — the stream is cold, so doing both would
      // fire the job twice.
      const t0 = Date.now();
      const done = await client.mark
        .delegate(rid, { motivation: 'linking', entityTypes: ['Concept'] })
        .run((e) => {
          if (e.kind === 'progress') {
            // eslint-disable-next-line no-console
            console.log(`LARGE_DOC: +${Date.now() - t0}ms progress ${JSON.stringify(e.data)}`);
          }
        });

      // Awaited, a delegation resolves on the job's completion. A mark job's

      // result is its counts or a decline; the counts say it did its work.

      expect(done.result !== undefined && 'found' in done.result, 'the linking job reports its counts on a document this size').toBe(true);
      // eslint-disable-next-line no-console
      console.log(`LARGE_DOC: delegated job completed in ${Date.now() - t0}ms`);

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
        'the persisted annotations include the linking references the delegated job created',
      ).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  /**
   * The larger fixture: ~400 KB, about twenty times the opening chunk on
   * either provider (see the header), so the run cannot be one call. The first
   * cut is made at the opening size, before any measurement can grow it; every
   * later size is the sizer's, which is why no chunk COUNT is asserted.
   *
   * What the progress stream shows: the reference processor reports
   * percentage by entity TYPES completed (20 + 60 × done/total), and this run
   * asks for one type, so percentage says nothing about chunks. The cumulative
   * `entitiesFound` does: it grows by what each committed chunk found, in a
   * frame sent after that chunk's commit. More than one distinct non-zero
   * value therefore means more than one chunk committed entities, which is
   * what the assertion below requires.
   */
  test('a chunk-forcing document exercises the per-chunk loop and still persists annotations', { tag: ['@slow'] }, async () => {
    test.setTimeout(2_700_000);

    const session = await signInSession();

    const client = session.client;

    try {
      // ~400 KB — about twenty times either provider's opening chunk (at most
      // ~21 KB on anthropic, ~18 KB on ollama).
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
      const foundTallies = new Set<number>();
      const done = await client.mark
        .delegate(rid, { motivation: 'linking', entityTypes: ['Concept'] })
        .run((e) => {
          if (e.kind !== 'progress') return;
          const { percentage, entitiesFound } = e.data;
          // eslint-disable-next-line no-console
          console.log(`CHUNKED: +${Date.now() - t0}ms progress ${percentage}% found ${entitiesFound}`);
          if (entitiesFound !== undefined && entitiesFound > 0) foundTallies.add(entitiesFound);
        });

      // Awaited, a delegation resolves on the job's completion. A mark job's

      // result is its counts or a decline; the counts say it did its work.

      expect(done.result !== undefined && 'found' in done.result, 'the chunked linking job reports its counts').toBe(true);
      // eslint-disable-next-line no-console
      console.log(`CHUNKED: ${foundTallies.size} distinct entity tallies in ${Date.now() - t0}ms`);

      expect(
        foundTallies.size,
        'a document past both providers\' per-chunk input bound must commit entities from more ' +
          'than one chunk: the cumulative `entitiesFound` grows once per committed chunk, so a ' +
          'single value means it ran as one chunk and the loop was never exercised',
      ).toBeGreaterThan(1);

      await expect
        .poll(async () => (await client.browse.annotations(rid).fresh()).length, { timeout: 60_000 })
        .toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(`CHUNKED: ${(await client.browse.annotations(rid).fresh()).length} annotations persisted`);
    } finally {
      await session.dispose();
    }
  });

  /**
   * Live-stack gate — **highlight / comment / assessment** read the whole
   * document, not its first 8,000 characters.
   *
   * A `content.substring(0, 8000)` in one of `motivation-prompts.ts`'s builders
   * would silently cap the input for that motivation. The linking prompt is
   * not built there — which is why the other tests in this file, all
   * `linking`, prove NOTHING about this.
   *
   * The fixture is built so a clip produces ZERO annotations rather
   * than merely fewer: the first ~10 KB is deliberately low-salience
   * boilerplate ("the remainder of this document is organized as follows…"),
   * and every substantive, annotation-worthy claim lives beyond char 8,000.
   * A clipped model sees only the barren prefix; an unclipped one anchors
   * annotations past char 8,000.
   *
   * Asserts on `TextPositionSelector.start` — the persisted whole-document
   * offset, which is exactly what "reconcile against the full document"
   * guarantees.
   */
  test('highlight, comment and assessment annotate beyond char 8,000', { tag: ['@slow'] }, async () => {
    test.setTimeout(2_700_000);

    const session = await signInSession();

    const client = session.client;

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

      // ── substantive content, ALL of it past char 8,000 ──
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
      expect(boundary, 'the barren prefix must extend past char 8,000, so a prompt clipped there sees nothing worth annotating').toBeGreaterThan(8_000);

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

      // All three motivations — one at a time, same resource.
      for (const motivation of ['highlighting', 'commenting', 'assessing'] as const) {
        const t0 = Date.now();
        const done = await client.mark.delegate(rid, { motivation, sourceLanguage: 'en' }).run(() => {});
        // Awaited, a delegation resolves on the job's completion. A mark job's
        // result is its counts or a decline; the counts say it did its work.
        expect(done.result !== undefined && 'found' in done.result, `the ${motivation} job reports its counts`).toBe(true);

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
            `worth annotating in this fixture lives past ${boundary}, so a ` +
            `content.substring(0, 8000) clip in motivation-prompts.ts yields none`,
        ).toBe(true);
      }
    } finally {
      await session.dispose();
    }
  });
});
