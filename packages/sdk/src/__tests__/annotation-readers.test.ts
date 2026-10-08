/**
 * The annotation readers are the SDK's to hand out: a script that reads an
 * annotation imports them with its client, and writes none by hand. The set
 * is the one specs/src/annotations/reader-cases.json holds every SDK to, and
 * each is core's own function, whose behaviour that table's test holds.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as core from '@semiont/core';
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
} from '../index';

const table: { readers: string[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/annotations/reader-cases.json', import.meta.url), 'utf8'),
);

/** Each reader the SDK exports, under the name the table gives it, beside core's. */
const READERS = {
  bodySource: [getBodySource, core.getBodySource],
  isBodyResolved: [isBodyResolved, core.isBodyResolved],
  targetSource: [getTargetSource, core.getTargetSource],
  targetSelector: [getTargetSelector, core.getTargetSelector],
  isHighlight: [isHighlight, core.isHighlight],
  isReference: [isReference, core.isReference],
  isAssessment: [isAssessment, core.isAssessment],
  isComment: [isComment, core.isComment],
  isTag: [isTag, core.isTag],
  commentText: [getCommentText, core.getCommentText],
  isStubReference: [isStubReference, core.isStubReference],
  isResolvedReference: [isResolvedReference, core.isResolvedReference],
  exactText: [getExactText, core.getExactText],
  annotationExactText: [getAnnotationExactText, core.getAnnotationExactText],
  textQuoteSelector: [getTextQuoteSelector, core.getTextQuoteSelector],
  entityTypes: [getEntityTypes, core.getEntityTypes],
  tagCategory: [getTagCategory, core.getTagCategory],
  tagSchemaId: [getTagSchemaId, core.getTagSchemaId],
} as const;

describe('the annotation readers the SDK exports', () => {
  it('are the ones the table names, and no other', () => {
    expect(Object.keys(READERS).sort()).toEqual([...table.readers].sort());
  });

  it('are each core\'s own function', () => {
    for (const [name, [exported, own]] of Object.entries(READERS)) {
      expect(exported, name).toBe(own);
      expect(typeof exported, name).toBe('function');
    }
  });
});
