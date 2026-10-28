/**
 * `reconcile`, held to specs/src/annotations/reconcile-cases.json: the table
 * every SDK's `reconcile` runs, so that what a model quoted lands on the same
 * span of the text whoever reconciles it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { reconcile, type QuotedText, type ReconciledSpan } from '../annotation-builders';

interface Case {
  why: string;
  text: string;
  quoted: QuotedText;
  /** `null` when the span is refused. */
  reconciled: ReconciledSpan | null;
}

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/annotations/reconcile-cases.json', import.meta.url), 'utf8'),
);

describe('reconciling a quoted span (specs/src/annotations/reconcile-cases.json)', () => {
  it('has cases', () => {
    expect(table.cases.length).toBeGreaterThan(0);
  });

  for (const { why, text, quoted, reconciled } of table.cases) {
    it(why, () => {
      expect(reconcile(text, quoted)).toStrictEqual(reconciled);
    });
  }
});
