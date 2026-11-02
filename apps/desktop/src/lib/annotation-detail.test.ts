import { describe, expect, it } from 'vitest';
import type { Annotation } from '@semiont/core';
import type { AnnotationsCollection } from '@semiont/react-ui';
import { findAnnotation } from './annotation-detail';

/** Minimal annotation fixture — only the fields findAnnotation touches. */
function ann(id: string, motivation: string): Annotation {
  return { id, motivation, target: { source: 'r-1' } } as unknown as Annotation;
}

function collection(overrides: Partial<AnnotationsCollection> = {}): AnnotationsCollection {
  return {
    highlights: [],
    references: [],
    assessments: [],
    comments: [],
    tags: [],
    ...overrides,
  };
}

describe('findAnnotation (detail click → the clicked annotation, whatever its group)', () => {
  it('finds an annotation in each motivation group', () => {
    const c = collection({
      highlights: [ann('h-1', 'highlighting')],
      references: [ann('r-1', 'linking')],
      assessments: [ann('a-1', 'assessing')],
      comments: [ann('c-1', 'commenting')],
      tags: [ann('t-1', 'tagging')],
    });
    for (const id of ['h-1', 'r-1', 'a-1', 'c-1', 't-1']) {
      expect(findAnnotation(c, id)?.id).toBe(id);
    }
  });

  it('returns null when the id is in no group', () => {
    const c = collection({ references: [ann('r-1', 'linking')] });
    expect(findAnnotation(c, 'nope')).toBeNull();
  });
});
