/**
 * Participant Routes HTTP Contract Tests
 *
 * Tests the HTTP contract of participant endpoints:
 * - POST /api/participants/:id/attention (beckon)
 * - GET  /api/participants/me/attention-stream (SSE)
 *
 * Focuses on status codes, authentication, request validation, and response shape.
 * Channel lifecycle and signal delivery are tested via attention-channels.test.ts.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { userId, email } from '@semiont/core';
import { JWTService } from '../../auth/jwt';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EnvironmentConfig, EventBus, EventMap } from '@semiont/core';
import type { MakeMeaningService } from '@semiont/make-meaning';
import type { JobQueue } from '@semiont/jobs';
import { makeMeaningMock } from '../helpers/make-meaning-mock';

type Variables = {
  user: User;
  config: EnvironmentConfig;
  eventBus: EventBus;
  makeMeaning: MakeMeaningService;
};

vi.mock('@semiont/make-meaning', () => ({
  ResourceContext: {
    getResourceMetadata: vi.fn().mockResolvedValue(null),
  },
  AnnotationContext: {
    buildLLMContext: vi.fn(),
    getAllAnnotations: vi.fn().mockResolvedValue([]),
  },
  startMakeMeaning: vi.fn().mockResolvedValue(makeMeaningMock({ jobQueue: { createJob: vi.fn() } as unknown as JobQueue })),
}));

vi.mock('../../db', () => ({
  DatabaseConnection: {
    getClient: vi.fn(() => ({
      user: { findUnique: vi.fn() },
    })),
  },
}));

vi.mock('../../auth/oauth', () => ({
  OAuthService: {
    getUserFromToken: vi.fn(),
  },
}));

describe('Participant Routes', () => {
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
    const prisma = DatabaseConnection.getClient();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(testUser as User);

    const { OAuthService } = await import('../../auth/oauth');
    vi.mocked(OAuthService.getUserFromToken).mockImplementation(async (token) =>
      token === authToken ? (testUser as User) : undefined!
    );

    const { app: importedApp } = await import('../../index');
    app = importedApp;
  });

  // =========================================================================
  // POST /api/participants/:id/attention  (beckon)
  // =========================================================================

  describe('POST /api/participants/:id/attention', () => {
    afterEach(async () => {
      // Remove any channel created during the test to avoid cross-test leakage
      const { removeChannel } = await import('../../routes/participants/attention-channels');
      removeChannel(testUser.id);
    });

    it('should accept a beckon with resourceId only', async () => {
      const response = await app.request(`/api/participants/${testUser.id}/attention`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ resourceId: 'urn:semiont:resource:doc-1' }),
      });

      expect(response.status).toBe(202);
      const body = await response.json() as any;
      expect(body.participant).toBe(testUser.id);
      expect(body.resourceId).toBeDefined();
    });

    it('should accept a beckon with resourceId and annotationId', async () => {
      const response = await app.request(`/api/participants/${testUser.id}/attention`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          resourceId: 'urn:semiont:resource:doc-1',
          annotationId: 'urn:semiont:annotation:ann-1',
        }),
      });

      expect(response.status).toBe(202);
      const body = await response.json() as any;
      expect(body.annotationId).toBe('urn:semiont:annotation:ann-1');
    });

    it('should omit annotationId from response when not provided', async () => {
      const response = await app.request(`/api/participants/${testUser.id}/attention`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ resourceId: 'urn:semiont:resource:doc-1' }),
      });

      expect(response.status).toBe(202);
      const body = await response.json() as any;
      expect(body.annotationId).toBeUndefined();
    });

    it('should reject a beckon missing resourceId', async () => {
      const response = await app.request(`/api/participants/${testUser.id}/attention`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });

    it('should require authentication', async () => {
      const response = await app.request(`/api/participants/${testUser.id}/attention`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId: 'urn:semiont:resource:doc-1' }),
      });

      expect(response.status).toBe(401);
    });

    it('should push the signal to the participant channel', async () => {
      const { getOrCreateChannel, removeChannel } = await import(
        '../../routes/participants/attention-channels'
      );
      const channel = getOrCreateChannel(testUser.id);
      const received: Array<EventMap['beckon:focus']> = [];
      const sub = channel.subscribe((s) => received.push(s));

      await app.request(`/api/participants/${testUser.id}/attention`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ resourceId: 'urn:semiont:resource:doc-1' }),
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.resourceId).toBe('urn:semiont:resource:doc-1');

      sub.unsubscribe();
      removeChannel(testUser.id);
    });
  });

  // =========================================================================
  // GET /api/participants/me/attention-stream  (SSE)
  // =========================================================================

  describe('GET /api/participants/me/attention-stream', () => {
    it('should return SSE content-type', async () => {
      const response = await app.request('/api/participants/me/attention-stream', {
        method: 'GET',
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    });

    it('should return 200', async () => {
      const response = await app.request('/api/participants/me/attention-stream', {
        method: 'GET',
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(response.status).toBe(200);
    });

    it('should require authentication', async () => {
      const response = await app.request('/api/participants/me/attention-stream', {
        method: 'GET',
      });

      expect(response.status).toBe(401);
    });

    it('should emit a stream-connected event on open', async () => {
      const response = await app.request('/api/participants/me/attention-stream', {
        method: 'GET',
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(response.status).toBe(200);
      expect(response.body).not.toBeNull();

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Read enough chunks to find the connected event
      for (let i = 0; i < 5; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('stream-connected')) break;
      }

      reader.cancel();
      expect(buffer).toContain('stream-connected');
    });
  });
});
