/**
 * Registry-driven content negotiation on GET /resources/:id
 * (.plans/MEDIA-TYPES.md, Phase 3a):
 * - big tent: Accept naming any supported media type serves the stored
 *   representation (application/zip used to fall through to JSON-LD metadata)
 * - dispatch: only formats the registry marks 'decode' take the
 *   charset-decode path — a stored ZIP is served verbatim, never mojibake
 * - registry-miss text/* still decodes (RFC 2046 fallback)
 * - application/json keeps its JSON-LD-metadata meaning (decision 2)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@prisma/client';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { EventBus as EventBusType, Logger, components } from '@semiont/core';
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

describe('GET /resources/:id registry-driven negotiation (MEDIA-TYPES.md Phase 3a)', () => {
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
    const rid = makeResourceId(`res-neg-${seq}`);
    const uri = `file://neg-${seq}.bin`;
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

  // PK\x03\x04 header followed by bytes that are invalid UTF-8 — a decode
  // round-trip cannot reproduce them.
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xe9, 0xff, 0x00, 0x80]);

  it('serves a stored ZIP for Accept: application/zip (big tent — used to fall through to metadata)', async () => {
    const { rid, checksum } = await putResource(zipBytes, 'application/zip');

    const res = await app.request(`/resources/${rid}`, {
      headers: { Accept: 'application/zip' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');

    const served = Buffer.from(await res.arrayBuffer());
    expect(served.equals(zipBytes)).toBe(true);
    expect(calculateChecksum(served)).toBe(checksum);
  });

  it('never charset-decodes a binary representation (Accept: text/plain on a ZIP)', async () => {
    const { rid, checksum } = await putResource(zipBytes, 'application/zip');

    const res = await app.request(`/resources/${rid}`, {
      headers: { Accept: 'text/plain' },
    });
    expect(res.status).toBe(200);

    const served = Buffer.from(await res.arrayBuffer());
    expect(served.equals(zipBytes)).toBe(true);
    expect(calculateChecksum(served)).toBe(checksum);
  });

  it('decodes registry-miss text/* via the RFC 2046 fallback', async () => {
    const text = 'héllo wörld';
    const { rid } = await putResource(Buffer.from(text, 'utf-8'), 'text/x-custom');

    const res = await app.request(`/resources/${rid}`, {
      headers: { Accept: 'text/plain' },
    });
    expect(res.status).toBe(200);
    // c.text() pins Content-Type to text/plain on the decoded path (Hono
    // behavior, unchanged by the registry dispatch); the stored media type
    // reaches Content-Type only on the verbatim-bytes path.
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(text);
  });

  it('returns JSON-LD metadata for Accept: application/json (decision 2 — json means metadata)', async () => {
    const metadataResponse: components['schemas']['GetResourceResponse'] = {
      resource: {
        '@context': 'https://schema.org',
        '@id': makeResourceId('res-neg-meta'),
        name: 'Metadata sentinel',
        representations: [],
      },
      annotations: [],
      entityReferences: [],
    };
    const sub = eventBus.get('browse:resource-requested').subscribe((e) => {
      eventBus.get('browse:resource-result').next({
        correlationId: e.correlationId,
        response: metadataResponse,
      });
    });
    try {
      const res = await app.request('/resources/res-neg-meta', {
        headers: { Accept: 'application/json' },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(metadataResponse);
    } finally {
      sub.unsubscribe();
    }
  });
});
