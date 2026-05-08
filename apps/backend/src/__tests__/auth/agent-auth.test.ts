/**
 * Tests for `/api/tokens/agent` — software-agent token exchange.
 *
 * The endpoint takes (secret, provider, model) and issues a JWT whose
 * `agentDid` field carries the agent's identity (so the bus stamps the
 * agent on `_userId`, not the synthetic User row backing the token).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

import { makeMeaningMock } from '../helpers/make-meaning-mock';

vi.mock('@semiont/make-meaning', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    startMakeMeaning: vi.fn().mockResolvedValue(makeMeaningMock())
  };
});

import { app } from '../../index';
import { DatabaseConnection } from '../../db';
import { JWTService } from '../../auth/jwt';
import { User } from '@prisma/client';
import { faker } from '@faker-js/faker';
import type { components } from '@semiont/core';

type ErrorResponse = components['schemas']['ErrorResponse'];

const prisma = DatabaseConnection.getClient();
const mockPrismaUser = vi.mocked(prisma.user);

const SITE_DOMAIN = 'test.local';
const WORKER_SECRET = 'test-worker-secret';

// JWTPayloadSchema requires CUID format: /^c[a-z0-9]{24,}$/
function makeCuid(): string {
  return `c${faker.string.alphanumeric(24).toLowerCase()}`;
}

function makeAgentUser(overrides: Partial<User> = {}): User {
  return {
    id: makeCuid(),
    email: 'ollama-gemma2-27b@agents.test.local',
    name: 'ollama gemma2:27b',
    image: null,
    domain: SITE_DOMAIN,
    provider: 'agent',
    providerId: 'ollama:gemma2:27b',
    passwordHash: null,
    isAdmin: false,
    isActive: true,
    isModerator: false,
    termsAcceptedAt: null,
    lastLogin: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('POST /api/tokens/agent', () => {
  beforeAll(() => {
    JWTService.initialize({
      site: { domain: SITE_DOMAIN, oauthAllowedDomains: [SITE_DOMAIN] },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SEMIONT_WORKER_SECRET = WORKER_SECRET;
  });

  describe('successful exchange', () => {
    it('issues a JWT and returns the agent DID for valid (provider, model)', async () => {
      const mockUser = makeAgentUser();
      mockPrismaUser.upsert.mockResolvedValue(mockUser);

      const response = await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: WORKER_SECRET,
          provider: 'ollama',
          model: 'gemma2:27b',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json() as { token: string; did: string };

      expect(data.did).toBe('did:web:test.local:agents:ollama:gemma2%3A27b');
      expect(typeof data.token).toBe('string');
      expect(data.token.split('.')).toHaveLength(3);
    });

    it('JWT carries the agent DID in `agentDid` so the bus uses it as `_userId`', async () => {
      mockPrismaUser.upsert.mockResolvedValue(makeAgentUser());

      const response = await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: WORKER_SECRET,
          provider: 'ollama',
          model: 'gemma2:27b',
        }),
      });

      const { token } = await response.json() as { token: string };
      const payload = JWTService.verifyToken(token as never);
      expect(payload.agentDid).toBe('did:web:test.local:agents:ollama:gemma2%3A27b');
    });

    it('upserts the agent User row keyed by (provider="agent", providerId)', async () => {
      mockPrismaUser.upsert.mockResolvedValue(makeAgentUser());

      await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: WORKER_SECRET,
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
        }),
      });

      expect(mockPrismaUser.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { provider_providerId: { provider: 'agent', providerId: 'anthropic:claude-3-5-sonnet' } },
        create: expect.objectContaining({
          provider: 'agent',
          providerId: 'anthropic:claude-3-5-sonnet',
          domain: SITE_DOMAIN,
          isActive: true,
          isAdmin: false,
        }),
      }));
    });

    it('places the synthetic email in the agents.<host> namespace, not the deployment domain', async () => {
      mockPrismaUser.upsert.mockResolvedValue(makeAgentUser());

      await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: WORKER_SECRET,
          provider: 'ollama',
          model: 'gemma2:27b',
        }),
      });

      const call = mockPrismaUser.upsert.mock.calls[0]![0] as { create: { email: string } };
      expect(call.create.email.endsWith(`@agents.${SITE_DOMAIN}`)).toBe(true);
    });

    it('URI-encodes models containing colons in the DID', async () => {
      mockPrismaUser.upsert.mockResolvedValue(makeAgentUser());

      const response = await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: WORKER_SECRET,
          provider: 'ollama',
          model: 'gemma2:27b',
        }),
      });

      const { did } = await response.json() as { did: string };
      // Colon in `gemma2:27b` must be %3A so DID parsing isn't ambiguous
      expect(did).toBe('did:web:test.local:agents:ollama:gemma2%3A27b');
    });
  });

  describe('rejected requests', () => {
    it('returns 401 for the wrong secret', async () => {
      const response = await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: 'wrong-secret',
          provider: 'ollama',
          model: 'gemma2:27b',
        }),
      });

      expect(response.status).toBe(401);
      expect(mockPrismaUser.upsert).not.toHaveBeenCalled();
    });

    it('returns 400 when `provider` is missing', async () => {
      const response = await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: WORKER_SECRET,
          model: 'gemma2:27b',
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json() as ErrorResponse;
      expect(String(data.error)).toMatch(/provider/i);
    });

    it('returns 400 when `model` is missing', async () => {
      const response = await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: WORKER_SECRET,
          provider: 'ollama',
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json() as ErrorResponse;
      expect(String(data.error)).toMatch(/model/i);
    });

    it('returns 400 for malformed JSON', async () => {
      const response = await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });

      expect(response.status).toBe(400);
    });

    it('returns 503 when SEMIONT_WORKER_SECRET is not configured on the backend', async () => {
      delete process.env.SEMIONT_WORKER_SECRET;

      const response = await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: 'anything',
          provider: 'ollama',
          model: 'gemma2:27b',
        }),
      });

      expect(response.status).toBe(503);
    });
  });
});
