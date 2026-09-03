/**
 * deriveDetectionBudget — pure window arithmetic over provider limits.
 *
 * Two provider shapes (per @semiont/inference interface.ts): shared window
 * (Ollama publishes maxOutputTokens === contextTokens) splits the post-
 * scaffold window input:output = 1:2; separate ceilings (Anthropic) give
 * output its full ceiling and input the rest. Document content never enters
 * the arithmetic.
 */

import { describe, it, expect } from 'vitest';
import { deriveDetectionBudget } from '../../../workers/detection/detection-chunking';
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
    const { chunking, outputBudget } = deriveDetectionBudget(
      { contextTokens: 200_000, maxOutputTokens: 64_000 },
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
  const anthropic1MNoRate = { contextTokens: 1_000_000, maxOutputTokens: 64_000 };

  it('caps per-call output at the provider rate × the inference bound', () => {
    const budget = deriveDetectionBudget(anthropic1M, 1_000, 1);

    expect(budget.outputBudget).toBe(Math.floor(128_000 * (INFERENCE_TIMEOUT_MS / 2) / 3_600_000));
  });

  it('scales input by the same factor — ratio preserved, so a capacity-sized document now splits (A5)', () => {
    const uncapped = deriveDetectionBudget(anthropic1MNoRate, 1_000, 1);
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

  it('providers publishing no rate are byte-identical to today — Ollama stays capacity-governed', () => {
    const shared = { contextTokens: 32_768, maxOutputTokens: 32_768 };

    const budget = deriveDetectionBudget(shared, 500, 1);
    const available = 32_768 - 500;
    const inputBudget = Math.floor(available / 3);
    expect(budget.chunking.chunkSize).toBe(inputBudget);
    expect(budget.outputBudget).toBe(available - inputBudget);
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

import { callChunkSubdividing } from '../../../workers/detection/detection-chunking';
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
    const result = await callChunkSubdividing(CHUNK, CHUNKING, async (piece) => {
      calls.push(piece);
      return ['a', 'b'];
    });
    expect(result).toEqual(['a', 'b']);
    expect(calls).toEqual([CHUNK]);
  });

  it('a timeout on the full chunk retries with smaller pieces and collects their results', async () => {
    const calls: string[] = [];
    const result = await callChunkSubdividing(CHUNK, CHUNKING, async (piece) => {
      calls.push(piece);
      if (piece.length === CHUNK.length) throw new InferenceTimeoutError('bound');
      return [`ok:${piece.length}`];
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
      const result = await callChunkSubdividing(CHUNK, CHUNKING, async (piece) => {
        if (first) { first = false; throw boom; }
        return [piece.length];
      });
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('does NOT subdivide on failures size cannot fix — unreadable end_turn, plain errors', async () => {
    for (const boom of [
      new StructuredReadError('parsed to object, not an array', 'end_turn'),
      new Error('model exploded'),
    ]) {
      const calls: string[] = [];
      await expect(callChunkSubdividing(CHUNK, CHUNKING, async (piece) => {
        calls.push(piece);
        throw boom;
      })).rejects.toBe(boom);
      expect(calls).toEqual([CHUNK]);
    }
  });

  it('is depth-bounded: a chunk that fails at every size rethrows the ORIGINAL failure', async () => {
    const boom = new InferenceTimeoutError('bound');
    let calls = 0;
    await expect(callChunkSubdividing(CHUNK, CHUNKING, async () => {
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
    const result = await callChunkSubdividing(BIG, { chunkSize: 4_000, overlap: 16 }, async (piece) => {
      if (piece.length > 1_200) throw new StructuredReadError('response is not valid JSON', 'max_tokens');
      succeededAt.push(piece.length);
      return [piece.length];
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
    const result = await callChunkSubdividing(CHUNK, CHUNKING, async (piece) => {
      const n = (seen.get(piece) ?? 0) + 1;
      seen.set(piece, n);
      if (n === 1) throw new StructuredReadError('response is not valid JSON', 'max_tokens');
      return [piece.length];
    });
    expect(result.length).toBeGreaterThan(0);
    // Some floor piece was re-rolled — same text, second invocation.
    expect(Math.max(...seen.values())).toBe(2);
  });

  it('a re-roll that truncates AGAIN rethrows — twice on the same piece is real pathology', async () => {
    const boom = new StructuredReadError('response is not valid JSON', 'max_tokens');
    let calls = 0;
    await expect(callChunkSubdividing(CHUNK, CHUNKING, async () => {
      calls++;
      throw boom;
    })).rejects.toBe(boom);
    // Full, first half, first quarter, quarter's one re-roll — then done.
    expect(calls).toBe(4);
  });
});
