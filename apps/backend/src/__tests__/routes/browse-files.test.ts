/**
 * Browse Files HTTP Contract Tests
 *
 * Tests the HTTP contract of GET /api/browse/files:
 * - Auth enforcement
 * - Valid responses (200)
 * - Error mapping: path escapes → 400, path not found → 404
 * - Query param pass-through (path, sort)
 *
 * Business logic (path validation, KB merge) is tested in packages/make-meaning.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { userId, email } from '@semiont/core';
import { JWTService } from '../../auth/jwt';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EnvironmentConfig, EventBus } from '@semiont/core';
import type { MakeMeaningService } from '@semiont/make-meaning';
import { makeMeaningMock, stubKnowledgeSystem } from '../helpers/make-meaning-mock';

type Variables = {
  user: User;
  config: EnvironmentConfig;
  eventBus: EventBus;
  makeMeaning: MakeMeaningService;
};

// ── @semiont/make-meaning mock ─────────────────────────────────────────────────

vi.mock('@semiont/make-meaning', () => ({
  startMakeMeaning: vi.fn().mockImplementation(async (_project: unknown, _config: unknown, eventBus: EventBus) => {
    eventBus.get('browse:directory-requested').subscribe((e: any) => {
      if (e.path === 'escape-test') {
        eventBus.get('browse:directory-failed').next({
          correlationId: e.correlationId,
          path: e.path,
          message: 'path escapes project root',
        });
      } else if (e.path === 'missing-dir') {
        eventBus.get('browse:directory-failed').next({
          correlationId: e.correlationId,
          path: e.path,
          message: 'path not found',
        });
      } else {
        eventBus.get('browse:directory-result').next({
          correlationId: e.correlationId,
          response: {
            path: e.path,
            entries: [
              { type: 'dir',  name: 'docs',     path: 'docs',     mtime: '2026-01-01T00:00:00Z' },
              { type: 'file', name: 'README.md', path: 'README.md', size: 512, mtime: '2026-01-02T00:00:00Z', tracked: false },
            ],
          },
        });
      }
    });

    return makeMeaningMock({ knowledgeSystem: stubKnowledgeSystem() });
  }),
}));

vi.mock('../../auth/oauth', () => ({
  OAuthService: { getUserFromToken: vi.fn() },
}));

// ── test suite ────────────────────────────────────────────────────────────────

describe('GET /api/browse/files', () => {
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
    // JWT_SECRET is set by setup.ts; initialize JWTService with the full config so
    // generateToken can find the jwtSecret via initialize() path used in other tests.
    const mockConfig: EnvironmentConfig = {
      site: { domain: 'test.local', oauthAllowedDomains: ['test.local'] },
      services: {
        backend: {
          publicURL: 'http://localhost:4000',
          platform: { type: 'posix' },
          port: 4000,
          corsOrigin: '*',
          jwtSecret: process.env.JWT_SECRET!,
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

    // Wire up the DB mock from setup.ts to recognise our test user
    const { DatabaseConnection } = await import('../../db');
    vi.mocked(DatabaseConnection.getClient().user.findUnique).mockResolvedValue(testUser as User);

    const { OAuthService } = await import('../../auth/oauth');
    vi.mocked(OAuthService.getUserFromToken).mockImplementation(async (token) =>
      token === authToken ? (testUser as User) : undefined!,
    );

    const { app: importedApp } = await import('../../index');
    app = importedApp;
  });

  it('returns 401 without authentication', async () => {
    const res = await app.request('/api/browse/files');
    expect(res.status).toBe(401);
  });

  it('returns 200 with entries for project root', async () => {
    const res = await app.request('/api/browse/files', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
  });

  it('passes path query param through to Browser', async () => {
    const res = await app.request('/api/browse/files?path=docs', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.path).toBe('docs');
  });

  it('passes sort query param through to Browser', async () => {
    const res = await app.request('/api/browse/files?sort=mtime', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid sort value', async () => {
    const res = await app.request('/api/browse/files?sort=invalid', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when path escapes project root', async () => {
    const res = await app.request('/api/browse/files?path=escape-test', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when directory does not exist', async () => {
    const res = await app.request('/api/browse/files?path=missing-dir', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(404);
  });
});
