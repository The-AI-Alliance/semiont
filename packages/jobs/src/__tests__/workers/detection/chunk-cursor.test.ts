/**
 * `runAdaptiveChunks` — the lazy cursor that makes `nextChunkSize` real.
 *
 * `chunk-size-controller.test.ts` pins the sizing RULE in isolation; the rule
 * changed nothing until something cut text with it. The gap between those two
 * files is the whole of DETECTION-QUALITY-THROUGHPUT P2: `chunkText` fixes every
 * boundary up front from provider limits alone, so a measurement taken on chunk
 * N has nowhere to land. This driver cuts chunk N+1 only after chunk N has
 * reported, which is the only ordering in which feedback can act.
 *
 * What is asserted here is the LOOP, not the rule: that the cursor covers the
 * document exactly once however the size moves, that a reported outcome reaches
 * the next cut, and that progress stays exact while the denominator it used to
 * be divided by no longer exists.
 */

import { describe, it, expect } from 'vitest';
import {
  runAdaptiveChunks,
  deriveDetectionBudget,
  type AdaptiveChunk,
} from '../../../workers/detection/detection-chunking';
import { nextChunkSize, type CallOutcome } from '../../../workers/detection/chunk-size-controller';
import type { UnitCursor } from '@semiont/core';

/** Ollama shape — a shared window, the config the live gate runs on. No
 * published output rate, so the assumed-floor duration bound applies, exactly
 * as it does in production. (The budget suite's `outputTokensPerHour:
 * 3_600_000_000` exists to switch that bound OFF while pinning allocation
 * arithmetic; borrowing it here would test a provider that does not exist.) */
const LIMITS = { contextTokens: 32_768, maxOutputTokens: 32_768 };
const budgetFor = (typesPerCall = 1) => deriveDetectionBudget(LIMITS, 500, typesPerCall);

/** Prose long enough to need many chunks, with real sentence boundaries for the
 * cutter to find. Content never enters the sizing — only its length matters. */
function prose(sentences: number): string {
  return Array.from(
    { length: sentences },
    (_, i) => `Sentence number ${i} carries some ordinary words for the cutter to break on.`,
  ).join(' ');
}

/** Run the driver, recording every chunk it hands out, answering each with a
 * fixed outcome. */
async function run(
  text: string,
  outcome: (chunk: AdaptiveChunk, outputBudget: number) => CallOutcome,
  typesPerCall = 1,
  resume?: UnitCursor,
) {
  const seen: AdaptiveChunk[] = [];
  const budget = budgetFor(typesPerCall);
  await runAdaptiveChunks(text, budget, async (chunk) => {
    seen.push(chunk);
    return outcome(chunk, budget.outputBudget);
  }, resume);
  return { seen, budget };
}

/** An outcome that leaves most of the budget unused — the grow signal. */
const sparse = (budget: number): CallOutcome => ({ outputTokens: Math.floor(budget * 0.1), truncated: false });
/** An outcome that nearly fills it — the ease-off signal. */
const dense = (budget: number): CallOutcome => ({ outputTokens: Math.floor(budget * 0.95), truncated: false });
/** Squarely inside the band — hold. */
const steady = (budget: number): CallOutcome => ({ outputTokens: Math.floor(budget * 0.65), truncated: false });

