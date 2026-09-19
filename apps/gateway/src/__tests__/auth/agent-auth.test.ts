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
    startMakeMeaningGateway: vi.fn().mockResolvedValue(makeMeaningMock())
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
    isAdmin: false,
    isModerator: false,
    lastLogin: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('POST /api/tokens/agent', () => {
  beforeAll(() => {
    JWTService.initialize({
      site: { domain: SITE_DOMAIN },
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

    /**
     * An agent token is the one credential here with no revocation behind it:
     * the account is synthetic, so there is nothing at the issuer to disable,
     * and rotating the shared secret stops new mints without touching tokens
     * already handed out. Its lifetime IS the revocation window, so this
     * bounds it. It was a day.
     *
     * The bound is asserted on the token's own `exp` claim because that claim
     * is what every holder schedules its re-authentication from — sidecars via
     * `startAgentSession`, workers via `SemiontSession`. Nothing restates the
     * number, so this is the only place it can be checked.
     */
    it('signs a lifetime short enough to serve as the revocation window', async () => {
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

      expect(payload.exp).toBeDefined();
      expect(payload.iat).toBeDefined();
      expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60 * 60);
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
      expect(payload.did).toBe('did:web:test.local:agents:ollama:gemma2%3A27b');
    });

    /**
     * No row is written any more, so the synthetic address is asserted where it
     * actually matters: inside the minted token. That is the copy every later
     * request validates, and an address that fails `email()` there breaks every
     * `/bus/subscribe` the worker makes — the regression this guards.
     */
    it('places the synthetic email in the agents.<host> namespace, not the deployment domain', async () => {
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
      expect(payload.email.endsWith(`@agents.${SITE_DOMAIN}`)).toBe(true);
    });

    it('strips the port from a host:port deployment domain when forming the synthetic email', async () => {
      // The DID format keeps the port (DIDs accept colons), but the synthetic
      // address must match RFC-5321 host syntax — so a deployment served at
      // `localhost:8080` produces `slug@agents.localhost`, not
      // `slug@agents.localhost:8080`.
      JWTService.setTestConfig('localhost:8080');
      try {
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
        expect(payload.email).not.toContain(':');
        expect(payload.email.endsWith('@agents.localhost')).toBe(true);
      } finally {
        // Restored even on failure: leaking this domain fails every later test
        // in the file for a reason that names the wrong culprit.
        JWTService.setTestConfig(SITE_DOMAIN);
      }
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

    it('returns 503 when SEMIONT_WORKER_SECRET is not configured on the gateway', async () => {
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
