/**
 * Tests for annotation utility functions
 */

import { describe, it, expect } from 'vitest';
import { getEntityTypes, getBodySource, isStubReference, isResolvedReference } from '../annotation-utils';
import type { Annotation } from '@semiont/core';

describe('getEntityTypes', () => {
  it('should extract entity types from TextualBody bodies with purpose: "tagging"', () => {
    const annotation: Partial<Annotation> = {
      id: 'ann-123',
      motivation: 'linking',
      body: [
        {
          type: 'TextualBody',
          value: 'Person',
          purpose: 'tagging',
        },
        {
          type: 'TextualBody',
          value: 'Scientist',
          purpose: 'tagging',
        },
        {
          type: 'TextualBody',
          value: 'Physicist',
          purpose: 'tagging',
        },
      ],
    };

    const entityTypes = getEntityTypes(annotation as Annotation);
    expect(entityTypes).toEqual(['Person', 'Scientist', 'Physicist']);
  });

  it('should extract entity types from mixed body array with SpecificResource', () => {
    const annotation: Partial<Annotation> = {
      id: 'ann-456',
      motivation: 'linking',
      body: [
        {
          type: 'TextualBody',
          value: 'Organization',
          purpose: 'tagging',
        },
        {
          type: 'TextualBody',
          value: 'University',
          purpose: 'tagging',
        },
        {
          type: 'SpecificResource',
          source: 'doc-789',
          purpose: 'linking',
        },
      ],
    };

    const entityTypes = getEntityTypes(annotation as Annotation);
    expect(entityTypes).toEqual(['Organization', 'University']);
  });

  it('should return empty array for empty body', () => {
    const annotation: Partial<Annotation> = {
      id: 'ann-empty',
      motivation: 'linking',
      body: [],
    };

    const entityTypes = getEntityTypes(annotation as Annotation);
    expect(entityTypes).toEqual([]);
  });

  it('should return empty array for highlight with no tagging bodies', () => {
    const annotation: Partial<Annotation> = {
      id: 'hl-123',
      motivation: 'highlighting',
      body: [],
    };

    const entityTypes = getEntityTypes(annotation as Annotation);
    expect(entityTypes).toEqual([]);
  });

  it('should ignore TextualBody with non-tagging purpose', () => {
    const annotation: Partial<Annotation> = {
      id: 'ann-describing',
      motivation: 'highlighting',
      body: [
        {
          type: 'TextualBody',
          value: 'This is a description',
          purpose: 'describing',
        },
        {
          type: 'TextualBody',
          value: 'Person',
          purpose: 'tagging',
        },
        {
          type: 'TextualBody',
          value: 'This is a comment',
          purpose: 'commenting',
        },
      ],
    };

    const entityTypes = getEntityTypes(annotation as Annotation);
    expect(entityTypes).toEqual(['Person']);
  });

  it('should handle single body (non-array)', () => {
    const annotation: Partial<Annotation> = {
      id: 'ann-single',
      motivation: 'linking',
      body: {
        type: 'SpecificResource',
        source: 'doc-123',
        purpose: 'linking',
      },
    };

    const entityTypes = getEntityTypes(annotation as Annotation);
    expect(entityTypes).toEqual([]);
  });

  it('should filter out empty string values', () => {
    const annotation: Partial<Annotation> = {
      id: 'ann-empty-values',
      motivation: 'linking',
      body: [
        {
          type: 'TextualBody',
          value: 'Person',
          purpose: 'tagging',
        },
        {
          type: 'TextualBody',
          value: '',
          purpose: 'tagging',
        },
        {
          type: 'TextualBody',
          value: 'Scientist',
          purpose: 'tagging',
        },
      ],
    };

    const entityTypes = getEntityTypes(annotation as Annotation);
    expect(entityTypes).toEqual(['Person', 'Scientist']);
  });
});

