/**
 * deriveDetectionBudget — pure window arithmetic over provider limits.
 *
 * Two provider shapes (per @semiont/inference interface.ts): shared window
 * (Ollama publishes maxOutputTokens === contextTokens) splits the post-
 * scaffold window input:output = 1:2; separate ceilings (Anthropic) give
 * output its full ceiling and input the rest. Document content never enters
 * the arithmetic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Observe the telemetry surface without losing the real module.
const { recordDetectionCallMock } = vi.hoisted(() => ({ recordDetectionCallMock: vi.fn() }));
vi.mock('@semiont/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@semiont/observability')>()),
  recordDetectionCall: recordDetectionCallMock,
}));
import { deriveDetectionBudget, ASSUMED_OUTPUT_TOKENS_PER_HOUR } from '../../../workers/detection/detection-chunking';
import { INFERENCE_TIMEOUT_MS } from '../../../workers/inference-call';

describe('deriveDetectionBudget', () => {
  it('splits a shared window 1:2 input:output after the scaffold', () => {
    // Ollama shape: maxOutputTokens === contextTokens signals one num_ctx
    // shared by prompt and response.
    const { chunking, outputBudget } = deriveDetectionBudget(
      { contextTokens: 8192, maxOutputTokens: 8192 },
      500,
      1,
    );

    const available = 8192 - 500;
    expect(chunking.chunkSize).toBe(Math.floor(available / 3));
    expect(outputBudget).toBe(available - Math.floor(available / 3));
    // Output gets the larger share.
    expect(outputBudget).toBeGreaterThan(chunking.chunkSize);
  });

  it('gives output its full ceiling on separate-ceilings providers, and input at most HALF of it', () => {
    // Anthropic shape: 200K context, 64K output ceiling. Input is NOT "the
    // rest of the window": the 1:2 allocation policy applies to every shape.
    // Measured 2026-09-02 (repro-real.log): a ~40K-token entity-dense chunk
    // demanded MORE than the whole output budget — the model ground toward
    // truncation for minutes or collapsed to []. Capacity-sized input plans
    // calls whose honest answers cannot fit.
    // Rate high enough that the duration cap is a no-op — this test pins the
    // ALLOCATION shape alone. (Since P3b, OMITTING the rate no longer means
    // uncapped: it means the assumed floor.)
    const { chunking, outputBudget } = deriveDetectionBudget(
      { contextTokens: 200_000, maxOutputTokens: 64_000, outputTokensPerHour: 3_600_000_000 },
      500,
      1,
    );

    expect(outputBudget).toBe(64_000);
    expect(chunking.chunkSize).toBe(32_000);
  });

  it('falls back to the shared split when the output ceiling nearly fills the window', () => {
    // Degenerate separate-ceilings shape: context 10K, output ceiling 9.9K
    // — taking the full ceiling would starve input below zero.
    const { chunking, outputBudget } = deriveDetectionBudget(
      { contextTokens: 10_000, maxOutputTokens: 9_900 },
      500,
      1,
    );

    const available = 10_000 - 500;
    expect(chunking.chunkSize).toBe(Math.floor(available / 3));
    expect(outputBudget).toBe(available - Math.floor(available / 3));
  });

  it('derives a schema-based overlap (selector prefix/suffix context), not a tuned value', () => {
    const { chunking } = deriveDetectionBudget(
      { contextTokens: 8192, maxOutputTokens: 8192 },
      500,
      1,
    );
    // 64-char prefix + 64-char suffix + 2×64 span allowance ≈ 256 chars ≈ 64
    // tokens at the ~4 chars/token heuristic.
    expect(chunking.overlap).toBe(64);
  });

  it('throws (fail-loud) when the window cannot hold the scaffold plus a useful chunk', () => {
    expect(() =>
      deriveDetectionBudget({ contextTokens: 300, maxOutputTokens: 300 }, 250, 1),
    ).toThrow(/window too small/i);
  });
});

// ── Duration bound (ABANDONED-INFERENCE P4, A5 — HD3) ─────────────────
// Capacity says what CAN fit in one call; duration says what SHOULD. On
// separate-ceilings providers the capacity budget allows ~935K-token
// chunks — calls that stream for 20+ minutes, the UX HD3 rejects. The
// bound DERIVES end to end: the provider SDK's own worst-case rate model
// (128K output tokens/hour — the calculateNonstreamingTimeout constant,
// surfaced through limits()) times our own 10-minute call bound. No
// hand-tuned cap; #1121's principle extends to a second bound.

describe('deriveDetectionBudget — duration bound (A5)', () => {
  const anthropic1M = { contextTokens: 1_000_000, maxOutputTokens: 64_000, outputTokensPerHour: 128_000 };
  // The uncapped BASELINE needs an explicitly-huge published rate: since P3b,
  // omitting the rate no longer means uncapped — it means the assumed floor.
  const anthropic1MUncapped = { contextTokens: 1_000_000, maxOutputTokens: 64_000, outputTokensPerHour: 3_600_000_000 };

  it('caps per-call output at the provider rate × the inference bound', () => {
    const budget = deriveDetectionBudget(anthropic1M, 1_000, 1);

    expect(budget.outputBudget).toBe(Math.floor(128_000 * (INFERENCE_TIMEOUT_MS / 2) / 3_600_000));
  });

  it('scales input by the same factor — ratio preserved, so a capacity-sized document now splits (A5)', () => {
    const uncapped = deriveDetectionBudget(anthropic1MUncapped, 1_000, 1);
    const capped = deriveDetectionBudget(anthropic1M, 1_000, 1);

    const factor = capped.outputBudget / uncapped.outputBudget;
    expect(capped.chunking.chunkSize).toBe(Math.floor(uncapped.chunking.chunkSize * factor));
    // The A5 clause itself: a document sized to the old single-call budget
    // no longer fits one call.
    expect(uncapped.chunking.chunkSize).toBeGreaterThan(capped.chunking.chunkSize);
  });

  it('is a floor on chunk count, never a raise — no-op when capacity is already tighter', () => {
    const tinyOutput = { contextTokens: 200_000, maxOutputTokens: 8_000 };

    expect(deriveDetectionBudget({ ...tinyOutput, outputTokensPerHour: 128_000 }, 1_000, 1))
      .toEqual(deriveDetectionBudget(tinyOutput, 1_000, 1));
  });

  it('a rate-silent provider is duration-capped at the ASSUMED floor rate — the F9 fix (OLLAMA-DETECTION-TESTING P3b)', () => {
    // DELIBERATE FLIP of the old "Ollama stays capacity-governed" pin, on
    // P2's data: capacity-sizing handed a 262K-window model a 174K-token
    // output budget, and a repetition loop then burned the full 10-minute
    // guillotine as TRANSIENT — retried identically, three times over. The
    // same loop under a duration-shaped cap dies in minutes as max_tokens →
    // deterministic → subdividable, the useful failure. Rate-silent providers
    // now get the consumer's own conservative floor (30 tok/s) instead of no
    // bound at all.
    const shared = { contextTokens: 262_144, maxOutputTokens: 262_144 };

    const budget = deriveDetectionBudget(shared, 500, 1);
    // 108,000 tokens/hour × half the 10-minute bound = 9,000 output tokens;
    // the 1:2 clamp then puts input at 4,500 (~18K chars per chunk) — the
    // worked numbers from the P3 dispatch.
    expect(budget.outputBudget).toBe(Math.floor(ASSUMED_OUTPUT_TOKENS_PER_HOUR * (INFERENCE_TIMEOUT_MS / 2) / 3_600_000));
    expect(budget.outputBudget).toBe(9_000);
    // Input scales by the same factor (ratio preserved), floored: 87,214 ×
    // 9,000/174,430 = 4,499.95 → 4,499 — one token under the 1:2 clamp's
    // 4,500, ~18K chars per chunk.
    expect(budget.chunking.chunkSize).toBe(4_499);
  });

  it('a published rate still wins over the assumed floor — Anthropic is untouched by P3b', () => {
    const anthropic = { contextTokens: 200_000, maxOutputTokens: 64_000, outputTokensPerHour: 128_000 };
    const budget = deriveDetectionBudget(anthropic, 500, 1);
    expect(budget.outputBudget).toBe(Math.floor(128_000 * (INFERENCE_TIMEOUT_MS / 2) / 3_600_000));
  });
});

// ── Output-demand allocation (2026-09-02 live diagnosis) ──────────────
// The separate-ceilings branch used to hand input the whole remaining
// window on the assumption that detection output stays far below its
// ceiling. Measured false: on a 1M-context model both DoD documents were
// single-chunk (~40K tokens in), and the honest answer for entity-dense
// prose EXCEEDED the entire duration-safe output budget — calls ground
// silently toward max_tokens for 4-10+ minutes (killed by the 10-minute
// bound as "stalls") or collapsed to the degenerate []. The shared-window
// branch always encoded the truth: annotation JSON echoes each span plus
// an envelope, so output needs the LARGER share. One policy, every shape.

describe('deriveDetectionBudget — input never exceeds half the output budget', () => {
  it('clamps duration-scaled separate-ceilings input to outputBudget/2', () => {
    const anthropic1M = { contextTokens: 1_000_000, maxOutputTokens: 64_000, outputTokensPerHour: 128_000 };
    const { chunking, outputBudget } = deriveDetectionBudget(anthropic1M, 1_000, 1);

    expect(outputBudget).toBe(Math.floor(128_000 * (INFERENCE_TIMEOUT_MS / 2) / 3_600_000));
    expect(chunking.chunkSize).toBe(Math.floor(outputBudget / 2));
  });

  it('is a no-op for the shared-window split, which is the policy it generalizes', () => {
    const { chunking, outputBudget } = deriveDetectionBudget(
      { contextTokens: 8192, maxOutputTokens: 8192 },
      500,
      1,
    );
    // 1:2 split already satisfies input ≤ output/2 exactly.
    expect(chunking.chunkSize).toBe(Math.floor(outputBudget / 2));
  });

  it('holds on tiny separate ceilings too — input follows the output budget down', () => {
    const { chunking, outputBudget } = deriveDetectionBudget(
      { contextTokens: 200_000, maxOutputTokens: 8_000 },
      1_000,
      1,
    );
    expect(outputBudget).toBe(8_000);
    expect(chunking.chunkSize).toBe(4_000);
  });

  it('scales input down by the number of entity types one call asks for — output demand is per type', () => {
    // A call listing K types demands roughly K types' worth of annotation
    // JSON from the same input, so the allocation divides by K. K=1 is the
    // production shape today (the per-type loop); the formula stops
    // silently assuming it.
    const anthropic1M = { contextTokens: 1_000_000, maxOutputTokens: 64_000, outputTokensPerHour: 128_000 };
    const one = deriveDetectionBudget(anthropic1M, 1_000, 1);
    const three = deriveDetectionBudget(anthropic1M, 1_000, 3);

    expect(three.outputBudget).toBe(one.outputBudget);
    expect(three.chunking.chunkSize).toBe(Math.floor(one.outputBudget / (2 * 3)));
    expect(one.chunking.chunkSize).toBe(Math.floor(one.outputBudget / 2));
  });
});

// ── Duration margin + subdivision ─────────────────────────────────────
// The output cap spends HALF the call bound: at the full bound, a chunk
// generating at the provider's own worst-case rate collides with the
// guillotine by construction. And when a chunk call still hits a
// size-shaped failure, it subdivides in place instead of burning the
// attempt.

import { callChunkSubdividing, YieldCollapseError } from '../../../workers/detection/detection-chunking';
import { InferenceTimeoutError } from '../../../workers/inference-call';
import { DeterministicJobError } from '../../../failure-class';
import { StructuredReadError } from '@semiont/inference';

describe('callChunkSubdividing', () => {
  const CHUNKING = { chunkSize: 1_000, overlap: 16 };
  // ~8K chars ≈ 2K tokens: splits into multiple sub-pieces at half size.
  // APERIODIC on purpose: with repeated text, different sub-pieces can be
  // identical strings, which breaks tests that count invocations per piece.
  const CHUNK = Array.from({ length: 200 }, (_, i) => `passage ${i} lorem ipsum dolor sit amet `).join('');

  it('passes a successful call through untouched — one invocation, no subdivision', async () => {
    const calls: string[] = [];
    const result = await callChunkSubdividing('entity', CHUNK, CHUNKING, async (piece) => {
      calls.push(piece);
      return { items: ['a', 'b'] };
    });
    expect(result).toEqual(['a', 'b']);
    expect(calls).toEqual([CHUNK]);
  });

  it('a timeout on the full chunk retries with smaller pieces and collects their results', async () => {
    const calls: string[] = [];
    const result = await callChunkSubdividing('entity', CHUNK, CHUNKING, async (piece) => {
      calls.push(piece);
      if (piece.length === CHUNK.length) throw new InferenceTimeoutError('bound');
      return { items: [`ok:${piece.length}`] };
    });
    // First call was the full chunk; the rest are strictly smaller pieces.
    expect(calls[0]).toBe(CHUNK);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls.slice(1)) expect(c.length).toBeLessThan(CHUNK.length);
    expect(result.length).toBe(calls.length - 1);
  });

  it('truncation-shaped failures subdivide too: DeterministicJobError and StructuredReadError(max_tokens)', async () => {
    for (const boom of [
      new DeterministicJobError('truncated despite budget'),
      new StructuredReadError('response is not valid JSON', 'max_tokens'),
    ]) {
      let first = true;
      const result = await callChunkSubdividing('entity', CHUNK, CHUNKING, async (piece) => {
        if (first) { first = false; throw boom; }
        return { items: [piece.length] };
      });
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('does NOT subdivide on failures size cannot fix — unreadable end_turn/unknown, plain errors', async () => {
    for (const boom of [
      new StructuredReadError('parsed to object, not an array', 'end_turn'),
      // The live Ollama failure's exact token (done_reason absent → 'unknown').
      // DECIDED not-subdividable (OLLAMA-DETECTION-TESTING P3a, 2026-09-05):
      // P2's 38-row sweep produced zero 'unknown' stops — no size-correlation
      // evidence that a smaller chunk would parse — so subdivision would spend
      // extra calls on a shape nothing ties to size. The original live failure
      // (F3) stands unreproduced; new evidence reopens this, not drift.
      new StructuredReadError('response is not valid JSON', 'unknown'),
      new Error('model exploded'),
    ]) {
      const calls: string[] = [];
      await expect(callChunkSubdividing('entity', CHUNK, CHUNKING, async (piece) => {
        calls.push(piece);
        throw boom;
      })).rejects.toBe(boom);
      expect(calls).toEqual([CHUNK]);
    }
  });

  it('a collapse verdict descends by SIZE, like truncation (P3c)', async () => {
    // A YieldCollapseError on the full chunk must subdivide — retry provably
    // returns the identical collapse, so changing the input is the one lever.
    const calls: string[] = [];
    let first = true;
    const result = await callChunkSubdividing('reference', CHUNK, CHUNKING, async (piece) => {
      calls.push(piece);
      if (first) { first = false; throw new YieldCollapseError('found 3 of 50 counted mentions'); }
      return { items: [piece.length] };
    });
    expect(result.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(1); // it descended rather than propagating
  });

  it('never re-runs a piece that cannot shrink — a no-op descent is the floor (P4 attempt 1)', async () => {
    // Measured live: a 572-char piece "descended" through three depths — each
    // re-chunk returned the identical piece, and at temperature 0 the
    // identical call returned the identical verdict. Once a piece fits inside
    // the smaller chunk size, descent changes nothing; it is AT its floor
    // regardless of the arithmetic floor. Collapse there: one call, propagate.
    const boom = new YieldCollapseError('found 1 of 4 counted mentions');
    const tiny = 'word '.repeat(20); // ~25 tokens — fits any half-size here
    const calls: string[] = [];
    await expect(callChunkSubdividing('reference', tiny, { chunkSize: 1_000, overlap: 16 }, async (piece) => {
      calls.push(piece);
      throw boom;
    })).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
  });

  it('a truncation on an unshrinkable piece gets its one floor re-roll, then propagates', async () => {
    // Same no-shrink condition, truncation flavor: the sanctioned same-size
    // retry is the floor RE-ROLL, exactly once — not an identical "descent".
    const boom = new DeterministicJobError('truncated (max_tokens)');
    const tiny = 'word '.repeat(20);
    const calls: string[] = [];
    await expect(callChunkSubdividing('reference', tiny, { chunkSize: 1_000, overlap: 16 }, async (piece) => {
      calls.push(piece);
      throw boom;
    })).rejects.toBe(boom);
    expect(calls).toHaveLength(2); // the call + its one re-roll
  });

  it('at the size floor a collapse verdict FAILS THE JOB — no re-roll (P3c, user-ratified)', async () => {
    // Truncation at the floor gets one same-size re-roll (a sampling
    // accident). Collapse must NOT: it is measured deterministic, so the
    // re-roll would return the identical under-report and turn a loud
    // failure into a wasted call. One call, then the typed error propagates.
    const boom = new YieldCollapseError('found 3 of 50 counted mentions');
    const small = 'a'.repeat(400);
    const calls: string[] = [];
    await expect(callChunkSubdividing('reference', small, { chunkSize: 8, overlap: 16 }, async (piece) => {
      calls.push(piece);
      throw boom;
    })).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
  });

  it('is depth-bounded: a chunk that fails at every size rethrows the ORIGINAL failure', async () => {
    const boom = new InferenceTimeoutError('bound');
    let calls = 0;
    await expect(callChunkSubdividing('entity', CHUNK, CHUNKING, async () => {
      calls++;
      throw boom;
    })).rejects.toBe(boom);
    // Fail-fast: full chunk, first half-piece, first quarter-piece — then
    // the original error propagates without trying siblings. A quarter-size
    // piece still failing is not a size problem, and exhaustively probing
    // every sibling would multiply a wedged provider's cost. (No re-roll for
    // TIMEOUTS at the floor: those classify transient, so the job-level
    // retry is their second chance.)
    expect(calls).toBe(3);
  });

  it('truncation descends by SIZE, past the timeout depth cap — register-dense text completes', async () => {
    // List-dense text (a register: every line several entities, each
    // echoing ~130 chars of context) honestly demands several times its
    // input in output — deeper than any fixed depth. Demand halves with
    // each subdivision, so size-based descent terminates; the depth cap is
    // for timeouts only.
    // Bigger scale than the shared fixture so the success threshold sits
    // BELOW the depth-2 quarter size (~4,000 chars here) but ABOVE the
    // overlap-derived size floor — only size-based descent can get there.
    const BIG = Array.from({ length: 400 }, (_, i) => `entry ${i} lorem ipsum dolor sit amet `).join('');
    const succeededAt: number[] = [];
    const result = await callChunkSubdividing('entity', BIG, { chunkSize: 4_000, overlap: 16 }, async (piece) => {
      if (piece.length > 1_200) throw new StructuredReadError('response is not valid JSON', 'max_tokens');
      succeededAt.push(piece.length);
      return { items: [piece.length] };
    });
    expect(result.length).toBeGreaterThan(0);
    for (const len of succeededAt) expect(len).toBeLessThanOrEqual(1_200);
  });

  it('truncation at the floor gets ONE same-size re-roll — a repetition loop is a sampling accident', async () => {
    // A floor-size piece cannot honestly overflow the output budget, so a
    // truncation there is a degeneration loop — a sampling accident a
    // re-roll usually escapes; the deterministic rethrow alone would kill
    // a job the same piece passes on the next roll.
    const seen = new Map<string, number>();
    const result = await callChunkSubdividing('entity', CHUNK, CHUNKING, async (piece) => {
      const n = (seen.get(piece) ?? 0) + 1;
      seen.set(piece, n);
      if (n === 1) throw new StructuredReadError('response is not valid JSON', 'max_tokens');
      return { items: [piece.length] };
    });
    expect(result.length).toBeGreaterThan(0);
    // Some floor piece was re-rolled — same text, second invocation.
    expect(Math.max(...seen.values())).toBe(2);
  });

  it('a re-roll that truncates AGAIN rethrows — twice on the same piece is real pathology', async () => {
    const boom = new StructuredReadError('response is not valid JSON', 'max_tokens');
    let calls = 0;
    await expect(callChunkSubdividing('entity', CHUNK, CHUNKING, async () => {
      calls++;
      throw boom;
    })).rejects.toBe(boom);
    // Full, first half, first quarter, quarter's one re-roll — then done.
    expect(calls).toBe(4);
  });
});

// ── P1: yield telemetry (DETECTION-QUALITY-THROUGHPUT) ──────────────────
//
// Every optimization phase after this one is judged by measurement, and the
// facts that judge it are per-CALL, not per-job: how big the piece was, how
// long it took, how many items came back, and — the two the adapters cannot
// know — how deep subdivision had descended and whether this was the floor
// re-roll. `callChunkSubdividing` is the only place those last two exist, so
// it is the only place one complete record can be written.
describe('callChunkSubdividing telemetry', () => {
  const CHUNKING = { chunkSize: 1_000, overlap: 16 };
  const CHUNK = Array.from({ length: 200 }, (_, i) => `passage ${i} lorem ipsum dolor sit amet `).join('');

  beforeEach(() => { recordDetectionCallMock.mockClear(); });

  it('records one call at depth 0 on the happy path, carrying the provider usage', async () => {
    await callChunkSubdividing('highlight', CHUNK, CHUNKING, async () => ({
      items: ['a', 'b'],
      usage: { inputTokens: 1200, outputTokens: 340 },
    }));

    expect(recordDetectionCallMock).toHaveBeenCalledTimes(1);
    expect(recordDetectionCallMock).toHaveBeenCalledWith(expect.objectContaining({
      label: 'highlight',
      pieceChars: CHUNK.length,
      items: 2,
      depth: 0,
      reroll: false,
      outcome: 'success',
      inputTokens: 1200,
      outputTokens: 340,
    }));
    // Duration is measured, not passed in — assert it exists and is sane
    // rather than pinning a number a fast machine would make zero.
    const { durationMs } = recordDetectionCallMock.mock.calls[0]![0] as { durationMs: number };
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records the FAILED attempt and each smaller retry — the descent is the data', async () => {
    // A truncation at full size, then success on the sub-pieces. Without a
    // record for the failure, the cost of a descent is invisible: the calls
    // that were paid for and thrown away are exactly what P2 must avoid.
    await callChunkSubdividing<string>('reference', CHUNK, CHUNKING, async (piece) => {
      if (piece.length === CHUNK.length) throw new DeterministicJobError('truncated (max_tokens)');
      return { items: ['x'] };
    });

    const records = recordDetectionCallMock.mock.calls.map(c => c[0] as { depth: number; outcome: string });
    expect(records.length).toBeGreaterThan(1);
    expect(records[0]).toMatchObject({ depth: 0, outcome: 'truncated' });
    expect(records.slice(1).every(r => r.depth === 1 && r.outcome === 'success')).toBe(true);
  });

  it('marks the floor re-roll, so a degeneration loop is distinguishable from honest overflow', async () => {
    // At the size floor a truncation is a sampling accident, not size — and
    // the re-roll is the same piece at the same size. Only the flag tells the
    // two apart in the history.
    const small = 'a'.repeat(400);
    let attempts = 0;
    await callChunkSubdividing<string>('tag', small, { chunkSize: 8, overlap: 16 }, async () => {
      if (++attempts === 1) throw new DeterministicJobError('truncated (max_tokens)');
      return { items: ['ok'] };
    });

    const records = recordDetectionCallMock.mock.calls.map(c => c[0] as { reroll: boolean; outcome: string });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ reroll: false, outcome: 'truncated' });
    expect(records[1]).toMatchObject({ reroll: true, outcome: 'success' });
  });

  it("records a collapse verdict as its own outcome — F7 finally has an in-band signal", async () => {
    // The bug report's core complaint was "no signal, nothing downstream can
    // detect it". The verifier creates the signal; the telemetry must not
    // collapse it into 'truncated' (which the DeterministicJobError
    // inheritance would otherwise do) — the two are different facts.
    await expect(
      callChunkSubdividing<string>('reference', 'a'.repeat(400), { chunkSize: 8, overlap: 16 }, async () => {
        throw new YieldCollapseError('found 3 of 50 counted mentions');
      }),
    ).rejects.toBeInstanceOf(YieldCollapseError);

    const outcomes = recordDetectionCallMock.mock.calls.map(c => (c[0] as { outcome: string }).outcome);
    expect(new Set(outcomes)).toEqual(new Set(['collapsed']));
  });

  it('classifies a timeout distinctly from a truncation — they demand opposite responses', async () => {
    await expect(
      callChunkSubdividing<string>('comment', CHUNK, CHUNKING, async () => {
        throw new InferenceTimeoutError('bound');
      }),
    ).rejects.toThrow(InferenceTimeoutError);

    const outcomes = recordDetectionCallMock.mock.calls.map(c => (c[0] as { outcome: string }).outcome);
    expect(new Set(outcomes)).toEqual(new Set(['timeout']));
  });
});
