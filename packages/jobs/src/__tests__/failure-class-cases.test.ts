/**
 * classifyFailure, held to specs/src/worker/failure-class-cases.json: the
 * table every worker's classification runs, so that a failure is reported in
 * one class whichever language the worker is written in.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ProviderStatusError, ProviderWithheldError, StructuredReadError } from '@semiont/inference';
import { classifyFailure, DeterministicJobError, type FailureClass } from '../failure-class';
import { YieldCollapseError } from '../workers/detection/detection-chunking';
import { InferenceTimeoutError } from '../workers/inference-call';

interface FailureDescription {
  name?: string;
  aborted?: true;
  status?: number | string;
  stopReason?: string;
}

interface Case {
  why: string;
  failure: FailureDescription | string | null;
  failureClass: FailureClass | null;
}

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/worker/failure-class-cases.json', import.meta.url), 'utf8'),
);

/**
 * The failure a case describes: the worker's or the driver's own where the
 * table names one, JavaScript's abort where it says the call was aborted, and
 * otherwise a plain failure; with the status given on whichever it is. A name
 * this runner does not have is refused: the table names no library's failure.
 */
function failureOf(described: Case['failure']): unknown {
  if (described === null || typeof described === 'string') return described;
  const { name, aborted, status, stopReason } = described;
  const carried = status !== undefined ? { status } : {};
  if (aborted) return Object.assign(new DOMException('described by the table', 'AbortError'), carried);
  switch (name) {
    case 'DeterministicJobError':
      return Object.assign(new DeterministicJobError('described by the table'), carried);
    case 'YieldCollapseError':
      return Object.assign(
        new YieldCollapseError('described by the table', [], { found: 0, counted: 0, pieceChars: 0 }),
        carried,
      );
    case 'InferenceTimeoutError':
      return Object.assign(new InferenceTimeoutError('described by the table'), carried);
    case 'StructuredReadError':
      if (stopReason === undefined) throw new Error('the table describes a StructuredReadError with no stop reason');
      return Object.assign(new StructuredReadError('described by the table', stopReason), carried);
    case 'ProviderWithheldError':
      return Object.assign(new ProviderWithheldError('described by the table', 'refusal'), carried);
    case 'ProviderStatusError':
      if (typeof status !== 'number') throw new Error('the table describes a ProviderStatusError with no status');
      return new ProviderStatusError('described by the table', status);
    case undefined:
      return Object.assign(new Error('described by the table'), carried);
    default:
      throw new Error(`the table names ${name}, which is no failure of the worker's or of its drivers'`);
  }
}

describe('classifyFailure (specs/src/worker/failure-class-cases.json)', () => {
  it('has cases to run', () => {
    expect(table.cases.length).toBeGreaterThan(0);
  });

  for (const { why, failure, failureClass } of table.cases) {
    it(why, () => {
      expect(classifyFailure(failureOf(failure)) ?? null).toBe(failureClass);
    });
  }
});
