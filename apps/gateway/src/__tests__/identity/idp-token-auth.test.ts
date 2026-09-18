/**
 * The gateway as an OIDC resource server (EXTERNAL-IDENTITY P4): a token the
 * trusted issuer signed for this audience authenticates, its subject is
 * provisioned as a User on first sight, and everything else — wrong audience,
 * another issuer, an inactive user — is a 401. Gateway-signed agent tokens
 * still authenticate: dispatch is by `iss`, not by algorithm.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

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
import { fixtureIssuer, type FixtureIssuer } from '../fixtures/issuer';
import type { User } from '@prisma/client';
import { faker } from '@faker-js/faker';
import { email as makeEmail, userId as makeUserId } from '@semiont/core';

const prisma = DatabaseConnection.getClient();
const mockPrismaUser = vi.mocked(prisma.user);

const ORIGIN = 'https://issuer.test';
const AUDIENCE = 'semiont-gateway';
const SITE_DOMAIN = 'test.local';

const makeCuid = () => `c${faker.string.alphanumeric(24).toLowerCase()}`;

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: makeCuid(),
    email: 'alice@example.com',
    name: 'Alice',
    image: null,
    domain: 'example.com',
    provider: ORIGIN,
    providerId: 'sub-alice',
    isAdmin: false,
    isModerator: false,
    lastLogin: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const ALICE = { sub: 'sub-alice', email: 'alice@example.com', email_verified: true, name: 'Alice' };

let issuer: FixtureIssuer;

beforeAll(() => {
  JWTService.initialize({ site: { domain: SITE_DOMAIN } });
});

beforeEach(async () => {
  for (const fn of Object.values(mockPrismaUser)) fn.mockReset();
  issuer = await fixtureIssuer(ORIGIN, { audience: AUDIENCE });
  configureTrustedIssuer({ type: 'oidc', issuer: ORIGIN }, AUDIENCE);
});

async function me(token: string) {
  return app.request('/api/users/me', { headers: { Authorization: `Bearer ${token}` } });
}

describe('a token from the trusted issuer', () => {
  it('authenticates, provisioning the subject as a User on first sight', async () => {
    mockPrismaUser.findFirst.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue(null);
    mockPrismaUser.create.mockResolvedValue(fakeUser());

    const res = await me(await issuer.token({ claims: ALICE }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'alice@example.com' });
    expect(mockPrismaUser.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'alice@example.com', provider: ORIGIN, providerId: 'sub-alice', isAdmin: false }),
    });
  });

  it('finds a linked subject with one read and no write', async () => {
    mockPrismaUser.findFirst.mockResolvedValue(fakeUser());

    const res = await me(await issuer.token({ claims: ALICE }));

    expect(res.status).toBe(200);
    expect(mockPrismaUser.findFirst).toHaveBeenCalledWith({ where: { provider: ORIGIN, providerId: 'sub-alice' } });
    expect(mockPrismaUser.findUnique).not.toHaveBeenCalled();
    expect(mockPrismaUser.create).not.toHaveBeenCalled();
    expect(mockPrismaUser.update).not.toHaveBeenCalled();
  });

  it('links an existing user with the same email to the issuer subject', async () => {
    const existing = fakeUser({ provider: 'password', providerId: 'alice@example.com' });
    mockPrismaUser.findFirst.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue(existing);
    mockPrismaUser.update.mockResolvedValue({ ...existing, provider: ORIGIN, providerId: 'sub-alice' });

    const res = await me(await issuer.token({ claims: ALICE }));

    expect(res.status).toBe(200);
    expect(mockPrismaUser.update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: expect.objectContaining({ provider: ORIGIN, providerId: 'sub-alice' }),
    });
    expect(mockPrismaUser.create).not.toHaveBeenCalled();
  });

});

describe('a token that must not authenticate', () => {
  it('is for another audience', async () => {
    mockPrismaUser.findFirst.mockResolvedValue(fakeUser());

    const res = await me(await issuer.token({ claims: ALICE, audience: 'someone-else' }));

    expect(res.status).toBe(401);
    expect(mockPrismaUser.findFirst).not.toHaveBeenCalled();
  });

  it('is from an issuer the gateway does not trust', async () => {
    const other = await fixtureIssuer('https://other.test', { audience: AUDIENCE });
    mockPrismaUser.findFirst.mockResolvedValue(fakeUser());

    const res = await me(await other.token({ claims: ALICE }));

    expect(res.status).toBe(401);
    expect(mockPrismaUser.findFirst).not.toHaveBeenCalled();
  });

  it('carries an email the issuer has not verified', async () => {
    mockPrismaUser.findFirst.mockResolvedValue(fakeUser());

    const res = await me(await issuer.token({ claims: { ...ALICE, email_verified: false } }));

    expect(res.status).toBe(401);
    expect(mockPrismaUser.findFirst).not.toHaveBeenCalled();
  });

  it('carries no email claim', async () => {
    const res = await me(await issuer.token({ claims: { sub: 'sub-nobody' } }));

    expect(res.status).toBe(401);
  });

  it('is absent — the existing 401 shape, with its hint', async () => {
    const res = await app.request('/api/users/me');

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: 'Unauthorized',
      hint: expect.stringMatching(/Authorization: Bearer/),
    });
  });

  it('is an issuer token when no issuer is trusted', async () => {
    configureTrustedIssuer(undefined, AUDIENCE);
    mockPrismaUser.findFirst.mockResolvedValue(fakeUser());

    const res = await me(await issuer.token({ claims: ALICE }));

    expect(res.status).toBe(401);
  });
});

describe('a gateway-signed token', () => {
  it('still authenticates a software agent: dispatch is by iss', async () => {
    const agent = fakeUser({
      email: 'ollama-gemma@agents.test.local',
      provider: 'agent',
      providerId: 'ollama:gemma',
      domain: SITE_DOMAIN,
    });
    mockPrismaUser.findUnique.mockResolvedValue(agent);
    const token = JWTService.generateToken({
      userId: makeUserId(agent.id),
      email: makeEmail(agent.email),
      domain: agent.domain,
      provider: agent.provider,
      isAdmin: false,
      agentDid: 'did:web:test.local:agents:ollama:gemma',
    }, '10m');

    const res = await me(token);

    expect(res.status).toBe(200);
    expect(mockPrismaUser.findFirst).not.toHaveBeenCalled();
  });
});
