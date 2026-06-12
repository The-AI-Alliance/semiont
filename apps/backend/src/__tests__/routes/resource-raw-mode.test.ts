/**
 * Transport-fidelity lemma for the smelter's S12 axiom
 * (`.plans/SMELTER-AXIOMS.md`): bytes served by GET /resources/:id in
 * verbatim mode (Accept: application/octet-stream) hash to the checksum
 * registered for the stored representation — ∀ contents, including
 * non-UTF-8 bytes that the decoded-text mode re-encodes.
 *
 * The smelter's S12 property runs against a mocked IContentTransport that
 * is byte-faithful by construction; this test makes that assumption
 * executable on the real route, which is where the fidelity can actually
 * break (decodeRepresentation + UTF-8 re-encode on the text path).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fc from 'fast-check';
import { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EventBus as EventBusType, Logger } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
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

describe('GET /resources/:id verbatim mode (S12 transport-fidelity lemma)', () => {
  let testEnv: TestEnvironmentConfig;
  let project: SemiontProject;
  let views: FilesystemViewStorage;
  let content: WorkingTreeStore;
  let app: Hono<{ Variables: Variables }>;
  let seq = 0;

  beforeAll(async () => {
    initializeLogger('error');
    testEnv = await setupTestEnvironment();
    project = new SemiontProject(testEnv.config._metadata!.projectRoot!);
    views = new FilesystemViewStorage(project);
    content = new WorkingTreeStore(project, mockLogger);

    // The verbatim/representation branch touches only kb.views and
    // kb.content — same stubbing depth as routes/bus.test.ts.
    const kb = { views, content };
    app = new Hono<{ Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('makeMeaning', { knowledgeSystem: { kb } });
      await next();
    });
    registerGetResourceUri(app as unknown as ResourcesRouterType);
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  async function putResource(bytes: Buffer, mediaType: string): Promise<{ rid: string; checksum: string }> {
    seq++;
    const rid = `res-raw-${seq}`;
    const uri = `file://raw-${seq}.bin`;
    const stored = await content.store(bytes, uri, { noGit: true });
    await views.save(makeResourceId(rid), {
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
  //   served(GET /resources/r, Accept: application/octet-stream) = b
  //   ∧ sha256(served) = registeredChecksum(b)
  it('serves stored bytes verbatim under Accept: application/octet-stream', async () => {
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

          const res = await app.request(`/resources/${rid}`, {
            headers: { Accept: 'application/octet-stream' },
          });
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

  it('decoded-text mode is not byte-faithful for non-UTF-8 content (why verbatim mode exists)', async () => {
    // "héh" in ISO-8859-1: 0xE9 is invalid UTF-8, so the text path's
    // decode + UTF-8 re-encode cannot reproduce the stored bytes.
    const buf = Buffer.from([0x68, 0xe9, 0x68]);
    const { rid, checksum } = await putResource(buf, 'text/plain; charset=iso-8859-1');

    const res = await app.request(`/resources/${rid}`, { headers: { Accept: 'text/plain' } });
    expect(res.status).toBe(200);

    const served = Buffer.from(await res.arrayBuffer());
    expect(calculateChecksum(served)).not.toBe(checksum);
  });
});
