/**
 * The Archivist, composed and asked over its own bus.
 *
 * `composeArchivist` is the composition `archivist-main` runs, so what
 * answers here is what answers in the service: the three actors and the
 * handlers beside them, on a real knowledge base. Requests carry `_userId`
 * as the gateway stamps it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  BusRequestError,
  ResourceOperations,
  SYSTEM_SCOPE,
  annotationId as makeAnnotationId,
  busRequest,
  kbDid,
  resourceId as makeResourceId,
  userId,
  type BusRequestPrimitive,
  type Logger,
  type ResourceId,
} from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { asBusRequestPrimitive } from '../bus-request-local';
import { composeArchivist, type Archivist } from '../archivist/compose';
import { declareTestKb, TEST_KB_DOMAIN } from './helpers/test-project';

const logger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => logger),
};

const USER = userId('did:web:test:users:test-host');

describe('the composed Archivist', () => {
  let testDir: string;
  let archivist: Archivist;
  let actors: BusRequestPrimitive;

  const seed = async (name: string, content: string): Promise<ResourceId> => {
    const stored = await archivist.content.store(Buffer.from(content, 'utf-8'), `file://${name}-${uuidv4()}.txt`);
    return ResourceOperations.createResource(
      { name, storageUri: stored.storageUri, contentChecksum: stored.checksum, byteSize: stored.byteSize, format: 'text/plain' },
      { did: USER, roles: [] },
      actors,
    );
  };

  const highlight = async (source: ResourceId, start: number, end: number, exact: string, motivation: 'highlighting' | 'linking' = 'highlighting') => {
    const { annotationId } = await busRequest(actors, 'mark:create-request', {
      resourceId: source,
      request: {
        motivation,
        target: { source, selector: [{ type: 'TextPositionSelector', start, end }, { type: 'TextQuoteSelector', exact }] },
      },
      _userId: USER,
    });
    return makeAnnotationId(annotationId);
  };

  const annotationsOf = async (resourceId: ResourceId) =>
    (await busRequest(actors, 'browse:annotations-requested', { resourceId })).annotations;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-archivist-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    await declareTestKb(testDir);
    archivist = await composeArchivist(
      new SemiontProject(testDir, { anchoredTextDir: `${testDir}/anchored-text` }), {}, logger, { skipRebuild: false },
    );
    actors = asBusRequestPrimitive(archivist.bus);
  });

  afterEach(async () => {
    await archivist?.stop();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("the knowledge base's identity", () => {
    it('seeds the default entity types as the knowledge base itself', async () => {
      const seeded = (await archivist.eventStore.log.getEvents(SYSTEM_SCOPE))
        .filter((e) => e.type === 'frame:entity-type-added');
      expect(seeded.length).toBeGreaterThan(0);
      expect(new Set(seeded.map((e) => e.userId))).toEqual(new Set([kbDid(TEST_KB_DOMAIN)]));
    });

    it('refuses a knowledge base that declares no [site] domain', async () => {
      const undeclaredDir = join(tmpdir(), `semiont-archivist-undeclared-${uuidv4()}`);
      await fs.mkdir(undeclaredDir, { recursive: true });
      try {
        await expect(composeArchivist(
          new SemiontProject(undeclaredDir, { anchoredTextDir: `${undeclaredDir}/anchored-text` }), {}, logger, { skipRebuild: false },
        )).rejects.toThrow('[site] domain');
      } finally {
        await fs.rm(undeclaredDir, { recursive: true, force: true });
      }
    });
  });

  describe('browse', () => {
    it('lists nothing for an empty knowledge base', async () => {
      const response = await busRequest(actors, 'browse:resources-requested', {});
      expect(response.resources).toEqual([]);
      expect(response.total).toBe(0);
    });

    it('lists a stowed resource, and describes it by id', async () => {
      const id = await seed('overview', 'hello world');

      const list = await busRequest(actors, 'browse:resources-requested', {});
      expect(list.resources.map((r) => [r['@id'], r.name])).toEqual([[id, 'overview']]);

      const one = await busRequest(actors, 'browse:resource-requested', { resourceId: id });
      expect(one.resource['@id']).toBe(id);
      expect(Array.isArray(one.annotations)).toBe(true);
      expect(Array.isArray(one.entityReferences)).toBe(true);
    });

    it('answers not-found for an id the record does not hold', async () => {
      const asked = busRequest(actors, 'browse:resource-requested', { resourceId: makeResourceId('does-not-exist') });
      await expect(asked).rejects.toBeInstanceOf(BusRequestError);
      await expect(asked).rejects.toMatchObject({ code: 'bus.not-found' });
    });
  });

  describe('mark', () => {
    it('an annotation is in the view by the time its create is confirmed', async () => {
      const rId = await seed('doc', 'hello world');
      const id = await highlight(rId, 0, 5, 'hello');
      expect((await annotationsOf(rId)).map((a) => a.id)).toContain(id);
    });

    it('a deleted annotation leaves the view', async () => {
      const rId = await seed('doc', 'hello world');
      const id = await highlight(rId, 0, 5, 'hello');

      await busRequest(actors, 'mark:delete', { annotationId: id, resourceId: rId, _userId: USER });

      expect((await annotationsOf(rId)).map((a) => a.id)).not.toContain(id);
    });
  });

  describe('bind', () => {
    it('links a reference annotation to a target resource', async () => {
      const sourceId = await seed('src', 'see also: target');
      const targetId = await seed('target', 'target body');
      const id = await highlight(sourceId, 10, 16, 'target', 'linking');

      await busRequest(actors, 'bind:update-body', {
        annotationId: id,
        resourceId: sourceId,
        operations: [{ op: 'add', item: { type: 'SpecificResource', source: targetId, purpose: 'linking' } }],
        _userId: USER,
      });

      const linked = (await annotationsOf(sourceId)).find((a) => a.id === id);
      const bodies = Array.isArray(linked?.body) ? linked.body : linked?.body ? [linked.body] : [];
      expect(bodies).toContainEqual(expect.objectContaining({ type: 'SpecificResource', source: targetId }));
    });
  });

  describe('frame', () => {
    it('an added entity type is listed', async () => {
      await busRequest(actors, 'frame:add-entity-type', { tag: 'Archivist Test Type', _userId: USER });
      const response = await busRequest(actors, 'browse:entity-types-requested', {});
      expect(response.entityTypes).toContain('Archivist Test Type');
    });

    it('an added tag schema is listed with its tags', async () => {
      const schema = {
        id: 'archivist-compose-test-schema',
        name: 'Archivist Compose Test Schema',
        description: 'Round-trip schema',
        domain: 'test',
        tags: [
          { name: 'X', description: 'cat X', examples: [] },
          { name: 'Y', description: 'cat Y', examples: [] },
        ],
      };
      await busRequest(actors, 'frame:add-tag-schema', { schema, _userId: USER });
      const response = await busRequest(actors, 'browse:tag-schemas-requested', {});
      const found = response.tagSchemas.find((s) => s.id === schema.id);
      expect(found?.tags.map((t) => t.name)).toEqual(['X', 'Y']);
    });
  });
});
