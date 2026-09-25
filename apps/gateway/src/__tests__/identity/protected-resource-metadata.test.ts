/**
 * Protected Resource Metadata (RFC 9728, EXTERNAL-IDENTITY P4): a client
 * learns which issuer this knowledge base trusts from a public well-known
 * document, and every 401 points at it in its WWW-Authenticate challenge.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import { app } from '../../index';
import { JWTService } from '../../auth/jwt';
import { configureTrustedIssuer } from '../../identity/trusted-issuer';
import { kbResource } from '@semiont/core';

const ISSUER = 'https://issuer.test';
// The knowledge base's own resource identifier, derived from its committed
// did:web domain — NOT the origin a request arrived on.
const RESOURCE = kbResource('test.local');
const METADATA_PATH = '/.well-known/oauth-protected-resource';

beforeAll(() => {
  JWTService.initialize({ site: { domain: 'test.local' } });
});

beforeEach(() => {
  configureTrustedIssuer({ type: 'oidc', issuer: ISSUER, subjectClaim: 'sub' }, { audience: RESOURCE, domain: 'test.local' });
});

describe('GET /.well-known/oauth-protected-resource', () => {
  it('names the trusted issuer, the resource as the KB\'s own identifier, and the bearer method', async () => {
    const res = await app.request(METADATA_PATH);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      resource_name: 'semiont-gateway-unit',
    });
  });

  it('publishes the identity, never the origin the request arrived on', async () => {
    // The whole point of deriving it: this document is fetched over
    // http://localhost in tests and in local development, and the resource is
    // still the https identity, so a token minted for one host verifies at
    // every other address the same knowledge base is reached through.
    const res = await app.request(METADATA_PATH);

    const body = await res.json() as { resource: string };
    expect(body.resource).toBe('https://test.local');
    expect(body.resource).not.toBe('http://localhost');
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

});
