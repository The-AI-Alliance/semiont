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
export function createTestResource(overrides?: Partial<ResourceDescriptor>): ResourceDescriptor {
  const id = overrides?.['@id'] || `urn:semiont:resource:test-${Date.now()}`;

  return {
    '@context': 'https://schema.org/',
    '@id': id,
    name: 'Test Resource',
    representations: [{
      mediaType: 'text/markdown',
      checksum: 'sha256:test123',
      rel: 'original',
    }],
    archived: false,
    entityTypes: [],
    creationMethod: 'api',
    dateCreated: new Date().toISOString(),
    wasAttributedTo: {
      name: 'Test User',
    },
    ...overrides,
  };
}

/**
 * Create a test Representation
 */
export function createTestRepresentation(overrides?: Partial<Representation>): Representation {
  return {
    mediaType: 'text/markdown',
    checksum: 'sha256:test123',
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

