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
import type { User } from '@prisma/client';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { EventBus as EventBusType, EventMap, Logger } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { FilesystemViewStorage } from '@semiont/event-sourcing';
import { WorkingTreeStore, calculateChecksum } from '@semiont/content';
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

type Variables = { user: User; principalDid: string; eventBus: EventBusType; makeMeaning: unknown };

describe('resource routes pipe contract (SIMPLER-JSON-LD.md Phase 1)', () => {
  let testEnv: TestEnvironmentConfig;
  let views: FilesystemViewStorage;
  let content: WorkingTreeStore;
  let eventBus: EventBus;
  let app: Hono<{ Variables: Variables }>;
  let seq = 0;

  beforeAll(async () => {
    initializeLogger('error');
    testEnv = await setupTestEnvironment();
    const project = new SemiontProject(testEnv.config._metadata!.projectRoot!);
    views = new FilesystemViewStorage(project);
    content = new WorkingTreeStore(project, mockLogger);
    eventBus = new EventBus();

    const kb = { views, content };
    app = new Hono<{ Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('makeMeaning', { knowledgeSystem: { kb } });
      c.set('eventBus', eventBus);
      await next();
    });
    registerGetResourceUri(app as unknown as ResourcesRouterType);
  });

  afterAll(async () => {
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
        storageUri: uri,
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
    const sub = eventBus.get('browse:resource-requested').subscribe((e) => {
      eventBus.get('browse:resource-result').next({
        correlationId: e.correlationId,
        response: graph,
      });
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
    const sub = eventBus.get('browse:resource-requested').subscribe((e) => {
      eventBus.get('browse:resource-failed').next({
        correlationId: e.correlationId,
        message: 'Resource not found',
      });
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