describe('runAdaptiveChunks', () => {
  it('covers the document exactly once, in order, however the size moves', async () => {
    // The safety property that must survive adaptivity: no text may be skipped
    // and no chunk may fail to advance. Overlap means pieces re-read each
    // other's edges (by design — a span on a boundary must be seeable whole),
    // so coverage is asserted by the cursor, not by concatenating pieces.
    const text = prose(400);
    const { seen } = await run(text, (_c, out) => sparse(out));

    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]!.at).toBe(0);
    for (const [i, chunk] of seen.entries()) {
      expect(chunk.piece.length).toBeGreaterThan(0);
      expect(chunk.next).toBeGreaterThan(chunk.at);
      expect(chunk.totalChars).toBe(text.length);
      if (i > 0) expect(chunk.at).toBe(seen[i - 1]!.next);
    }
    expect(seen.at(-1)!.next).toBeGreaterThanOrEqual(text.length);
  });

  it('makes a one-chunk document one call, with no sizing at all', async () => {
    // Adaptivity must not cost the small-document case its single call.
    const { seen } = await run('A short document that fits in one chunk.', () => ({ outputTokens: 1, truncated: false }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ at: 0, piece: 'A short document that fits in one chunk.' });
  });

  it('grows the next cut when a call leaves the output budget unused', async () => {
    // The calibration case, end to end: the sizer said grow, and the CUTTER
    // must have obeyed. `chunkText` cannot express this at all — every one of
    // its boundaries is fixed before the first call returns.
    const { seen } = await run(prose(1500), (_c, out) => sparse(out));

    expect(seen.length).toBeGreaterThan(2);
    expect(seen[1]!.piece.length).toBeGreaterThan(seen[0]!.piece.length);
    // And it keeps growing while the evidence keeps saying so.
    expect(seen[2]!.piece.length).toBeGreaterThan(seen[1]!.piece.length);
  });

  it('eases the next cut down when a call nears the budget', async () => {
    const { seen } = await run(prose(600), (_c, out) => dense(out));

    expect(seen.length).toBeGreaterThan(2);
    // Against the SHRINK FACTOR, not merely "shorter". Boundary-seeking alone
    // makes a later cut a little shorter than an earlier one, so `<` passes on
    // a loop that ignores the sizer entirely — measured: mutating the feedback
    // away left this test green. The step has to be visible as a step.
    expect(seen[1]!.piece.length).toBeLessThan(seen[0]!.piece.length * 0.8);
    expect(seen[2]!.piece.length).toBeLessThan(seen[1]!.piece.length * 0.8);
  });

  it('stops at the end instead of re-cutting the tail it just returned', async () => {
    // `chunkText` backed the cursor off by the overlap unconditionally, so
    // after the chunk that reached the end it took ONE more — covering only
    // text that chunk already contained. Measured across four document sizes,
    // every one paid exactly one extra inference call whose entire span sat
    // inside its predecessor, yielding nothing but duplicate spans for the
    // dedupe layer to drop. One free call per document, per detection type.
    const { seen } = await run(prose(1500), (_c, out) => steady(out));

    // Measured against the text FRONTIER, not the cursor: `next` is deliberately
    // backed off by the overlap, so a chunk that re-reads its predecessor whole
    // still reports a `next` past it. What must advance is the furthest
    // character any piece has actually carried.
    let frontier = 0;
    for (const [i, chunk] of seen.entries()) {
      const reach = chunk.at + chunk.piece.length;
      expect(reach, `chunk ${i} at ${chunk.at} carries no text past ${frontier}`).toBeGreaterThan(frontier);
      frontier = reach;
    }
  });

  it('shrinks after a chunk that only succeeded by subdividing', async () => {
    // `truncated` here means "the size did not fit", including a chunk that
    // subdivision rescued. Paying the descent and then re-cutting at the same
    // size would pay it again on the next chunk.
    const { seen } = await run(prose(600), (_c, out) => ({ outputTokens: Math.floor(out * 0.1), truncated: true }));

    expect(seen[1]!.piece.length).toBeLessThan(seen[0]!.piece.length);
  });

  it('holds the opening size end to end when the provider reports no usage', async () => {
    // The whole loop's version of the same rule: against a provider that never
    // reports token counts, an adaptive run must be indistinguishable from the
    // static one it replaced — not a run that climbs to the ceiling because
    // "nothing reported" was read as "nothing produced".
    const { seen } = await run(prose(1500), () => ({ truncated: false }));

    const lengths = seen.slice(0, -1).map((c) => c.piece.length);
    expect(lengths.length).toBeGreaterThan(2);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(lengths[0]! * 0.05);
  });

  it('holds the opening size while the evidence stays inside the band', async () => {
    // No drift when nothing is learned: a steady document is cut the way
    // `chunkText` would have cut it.
    const { seen } = await run(prose(600), (_c, out) => steady(out));

    const lengths = seen.slice(0, -1).map((c) => c.piece.length);
    const spread = Math.max(...lengths) - Math.min(...lengths);
    // Boundary-seeking still moves each cut a little; sizing does not.
    expect(spread).toBeLessThan(lengths[0]! * 0.25);
  });

  it('never cuts above the provider ceiling, however sparse the document', async () => {
    const { seen, budget } = await run(prose(3000), (_c, out) => sparse(out));

    // The ceiling is a token budget; chars are the cutter's unit. `cutChunk`
    // takes chunkSize * 4 chars, so that product is the bound a piece cannot
    // pass. (Boundary-seeking only ever cuts a piece SHORTER.)
    for (const chunk of seen) {
      expect(chunk.piece.length).toBeLessThanOrEqual(budget.bounds.ceiling * 4);
    }
    // It actually reached up, rather than passing vacuously.
    expect(Math.max(...seen.map((c) => c.piece.length))).toBeGreaterThan(budget.chunking.chunkSize * 4);
  });

  it('never cuts below the floor, however dense', async () => {
    const { seen, budget } = await run(prose(3000), (_c, out) => ({ outputTokens: out, truncated: true }));

    const floorChars = budget.bounds.floor * 4;
    // Every piece but the last (a remainder, legitimately short) respects it.
    for (const chunk of seen.slice(0, -1)) {
      // Boundary-seeking can trim up to half, which is the cutter's own
      // contract; the floor bounds the REQUEST, so half of it bounds the piece.
      expect(chunk.piece.length).toBeGreaterThan(floorChars / 2);
    }
    expect(budget.bounds.floor).toBeLessThanOrEqual(budget.chunking.chunkSize);
  });

  it('reports exact character progress that never runs backwards', async () => {
    // The denominator adaptivity destroys. `i / chunks.length` needed a chunk
    // count known in advance; with sizes moving there is none, and a PROJECTED
    // count would make a shrink look like regress. Characters are exact, and
    // were always more honest than chunk index — boundary-seeking already made
    // chunks unequal, so "chunk 3 of 10" was never 30% of the document.
    const text = prose(800);
    let previous = -1;
    let flip = false;
    await run(text, (chunk, out) => {
      expect(chunk.at).toBeGreaterThan(previous);
      expect(chunk.at).toBeLessThan(text.length);
      previous = chunk.at;
      // Alternate grow/shrink so the size genuinely moves both ways.
      flip = !flip;
      return flip ? sparse(out) : dense(out);
    });
    expect(previous).toBeGreaterThan(0);
  });

  it('propagates a failure from a chunk without advancing past it', async () => {
    // A chunk that throws must stop the run where it stands: the cursor is
    // what CHUNK-GRAIN-RESUME will checkpoint, and a cursor that advanced past
    // an unprocessed chunk would checkpoint a lie.
    const seen: AdaptiveChunk[] = [];
    const budget = budgetFor();
    await expect(runAdaptiveChunks(prose(600), budget, async (chunk) => {
      seen.push(chunk);
      if (seen.length === 2) throw new Error('chunk 2 failed');
      return sparse(budget.outputBudget);
    })).rejects.toThrow('chunk 2 failed');

    expect(seen).toHaveLength(2);
  });
});

