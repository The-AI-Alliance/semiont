/**
 * Transport-fidelity lemma for the smelter's S12 axiom
 * (`.plans/SMELTER-AXIOMS.md`): bytes served by GET /resources/:id hash to
 * the checksum registered for the stored representation — ∀ contents,
 * including non-UTF-8 bytes.
 *
 * Since .plans/SIMPLER-JSON-LD.md Phase 1 the route is a pure pipe, so this
 * holds on EVERY content response — no special Accept: application/octet-stream
 * mode is needed (or honored; Accept is never read). The smelter's S12
 * property runs against a mocked IContentTransport that is byte-faithful by
 * construction; this test makes that assumption executable on the real route.
 *
 * Since SINGLE-KB-MOUNT P3 the route proxies a real Archivist, so the lemma
 * is now stronger than it was: byte fidelity has to survive the process hop
 * and the streaming pipe, not merely a local `readFile`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fc from 'fast-check';
import { Hono } from 'hono';
import type { Principal } from '../../identity/principal';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { EnvironmentConfig, EventBus as EventBusType, Logger, ResourceId } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { createServer } from 'http';
import type { IssuerVerifier } from '@semiont/core/identity';
import { FilesystemViewStorage } from '@semiont/event-sourcing';
import { WorkingTreeStore, calculateChecksum } from '@semiont/content';
import { createArchivistServer } from '@semiont/make-meaning';
import { registerGetResourceUri } from '../../routes/resources/routes/get-uri';
import type { ResourcesRouterType } from '../../routes/resources/shared';
import { initializeLogger } from '../../logger';
import { setupTestEnvironment, type TestEnvironmentConfig } from '../_test-setup';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

type Variables = { principal: Principal; eventBus: EventBusType; config: EnvironmentConfig };

/**
 * A minimal issuer and a stub verifier, so this suite still drives a REAL
 * Archivist across the process boundary now that the hop authenticates with a
 * service-account token rather than a shared string.
 */
const SERVICE_TOKEN = 'a-service-account-token';
const stubVerifier = {
  issuer: 'https://issuer.test',
  audience: 'https://example.github.io/kb',
  verify: async (token: string) => {
    if (token !== SERVICE_TOKEN) throw new Error('bad signature');
    return { sub: 'service-account-semiont-gateway', roles: ['semiont-service'] };
  },
} as unknown as IssuerVerifier;

/** Serves discovery and the token endpoint; hands out the one accepted token. */
async function startStubIssuer(): Promise<{ url: string; close: () => Promise<void> }> {
  let url = '';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url?.includes('/.well-known/openid-configuration')) {
      res.end(JSON.stringify({ issuer: url, token_endpoint: `${url}/token` }));
      return;
    }
    res.end(JSON.stringify({ access_token: SERVICE_TOKEN, expires_in: 300 }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe('GET /resources/:id byte fidelity (S12 transport-fidelity lemma)', () => {
  let testEnv: TestEnvironmentConfig;
  let project: SemiontProject;
  let views: FilesystemViewStorage;
  let content: WorkingTreeStore;
  let app: Hono<{ Variables: Variables }>;
  let archivist: Server;
  let issuer: { url: string; close: () => Promise<void> };
  let seq = 0;

  beforeAll(async () => {
    initializeLogger('error');
    testEnv = await setupTestEnvironment();
    project = new SemiontProject(testEnv.config._metadata!.projectRoot!, { anchoredTextDir: `${testEnv.config._metadata!.projectRoot!}/anchored-text` });
    views = new FilesystemViewStorage(project);
    content = new WorkingTreeStore(project, mockLogger);

    // The bytes live behind a real Archivist (SINGLE-KB-MOUNT P3), so the
    // property crosses the wire the deployment actually uses.
    archivist = createArchivistServer({
      events: { queryEvents: async () => [] },
      content,
      views,
      verifier: stubVerifier,
      health: () => ({ status: 'ok' }),
      branch: () => 'main',
      logger: mockLogger,
    });
    await new Promise<void>((resolve) => archivist.listen(0, resolve));
    const archivistPort = (archivist.address() as AddressInfo).port;

    issuer = await startStubIssuer();
    process.env.SEMIONT_OIDC_CLIENT_ID = 'semiont-gateway';
    process.env.SEMIONT_OIDC_CLIENT_SECRET = 'a-client-secret';

    app = new Hono<{ Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('config', {
        services: {
          archivist: { host: '127.0.0.1', port: archivistPort },
          identity: { issuer: issuer.url },
        },
      } as unknown as EnvironmentConfig);
      // The credential the Archivist-dialling routes resolve. A test can now
      // supply its own — it could not while the value was read from process.env.
      c.set('archivistCredential', () => ({
        issuer: issuer.url,
        clientId: 'semiont-gateway',
        clientSecret: 'test-secret',
      }));
      await next();
    });
    registerGetResourceUri(app as unknown as ResourcesRouterType);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => archivist.close((e) => (e ? reject(e) : resolve())));
    await issuer.close();
    await testEnv.cleanup();
  });

  async function putResource(bytes: Buffer, mediaType: string): Promise<{ rid: ResourceId; checksum: string }> {
    seq++;
    const rid = makeResourceId(`res-raw-${seq}`);
    const uri = `file://raw-${seq}.bin`;
    const stored = await content.store(bytes, uri, { noGit: true });
    await views.save(rid, {
      resource: {
        '@context': 'https://schema.org',
        '@id': rid,
        name: rid,
        archived: false,
        representations: [{ mediaType, storageUri: uri, checksum: stored.checksum }],
      },
      annotations: { resourceId: rid, annotations: [], version: 0, updatedAt: '' },
    });
    return { rid, checksum: stored.checksum };
  }

  // Lemma (FOPL): ∀ bytes b, ∀ media m:
  //   served(GET /resources/r) = b ∧ sha256(served) = registeredChecksum(b)
  it('serves stored bytes verbatim on every content response', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 2048 }),
        fc.constantFrom(
          'text/plain',
          'text/markdown',
          'text/html; charset=iso-8859-1',
          'application/pdf',
          'application/octet-stream',
          'image/png',
        ),
        async (bytes, mediaType) => {
          const buf = Buffer.from(bytes);
          const { rid, checksum } = await putResource(buf, mediaType);

          const res = await app.request(`/resources/${rid}`);
          expect(res.status).toBe(200);

          const served = Buffer.from(await res.arrayBuffer());
          expect(served.equals(buf)).toBe(true);
          expect(calculateChecksum(served)).toBe(checksum);
          expect(res.headers.get('content-type')).toContain(mediaType.split(';')[0]);
        },
      ),
      { numRuns: 25 },
    );
  }, 30_000);

  it('serves non-UTF-8 text byte-faithfully with the stored Content-Type verbatim', async () => {
    // "héh" in ISO-8859-1: 0xE9 is invalid UTF-8. The conneg-era route
    // charset-decoded and UTF-8 re-encoded this (changing the bytes); the
    // pipe must not.
    const buf = Buffer.from([0x68, 0xe9, 0x68]);
    const mediaType = 'text/plain; charset=iso-8859-1';
    const { rid, checksum } = await putResource(buf, mediaType);

    const res = await app.request(`/resources/${rid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(mediaType);

    const served = Buffer.from(await res.arrayBuffer());
    expect(served.equals(buf)).toBe(true);
    expect(calculateChecksum(served)).toBe(checksum);
  });
});
