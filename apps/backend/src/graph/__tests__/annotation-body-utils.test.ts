/**
 * Tests for annotation body utility functions
 */

import { describe, it, expect } from 'vitest';
import { extractEntityTypes, extractBodySource } from '../annotation-body-utils';
import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

describe('extractEntityTypes', () => {
  it('should extract entity types from TextualBody bodies with purpose: "tagging"', () => {
    const body: Annotation['body'] = [
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
    ];

    const entityTypes = extractEntityTypes(body);
    expect(entityTypes).toEqual(['Person', 'Scientist', 'Physicist']);
  });

  it('should extract entity types from mixed body array with SpecificResource', () => {
    const body: Annotation['body'] = [
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
    ];

    const entityTypes = extractEntityTypes(body);
    expect(entityTypes).toEqual(['Organization', 'University']);
  });

  it('should return empty array for empty body', () => {
    const body: Annotation['body'] = [];

    const entityTypes = extractEntityTypes(body);
    expect(entityTypes).toEqual([]);
  });

  it('should return empty array for non-array body', () => {
    const body: Annotation['body'] = {
      type: 'SpecificResource',
      source: 'doc-123',
      purpose: 'linking',
    };

    const entityTypes = extractEntityTypes(body);
    expect(entityTypes).toEqual([]);
  });

  it('should ignore TextualBody with non-tagging purpose', () => {
    const body: Annotation['body'] = [
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
    ];

    const entityTypes = extractEntityTypes(body);
    expect(entityTypes).toEqual(['Person']);
  });

  it('should filter out empty string values', () => {
    const body: Annotation['body'] = [
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
    ];

    const entityTypes = extractEntityTypes(body);
    expect(entityTypes).toEqual(['Person', 'Scientist']);
  });

  it('should handle null body', () => {
    const entityTypes = extractEntityTypes(null as any);
    expect(entityTypes).toEqual([]);
  });

  it('should handle undefined body', () => {
    const entityTypes = extractEntityTypes(undefined as any);
    expect(entityTypes).toEqual([]);
  });
});

describe('extractBodySource', () => {
  it('should extract source from SpecificResource in array', () => {
    const body: Annotation['body'] = [
      {
        type: 'TextualBody',
        value: 'Person',
        purpose: 'tagging',
      },
      {
        type: 'SpecificResource',
        source: 'doc-resolved',
        purpose: 'linking',
      },
    ];

    const source = extractBodySource(body);
    expect(source).toBe('doc-resolved');
  });

  it('should extract source from single SpecificResource', () => {
    const body: Annotation['body'] = {
      type: 'SpecificResource',
      source: 'doc-single',
      purpose: 'linking',
    };

    const source = extractBodySource(body);
    expect(source).toBe('doc-single');
  });

  it('should return null for empty array', () => {
    const source = extractBodySource([]);
    expect(source).toBeNull();
  });

  it('should return null for array with only TextualBody', () => {
    const body: Annotation['body'] = [
      {
        type: 'TextualBody',
        value: 'Person',
        purpose: 'tagging',
      },
    ];

    const source = extractBodySource(body);
    expect(source).toBeNull();
  });

  it('should return first SpecificResource source when multiple exist', () => {
    const body: Annotation['body'] = [
      {
        type: 'SpecificResource',
        source: 'doc-first',
        purpose: 'linking',
      },
      {
        type: 'SpecificResource',
        source: 'doc-second',
        purpose: 'linking',
      },
    ];

    const source = extractBodySource(body);
    expect(source).toBe('doc-first');
  });

  it('should return null for null body', () => {
    const source = extractBodySource(null as any);
    expect(source).toBeNull();
  });

  it('should return null for undefined body', () => {
    const source = extractBodySource(undefined as any);
    expect(source).toBeNull();
  });
});
