/**
 * SDK-AUTH-CORS Phase 3 — bearer-only (RED-first).
 *
 * The `semiont-token` cookie is removed: login sets no Set-Cookie, and the
 * middleware authenticates by `Authorization: Bearer` (and the `?token=`
 * media path) only — a request carrying just the cookie is rejected. RED on
 * `main` today (login sets the cookie; the middleware honors it), GREEN once
 * Phase 3 lands.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// pdfjs (pulled in transitively by the make-meaning mock's importOriginal)
// references DOMMatrix at module load; the node env lacks it. Stub it in the
// hoist phase so this file runs in isolation.
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
import { JWTService } from '../../auth/jwt';
import type { Principal } from '../../identity/principal';
import { email as makeEmail } from '@semiont/core';

function fakeUser(overrides: Partial<Principal> = {}): Principal {
  return {
    did: `did:web:${'example.com'}:users:${encodeURIComponent('bearer@example.com')}`,
    email: 'bearer@example.com',
    name: 'Bearer User',
    image: null,
    domain: 'example.com',
    isAgent: false,
    ...overrides,
  };
}

function mintToken(user: Principal) {
  return JWTService.generateToken({    did: `did:web:${user.domain}:agents:test:model`,

    email: makeEmail(user.email),
    domain: user.domain,
  }, '10m');
}

describe('SDK-AUTH-CORS Phase 3 — bearer-only (no cookie)', () => {
  beforeAll(() => {
    JWTService.initialize({
      site: { domain: 'test.local' },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });


  it('rejects a request authenticated only by the semiont-token cookie → 401', async () => {
    const user = fakeUser();
    const token = mintToken(user);

    const res = await app.request('/api/users/me', {
      headers: { Cookie: `semiont-token=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('still authenticates a bearer request (regression guard)', async () => {
    const user = fakeUser();
    const token = mintToken(user);

    const res = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});
