/**
 * The id of an annotation, held to specs/src/annotations/id-cases.json: the
 * table every SDK's builders run, so that the same annotation has the same id
 * whoever makes it, and making it again writes nothing new.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { annotationIdFor, type AnnotationIdentity } from '../annotation-id';

interface Case extends AnnotationIdentity {
  why: string;
  id: string;
}

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/annotations/id-cases.json', import.meta.url), 'utf8'),
);

describe('the id of an annotation (specs/src/annotations/id-cases.json)', () => {
  it('has cases', () => {
    expect(table.cases.length).toBeGreaterThan(0);
  });

  for (const { why, id, ...identity } of table.cases) {
    it(why, () => {
      expect(annotationIdFor(identity)).toBe(id);
    });
  }
});
