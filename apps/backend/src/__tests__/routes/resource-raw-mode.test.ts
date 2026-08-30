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
import type { User } from '@prisma/client';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { EnvironmentConfig, EventBus as EventBusType, Logger, ResourceId } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
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

type Variables = { user: User; principalDid: string; eventBus: EventBusType; makeMeaning: unknown; config: EnvironmentConfig };

describe('GET /resources/:id byte fidelity (S12 transport-fidelity lemma)', () => {
  let testEnv: TestEnvironmentConfig;
  let project: SemiontProject;
  let views: FilesystemViewStorage;
  let content: WorkingTreeStore;
  let app: Hono<{ Variables: Variables }>;
  let archivist: Server;
  let seq = 0;
  const WORKER_SECRET = 'raw-mode-test-worker-secret';

  beforeAll(async () => {
    initializeLogger('error');
    testEnv = await setupTestEnvironment();
    project = new SemiontProject(testEnv.config._metadata!.projectRoot!, { anchoredTextDir: `${testEnv.config._metadata!.projectRoot!}/anchored-text` });
    views = new FilesystemViewStorage(project);
    content = new WorkingTreeStore(project, mockLogger);

    // The bytes live behind a real Archivist (SINGLE-KB-MOUNT P3), so the
    // property crosses the wire the deployment actually uses.
    process.env.SEMIONT_WORKER_SECRET = WORKER_SECRET;
    archivist = createArchivistServer({
      events: { queryEvents: async () => [] },
      content,
      views,
      workerSecret: WORKER_SECRET,
      health: () => ({ status: 'ok' }),
      logger: mockLogger,
    });
    await new Promise<void>((resolve) => archivist.listen(0, resolve));
    const archivistPort = (archivist.address() as AddressInfo).port;

    const kb = { views, content };
    app = new Hono<{ Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('makeMeaning', { knowledgeSystem: { kb } });
      c.set('config', {
        services: { archivist: { host: '127.0.0.1', port: archivistPort } },
      } as unknown as EnvironmentConfig);
      await next();
    });
    registerGetResourceUri(app as unknown as ResourcesRouterType);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => archivist.close((e) => (e ? reject(e) : resolve())));
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
        storageUri: uri,
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
