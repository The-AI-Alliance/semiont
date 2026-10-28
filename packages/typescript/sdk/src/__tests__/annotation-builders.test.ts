/**
 * The annotation builders are the SDK's to hand out: a worker that records
 * what a model found imports them with its client, and restates none of how a
 * quote is found, a selector made or an id derived. The set is the one
 * specs/src/annotations/builder-cases.json holds every SDK to, and each is
 * core's own function, whose behaviour that table's test holds.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as core from '@semiont/core';
import { annotationOfResource, annotationOfSpan, reconcile, SpanRefusedError } from '../index';

const table: { builders: string[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/annotations/builder-cases.json', import.meta.url), 'utf8'),
);

/** Each builder the SDK exports, under the name the table gives it, beside core's. */
const BUILDERS = {
  reconcile: [reconcile, core.reconcile],
  annotationOfSpan: [annotationOfSpan, core.annotationOfSpan],
  annotationOfResource: [annotationOfResource, core.annotationOfResource],
} as const;

describe('the annotation builders the SDK exports', () => {
  it('are the ones the table names, and no other', () => {
    expect(Object.keys(BUILDERS).sort()).toEqual([...table.builders].sort());
  });

  it('are each core\'s own function', () => {
    for (const [name, [exported, own]] of Object.entries(BUILDERS)) {
      expect(exported, name).toBe(own);
      expect(typeof exported, name).toBe('function');
    }
  });

  it('come with the error a refused span is, which is core\'s own', () => {
    expect(SpanRefusedError).toBe(core.SpanRefusedError);
    expect(typeof SpanRefusedError).toBe('function');
  });
});
