/**
 * Annotation CRUD HTTP Contract Tests
 *
 * Tests the HTTP contract of annotation CRUD endpoints:
 * - GET /resources/:id/annotations (list)
 * - GET /resources/:id/annotation/:annotationId (get)
 * - PUT /resources/:id/annotation/:annotationId/body (update body)
 * - DELETE /resources/:id/annotation/:annotationId (delete)
 *
 * Focuses on status codes, W3C annotation format validation, authentication, and request/response validation.
 * Business logic is tested in package tests.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { userId } from '@semiont/core';
import { email } from '@semiont/api-client';
import { JWTService } from '../../auth/jwt';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EnvironmentConfig } from '@semiont/core';

type Variables = {
  user: User;
  config: EnvironmentConfig;
  makeMeaning: any;
};

// Mock @semiont/make-meaning
const mockEventStore = {
  append: vi.fn().mockResolvedValue(undefined),
  appendEvent: vi.fn().mockResolvedValue(undefined),
  getEvents: vi.fn().mockResolvedValue([]),
  query: vi.fn().mockResolvedValue([]),
  getView: vi.fn().mockResolvedValue({
    resource: {
      '@id': 'urn:semiont:resource:test-resource',
      name: 'Test Resource',
    },
    annotations: {
      version: 1,
      annotations: [{
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        'id': 'test-annotation',
        'motivation': 'highlighting',
        'target': { source: 'test-resource' },
        'body': [],
        'created': new Date().toISOString(),
        'modified': new Date().toISOString()
      }]
    }
  })
};

vi.mock('@semiont/make-meaning', () => ({
  ResourceContext: {
    getResourceMetadata: vi.fn().mockResolvedValue({
      '@context': 'https://www.w3.org/ns/activitystreams',
      '@id': 'urn:semiont:resource:test-resource',
      '@type': 'ResourceDescriptor',
      name: 'Test Resource',
    })
  },
  AnnotationContext: {
    buildLLMContext: vi.fn().mockResolvedValue({
    getAllAnnotations: vi.fn().mockResolvedValue([])
      sourceContext: null,
      targetContext: null
    })
  },
  startMakeMeaning: vi.fn().mockResolvedValue({
    eventStore: mockEventStore,
    repStore: { get: vi.fn(), store: vi.fn() },
    jobQueue: { createJob: vi.fn() },
    workers: [],
    graphConsumer: {}
  })
}));

// Mock database
vi.mock('../../db', () => ({
  DatabaseConnection: {
    getClient: vi.fn(() => ({
      user: {
        findUnique: vi.fn(),
      },
    })),
  },
}));

// Mock OAuth
vi.mock('../../auth/oauth', () => ({
  OAuthService: {
    getUserFromToken: vi.fn(),
  },
}));

describe('Annotation CRUD HTTP Contract', () => {
  let app: Hono<{ Variables: Variables }>;
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
    // Initialize JWTService
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

    // Create auth token
    const tokenPayload = {
      userId: userId(testUser.id),
      email: email(testUser.email),
      domain: testUser.domain,
      provider: testUser.provider,
      isAdmin: testUser.isAdmin,
      name: testUser.name || undefined,
    };
    authToken = JWTService.generateToken(tokenPayload);

    // Mock database user lookup
    const { DatabaseConnection } = await import('../../db');
    const prisma = DatabaseConnection.getClient();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(testUser as any);

    // Mock OAuth service
    const { OAuthService } = await import('../../auth/oauth');
    vi.mocked(OAuthService.getUserFromToken).mockImplementation(async (token) => {
      return token === authToken ? (testUser as any) : null;
    });

    // Import app after mocks are set up
    const { app: importedApp } = await import('../../index');
    app = importedApp;
  });

  describe('GET /resources/:id/annotations (list)', () => {
    it('should return 200 with W3C annotation collection', async () => {
      const response = await app.request('/resources/test-resource/annotations', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data).toHaveProperty('@context');
      expect(data).toHaveProperty('type');
      expect(data).toHaveProperty('items');
      expect(Array.isArray(data.items)).toBe(true);
    });

    it('should return 404 for non-existent resource', async () => {
      const { ResourceContext } = await import('@semiont/make-meaning');
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValueOnce(null);

      const response = await app.request('/resources/nonexistent/annotations', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(404);
    });

    it('should return 401 without authentication', async () => {
      const response = await app.request('/resources/test-resource/annotations', {
        method: 'GET',
      });

      expect(response.status).toBe(401);
    });

    it('should support pagination parameters', async () => {
      const response = await app.request('/resources/test-resource/annotations?limit=10&offset=0', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(200);
    });

    it('should filter by motivation parameter', async () => {
      const response = await app.request('/resources/test-resource/annotations?motivation=highlighting', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(200);
    });
  });

  describe('GET /resources/:id/annotation/:annotationId (get)', () => {
    it('should return 200 with W3C annotation', async () => {
      const response = await app.request('/resources/test-resource/annotation/test-annotation', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(200);
      const annotation = await response.json();
      expect(annotation).toHaveProperty('@context', 'http://www.w3.org/ns/anno.jsonld');
      expect(annotation).toHaveProperty('type', 'Annotation');
      expect(annotation).toHaveProperty('id');
      expect(annotation).toHaveProperty('motivation');
      expect(annotation).toHaveProperty('target');
    });

    it('should return 404 for non-existent annotation', async () => {
      vi.mocked(mockEventStore.getView).mockResolvedValueOnce({
        resource: { '@id': 'test-resource' },
        annotations: { version: 1, annotations: [] }
      });

      const response = await app.request('/resources/test-resource/annotation/nonexistent', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(404);
    });

    it('should return 404 for non-existent resource', async () => {
      const { ResourceContext } = await import('@semiont/make-meaning');
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValueOnce(null);

      const response = await app.request('/resources/nonexistent/annotation/test-annotation', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(404);
    });

    it('should return 401 without authentication', async () => {
      const response = await app.request('/resources/test-resource/annotation/test-annotation', {
        method: 'GET',
      });

      expect(response.status).toBe(401);
    });
  });

  describe('PUT /resources/:id/annotation/:annotationId/body (update)', () => {
    it('should return 200 on successful body update', async () => {
      const response = await app.request('/resources/test-resource/annotation/test-annotation/body', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          operations: [{
            op: 'add',
            item: {
              type: 'TextualBody',
              value: 'Person',
              purpose: 'tagging'
            }
          }]
        }),
      });

      expect(response.status).toBe(200);
    });

    it('should return 404 for non-existent annotation', async () => {
      vi.mocked(mockEventStore.getView).mockResolvedValueOnce({
        resource: { '@id': 'test-resource' },
        annotations: { version: 1, annotations: [] }
      });

      const response = await app.request('/resources/test-resource/annotation/nonexistent/body', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          operations: [{
            op: 'add',
            item: { type: 'TextualBody', value: 'test' }
          }]
        }),
      });

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid body structure', async () => {
      const response = await app.request('/resources/test-resource/annotation/test-annotation/body', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          invalidField: 'invalid'
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should return 401 without authentication', async () => {
      const response = await app.request('/resources/test-resource/annotation/test-annotation/body', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operations: []
        }),
      });

      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /resources/:id/annotation/:annotationId (delete)', () => {
    it('should return 204 on successful deletion', async () => {
      const response = await app.request('/resources/test-resource/annotation/test-annotation', {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(204);
    });

    it('should return 404 for non-existent annotation', async () => {
      vi.mocked(mockEventStore.getView).mockResolvedValueOnce({
        resource: { '@id': 'test-resource' },
        annotations: { version: 1, annotations: [] }
      });

      const response = await app.request('/resources/test-resource/annotation/nonexistent', {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(404);
    });

    it('should return 401 without authentication', async () => {
      const response = await app.request('/resources/test-resource/annotation/test-annotation', {
        method: 'DELETE',
      });

      expect(response.status).toBe(401);
    });
  });
});
