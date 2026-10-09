/**
 * classifyFailure, held to specs/src/worker/failure-class-cases.json: the
 * table every worker's classification runs, so that a failure is reported in
 * one class whichever language the worker is written in.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { StructuredReadError } from '@semiont/inference';
import { classifyFailure, DeterministicJobError, type FailureClass } from '../failure-class';
import { YieldCollapseError } from '../workers/detection/detection-chunking';
import { InferenceTimeoutError } from '../workers/inference-call';

interface FailureDescription {
  name?: string;
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

/** The failure a case describes: the worker's own kind where the table names one, and otherwise a failure carrying the name and status given. */
function failureOf(described: Case['failure']): unknown {
  if (described === null || typeof described === 'string') return described;
  const { name, status, stopReason } = described;
  const carried = status !== undefined ? { status } : {};
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
    default:
      return Object.assign(new Error('described by the table'), name !== undefined ? { name } : {}, carried);
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
