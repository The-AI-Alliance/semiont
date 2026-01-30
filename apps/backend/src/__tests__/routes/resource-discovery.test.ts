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
import { userId, email } from '@semiont/api-client';
import { JWTService } from '../../auth/jwt';
import type { Hono } from 'hono';
import type { EnvironmentConfig } from '@semiont/core';

// Standard test setup
const setupMocks = () => {
  vi.mock('@semiont/make-meaning', () => ({
    ResourceContext: {
      getResourceMetadata: vi.fn().mockResolvedValue({
        '@id': 'urn:semiont:resource:test-resource',
        name: 'Test Resource',
      })
    },
    startMakeMeaning: vi.fn().mockResolvedValue({
      eventStore: { getView: vi.fn().mockResolvedValue({ resource: {}, annotations: { annotations: [] } }) },
      graphDb: {
        getResourceReferencedBy: vi.fn().mockResolvedValue([]),
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
  let app: Hono;
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
    vi.mocked(DatabaseConnection.getClient().user.findUnique).mockResolvedValue(testUser as any);

    const { OAuthService } = await import('../../auth/oauth');
    vi.mocked(OAuthService.getUserFromToken).mockImplementation(async (token) =>
      token === authToken ? (testUser as any) : null
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
      const data = await response.json();
      expect(data).toHaveProperty('referencedBy');
      expect(Array.isArray(data.referencedBy)).toBe(true);
    });

    it('should return 404 for non-existent resource', async () => {
      const { ResourceContext } = await import('@semiont/make-meaning');
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValueOnce(null);

      const response = await app.request('/resources/nonexistent/referenced-by', {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });

      expect(response.status).toBe(404);
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

  describe('POST /resources/:id/llm-context', () => {
    it('should return 200 with LLM context structure', async () => {
      const response = await app.request('/resources/test-resource/llm-context', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          includeAnnotations: true,
          includeBacklinks: false
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('mainResource');
    });

    it('should return 404 for non-existent resource', async () => {
      const { ResourceContext } = await import('@semiont/make-meaning');
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValueOnce(null);

      const response = await app.request('/resources/nonexistent/llm-context', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(404);
    });

    it('should return 401 without authentication', async () => {
      const response = await app.request('/resources/test-resource/llm-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(401);
    });
  });
});
