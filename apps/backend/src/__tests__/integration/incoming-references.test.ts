/**
 * Integration Tests: Incoming References
 *
 * Tests the /resources/:id/referenced-by endpoint which returns
 * resources that have annotations referencing a given resource.
 *
 * Uses terminology: "incoming references" for all test names and comments.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { userId, type EnvironmentConfig } from '@semiont/core';
import { loadEnvironmentConfig } from '../../utils/config';
import { email } from '@semiont/core';
import type { components } from '@semiont/core';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';

type GetReferencedByResponse = components['schemas']['GetReferencedByResponse'];

type Variables = {
  user: User;
  config: EnvironmentConfig;
  makeMeaning: any;
};

let app: Hono<{ Variables: Variables }>;

// Mock test user
const testUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  name: 'Test User',
  image: null,
  domain: 'example.com',
  provider: 'google',
  providerId: 'google-test-user-id',
  isAdmin: false,
  isModerator: false,
  isActive: true,
  termsAcceptedAt: new Date(),
  lastLogin: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Mock graph database
const mockGraphDb = {
  getResourceReferencedBy: vi.fn(),
  getResource: vi.fn(),
};

// Mock the graph database factory (updated path after package extraction)
vi.mock('@semiont/graph', () => ({
  getGraphDatabase: vi.fn(() => Promise.resolve(mockGraphDb)),
}));

// Mock database
const sharedMockClient = {
  $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  user: {
    findUnique: vi.fn().mockResolvedValue(testUser),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  },
};

vi.mock('../../db', () => ({
  DatabaseConnection: {
    getClient: vi.fn(() => sharedMockClient),
    checkHealth: vi.fn().mockResolvedValue(true),
  },
  prisma: sharedMockClient,
}));

// Mock OAuth
vi.mock('../../auth/oauth', () => ({
  OAuthService: {
    getUserFromToken: vi.fn(),
  },
}));

describe('Incoming References Integration Tests', () => {
  let testToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';

    const projectRoot = process.env.SEMIONT_ROOT;
    if (!projectRoot) throw new Error("SEMIONT_ROOT not set");
    const environment = process.env.SEMIONT_ENV || 'integration';

    const config = loadEnvironmentConfig(projectRoot, environment);

    // Initialize JWT
    const { JWTService } = await import('../../auth/jwt');
    JWTService.initialize(config);

    // Import app
    const serverModule = await import('../../index');
    app = serverModule.app;

    // Generate test token
    testToken = JWTService.generateToken({
      userId: userId(testUser.id),
      email: email(testUser.email),
      name: testUser.name,
      domain: testUser.domain,
      provider: testUser.provider,
      isAdmin: testUser.isAdmin,
    });

    // Mock OAuth to return test user
    const { OAuthService } = await import('../../auth/oauth');
    vi.mocked(OAuthService.getUserFromToken).mockImplementation(async (token) => {
      if (token === testToken) {
        return testUser as User;
      }
      throw new Error('Invalid token');
    });
  });

  afterAll(() => {
    vi.clearAllMocks();
  });

  it('should return empty array when resource has no incoming references', async () => {
    const resourceId = 'test-resource-no-refs';

    // Mock Neo4j to return no references
    mockGraphDb.getResourceReferencedBy.mockResolvedValueOnce([]);

    const res = await app.request(`/resources/${resourceId}/referenced-by`, {
      headers: {
        'Authorization': `Bearer ${testToken}`,
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json() as GetReferencedByResponse;
    expect(data.referencedBy).toEqual([]);
  });

  it('should return single incoming reference with resource name', async () => {
    const targetResourceId = 'target-resource-1';
    const sourceResourceId = 'source-resource-1';
    const annotationId = 'annotation-1';
    const publicURL = 'http://localhost:4000';

    // Mock Neo4j to return one reference
    mockGraphDb.getResourceReferencedBy.mockResolvedValueOnce([
      {
        id: annotationId,
        target: {
          type: 'SpecificResource',
          source: `${publicURL}/resources/${sourceResourceId}`,
          selector: {
            type: 'TextQuoteSelector',
            exact: 'selected text from source document',
          },
        },
      },
    ]);

    // Mock Neo4j to return the source resource with proper @id
    mockGraphDb.getResource.mockResolvedValueOnce({
      '@id': `${publicURL}/resources/${sourceResourceId}`,
      '@context': 'https://schema.org',
      '@type': 'DigitalDocument',
      name: 'Source Document Title',
      description: 'A document that references the target',
      encodingFormat: 'text/plain',
    });

    const res = await app.request(`/resources/${targetResourceId}/referenced-by`, {
      headers: {
        'Authorization': `Bearer ${testToken}`,
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json() as GetReferencedByResponse;

    expect(data.referencedBy).toHaveLength(1);
    expect(data.referencedBy[0]).toEqual({
      id: annotationId,
      resourceName: 'Source Document Title',
      target: {
        source: `${publicURL}/resources/${sourceResourceId}`,
        selector: {
          exact: 'selected text from source document',
        },
      },
    });
  });

  it('should return multiple incoming references from different resources', async () => {
    const targetResourceId = 'target-resource-2';
    const publicURL = 'http://localhost:4000';

    // Mock Neo4j to return three references from two different resources
    mockGraphDb.getResourceReferencedBy.mockResolvedValueOnce([
      {
        id: 'annotation-1',
        target: {
          type: 'SpecificResource',
          source: `${publicURL}/resources/source-resource-a`,
          selector: {
            type: 'TextQuoteSelector',
            exact: 'first reference from resource A',
          },
        },
      },
      {
        id: 'annotation-2',
        target: {
          type: 'SpecificResource',
          source: `${publicURL}/resources/source-resource-a`,
          selector: {
            type: 'TextQuoteSelector',
            exact: 'second reference from resource A',
          },
        },
      },
      {
        id: 'annotation-3',
        target: {
          type: 'SpecificResource',
          source: `${publicURL}/resources/source-resource-b`,
          selector: {
            type: 'TextQuoteSelector',
            exact: 'reference from resource B',
          },
        },
      },
    ]);

    // Mock Neo4j to return both source resources
    mockGraphDb.getResource
      .mockResolvedValueOnce({
        '@id': `${publicURL}/resources/source-resource-a`,
        '@context': 'https://schema.org',
        '@type': 'DigitalDocument',
        name: 'Source Document A',
        encodingFormat: 'text/plain',
      })
      .mockResolvedValueOnce({
        '@id': `${publicURL}/resources/source-resource-b`,
        '@context': 'https://schema.org',
        '@type': 'DigitalDocument',
        name: 'Source Document B',
        encodingFormat: 'text/plain',
      });

    const res = await app.request(`/resources/${targetResourceId}/referenced-by`, {
      headers: {
        'Authorization': `Bearer ${testToken}`,
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json() as GetReferencedByResponse;

    expect(data.referencedBy).toHaveLength(3);

    // First two references from resource A
    expect(data.referencedBy[0]?.resourceName).toBe('Source Document A');
    expect(data.referencedBy[0]?.target.selector?.exact).toBe('first reference from resource A');

    expect(data.referencedBy[1]?.resourceName).toBe('Source Document A');
    expect(data.referencedBy[1]?.target.selector?.exact).toBe('second reference from resource A');

    // Third reference from resource B
    expect(data.referencedBy[2]?.resourceName).toBe('Source Document B');
    expect(data.referencedBy[2]?.target.selector?.exact).toBe('reference from resource B');
  });

  it('should return "Untitled Resource" when source resource not found', async () => {
    const targetResourceId = 'target-resource-3';
    const publicURL = 'http://localhost:4000';

    // Mock Neo4j to return reference to non-existent resource
    mockGraphDb.getResourceReferencedBy.mockResolvedValueOnce([
      {
        id: 'annotation-orphan',
        target: {
          type: 'SpecificResource',
          source: `${publicURL}/resources/non-existent-resource`,
          selector: {
            type: 'TextQuoteSelector',
            exact: 'reference to deleted resource',
          },
        },
      },
    ]);

    // Mock Neo4j to return null (resource not found)
    mockGraphDb.getResource.mockResolvedValueOnce(null);

    const res = await app.request(`/resources/${targetResourceId}/referenced-by`, {
      headers: {
        'Authorization': `Bearer ${testToken}`,
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json() as GetReferencedByResponse;

    expect(data.referencedBy).toHaveLength(1);
    expect(data.referencedBy[0]?.resourceName).toBe('Untitled Resource');
  });

  it('should handle incoming references from image annotations without text selector', async () => {
    const targetResourceId = 'target-resource-4';
    const publicURL = 'http://localhost:4000';

    // Mock Neo4j to return image annotation reference (no text selector)
    mockGraphDb.getResourceReferencedBy.mockResolvedValueOnce([
      {
        id: 'annotation-image',
        target: {
          type: 'SpecificResource',
          source: `${publicURL}/resources/image-resource`,
          selector: {
            type: 'SvgSelector',
            value: '<svg>...</svg>',
          },
        },
      },
    ]);

    // Mock Neo4j to return the image resource
    mockGraphDb.getResource.mockResolvedValueOnce({
      '@id': `${publicURL}/resources/image-resource`,
      '@context': 'https://schema.org',
      '@type': 'ImageObject',
      name: 'Image with Annotations',
      encodingFormat: 'image/png',
    });

    const res = await app.request(`/resources/${targetResourceId}/referenced-by`, {
      headers: {
        'Authorization': `Bearer ${testToken}`,
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json() as GetReferencedByResponse;

    expect(data.referencedBy).toHaveLength(1);
    expect(data.referencedBy[0]?.resourceName).toBe('Image with Annotations');
    expect(data.referencedBy[0]?.target.selector?.exact).toBe(''); // No text for image annotations
  });

  it('should require authentication', async () => {
    const resourceId = 'test-resource-auth';

    const res = await app.request(`/resources/${resourceId}/referenced-by`);

    expect(res.status).toBe(401);
  });

  it('should correctly build resource map using @id not id', async () => {
    const targetResourceId = 'target-resource-5';
    const publicURL = 'http://localhost:4000';
    const sourceResourceURI = `${publicURL}/resources/source-resource-5`;

    // Mock Neo4j to return reference
    mockGraphDb.getResourceReferencedBy.mockResolvedValueOnce([
      {
        id: 'annotation-5',
        target: {
          type: 'SpecificResource',
          source: sourceResourceURI,
          selector: {
            type: 'TextQuoteSelector',
            exact: 'test text',
          },
        },
      },
    ]);

    // Mock Neo4j to return resource with @id (JSON-LD format)
    // Note: ResourceDescriptor uses @id, not id
    mockGraphDb.getResource.mockResolvedValueOnce({
      '@id': sourceResourceURI,
      '@context': 'https://schema.org',
      '@type': 'DigitalDocument',
      name: 'Correctly Mapped Resource',
      encodingFormat: 'text/plain',
    });

    const res = await app.request(`/resources/${targetResourceId}/referenced-by`, {
      headers: {
        'Authorization': `Bearer ${testToken}`,
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json() as GetReferencedByResponse;

    // Verify the resource name is correctly mapped using @id, not undefined
    expect(data.referencedBy[0]?.resourceName).toBe('Correctly Mapped Resource');
    expect(data.referencedBy[0]?.resourceName).not.toBe('Untitled Resource');
  });

  it('should filter incoming references by motivation type', async () => {
    const targetResourceId = 'target-resource-6';
    const publicURL = 'http://localhost:4000';

    // Mock Neo4j to return only linking annotations (not highlighting)
    // This simulates the label-based filtering in Neo4j
    mockGraphDb.getResourceReferencedBy.mockResolvedValueOnce([
      {
        id: 'annotation-linking',
        motivation: 'linking',
        target: {
          type: 'SpecificResource',
          source: `${publicURL}/resources/source-with-link`,
          selector: {
            type: 'TextQuoteSelector',
            exact: 'this is a link reference',
          },
        },
      },
    ]);

    // Mock Neo4j to return the source resource
    mockGraphDb.getResource.mockResolvedValueOnce({
      '@id': `${publicURL}/resources/source-with-link`,
      '@context': 'https://schema.org',
      '@type': 'DigitalDocument',
      name: 'Document with Link',
      encodingFormat: 'text/plain',
    });

    const res = await app.request(`/resources/${targetResourceId}/referenced-by?motivation=linking`, {
      headers: {
        'Authorization': `Bearer ${testToken}`,
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json() as GetReferencedByResponse;

    // Should only return linking annotations
    expect(data.referencedBy).toHaveLength(1);
    expect(data.referencedBy[0]?.id).toBe('annotation-linking');
    expect(data.referencedBy[0]?.resourceName).toBe('Document with Link');
  });
});
