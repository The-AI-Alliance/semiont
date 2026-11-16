/**
 * GET /api/admin/oauth/config reads its allowed domains from CONFIG, not the
 * environment.
 *
 * It used to parse an OAUTH_ALLOWED_DOMAINS env var and throw when it was
 * absent — a second source of truth for a fact `site.oauthAllowedDomains`
 * already owns and JWTService already validates at startup. The retired CLI set
 * that var, so the split was invisible; once the CLI went, nothing supplied it
 * and the endpoint 500'd for every admin who opened it.
 *
 * The request has to be an AUTHENTICATED ADMIN one: the route is admin-gated, so
 * an unauthenticated call 401s in middleware and never reaches the handler body
 * where the throw lived. A test that only checks "not 500" while unauthenticated
 * passes no matter what the handler does.
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
  return { ...actual, startMakeMeaning: vi.fn().mockResolvedValue(makeMeaningMock()) };
});

import { app } from '../../index';
import { DatabaseConnection } from '../../db';
import { JWTService } from '../../auth/jwt';
import type { User } from '@prisma/client';
import { faker } from '@faker-js/faker';
import { email as makeEmail, userId as makeUserId } from '@semiont/core';

const prisma = DatabaseConnection.getClient();
const mockPrismaUser = vi.mocked(prisma.user);

const CONFIGURED = ['example.com', 'partner.org'];

function adminUser(): User {
  return {
    id: `c${faker.string.alphanumeric(24).toLowerCase()}`,
    email: 'admin@example.com',
    name: 'Admin',
    image: null,
    domain: 'example.com',
    provider: 'google',
    providerId: 'google-admin-1',
    passwordHash: null,
    isAdmin: true,
    isActive: true,
    isModerator: false,
    termsAcceptedAt: null,
    lastLogin: null,
    tokenVersion: 0,
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
    tokenVersion: user.tokenVersion,
  }, '10m');
}

describe('GET /api/admin/oauth/config — source of the allowed domains', () => {
  let savedEnv: string | undefined;

  beforeAll(() => {
    JWTService.initialize({
      site: { domain: 'test.local', oauthAllowedDomains: CONFIGURED },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = process.env.OAUTH_ALLOWED_DOMAINS;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OAUTH_ALLOWED_DOMAINS;
    else process.env.OAUTH_ALLOWED_DOMAINS = savedEnv;
  });

  async function fetchAsAdmin() {
    const user = adminUser();
    mockPrismaUser.findUnique.mockResolvedValue(user);
    return app.request('/api/admin/oauth/config', {
      headers: { Authorization: `Bearer ${mintToken(user)}` },
    });
  }

  it('serves the configured domains with OAUTH_ALLOWED_DOMAINS unset', async () => {
    delete process.env.OAUTH_ALLOWED_DOMAINS;
    const res = await fetchAsAdmin();
    expect(res.status).toBe(200);
    const body = await res.json() as { allowedDomains: string[] };
    expect(body.allowedDomains).toEqual(CONFIGURED);
  });

  it('ignores OAUTH_ALLOWED_DOMAINS when it disagrees with the config', async () => {
    process.env.OAUTH_ALLOWED_DOMAINS = 'ignored-and-wrong.example';
    const res = await fetchAsAdmin();
    expect(res.status).toBe(200);
    const body = await res.json() as { allowedDomains: string[] };
    expect(body.allowedDomains).toEqual(CONFIGURED);
    expect(body.allowedDomains).not.toContain('ignored-and-wrong.example');
  });

  it('exposes the configured domains through a single accessor', () => {
    delete process.env.OAUTH_ALLOWED_DOMAINS;
    expect(JWTService.getAllowedDomains()).toEqual(CONFIGURED);
  });
});
