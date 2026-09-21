/**
 * The pipe contract for the resource routes (.plans/SIMPLER-JSON-LD.md,
 * Phase 1):
 * - GET /resources/:id serves the stored bytes verbatim regardless of the
 *   Accept header (there is no content negotiation — Accept is never read),
 *   with the stored media type in Content-Type, private+immutable caching,
 *   and a Link: rel="describedby" header advertising the JSON-LD
 *   description.
 * - A stored application/json representation is served by its own name —
 *   the old "Accept: application/json means metadata" collision is gone.
 * - GET /resources/:id/jsonld serves the assembled graph via the bus
 *   gateway, as application/ld+json with no-cache.
 * - GET /api/resources/:id is the same pipe with public caching (its
 *   ?token= is part of the cache key).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { Principal } from '../../identity/principal';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { EventBus as EventBusType, EnvironmentConfig, EventMap, Logger } from '@semiont/core';
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

describe('resource routes pipe contract (SIMPLER-JSON-LD.md Phase 1)', () => {
  let testEnv: TestEnvironmentConfig;
  let views: FilesystemViewStorage;
  let content: WorkingTreeStore;
  let eventBus: EventBus;
  let app: Hono<{ Variables: Variables }>;
  let archivist: Server;
  let issuer: { url: string; close: () => Promise<void> };
  let seq = 0;

  beforeAll(async () => {
    initializeLogger('error');
    testEnv = await setupTestEnvironment();
    const project = new SemiontProject(testEnv.config._metadata!.projectRoot!, { anchoredTextDir: `${testEnv.config._metadata!.projectRoot!}/anchored-text` });
    views = new FilesystemViewStorage(project);
    content = new WorkingTreeStore(project, mockLogger);
    eventBus = new EventBus();

    // The gateway no longer holds the bytes (SINGLE-KB-MOUNT P3): it proxies
    // a REAL Archivist here, so this suite still proves the client-visible
    // contract end to end — byte fidelity, media type, headers — across the
    // process boundary the phase introduces rather than around it.
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
      c.set('eventBus', eventBus);
      c.set('config', {
        services: {
          archivist: { host: '127.0.0.1', port: archivistPort },
          identity: { issuer: issuer.url },
        },
      } as unknown as EnvironmentConfig);
      await next();
    });
    registerGetResourceUri(app as unknown as ResourcesRouterType);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => archivist.close((e) => (e ? reject(e) : resolve())));
    await issuer.close();
    await testEnv.cleanup();
  });

  async function putResource(bytes: Buffer, mediaType: string) {
    seq++;
    const rid = makeResourceId(`res-pipe-${seq}`);
    const uri = `file://pipe-${seq}.bin`;
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

  // ZIP magic followed by bytes that are invalid UTF-8 — any decode
  // round-trip would corrupt them.
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xe9, 0xff, 0x00, 0x80]);

  it('serves stored bytes verbatim regardless of the Accept header', async () => {
    const { rid, checksum } = await putResource(zipBytes, 'application/zip');

    // Accept named the type / named a text type / asked for "metadata" /
    // was absent entirely — the pipe never reads it.
    const accepts: (string | undefined)[] = [
      'application/zip',
      'text/plain',
      'application/json',
      'application/ld+json',
      undefined,
    ];
    for (const accept of accepts) {
      const res = await app.request(`/resources/${rid}`, {
        headers: accept ? { Accept: accept } : {},
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/zip');
      const served = Buffer.from(await res.arrayBuffer());
      expect(served.equals(zipBytes)).toBe(true);
      expect(calculateChecksum(served)).toBe(checksum);
    }
  });

  it('serves a stored application/json representation by its own name (collision gone)', async () => {
    const doc = '{"hello":"world"}';
    const { rid, checksum } = await putResource(Buffer.from(doc, 'utf-8'), 'application/json');

    const res = await app.request(`/resources/${rid}`, {
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const served = Buffer.from(await res.arrayBuffer());
    expect(served.toString('utf-8')).toBe(doc);
    expect(calculateChecksum(served)).toBe(checksum);
  });

  it('sends private immutable caching and the describedby Link on the main route', async () => {
    const { rid } = await putResource(zipBytes, 'application/zip');

    const res = await app.request(`/resources/${rid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('link')).toBe(
      `</resources/${rid}/jsonld>; rel="describedby"; type="application/ld+json"`,
    );
  });

  it('pipes on the browser alias with public immutable caching', async () => {
    const { rid, checksum } = await putResource(zipBytes, 'application/zip');

    const res = await app.request(`/api/resources/${rid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('link')).toBe(
      `</resources/${rid}/jsonld>; rel="describedby"; type="application/ld+json"`,
    );
    const served = Buffer.from(await res.arrayBuffer());
    expect(calculateChecksum(served)).toBe(checksum);
  });

  it('serves the JSON-LD description at /resources/:id/jsonld', async () => {
    // The branded reply flavor the protocol declares (bus-protocol.ts) — the
    // fixture's ids are built with the real constructors, so it satisfies it.
    const graph: EventMap['browse:resource-result']['response'] = {
      resource: {
        '@context': 'https://schema.org',
        '@id': makeResourceId('res-pipe-graph'),
        name: 'Graph sentinel',
        representations: [],
      },
      annotations: [],
      entityReferences: [],
    };
    // `frames`, not `on`: a responder echoes the key it was HANDED, and the
    // payload no longer carries one.
    const sub = eventBus.frames('browse:resource-requested').subscribe((frame) => {
      eventBus.emit('browse:resource-result', { response: graph }, { correlationId: frame.correlationId });
    });
    try {
      const res = await app.request('/resources/res-pipe-graph/jsonld');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/ld+json');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.json()).toEqual(graph);
    } finally {
      sub.unsubscribe();
    }
  });

  it('404s on /jsonld when the bus reports the resource missing', async () => {
    const sub = eventBus.frames('browse:resource-requested').subscribe((frame) => {
      eventBus.emit('browse:resource-failed', { message: 'Resource not found' }, { correlationId: frame.correlationId });
    });
    try {
      const res = await app.request('/resources/res-pipe-missing/jsonld');
      expect(res.status).toBe(404);
    } finally {
      sub.unsubscribe();
    }
  });

  it('404s (not 500) on the pipe for a resource that was never stored', async () => {
    const res = await app.request('/resources/res-pipe-absent');
    expect(res.status).toBe(404);
  });

  it('404s on the /api/ alias for a missing resource too', async () => {
    const res = await app.request('/api/resources/res-pipe-absent');
    expect(res.status).toBe(404);
  });
});