describe('isStubReference', () => {
  it('should return true for linking annotation with no SpecificResource', () => {
    const annotation: Partial<Annotation> = {
      id: 'ann-stub',
      motivation: 'linking',
      body: [
        {
          type: 'TextualBody',
          value: 'Person',
          purpose: 'tagging',
        },
      ],
    };

    expect(isStubReference(annotation as Annotation)).toBe(true);
  });

  it('should return true for linking annotation with empty body', () => {
    const annotation: Partial<Annotation> = {
      id: 'ann-empty',
      motivation: 'linking',
      body: [],
    };

    expect(isStubReference(annotation as Annotation)).toBe(true);
  });

  it('should return false for linking annotation with SpecificResource', () => {
    const annotation: Partial<Annotation> = {
      id: 'ann-resolved',
      motivation: 'linking',
      body: [
        {
          type: 'TextualBody',
          value: 'Person',
          purpose: 'tagging',
        },
        {
          type: 'SpecificResource',
          source: 'doc-123',
          purpose: 'linking',
        },
      ],
    };

    expect(isStubReference(annotation as Annotation)).toBe(false);
  });

  it('should return false for highlight annotation', () => {
    const annotation: Partial<Annotation> = {
      id: 'hl-123',
      motivation: 'highlighting',
      body: [],
    };

    expect(isStubReference(annotation as Annotation)).toBe(false);
  });
});

describe('isResolvedReference', () => {
  it('should return true for linking annotation with SpecificResource', () => {
    const annotation: Partial<Annotation> = {
      id: 'ann-resolved',
      motivation: 'linking',
      body: [
        {
          type: 'TextualBody',
          value: 'Person',
          purpose: 'tagging',
        },
        {
          type: 'SpecificResource',
          source: 'doc-123',
          purpose: 'linking',
        },
      ],
    };

    expect(isResolvedReference(annotation as Annotation)).toBe(true);
  });

  it('should return false for linking annotation without SpecificResource', () => {
    const annotation: Partial<Annotation> = {
      id: 'ann-stub',
      motivation: 'linking',
      body: [
        {
          type: 'TextualBody',
          value: 'Person',
          purpose: 'tagging',
        },
      ],
    };

    expect(isResolvedReference(annotation as Annotation)).toBe(false);
  });

  it('should return false for highlight annotation', () => {
    const annotation: Partial<Annotation> = {
      id: 'hl-123',
      motivation: 'highlighting',
      body: [],
    };

    expect(isResolvedReference(annotation as Annotation)).toBe(false);
  });
});

describe('getBodySource', () => {
  it('should extract source from SpecificResource in array', () => {
    const body = [
      {
        type: 'TextualBody' as const,
        value: 'Person',
        purpose: 'tagging' as const,
      },
      {
        type: 'SpecificResource' as const,
        source: 'doc-resolved',
        purpose: 'linking' as const,
      },
    ];

    const source = getBodySource(body as Annotation['body']);
    expect(source).toBe('doc-resolved');
  });

  it('should extract source from single SpecificResource', () => {
    const body = {
      type: 'SpecificResource' as const,
      source: 'doc-single',
      purpose: 'linking' as const,
    };

    const source = getBodySource(body as Annotation['body']);
    expect(source).toBe('doc-single');
  });

  it('should return null for empty array', () => {
    const source = getBodySource([] as Annotation['body']);
    expect(source).toBeNull();
  });

  it('should return null for array with only TextualBody', () => {
    const body = [
      {
        type: 'TextualBody' as const,
        value: 'Person',
        purpose: 'tagging' as const,
      },
    ];

    const source = getBodySource(body as Annotation['body']);
    expect(source).toBeNull();
  });

  it('should return first SpecificResource source when multiple exist', () => {
    const body = [
      {
        type: 'SpecificResource' as const,
        source: 'doc-first',
        purpose: 'linking' as const,
      },
      {
        type: 'SpecificResource' as const,
        source: 'doc-second',
        purpose: 'linking' as const,
      },
    ];

    const source = getBodySource(body as Annotation['body']);
    expect(source).toBe('doc-first');
  });
});
