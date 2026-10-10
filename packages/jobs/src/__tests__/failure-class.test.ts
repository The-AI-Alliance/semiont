/**
 * Failure classification: a deterministic failure is not retried, and neither
 * is an answer the provider withheld.
 *
 * The taxonomy is deliberately small and one-sided: only failures KNOWN to be
 * deterministic or withheld skip the retry budget; everything unrecognized
 * stays retryable (`undefined`), because mis-classifying a transient failure
 * as either silently halves reliability, while the reverse merely costs one
 * wasted attempt. The withheld answer's case, and that of a model not known
 * to hold a reply to a schema, are the table's (failure-class-cases.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { StructuredReadError } from '@semiont/inference';
import { RETRY_RULES } from '@semiont/core';
import { APIError } from '@semiont/http-transport';
import { classifyFailure, DeterministicJobError } from '../failure-class';
import { YieldCollapseError } from '../workers/detection/detection-chunking';
import { InferenceTimeoutError } from '../workers/inference-call';

describe('classifyFailure', () => {
  it('our own deterministic marker classifies deterministic', () => {
    expect(classifyFailure(new DeterministicJobError('response truncated'))).toBe('deterministic');
  });

  it('our timeout bound classifies transient — a stall says nothing about the request', () => {
    expect(classifyFailure(new InferenceTimeoutError('timed out'))).toBe('transient');
  });

  it('aborts are transient — the transport was torn down, not the request judged', () => {
    expect(classifyFailure(new DOMException('This operation was aborted', 'AbortError'))).toBe('transient');
  });

  it('reads no name a provider\'s library gives a failure: its driver reports an abort as the language\'s', () => {
    expect(classifyFailure(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' }))).toBeUndefined();
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
    // The truncated JSON of an over-demanded answer surfaces as
    // StructuredReadError from the adapter BEFORE the caller's
    // assertNotTruncated can see the stop reason — without this rule it
    // classifies retryable and burns the budget re-issuing a guaranteed
    // truncation.
    expect(classifyFailure(new StructuredReadError('response is not valid JSON', 'max_tokens'))).toBe('deterministic');
  });

  it('a yield-collapse verdict is deterministic — retries provably return the identical under-report', () => {
    // Inherited from DeterministicJobError on purpose: the collapse was
    // measured bit-identical across retries AND budget regimes, so spending
    // the retry budget on it is pure waste. Pinned at the seam so the
    // inheritance cannot be silently severed.
    expect(classifyFailure(new YieldCollapseError('found 3 of 50 counted mentions', [], { found: 3, counted: 50, pieceChars: 100 }))).toBe('deterministic');
  });

  it('a depth-exhausted end_turn stays retryable — because the RETRY re-cuts it, not because sampling might', () => {
    // This classifier and `subdividable()` disagree about one error, on
    // purpose. Sampling cannot fix it: `DETECTION_TEMPERATURE` is 0, so an
    // identical call returns an identical answer, and that is precisely
    // `subdividable()`'s argument for the opposite verdict.
    //
    // It stays retryable because of chunk-grain resume: a resumed unit seeds
    // the checkpoint's size and then takes one shrink step, so the retry reads
    // the poison text in a DIFFERENT piece. The retry is not the same call,
    // and being wrong costs one chunk rather than a whole re-paid prefix.
    //
    // `undefined`, not `'transient'`: the wire vocabulary has three values
    // and this is none of them — not weather, but "the next attempt reads different
    // input". Absent says unrecognised-so-retryable, which is what is true.
    expect(classifyFailure(new StructuredReadError('parsed to object, not an array', 'end_turn'))).toBeUndefined();
  });

  it("an 'unknown'-stop unreadable response stays retryable — Ollama's absent done_reason", () => {
    // Ollama (gemma4:26b) can omit done_reason → the adapter maps 'unknown'.
    // An unknown stop is not provably-repeatable the way max_tokens is, and a
    // genuinely broken server deserves its retry budget, so it stays inside
    // it. What this shape changes is SUBDIVIDABILITY, not classification: it
    // descends by size (see detection-chunking), which keeps the
    // deterministic-in-practice case from burning that budget at same size.
    expect(classifyFailure(new StructuredReadError('response is not valid JSON', 'unknown'))).toBeUndefined();
  });

  it('a read of bytes the gateway refuses classifies by its status, as the transport reports it', () => {
    // The worker reads a resource's bytes on the gateway, and a refusal is the
    // transport's own error. Bytes that are not there will not be there on a
    // second identical read; an Archivist the gateway cannot reach may be.
    const missing = APIError.refusal(404, 'Not Found', { error: 'No representation' }, null);
    const unreachable = APIError.refusal(503, 'Service Unavailable', { error: 'The Archivist cannot serve it' }, null);
    expect(classifyFailure(missing)).toBe('deterministic');
    expect(classifyFailure(unreachable)).toBe('transient');
  });

  // ── the status branch is DERIVED, not restated ────────────────────────────
  describe('status classification follows RETRY_RULES.job', () => {
    it('agrees with the rule on every status, so the two cannot drift apart', () => {
      // A bare status list here would be a second opinion nobody can see is
      // one, and where a list and an argument disagree the LIST wins silently.
      // This is the gate that makes that impossible here: change the rule and
      // this file follows, change only one and this fails.
      for (let status = 100; status < 600; status++) {
        const viaRule = RETRY_RULES.job.retryable({ status });
        const viaClassifier = classifyFailure({ status }) === 'transient';
        expect(viaClassifier, `status ${status}`).toBe(viaRule);
      }
    });

    it('keeps 413 deterministic — a payload too large is not weather', () => {
      // Pinned as a DECISION rather than left as the side effect of branch
      // order: 413 is below 500 and outside the rule's
      // transient set, so it falls to the >= 400 rejection branch. The transport
      // rule retries it (with a Retry-After) and this one does not — a genuine
      // per-context disagreement, which is what the taxonomy exists to make
      // visible rather than accidental.
      expect(classifyFailure({ status: 413 })).toBe('deterministic');
      expect(RETRY_RULES.job.retryable({ status: 413 })).toBe(false);
    });
  });

  it('everything unrecognized is unclassified — retryable by default (only failures KNOWN to be deterministic or withheld are gated)', () => {
    expect(classifyFailure(new Error('MessageStream terminated'))).toBeUndefined();
    expect(classifyFailure(new TypeError('fetch failed'))).toBeUndefined();
    expect(classifyFailure('a string')).toBeUndefined();
    expect(classifyFailure(undefined)).toBeUndefined();
  });
});
