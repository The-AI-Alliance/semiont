/**
 * The annotation readers, held to specs/src/annotations/reader-cases.json:
 * the table every SDK's readers run, so that TypeScript, Rust and Python give
 * one answer for one annotation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Annotation } from '../annotation-types';
import {
  getAnnotationExactText,
  getBodySource,
  getCommentText,
  getEntityTypes,
  getExactText,
  getTagCategory,
  getTagSchemaId,
  getTargetSelector,
  getTargetSource,
  getTextQuoteSelector,
  isAssessment,
  isBodyResolved,
  isComment,
  isHighlight,
  isReference,
  isResolvedReference,
  isStubReference,
  isTag,
} from '../web-annotation-utils';

interface Case {
  why: string;
  annotation: Annotation;
  reads: Record<string, unknown>;
}

const table: { readers: string[]; cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/annotations/reader-cases.json', import.meta.url), 'utf8'),
);

/** Each reader of the table, given the part of the annotation it reads. Nothing is `null`, as the table writes it. */
const READERS: Record<string, (annotation: Annotation) => unknown> = {
  bodySource: (a) => getBodySource(a.body),
  isBodyResolved: (a) => isBodyResolved(a.body),
  targetSource: (a) => getTargetSource(a.target),
  targetSelector: (a) => getTargetSelector(a.target) ?? null,
  isHighlight,
  isReference,
  isAssessment,
  isComment,
  isTag,
  commentText: (a) => getCommentText(a) ?? null,
  isStubReference,
  isResolvedReference,
  exactText: (a) => getExactText(getTargetSelector(a.target)),
  annotationExactText: getAnnotationExactText,
  textQuoteSelector: (a) => {
    const selector = getTargetSelector(a.target);
    if (selector === undefined) throw new Error('the table gives textQuoteSelector no selector to read');
    return getTextQuoteSelector(selector);
  },
  entityTypes: getEntityTypes,
  tagCategory: (a) => getTagCategory(a) ?? null,
  tagSchemaId: (a) => getTagSchemaId(a) ?? null,
};

describe('the annotation readers (specs/src/annotations/reader-cases.json)', () => {
  it('has a reader here for each the table names, and no other', () => {
    expect(Object.keys(READERS).sort()).toEqual([...table.readers].sort());
  });

  it('states every reader in every case, but the quote selector where there is no selector', () => {
    for (const { why, annotation, reads } of table.cases) {
      const applies = table.readers.filter(
        (reader) => reader !== 'textQuoteSelector' || getTargetSelector(annotation.target) !== undefined,
      );
      expect(Object.keys(reads).sort(), why).toEqual(applies.sort());
    }
  });

  for (const { why, annotation, reads } of table.cases) {
    it(why, () => {
      for (const [reader, answer] of Object.entries(reads)) {
        expect(READERS[reader]?.(annotation), `${reader} of ${annotation.id}`).toEqual(answer);
      }
    });
  }
});
