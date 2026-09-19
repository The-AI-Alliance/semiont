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
import { JWTService } from '../../auth/jwt';
import { configureTrustedIssuer } from '../../identity/trusted-issuer';
import { fixtureIssuer, type FixtureIssuer } from '../fixtures/issuer';
import type { Principal } from '../../identity/principal';
import { email as makeEmail } from '@semiont/core';


const ORIGIN = 'https://issuer.test';
const AUDIENCE = 'semiont-gateway';
const SITE_DOMAIN = 'test.local';

function fakeUser(overrides: Partial<Principal> = {}): Principal {
  return {
    did: `did:web:${'example.com'}:users:${encodeURIComponent('alice@example.com')}`,
    email: 'alice@example.com',
    name: 'Alice',
    image: null,
    domain: 'example.com',
    isAgent: false,
    ...overrides,
  };
}

const ALICE = { sub: 'sub-alice', email: 'alice@example.com', email_verified: true, name: 'Alice' };

let issuer: FixtureIssuer;

beforeAll(() => {
  JWTService.initialize({ site: { domain: SITE_DOMAIN } });
});

beforeEach(async () => {
  issuer = await fixtureIssuer(ORIGIN, { audience: AUDIENCE });
  configureTrustedIssuer({ type: 'oidc', issuer: ORIGIN }, AUDIENCE);
});

async function me(token: string) {
  return app.request('/api/users/me', { headers: { Authorization: `Bearer ${token}` } });
}

describe('a token from the trusted issuer', () => {
  /**
   * Nothing is provisioned. The principal is built from the claims the token
   * carries, so a subject the gateway has never seen authenticates exactly as
   * one it has — there is no first-sight write, and no row to find or link.
   */
  it('authenticates a subject it has never seen, writing nothing', async () => {
    const res = await me(await issuer.token({ claims: ALICE }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      did: `did:web:example.com:users:${encodeURIComponent('alice@example.com')}`,
      email: 'alice@example.com',
      name: 'Alice',
      domain: 'example.com',
    });
  });

  it('answers identically on a second presentation of the same subject', async () => {
    const token = await issuer.token({ claims: ALICE });

    const first = await me(token);
    const second = await me(token);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
  });

  it('carries the issuer picture claim through as the image', async () => {
    const res = await me(await issuer.token({
      claims: { ...ALICE, picture: 'https://example.com/alice.png' },
    }));

    expect(await res.json()).toMatchObject({ image: 'https://example.com/alice.png' });
  });
});

describe('a token that must not authenticate', () => {
  it('is for another audience', async () => {

    const res = await me(await issuer.token({ claims: ALICE, audience: 'someone-else' }));

    expect(res.status).toBe(401);
  });

  it('is from an issuer the gateway does not trust', async () => {
    const other = await fixtureIssuer('https://other.test', { audience: AUDIENCE });

    const res = await me(await other.token({ claims: ALICE }));

    expect(res.status).toBe(401);
  });

  it('carries an email the issuer has not verified', async () => {

    const res = await me(await issuer.token({ claims: { ...ALICE, email_verified: false } }));

    expect(res.status).toBe(401);
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

    const res = await me(await issuer.token({ claims: ALICE }));

    expect(res.status).toBe(401);
  });
});

describe('a gateway-signed token', () => {
  it('still authenticates a software agent: dispatch is by iss', async () => {
    const agent = fakeUser({
      email: 'ollama-gemma@agents.test.local',
      domain: SITE_DOMAIN,
      isAgent: true,
    });
    const token = JWTService.generateToken({
      did: 'did:web:test.local:agents:ollama:gemma',
      email: makeEmail(agent.email),
      domain: agent.domain,
    }, '10m');

    const res = await me(token);

    expect(res.status).toBe(200);
  });
});
