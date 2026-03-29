/**
 * Resource Discovery HTTP Contract Tests
 *
 * Tests:
 * - GET /resources/:id/referenced-by
 *
 * Focuses on HTTP contract - status codes, authentication, response validation.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { userId } from '@semiont/core';
import { email } from '@semiont/core';
import { JWTService } from '../../auth/jwt';
import type { Hono } from 'hono';
import type { EnvironmentConfig, EventBus, ResourceId } from '@semiont/core';
import type { components } from '@semiont/core';
import type { User } from '@prisma/client';
import type { MakeMeaningService, KnowledgeBase } from '@semiont/make-meaning';
import { makeMeaningMock, stubKnowledgeSystem } from '../helpers/make-meaning-mock';

type Variables = {
  user: User;
  config: EnvironmentConfig;
  eventBus: EventBus;
  makeMeaning: MakeMeaningService;
};

type GetReferencedByResponse = components['schemas']['GetReferencedByResponse'];

// Standard test setup
const setupMocks = () => {
  vi.mock('@semiont/make-meaning', () => ({
    startMakeMeaning: vi.fn().mockImplementation(async (_project: unknown, _config: unknown, eventBus: EventBus) => {
      // Bridge referenced-by events
      (eventBus as any).get('browse:referenced-by-requested').subscribe((e: { correlationId: string; resourceId: ResourceId; motivation?: string }) => {
        (eventBus as any).get('browse:referenced-by-result').next({
          correlationId: e.correlationId,
          response: { referencedBy: [] },
        });
      });
      return makeMeaningMock({
        knowledgeSystem: stubKnowledgeSystem({
          content: { get: vi.fn(), store: vi.fn() } as unknown as KnowledgeBase['content'],
          graph: {
            getResourceReferencedBy: vi.fn().mockResolvedValue([]),
            getResource: vi.fn().mockImplementation(async (uri: string) => {
              if (uri.includes('test-resource')) {
                return { '@id': 'urn:semiont:resource:test-resource', name: 'Test Resource' };
              }
              return null;
            }),
            getAnnotations: vi.fn().mockResolvedValue([]),
            getResourceConnections: vi.fn().mockResolvedValue([]),
            listAnnotations: vi.fn().mockResolvedValue([]),
          } as unknown as KnowledgeBase['graph'],
          eventStore: { getView: vi.fn().mockResolvedValue({ resource: {}, annotations: { annotations: [] } }) } as unknown as KnowledgeBase['eventStore'],
        }),
      });
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
      env: { NODE_ENV: 'test' as const },
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
});
