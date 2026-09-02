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
import { classifyFailure, DeterministicJobError } from '../failure-class';
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
    for (const status of [408, 429, 500, 529]) {
      expect(classifyFailure(Object.assign(new Error(`http ${status}`), { status }))).toBe('transient');
    }
  });

  it('request-rejection statuses are deterministic: the same request cannot succeed twice', () => {
    for (const status of [400, 401, 403, 413, 422]) {
      expect(classifyFailure(Object.assign(new Error(`http ${status}`), { status }))).toBe('deterministic');
    }
  });

  it('everything unrecognized is unclassified — retryable by default (HD2 gates only KNOWN-deterministic)', () => {
    expect(classifyFailure(new Error('MessageStream terminated'))).toBeUndefined();
    expect(classifyFailure(new TypeError('fetch failed'))).toBeUndefined();
    expect(classifyFailure('a string')).toBeUndefined();
    expect(classifyFailure(undefined)).toBeUndefined();
  });
});
