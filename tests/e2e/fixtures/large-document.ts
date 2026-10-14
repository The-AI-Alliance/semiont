/**
 * Build a large document whose entity yield lands inside the WINDOW the
 * density guard of spec 21's first test pins (150 < occurrences < 1000): dense
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
export function buildLargeDocument(targetBytes: number): string {
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
