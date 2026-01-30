/**
 * Resource CRUD HTTP Contract Tests
 *
 * Tests the HTTP contract of resource CRUD endpoints:
 * - POST /resources (create)
 * - GET /resources (list)
 * - PUT /resources/:id (update)
 * - DELETE /resources/:id (delete)
 *
 * Focuses on status codes, headers, authentication, and request/response validation.
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
  getEvents: vi.fn().mockResolvedValue([]),
  query: vi.fn().mockResolvedValue([]),
};

const mockRepStore = {
  store: vi.fn().mockResolvedValue({ checksum: 'test-checksum' }),
  get: vi.fn().mockResolvedValue({ content: 'test content' }),
};

vi.mock('@semiont/make-meaning', () => ({
  ResourceContext: {
    getResourceMetadata: vi.fn().mockResolvedValue({
      '@context': 'https://www.w3.org/ns/activitystreams',
      '@id': 'urn:semiont:resource:test-resource',
      '@type': 'ResourceDescriptor',
      name: 'Test Resource',
      representations: [{
        mediaType: 'text/plain',
        rel: 'original',
        checksum: 'abc123'
      }]
    }),
    listResources: vi.fn().mockResolvedValue({
      resources: [],
      total: 0
    })
  },
  startMakeMeaning: vi.fn().mockResolvedValue({
    eventStore: mockEventStore,
    repStore: mockRepStore,
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

describe('Resource CRUD HTTP Contract', () => {
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

  describe('POST /resources (create)', () => {
    it('should return 201 with Location header on success', async () => {
      const response = await app.request('/resources', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: 'Test resource content',
          format: 'text/plain',
          name: 'Test Resource'
        }),
      });

      expect(response.status).toBe(201);
      expect(response.headers.get('Location')).toMatch(/^urn:semiont:resource:/);
    });

    it('should return 401 without authentication', async () => {
      const response = await app.request('/resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test content',
          format: 'text/plain'
        }),
      });

      expect(response.status).toBe(401);
    });

    it('should return 400 for missing required fields', async () => {
      const response = await app.request('/resources', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}), // Missing content and format
      });

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid content type', async () => {
      const response = await app.request('/resources', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: 'Test content',
          format: 'invalid/mime-type'
        }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /resources (list)', () => {
    it('should return 200 with resource list', async () => {
      const response = await app.request('/resources', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('resources');
      expect(Array.isArray(data.resources)).toBe(true);
    });

    it('should return 401 without authentication', async () => {
      const response = await app.request('/resources', {
        method: 'GET',
      });

      expect(response.status).toBe(401);
    });

    it('should support pagination parameters', async () => {
      const response = await app.request('/resources?limit=10&offset=0', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(200);
    });

    it('should support filtering by archived status', async () => {
      const response = await app.request('/resources?archived=false', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(200);
    });
  });

  describe('PATCH /resources/:id (update)', () => {
    it('should return 200 on successful update', async () => {
      const response = await app.request('/resources/test-resource', {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Updated Resource Name'
        }),
      });

      expect(response.status).toBe(200);
    });

    it('should return 404 for non-existent resource', async () => {
      const { ResourceContext } = await import('@semiont/make-meaning');
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValueOnce(null);

      const response = await app.request('/resources/nonexistent', {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Updated Name'
        }),
      });

      expect(response.status).toBe(404);
    });

    it('should return 401 without authentication', async () => {
      const response = await app.request('/resources/test-resource', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Updated Name'
        }),
      });

      expect(response.status).toBe(401);
    });

    it('should support archiving via PATCH', async () => {
      const response = await app.request('/resources/test-resource', {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          archived: true
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.resource.archived).toBe(true);
    });
  });
});
