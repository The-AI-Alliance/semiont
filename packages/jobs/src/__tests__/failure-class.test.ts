/**
 * Failure classification — ABANDONED-INFERENCE P3 (A4, HD2).
 *
 * The taxonomy is deliberately small and one-sided: only KNOWN-deterministic
 * failures skip the retry budget; everything unrecognized stays retryable
 * (`undefined`), because mis-classifying a transient failure as deterministic
 * silently halves reliability, while the reverse merely costs one wasted
 * attempt — today's behavior.
 */

import { describe, it, expect } from 'vitest';
import { StructuredReadError } from '@semiont/inference';
import { RETRY_RULES } from '@semiont/core';
import { classifyFailure, DeterministicJobError } from '../failure-class';
import { YieldCollapseError } from '../workers/detection/detection-chunking';
import { InferenceTimeoutError } from '../workers/inference-call';

describe('classifyFailure (A4)', () => {
  it('our own deterministic marker classifies deterministic', () => {
    expect(classifyFailure(new DeterministicJobError('response truncated'))).toBe('deterministic');
  });

  it('our timeout bound classifies transient — a stall says nothing about the request', () => {
    expect(classifyFailure(new InferenceTimeoutError('timed out'))).toBe('transient');
  });

  it('aborts are transient — the transport was torn down, not the request judged', () => {
    expect(classifyFailure(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' }))).toBe('transient');
    expect(classifyFailure(new DOMException('This operation was aborted', 'AbortError'))).toBe('transient');
  });

  it('environmental provider statuses are transient: 408, 429, 5xx', () => {
    // 502/503/504 are included deliberately, not for padding: they are exactly
    // where the three rules DISAGREE — boot retries 503/504 but refuses 500,
    // transport retries all of them on idempotent methods only, and this rule
    // takes the whole range. Pinning them here makes the job's answer visible at
    // the job's own site rather than only in the taxonomy.
    for (const status of [408, 429, 500, 502, 503, 504, 529]) {
      expect(classifyFailure(Object.assign(new Error(`http ${status}`), { status }))).toBe('transient');
    }
  });

  it('request-rejection statuses are deterministic: the same request cannot succeed twice', () => {
    for (const status of [400, 401, 403, 413, 422]) {
      expect(classifyFailure(Object.assign(new Error(`http ${status}`), { status }))).toBe('deterministic');
    }
  });

  it('an unreadable structured response CUT OFF by max_tokens is deterministic — same input truncates the same way', () => {
    // Measured live 2026-09-02 (repro-real.log run 3): the truncated JSON of
    // an over-demanded answer surfaces as StructuredReadError from the
    // adapter BEFORE the caller's assertNotTruncated can see the stop
    // reason — without this rule it classified retryable and burned the
    // budget re-issuing a guaranteed truncation.
    expect(classifyFailure(new StructuredReadError('response is not valid JSON', 'max_tokens'))).toBe('deterministic');
  });

  it('a yield-collapse verdict is deterministic — retries provably return the identical under-report (P3c)', () => {
    // Inherited from DeterministicJobError on purpose: the collapse was
    // measured bit-identical across retries AND budget regimes, so spending
    // the retry budget on it is pure waste. Pinned at the seam so the
    // inheritance cannot be silently severed.
    expect(classifyFailure(new YieldCollapseError('found 3 of 50 counted mentions', [], { found: 3, counted: 50, pieceChars: 100 }))).toBe('deterministic');
  });

  it('a depth-exhausted end_turn stays retryable — because the RETRY re-cuts it, not because sampling might', () => {
    // RETRY-CLASSIFICATION P2, the site 3 ↔ site 5 disagreement, decided
    // 2026-09-12. This test used to say "sampling may fix it", which was never
    // true: `DETECTION_TEMPERATURE` is 0, so an identical call returns an
    // identical answer, and that is precisely `subdividable()`'s argument for
    // the opposite verdict.
    //
    // The real reason it stays retryable arrived with CHUNK-GRAIN-RESUME HD2
    // (option C): a resumed unit seeds the checkpoint's size and then takes one
    // shrink step, so the retry reads the poison text in a DIFFERENT piece. The
    // retry is no longer the same call. And the price of being wrong fell from a
    // whole re-paid prefix (~26 min on the 1958 document) to one chunk.
    //
    // Still `undefined`, not `'transient'`: the wire vocabulary has two values
    // and this is neither — not weather, but "the next attempt reads different
    // input". Absent says unrecognised-so-retryable, which is what is true.
    expect(classifyFailure(new StructuredReadError('parsed to object, not an array', 'end_turn'))).toBeUndefined();
  });

  it("an 'unknown'-stop unreadable response stays retryable — the live Ollama failure's exact shape (OLLAMA-DETECTION-TESTING P1)", () => {
    // gemma4:26b, 2026-09-03: done_reason ABSENT → the adapter maps 'unknown'.
    // An unknown stop is not provably-repeatable the way max_tokens is, so it
    // stays inside the retry budget.
    //
    // Retryable STANDS after F3's live recurrence (P4 attempt 2, 2026-09-05):
    // the new evidence flipped SUBDIVIDABILITY (see detection-chunking — the
    // shape descends by size now), not classification. An unknown stop still
    // is not provably-repeatable the way max_tokens is, and a genuinely broken
    // server deserves its retry budget; the subdivision fix is what keeps the
    // deterministic-in-practice case from burning that budget at same size.
    expect(classifyFailure(new StructuredReadError('response is not valid JSON', 'unknown'))).toBeUndefined();
  });

  // ── the status branch is DERIVED, not restated (RETRY-CLASSIFICATION P2) ──
  describe('status classification follows RETRY_RULES.job', () => {
    it('agrees with the rule on every status, so the two cannot drift apart', () => {
      // The census's finding was not that four sites disagreed — it was that
      // two of them asserted a bare list nobody could see was a second opinion,
      // and where a list and an argument disagreed the LIST won silently. This
      // is the gate that makes that impossible here: change the rule and this
      // file follows, change only one and this fails.
      for (let status = 100; status < 600; status++) {
        const viaRule = RETRY_RULES.job.retryable({ status });
        const viaClassifier = classifyFailure({ status }) === 'transient';
        expect(viaClassifier, `status ${status}`).toBe(viaRule);
      }
    });

    it('keeps 413 deterministic — a payload too large is not weather', () => {
      // Green on arrival, and pinned as a DECISION rather than left as the side
      // effect of branch order: 413 is below 500 and outside the rule's
      // transient set, so it falls to the >= 400 rejection branch. The transport
      // rule retries it (with a Retry-After) and this one does not — a genuine
      // per-context disagreement, which is what the taxonomy exists to make
      // visible rather than accidental.
      expect(classifyFailure({ status: 413 })).toBe('deterministic');
      expect(RETRY_RULES.job.retryable({ status: 413 })).toBe(false);
    });
  });

  it('everything unrecognized is unclassified — retryable by default (HD2 gates only KNOWN-deterministic)', () => {
    expect(classifyFailure(new Error('MessageStream terminated'))).toBeUndefined();
    expect(classifyFailure(new TypeError('fetch failed'))).toBeUndefined();
    expect(classifyFailure('a string')).toBeUndefined();
    expect(classifyFailure(undefined)).toBeUndefined();
  });
});
