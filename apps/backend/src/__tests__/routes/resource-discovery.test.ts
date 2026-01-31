/**
 * Resource Discovery HTTP Contract Tests
 *
 * Tests:
 * - GET /resources/:id/referenced-by
 * - POST /resources/:id/llm-context
 *
 * Focuses on HTTP contract - status codes, authentication, response validation.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { userId } from '@semiont/core';
import { email } from '@semiont/api-client';
import { JWTService } from '../../auth/jwt';
import type { EnvironmentConfig } from '@semiont/core';
import type { components } from '@semiont/api-client';
import type { User } from '@prisma/client';

type GetReferencedByResponse = components['schemas']['GetReferencedByResponse'];

// Standard test setup
const setupMocks = () => {
  vi.mock('@semiont/make-meaning', () => ({
    ResourceContext: {
      getResourceMetadata: vi.fn().mockResolvedValue({
        '@id': 'urn:semiont:resource:test-resource',
        name: 'Test Resource',
      })
    },
    AnnotationContext: {
      buildLLMContext: vi.fn().mockResolvedValue({
        sourceContext: { content: 'test', annotations: [] },
        targetContext: null
      }),
      getAnnotation: vi.fn().mockResolvedValue({
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        id: 'http://localhost:4000/annotations/test-annotation',
        type: 'Annotation',
        body: [],
        target: { source: 'urn:semiont:resource:test-resource' }
      })
    },
    startMakeMeaning: vi.fn().mockResolvedValue({
      eventStore: { getView: vi.fn().mockResolvedValue({ resource: {}, annotations: { annotations: [] } }) },
      graphDb: {
        getResourceReferencedBy: vi.fn().mockResolvedValue([]),
        getResource: vi.fn().mockImplementation(async (uri: string) => {
          // Return resource for test-resource, null for others
          if (uri.includes('test-resource')) {
            return {
              '@id': 'urn:semiont:resource:test-resource',
              name: 'Test Resource',
            };
          }
          return null;
        }),
        getAnnotations: vi.fn().mockResolvedValue([]),
        getResourceConnections: vi.fn().mockResolvedValue([]),
        listAnnotations: vi.fn().mockResolvedValue([]),
      },
      repStore: { get: vi.fn(), store: vi.fn() },
      jobQueue: { createJob: vi.fn() },
      workers: [],
      graphConsumer: {}
    })
  }));

  vi.mock('../../db', () => ({
    DatabaseConnection: {
      getClient: vi.fn(() => ({ user: { findUnique: vi.fn() } })),
    },
  }));

  vi.mock('../../auth/oauth', () => ({
    OAuthService: { getUserFromToken: vi.fn() },
  }));
};

setupMocks();

describe('Resource Discovery HTTP Contract', () => {
  let app: any; // Use any to avoid Hono type complexity in tests
  let authToken: string;
  const testUser = {
    id: 'test-user-id',
    email: 'test@test.local',
    domain: 'test.local',
    provider: 'oauth',
    isAdmin: false,
    name: 'Test User',
  };

  beforeAll(async () => {
    const mockConfig: EnvironmentConfig = {
      site: {
        domain: 'test.local',
        oauthAllowedDomains: ['test.local'],
      },
      services: {
        backend: {
          publicURL: 'http://localhost:4000',
          platform: { type: 'posix' },
          port: 4000,
          corsOrigin: '*',
          jwtSecret: 'test-secret-key-at-least-32-characters-long',
        },
      },
    } as EnvironmentConfig;
    JWTService.initialize(mockConfig);

    authToken = JWTService.generateToken({
      userId: userId(testUser.id),
      email: email(testUser.email),
      domain: testUser.domain,
      provider: testUser.provider,
      isAdmin: testUser.isAdmin,
      name: testUser.name,
    });

    const { DatabaseConnection } = await import('../../db');
    vi.mocked(DatabaseConnection.getClient().user.findUnique).mockResolvedValue(testUser as User);

    const { OAuthService } = await import('../../auth/oauth');
    vi.mocked(OAuthService.getUserFromToken).mockImplementation(async (token) =>
      token === authToken ? (testUser as User) : undefined!
    );

    const { app: importedApp } = await import('../../index');
    app = importedApp;
  });

  describe('GET /resources/:id/referenced-by', () => {
    it('should return 200 with reference list', async () => {
      const response = await app.request('/resources/test-resource/referenced-by', {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });

      expect(response.status).toBe(200);
      const data = await response.json() as GetReferencedByResponse;
      expect(data).toHaveProperty('referencedBy');
      expect(Array.isArray(data.referencedBy)).toBe(true);
    });

    it('should return 200 with empty list for non-existent resource', async () => {
      const response = await app.request('/resources/nonexistent/referenced-by', {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });

      // Route doesn't validate resource existence, returns empty list
      expect(response.status).toBe(200);
    });

    it('should return 401 without authentication', async () => {
      const response = await app.request('/resources/test-resource/referenced-by');
      expect(response.status).toBe(401);
    });

    it('should filter by motivation parameter', async () => {
      const response = await app.request('/resources/test-resource/referenced-by?motivation=linking', {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });

      expect(response.status).toBe(200);
    });
  });

  describe('GET /resources/:id/llm-context', () => {
    it('should return 200 with LLM context structure', async () => {
      const response = await app.request('/resources/test-resource/llm-context', {
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('mainResource');
    });

    it('should return 404 for non-existent resource', async () => {
      // The route will get 404 because LLMContextService.getResourceLLMContext throws "Resource not found"
      // when graphDb.getResource returns null, which is the default mock behavior for non-test-resource IDs
      const response = await app.request('/resources/nonexistent/llm-context', {
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(404);
    });

    it('should return 401 without authentication', async () => {
      const response = await app.request('/resources/test-resource/llm-context');

      expect(response.status).toBe(401);
    });
  });
});
