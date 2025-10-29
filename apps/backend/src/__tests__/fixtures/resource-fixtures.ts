/**
 * Test fixtures for W3C ResourceDescriptor schema
 */

import type { components } from '@semiont/api-client';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Representation = components['schemas']['Representation'];
type Agent = components['schemas']['Agent'];

/**
 * Create a test ResourceDescriptor with sensible defaults
 */
export function createTestResource(overrides?: Partial<ResourceDescriptor & { id?: string; creator?: any }>): ResourceDescriptor {
  // Support both @id and id for test convenience
  const id = overrides?.['@id'] || (overrides?.id ? `http://localhost:4000/resources/${overrides.id}` : `urn:semiont:resource:test-${Date.now()}`);

  // Support creator as alias for wasAttributedTo
  const wasAttributedTo = overrides?.wasAttributedTo || overrides?.creator || {
    name: 'Test User',
  };

  const { id: _legacyId, creator: _legacyCreator, ...rest } = overrides || {};

  return {
    '@context': 'https://schema.org/',
    '@id': id,
    name: 'Test Resource',
    representations: [{
      mediaType: 'text/markdown',
      checksum: 'test123',
      rel: 'original',
    }],
    archived: false,
    entityTypes: [],
    creationMethod: 'api',
    dateCreated: new Date().toISOString(),
    wasAttributedTo,
    ...rest,
  };
}

/**
 * Create a test Representation
 */
export function createTestRepresentation(overrides?: Partial<Representation>): Representation {
  return {
    mediaType: 'text/markdown',
    checksum: 'test123',
    rel: 'original',
    ...overrides,
  };
}

/**
 * Create a test Agent
 */
export function createTestAgent(overrides?: Partial<Agent>): Agent {
  return {
    name: 'Test User',
    ...overrides,
  };
}

