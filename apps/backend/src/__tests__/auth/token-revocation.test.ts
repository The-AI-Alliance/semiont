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

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

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
