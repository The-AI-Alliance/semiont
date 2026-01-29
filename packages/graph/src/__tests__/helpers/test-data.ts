/**
 * Test data helpers for graph database tests
 */

import { v4 as uuidv4 } from 'uuid';
import type { components } from '@semiont/api-client';
import type { CreateAnnotationInternal } from '@semiont/core';
import { resourceUri } from '@semiont/api-client';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

/**
 * Create a test resource with sensible defaults
 */
export function createTestResource(overrides: Partial<ResourceDescriptor> = {}): ResourceDescriptor {
  const id = (overrides as any)['@id'] || overrides.id || `http://example.com/resources/${uuidv4()}`;

  return {
    '@context': 'https://www.w3.org/ns/ldp',
    '@id': id,
    type: 'ldp:RDFSource',
    name: 'Test Resource',
    entityTypes: ['Person'],
    representations: [
      {
        id: `http://example.com/representations/${uuidv4()}`,
        mediaType: 'text/plain',
        content: { value: 'test content' },
      },
    ],
    created: new Date().toISOString(),
    ...overrides,
  } as ResourceDescriptor;
}

/**
 * Create a test annotation with highlighting motivation
 */
export function createTestHighlight(
  resourceId: string,
  overrides: Partial<CreateAnnotationInternal> = {}
): CreateAnnotationInternal {
  return {
    id: uuidv4(),
    motivation: 'highlighting',
    target: {
      source: resourceUri(resourceId),
      selector: {
        type: 'TextQuoteSelector',
        exact: 'test highlight',
        prefix: '',
        suffix: '',
      },
    },
    body: {
      type: 'TextualBody',
      value: 'This is a highlight',
      format: 'text/plain',
      purpose: 'highlighting',
    },
    creator: {
      name: `User ${uuidv4()}`,
    },
    ...overrides,
  };
}

/**
 * Create a test annotation with linking motivation (stub reference)
 */
export function createTestReference(
  targetResourceId: string,
  overrides: Partial<CreateAnnotationInternal> = {}
): CreateAnnotationInternal {
  return {
    id: uuidv4(),
    motivation: 'linking',
    target: {
      source: resourceUri(targetResourceId),
      selector: {
        type: 'TextQuoteSelector',
        exact: 'reference text',
        prefix: '',
        suffix: '',
      },
    },
    body: [], // Stub - will be resolved later
    creator: {
      name: `User ${uuidv4()}`,
    },
    ...overrides,
  };
}

/**
 * Create a test entity reference annotation
 */
export function createTestEntityReference(
  targetResourceId: string,
  sourceResourceId: string,
  entityTypes: string[] = ['Person'],
  overrides: Partial<CreateAnnotationInternal> = {}
): CreateAnnotationInternal {
  return {
    id: uuidv4(),
    motivation: 'linking',
    target: {
      source: resourceUri(targetResourceId),
      selector: {
        type: 'TextQuoteSelector',
        exact: 'entity text',
        prefix: '',
        suffix: '',
      },
    },
    body: {
      type: 'SpecificResource',
      source: resourceUri(sourceResourceId),
      purpose: 'linking',
      entityTypes,
    } as any,
    creator: {
      name: `User ${uuidv4()}`,
    },
    ...overrides,
  };
}

/**
 * Generate a unique resource ID
 */
export function generateResourceId(): string {
  return `http://example.com/resources/${uuidv4()}`;
}

/**
 * Generate a unique annotation ID
 */
export function generateAnnotationId(): string {
  return uuidv4().replace(/-/g, '').substring(0, 12);
}
