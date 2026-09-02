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

    expect(budget.outputBudget).toBe(Math.floor(128_000 * (INFERENCE_TIMEOUT_MS / 3_600_000)));
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

    expect(outputBudget).toBe(Math.floor(128_000 * (INFERENCE_TIMEOUT_MS / 3_600_000)));
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