// ── resuming from a checkpoint (CHUNK-GRAIN-RESUME P3) ────────────────────
//
// P2 made the cursor durable; this is the half that spends it. Without it the
// cursor is a record nobody reads, and a retried job re-pays for every chunk it
// already committed — the 26-minute attempt this arc exists to stop repeating.
describe('runAdaptiveChunks — resuming', () => {
  it('starts at the checkpointed position, not the top', async () => {
    const text = prose(1500);
    const { seen } = await run(text, (_c, out) => steady(out), 1, { next: 40_000, size: 4_500, found: 0, emitted: 0 });

    expect(seen[0]!.at).toBe(40_000);
    // And nothing before it is read again — the point is that the INFERENCE is
    // not re-paid, not merely that the log would dedupe the annotations.
    expect(Math.min(...seen.map((c) => c.at))).toBe(40_000);
  });

  it('seeds the size from the checkpoint and takes ONE shrink step (HD2 option C)', async () => {
    // Neither of the losing options. Opening at the default would discard the
    // calibration the dead attempt paid for over its earlier chunks; seeding
    // unchanged would re-cut the identical failing piece, and at
    // DETECTION_TEMPERATURE 0 an identical call returns an identical failure.
    // The resume opens as if the last outcome were a failure — which it was,
    // the job died.
    const budget = budgetFor();
    const seeded = 4_000;
    const expected = nextChunkSize({ truncated: true }, seeded, budget.bounds);
    expect(expected).toBeLessThan(seeded);

    const { seen } = await run(prose(1500), (_c, out) => steady(out), 1, { next: 10_000, size: seeded, found: 0, emitted: 0 });
    expect(seen[0]!.size).toBe(expected);
  });

  it('opens at the budget when there is no checkpoint — a first attempt is unchanged', async () => {
    const budget = budgetFor();
    const { seen } = await run(prose(1500), (_c, out) => steady(out));

    expect(seen[0]!.at).toBe(0);
    expect(seen[0]!.size).toBe(budget.chunking.chunkSize);
  });

  it('keeps adapting after the resume — the seed is a start, not a lock', async () => {
    // "Attempts should learn from previous attempts, but not be beholden to
    // them." One shrink step of conservatism, then the ordinary feedback takes
    // over and grows again on the first low-utilization outcome.
    const { seen } = await run(prose(1500), (_c, out) => sparse(out), 1, { next: 10_000, size: 4_000, found: 0, emitted: 0 });

    expect(seen.length).toBeGreaterThan(2);
    expect(seen[1]!.piece.length).toBeGreaterThan(seen[0]!.piece.length);
  });

  it('does nothing when the checkpoint is already at the end', async () => {
    // The unit finished its last chunk but died before it could be marked
    // complete. Re-running it must cost no inference at all.
    const text = prose(400);
    const { seen } = await run(text, (_c, out) => steady(out), 1, { next: text.length, size: 4_500, found: 0, emitted: 0 });

    expect(seen).toHaveLength(0);
  });
});

