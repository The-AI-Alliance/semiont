/**
 * The retry taxonomy: one place where every "is this worth another attempt"
 * answer is visible beside the others.
 *
 * The defect is not that contexts disagree — a `500` mid-job is worth another
 * attempt where the same `500` in a boot pass replays whatever broke it. It is
 * that today two sites carry an argument, two carry a bare list, and no reader of
 * either can see that the other exists.
 */

import { describe, it, expect } from 'vitest';
import { RETRY_RULES } from '../retry-rules';

describe('RETRY_RULES', () => {
  it('gives one 500 two answers, from one taxonomy', () => {
    // The whole plan as a single assertion. Today these two answers live in
    // different packages and neither knows the other exists: core excludes 500
    // on the record ("an unclassified server fault is not a promise to recover"),
    // while jobs retries it because the alternative is discarding a 26-minute
    // attempt over one fault.
    expect(RETRY_RULES.boot.retryable({ status: 500 })).toBe(false);
    expect(RETRY_RULES.job.retryable({ status: 500 })).toBe(true);
  });

  it('agrees with itself where the contexts agree', () => {
    // A method is supplied because the transport rule needs one and the other two
    // ignore it — a method-free 429 is deliberately `false` for transport, since
    // "not stated" reads as unsafe rather than as permission.
    for (const rule of Object.values(RETRY_RULES)) {
      expect(rule.retryable({ status: 429, method: 'GET' }), `${rule.name} on 429`).toBe(true);
      expect(rule.retryable({ status: 403, method: 'GET' }), `${rule.name} on 403`).toBe(false);
    }
  });

  it('every rule carries a name and a rationale', () => {
    // Catches OMISSION, which is the real failure mode here — sites 3, 4 and 6
    // all answered by default rather than by choice. It cannot catch a lazy
    // rationale, and does not claim to: there is no source to check one against.
    for (const rule of Object.values(RETRY_RULES)) {
      expect(rule.name).toMatch(/\S/);
      expect(rule.rationale.length, `${rule.name} rationale`).toBeGreaterThan(80);
    }
  });

  it('is the only way to reach a rule, so a new one cannot be unreachable-but-forgotten', () => {
    // Reachability IS the census gate: rules are not exported individually, so a
    // rule absent from this record cannot be consumed by anyone.
    expect(Object.keys(RETRY_RULES).sort()).toEqual(['boot', 'job', 'transport']);
    expect(Object.isFrozen(RETRY_RULES)).toBe(true);
  });

  describe('the transport rule keys on method as well as status', () => {
    // The dimension a ReadonlySet<number> cannot express, and the reason the
    // taxonomy is not typed as one. P3 consumes this.
    it('retries a 401 on any method — the request was rejected, not processed', () => {
      expect(RETRY_RULES.transport.retryable({ status: 401, method: 'POST' })).toBe(true);
      expect(RETRY_RULES.transport.retryable({ status: 401, method: 'GET' })).toBe(true);
    });

    it('retries a 5xx only on methods that are safe to repeat', () => {
      // The live hazard: a POST /resources that gets a 502 may already have been
      // processed, and the Stower mints a fresh UUID — so a retry writes a
      // SECOND resource whose id the caller never learns.
      expect(RETRY_RULES.transport.retryable({ status: 502, method: 'GET' })).toBe(true);
      expect(RETRY_RULES.transport.retryable({ status: 502, method: 'POST' })).toBe(false);
      expect(RETRY_RULES.transport.retryable({ status: 504, method: 'PATCH' })).toBe(false);
    });

    it('treats an unstated method as unsafe', () => {
      // Absence is not permission. A caller that cannot say which method it used
      // gets the conservative answer rather than a silent yes.
      expect(RETRY_RULES.transport.retryable({ status: 502 })).toBe(false);
    });
  });

  describe('the boot and job rules ignore method, and say so by accepting facts without one', () => {
    it('answers the same with or without a method', () => {
      for (const rule of [RETRY_RULES.boot, RETRY_RULES.job]) {
        expect(rule.retryable({ status: 503 })).toBe(rule.retryable({ status: 503, method: 'POST' }));
      }
    });
  });

  it('leaves the existing predicates answering exactly as they did', async () => {
    // This phase is additive on purpose: behavior moves in P2/P3, so a
    // regression there cannot be mistaken for a taxonomy bug.
    const { isRetryableRequestError } = await import('../retry');
    for (const status of [429, 503, 504]) {
      expect(isRetryableRequestError(Object.assign(new Error('x'), { status }))).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 500]) {
      expect(isRetryableRequestError(Object.assign(new Error('x'), { status }))).toBe(false);
    }
  });
});
