/**
 * GET /api/admin/oauth/config reports the issuer this knowledge base trusts.
 *
 * It reads the configured verifier — the same object the middleware checks
 * every token against — rather than a second copy of the configuration, so an
 * administrator reading this page is reading what actually gates sign-in. The
 * endpoint used to report an email-domain allowlist, which no longer decides
 * anything now that the issuer does.
 *
 * The request has to be an AUTHENTICATED ADMIN one: the route is admin-gated, so
 * an unauthenticated call 401s in middleware and never reaches the handler body.
 * A test that only checks "not 500" while unauthenticated passes no matter what
 * the handler does.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// pdfjs (via the make-meaning mock's importOriginal) needs DOMMatrix at module
// load; stub it in the hoist phase so this file runs in isolation.
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.DOMMatrix ??= class {};
  g.ImageData ??= class {};
  g.Path2D ??= class {};
});

import { makeMeaningMock } from '../helpers/make-meaning-mock';

vi.mock('@semiont/make-meaning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/make-meaning')>();
  return { ...actual, startMakeMeaningGateway: vi.fn().mockResolvedValue(makeMeaningMock()) };
});

import { app } from '../../index';
import { DatabaseConnection } from '../../db';
import { JWTService } from '../../auth/jwt';
import { configureTrustedIssuer } from '../../identity/trusted-issuer';
import type { User } from '@prisma/client';
import { faker } from '@faker-js/faker';
import { email as makeEmail, userId as makeUserId } from '@semiont/core';

const prisma = DatabaseConnection.getClient();
const mockPrismaUser = vi.mocked(prisma.user);

const ISSUER = 'https://issuer.test/realms/semiont';
const AUDIENCE = 'semiont-gateway';

function adminUser(): User {
  return {
    id: `c${faker.string.alphanumeric(24).toLowerCase()}`,
    email: 'admin@example.com',
    name: 'Admin',
    image: null,
    domain: 'example.com',
    provider: ISSUER,
    providerId: 'issuer-admin-1',
    isAdmin: true,
    isActive: true,
    isModerator: false,
    lastLogin: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function mintToken(user: User) {
  return JWTService.generateToken({
    userId: makeUserId(user.id),
    email: makeEmail(user.email),
    domain: user.domain,
    provider: user.provider,
    isAdmin: user.isAdmin,
  }, '10m');
}

describe('GET /api/admin/oauth/config — the issuer this knowledge base trusts', () => {
  beforeAll(() => {
    JWTService.initialize({ site: { domain: 'test.local' } });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    configureTrustedIssuer({ type: 'keycloak', issuer: ISSUER, audience: AUDIENCE });
  });

  afterEach(() => {
    configureTrustedIssuer(undefined);
  });

  async function fetchAsAdmin() {
    const user = adminUser();
    mockPrismaUser.findUnique.mockResolvedValue(user);
    return app.request('/api/admin/oauth/config', {
      headers: { Authorization: `Bearer ${mintToken(user)}` },
    });
  }

  it('reports the configured issuer and the audience it requires', async () => {
    const res = await fetchAsAdmin();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuer: ISSUER, audience: AUDIENCE });
  });

  it('reports nulls when the knowledge base trusts no issuer', async () => {
    configureTrustedIssuer(undefined);

    const res = await fetchAsAdmin();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuer: null, audience: null });
  });

  it('refuses an unauthenticated request', async () => {
    const res = await app.request('/api/admin/oauth/config');

    expect(res.status).toBe(401);
  });
});
