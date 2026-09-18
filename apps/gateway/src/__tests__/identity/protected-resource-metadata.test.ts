/**
 * Protected Resource Metadata (RFC 9728, EXTERNAL-IDENTITY P4): a client
 * learns which issuer this knowledge base trusts from a public well-known
 * document, and every 401 points at it in its WWW-Authenticate challenge.
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

const ISSUER = 'https://issuer.test';
const AUDIENCE = 'semiont-gateway';
const METADATA_PATH = '/.well-known/oauth-protected-resource';

beforeAll(() => {
  JWTService.initialize({ site: { domain: 'test.local' } });
});

beforeEach(() => {
  configureTrustedIssuer({ type: 'oidc', issuer: ISSUER, audience: AUDIENCE });
});

describe('GET /.well-known/oauth-protected-resource', () => {
  it('names the trusted issuer, the resource as the origin fetched, and the bearer method', async () => {
    const res = await app.request(METADATA_PATH);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: 'http://localhost',
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      resource_name: 'semiont-gateway-unit',
    });
  });

  it('is 404 when no issuer is trusted — there is nothing to advertise', async () => {
    configureTrustedIssuer(undefined);

    const res = await app.request(METADATA_PATH);

    expect(res.status).toBe(404);
  });

  it('is public: no token, no challenge', async () => {
    const res = await app.request(METADATA_PATH);

    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });
});

describe('the 401 challenge', () => {
  it('points a tokenless request at the metadata', async () => {
    const res = await app.request('/api/users/me');

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="http://localhost${METADATA_PATH}"`);
  });

  it('names the error for a token that does not verify, and still points at the metadata', async () => {
    const res = await app.request('/api/users/me', { headers: { Authorization: 'Bearer not.a.token' } });

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `Bearer error="invalid_token", resource_metadata="http://localhost${METADATA_PATH}"`,
    );
  });

  it('is a bare Bearer challenge when no issuer is trusted', async () => {
    configureTrustedIssuer(undefined);

    const res = await app.request('/api/users/me');

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });
});
