/**
 * SDK-AUTH-CORS Phase 2 — revocable sessions (RED-first).
 *
 * Per-user revocation epoch: every token carries the user's `tokenVersion` at
 * mint; logout bumps `User.tokenVersion`, so a token whose `tokenVersion` is
 * behind the user's current value is rejected. These pin the behavior that
 * makes logout *mean something* — RED on `main` today (no epoch check; logout
 * only deletes a cookie and returns 200), GREEN once Phase 2's enforcement
 * lands. Prisma is mocked (same harness as auth-integration), so the tests
 * simulate the post-logout state by returning a bumped user from findUnique.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// The real @semiont/make-meaning (pulled in by the mock's importOriginal below)
// transitively loads pdfjs-dist, which references DOMMatrix at module load. The
// node test environment has no DOM, so stub the few globals pdfjs touches —
// during the hoist phase, before the make-meaning mock factory runs. (The full
// suite limps past this on thread-shared state; this makes the file runnable in
// isolation.)
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
import type { User } from '@prisma/client';
import { faker } from '@faker-js/faker';
import { email as makeEmail, userId as makeUserId } from '@semiont/core';

const prisma = DatabaseConnection.getClient();
const mockPrismaUser = vi.mocked(prisma.user);

const makeCuid = () => `c${faker.string.alphanumeric(24).toLowerCase()}`;

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: makeCuid(),
    email: 'revoke@example.com',
    name: 'Revoke User',
    image: null,
    domain: 'example.com',
    provider: 'google',
    providerId: 'google-revoke-1',
    passwordHash: null,
    isAdmin: false,
    isActive: true,
    isModerator: false,
    termsAcceptedAt: null,
    lastLogin: null,
    tokenVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mintToken(user: User, tokenVersion: number, ttl = '1h') {
  return JWTService.generateToken({
    userId: makeUserId(user.id),
    email: makeEmail(user.email),
    domain: user.domain,
    provider: user.provider,
    isAdmin: user.isAdmin,
    tokenVersion,
  }, ttl);
}

describe('SDK-AUTH-CORS Phase 2 — per-user token revocation', () => {
  beforeAll(() => {
    JWTService.initialize({
      site: { domain: 'test.local', oauthAllowedDomains: ['test.local', 'example.com'] },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an access token whose tokenVersion is behind the user (post-logout) → 401', async () => {
    // The user's current epoch is 1 (a logout bumped it); this token was minted at 0.
    const user = fakeUser({ tokenVersion: 1 });
    mockPrismaUser.findUnique.mockResolvedValue(user);
    const staleToken = mintToken(user, 0);

    const res = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${staleToken}` },
    });
    expect(res.status).toBe(401);
  });

  it('refuses to refresh with a refresh token whose tokenVersion is stale → 401', async () => {
    const user = fakeUser({ tokenVersion: 1 });
    mockPrismaUser.findUnique.mockResolvedValue(user);
    const staleRefresh = mintToken(user, 0, '30d');

    const res = await app.request('/api/tokens/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: staleRefresh }),
    });
    expect(res.status).toBe(401);
  });

  it('logout bumps tokenVersion (revokes all this user\'s tokens) and returns 204', async () => {
    const user = fakeUser({ tokenVersion: 0 });
    mockPrismaUser.findUnique.mockResolvedValue(user);
    mockPrismaUser.update.mockResolvedValue({ ...user, tokenVersion: 1 });
    const token = mintToken(user, 0);

    const res = await app.request('/api/users/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(204);
    expect(mockPrismaUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: user.id },
        data: { tokenVersion: { increment: 1 } },
      }),
    );
  });

  it('still accepts a token whose tokenVersion matches the user (regression guard)', async () => {
    const user = fakeUser({ tokenVersion: 2 });
    mockPrismaUser.findUnique.mockResolvedValue(user);
    const goodToken = mintToken(user, 2);

    const res = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${goodToken}` },
    });
    expect(res.status).toBe(200);
  });
});

/**
 * JWT-SECRET-ROTATION Half B — where the key ring meets the revocation epoch.
 *
 * The ring WIDENS which signatures verify (during a rotation window); the epoch
 * NARROWS which tokens are accepted (after a logout). They compose, and the
 * epoch must always win — a rotation is not an amnesty. Unit coverage of the
 * ring itself lives in `jwt-rotation.test.ts`; these two go through the real
 * `POST /api/tokens/refresh` because the grace path only matters end-to-end.
 */
describe('JWT-SECRET-ROTATION — refresh across a secret rotation', () => {
  const OLD_SECRET = 'previous-secret-aaaaaaaaaaaaaaaaaaaaaaaa';
  const NEW_SECRET = 'current-secret-bbbbbbbbbbbbbbbbbbbbbbbbb';
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.JWT_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  it('refreshes a token signed under the PREVIOUS secret and re-mints under the current one', async () => {
    const user = fakeUser({ tokenVersion: 0 });
    mockPrismaUser.findUnique.mockResolvedValue(user);

    // Minted before the rotation...
    process.env.JWT_SECRET = OLD_SECRET;
    const refreshToken = mintToken(user, 0, '30d');

    // ...and presented after it, with the old secret still in the ring.
    process.env.JWT_SECRET = `${NEW_SECRET},${OLD_SECRET}`;
    const res = await app.request('/api/tokens/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { access_token: string };

    // The session heals: the new access token is signed with the CURRENT secret,
    // so dropping the old one after the window retires it cleanly.
    expect(() => jwt.verify(body.access_token, NEW_SECRET)).not.toThrow();
    expect(() => jwt.verify(body.access_token, OLD_SECRET)).toThrow();
  });

  it('the revocation epoch still wins over the grace path → 401', async () => {
    // Signed under a ring member, but revoked: the user's epoch has moved on.
    const user = fakeUser({ tokenVersion: 1 });
    mockPrismaUser.findUnique.mockResolvedValue(user);

    process.env.JWT_SECRET = OLD_SECRET;
    const staleRefresh = mintToken(user, 0, '30d');

    process.env.JWT_SECRET = `${NEW_SECRET},${OLD_SECRET}`;
    const res = await app.request('/api/tokens/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: staleRefresh }),
    });

    expect(res.status).toBe(401);
  });
});