describe('deriveDetectionBudget bounds', () => {
  it('opens at the density guess and ceilings at what the window can actually hold', async () => {
    // The 1:2 allocation is a GUESS about density — the only one #1121 left in
    // place — and it is the number the sizer exists to replace with
    // measurement. So it opens the run, and the window fit (context minus
    // scaffold minus the reserved output budget) is the hard cap above it.
    const budget = budgetFor();
    expect(budget.bounds.ceiling).toBeGreaterThan(budget.chunking.chunkSize);
    expect(budget.bounds.floor).toBeLessThanOrEqual(budget.chunking.chunkSize);
    expect(budget.bounds.outputBudget).toBe(budget.outputBudget);
  });

  it('has no headroom when a shared window is fully allocated — and says so', async () => {
    // The honest edge. A shared window with a published rate high enough to
    // disable the duration bound is allocated to the last token: input + output
    // + scaffold IS the context. Input cannot then grow without shrinking the
    // output reservation, which this phase does not size — so the ceiling meets
    // the opening and the sizer keeps only its ease-off half. That is a
    // property of the provider's shape, not a defect, and it is pinned here so
    // a later reading of `ceiling === chunkSize` is not mistaken for a bug.
    const allocated = deriveDetectionBudget(
      { contextTokens: 32_768, maxOutputTokens: 32_768, outputTokensPerHour: 3_600_000_000 }, 500, 1,
    );
    expect(allocated.bounds.ceiling).toBe(allocated.chunking.chunkSize);
    expect(allocated.chunking.chunkSize + allocated.outputBudget + 500).toBe(32_768);
  });

  it('leaves headroom on every provider shape, shared window included', async () => {
    // The ceiling cannot be read off either derived input number. On a SHARED
    // window (Ollama — what the live gate runs) the 1:3 split and the duration
    // rescale both preserve input = outputBudget / 2 exactly, so both come back
    // AT the density guess: a ceiling taken from them is 1.00x, and the growth
    // half of this feature would be dead on precisely the self-hosted providers
    // it was built for. Measured from the window instead, every shape has room.
    for (const limits of [
      { contextTokens: 32_768, maxOutputTokens: 32_768 },                                     // shared
      { contextTokens: 200_000, maxOutputTokens: 64_000, outputTokensPerHour: 128_000 },      // separate ceilings
      { contextTokens: 200_000, maxOutputTokens: 8_000 },                                     // small output ceiling
    ]) {
      const b = deriveDetectionBudget(limits, 500, 1);
      expect(b.bounds.ceiling).toBeGreaterThan(b.chunking.chunkSize * 2);
      // And the ceiling still FITS: a full-size chunk leaves the whole output
      // budget room beside it inside the context window.
      expect(b.bounds.ceiling + b.outputBudget + 500).toBeLessThanOrEqual(limits.contextTokens);
    }
  });

  it('keeps the floor under the opening size even on a cramped window', async () => {
    // A window barely wide enough to chunk at all must still produce usable
    // bounds rather than floor > opening, which would clamp every proposal up.
    const cramped = deriveDetectionBudget({ contextTokens: 4_000, maxOutputTokens: 4_000 }, 3_000, 1);
    expect(cramped.bounds.floor).toBeLessThanOrEqual(cramped.chunking.chunkSize);
    expect(cramped.bounds.ceiling).toBeGreaterThanOrEqual(cramped.chunking.chunkSize);
  });
});
