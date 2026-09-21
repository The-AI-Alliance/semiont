/**
 * Where the Archivist is, and what a caller shows it.
 *
 * These live in CORE because both functions are core's, and until now they were
 * exercised only from `@semiont/content` and the gateway — so
 * `npm test --workspace=@semiont/core` could pass on a broken resolver.
 *
 * The property that matters most here is the one that changed: the credential
 * is a PARAMETER. It used to be read from `process.env` mid-call, which meant a
 * caller could neither supply one, stub one, nor hold two — and every field of
 * the config was optional, so a narrowed config satisfied the type carrying
 * none of what the function needed. The Librarian shipped that way and died on
 * its first Archivist read.
 *
 * Imported from SOURCE, not the built subpath: a suite that tests its own
 * package through the artifact reports on the last build.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { archivistAddress, archivistEndpoint } from '../../config/node-config-loader';
import type { ServiceAccountCredential } from '../../service-account';

const ISSUER = 'https://issuer.test/realms/semiont';

const CREDENTIAL: ServiceAccountCredential = {
  issuer: ISSUER,
  clientId: 'semiont-gateway',
  clientSecret: 'a-secret',
};

const configFor = (archivist: { host?: string; port?: number } | undefined) =>
  ({ services: { ...(archivist ? { archivist } : {}) } }) as Parameters<typeof archivistAddress>[0];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('archivistAddress', () => {
  it('builds the base from the configured host and port', () => {
    const { base } = archivistAddress(configFor({ host: 'archivist.internal', port: 9999 }), CREDENTIAL);
    expect(base).toBe('http://archivist.internal:9999');
  });

  it('falls back to the default port, and only the port', () => {
    // A default ADDRESS would be a fabricated deployment fact; a default port
    // is the service's own published number.
    const { base } = archivistAddress(configFor({ host: 'archivist.internal' }), CREDENTIAL);
    expect(base).toMatch(/^http:\/\/archivist\.internal:\d+$/);
  });

  it('returns the credential it was GIVEN, not one it found', () => {
    const other: ServiceAccountCredential = {
      issuer: 'https://elsewhere.test/realms/other',
      clientId: 'semiont-librarian',
      clientSecret: 'a-different-secret',
    };
    // Two callers, two credentials, one process — impossible while this read
    // SEMIONT_OIDC_CLIENT_ID out of the environment.
    expect(archivistAddress(configFor({ host: 'a' }), CREDENTIAL).credential).toBe(CREDENTIAL);
    expect(archivistAddress(configFor({ host: 'a' }), other).credential).toBe(other);
  });

  it('ignores the environment entirely', () => {
    // The old implementation would have preferred these. Pinning it means the
    // regression is caught here rather than by a sidecar dying at boot.
    vi.stubEnv('SEMIONT_OIDC_CLIENT_ID', 'from-the-environment');
    vi.stubEnv('SEMIONT_OIDC_CLIENT_SECRET', 'also-from-the-environment');
    expect(archivistAddress(configFor({ host: 'a' }), CREDENTIAL).credential).toEqual(CREDENTIAL);
  });

  it('throws when no host is configured — absence is a misconfiguration', () => {
    // Loudly, at construction: the callers resolve this at boot precisely so a
    // missing address kills the process while an operator is watching rather
    // than failing every read quietly for the life of it.
    expect(() => archivistAddress(configFor(undefined), CREDENTIAL)).toThrow(/services\.archivist\.host/);
    expect(() => archivistAddress(configFor({ port: 9999 }), CREDENTIAL)).toThrow(/services\.archivist\.host/);
  });

  it('throws for a host even when the environment could have supplied a credential', () => {
    vi.stubEnv('SEMIONT_OIDC_CLIENT_ID', 'x');
    vi.stubEnv('SEMIONT_OIDC_CLIENT_SECRET', 'y');
    expect(() => archivistAddress(configFor(undefined), CREDENTIAL)).toThrow(/services\.archivist\.host/);
  });
});

describe('archivistEndpoint', () => {
  /** Discovery, then the client-credentials grant — the two calls a token costs. */
  function serveIssuer(token: string, expiresIn = 300): void {
    const discovery = `${ISSUER}/.well-known/openid-configuration`;
    const tokenUrl = `${ISSUER}/token`;
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === discovery) {
        return new Response(JSON.stringify({ issuer: ISSUER, token_endpoint: tokenUrl }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === tokenUrl) {
        return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unstubbed fetch: ${url}`);
    });
  }

  it('carries the token as a Bearer header, beside the base', async () => {
    serveIssuer('a-service-account-token');
    const { base, headers } = await archivistEndpoint(
      configFor({ host: 'archivist.internal', port: 9999 }),
      { ...CREDENTIAL, clientId: `bearer-${Math.random()}` },
    );
    expect(base).toBe('http://archivist.internal:9999');
    expect(headers.authorization).toBe('Bearer a-service-account-token');
  });

  it('refuses before reaching the issuer when the address is missing', async () => {
    // Nothing is stubbed: a fetch here would throw an unstubbed-URL error
    // rather than the configuration error, which is the point.
    await expect(archivistEndpoint(configFor(undefined), CREDENTIAL)).rejects.toThrow(
      /services\.archivist\.host/,
    );
  });
});
