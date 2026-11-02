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
 * 4. **Verbatim repeats.** One template, with the concept and the field
 *    cycling 30 against 8, repeats every lcm(30, 8) = 120 sections word for
 *    word but for the section number. An occurrence then has the same words
 *    around it as another, the anchorer cannot tell them apart, and they
 *    collapse onto one span (`first-of-many`): a count measures the template,
 *    not the detector.
 *
 * So: ONE named concept per paragraph, embedded in ordinary narrative prose
 * that carries no further extractable terms. A paragraph is about 800 bytes,
 * so 170 KB gives about 210 occurrences. That is also what a real RFC looks
 * like: large, genuinely technical, but not concept-saturated. The prose is
 * built from sentences each section chooses from lists of 11, 7, 5, 3 and 13,
 * so that what follows a concept differs from every other occurrence of it:
 * the same concept, field and following sentence meet again only after 1,320
 * sections, and the whole paragraph after 120,120. The specs build at most
 * 400 KB, about 500 sections.
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

  // What follows the concept, ending its sentence. Eleven, a length that shares no factor with
  // the concept's 30 or the field's 8, so no two occurrences of one concept are followed alike.
  const after = [
    'usually after a quarter in which the system behaved acceptably right up until it did not.',
    'often in the week after a release that everyone had called uneventful.',
    'most often when a small change made months ago finally meets the work it was never meant for.',
    'typically on a quiet afternoon, when nothing else seems to be going wrong at all.',
    'rarely when they expect to, and almost never when someone is free to look into it properly.',
    'usually just as the people who built the original piece have moved on to other work.',
    'often after a year of steady growth that nobody thought to treat as a warning.',
    'in most cases during the first busy season after a reorganisation.',
    'more or less on schedule, about a month after the last person who understood it went on leave.',
    'generally after a long stretch in which every number anyone looked at seemed reassuring.',
    'sometimes only once someone outside writes in to describe what nobody inside had noticed.',
  ];
  const first = [
    'The first investigation rarely finds anything conclusive; the graphs look ordinary, the error ' +
      'rate is flat, and the only hint is that certain requests take longer than they used to for ' +
      'reasons nobody can articulate.',
    'The first look turns up nothing anyone can point to; every chart is calm, and the only sign is ' +
      'a vague sense that some things are slower than they were.',
    'Whoever looks first finds very little, because what is wrong does not show up in any of the ' +
      'usual places, and the people who notice it cannot quite say what they noticed.',
    'At first nobody can reproduce it, and the few reports that come in describe it in words that ' +
      'do not match one another.',
    'The early attempts to pin it down mostly rule things out, which feels like progress for a ' +
      'while and then stops feeling like anything at all.',
    'For the first few days the evidence points in three directions at once, and each person who ' +
      'looks at it comes away sure of a different explanation.',
    'Nobody finds a cause at first; what they find instead is a list of things that changed around ' +
      'the same time, none of which seems large enough to matter.',
  ];
  const middle = [
    'Someone eventually reads the original design document and discovers that an assumption made ' +
      'years earlier no longer holds, though it held perfectly well at the time and the person who ' +
      'made it had good reasons.',
    'Eventually someone goes back to the notes written when the work began and finds a sentence that ' +
      'was true then and is not true now.',
    'In the end the answer is in an old discussion that nobody had reread, where a choice was made ' +
      'for reasons that have since quietly stopped applying.',
    'Sooner or later a person with a long memory recalls a decision taken under very different ' +
      'conditions, and the room goes quiet as everyone works out what that means.',
    'The trail leads back, as it usually does, to something sensible that was decided long ago by ' +
      'people who could not have known what would come later.',
  ];
  const discussion = [
    'The discussion that follows tends to be less about what to change than about what the system ' +
      'was ever supposed to guarantee, which turns out to have been written down in two places that ' +
      'disagree.',
    'What follows is a long conversation, not about the fix, which is small, but about whose promise ' +
      'it was in the first place and to whom it was made.',
    'The argument that follows is mostly about words: what each group thought had been agreed, and ' +
      'how two careful readings of the same page came to differ.',
  ];
  const ending = [
    'What finally settles it is usually a measurement nobody thought to take, produced by someone ' +
      'who joined recently enough to ask why things work the way they do rather than assuming there ' +
      'was a reason.',
    'It is settled, in the end, by a simple count that nobody had made, taken by a newcomer who did ' +
      'not yet know which questions were not supposed to be asked.',
    'The matter closes when someone writes down, in one place, what everyone had been assuming in ' +
      'several, and the disagreement turns out to have been about very little.',
    'What ends it is patience more than insight: a week of careful notes, kept by one person, until ' +
      'the pattern is too plain to argue with.',
    'The resolution, when it comes, is almost disappointing, a single line changed, though the weeks ' +
      'spent getting there taught the group more than the change itself.',
    'In the end it is a question asked at the wrong meeting by the right person that turns the whole ' +
      'thing around.',
    'The fix is agreed over a late lunch, and the account of how it was found is retold for years, ' +
      'growing a little each time.',
    'What settles it is a second pair of eyes from another part of the building, belonging to someone ' +
      'who had seen the same thing somewhere else.',
    'It is put to rest by the least senior person in the room, who simply tried the obvious thing ' +
      'that everyone else had assumed was already tried.',
    'The last step is the hardest one to take: admitting that nothing was broken, and that what ' +
      'changed was what everyone had come to expect.',
    'Afterwards nobody can remember who first suggested the answer, which is perhaps the best sign ' +
      'that the group finally understood the problem together.',
    'The episode ends with a short note added to the old document, so that the next people to meet ' +
      'this will at least know where to look.',
    'What finally clears it up is a plain description, read aloud, of what the system does today, ' +
      'which turns out to differ from what anyone believed.',
  ];
  const nth = (sentences: readonly string[], i: number): string => sentences[i % sentences.length]!;

  const paragraphs: string[] = [];
  let i = 0;
  let total = 0;
  while (total < targetBytes) {
    const c = nth(concepts, i);
    const f = nth(fields, i);
    // ONE named concept, then filler narrative with no further technical terms.
    const p =
      `Section ${i + 1}. Teams working on ${f} eventually confront ${c}, ${nth(after, i)} ` +
      `${nth(first, i)} ${nth(middle, i)} ${nth(discussion, i)} ${nth(ending, i)}\n\n`;
    paragraphs.push(p);
    total += p.length;
    i += 1;
  }
  return paragraphs.join('');
}
