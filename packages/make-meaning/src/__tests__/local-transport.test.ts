/**
 * SemiontClient over LocalTransport — end-to-end coverage.
 *
 * Exercises the namespace surface and bus bridge against a real
 * `KnowledgeSystem` booted in-process via `startMakeMeaning`. No HTTP
 * mock, no actor-vm mock — the bus events flow through the same actors
 * production uses, just bridged into the client via `LocalTransport`.
 */

import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { firstValueFrom, race, timer, type Observable } from 'rxjs';
import { filter, map, take } from 'rxjs/operators';

import {
  EventBus,
  annotationId as makeAnnotationId,
  entityType as makeEntityType,
  resourceId as makeResourceId,
  userDID,
  userId as makeUserId,
  type Logger,
  type ResourceId,
} from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { SemiontClient } from '@semiont/api-client';

import { LocalTransport } from '../local-transport';
import { LocalContentTransport } from '../local-content-transport';
import { ResourceOperations } from '../resource-operations';
import { startMakeMeaning, type MakeMeaningConfig, type MakeMeaningService } from '../service';

const SETTLE_MS = 5_000;

const silentLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

const config: MakeMeaningConfig = {
  services: {
    graph: { platform: { type: 'posix' }, type: 'memory' },
  },
  actors: {
    gatherer: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
    matcher:  { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
  },
  workers: {
    default: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
  },
};

const TEST_USER_DID = userDID('did:semiont:test-host');
const TEST_USER_ID  = makeUserId('test-host');

interface Harness {
  client: SemiontClient;
  service: MakeMeaningService;
  eventBus: EventBus;
  seedResource(input: { name: string; content: string; format?: string; entityTypes?: string[] }): Promise<ResourceId>;
  dispose(): Promise<void>;
}

async function bootHarness(): Promise<Harness> {
  const testDir = join(tmpdir(), `semiont-local-${uuidv4()}`);
  await fs.mkdir(testDir, { recursive: true });
  const project = new SemiontProject(testDir);
  const eventBus = new EventBus();
  let service: MakeMeaningService | null = null;
  let client: SemiontClient | null = null;

  try {
    service = await startMakeMeaning(project, config, eventBus, silentLogger);
    const transport = new LocalTransport({
      knowledgeSystem: service.knowledgeSystem,
      eventBus,
      userId: TEST_USER_DID,
    });
    const content = new LocalContentTransport(service.knowledgeSystem);
    client = new SemiontClient(transport, content);

    const seedResource = async (input: {
      name: string;
      content: string;
      format?: string;
      entityTypes?: string[];
    }): Promise<ResourceId> => {
      const buf = Buffer.from(input.content, 'utf-8');
      const storageUri = `file://${input.name}-${uuidv4()}.txt`;
      const stored = await service!.knowledgeSystem.kb.content.store(buf, storageUri);
      return ResourceOperations.createResource(
        {
          name: input.name,
          storageUri: stored.storageUri,
          contentChecksum: stored.checksum,
          byteSize: stored.byteSize,
          format: (input.format ?? 'text/plain') as 'text/plain',
          entityTypes: input.entityTypes,
        },
        TEST_USER_ID,
        eventBus,
      );
    };

    const dispose = async () => {
      try { client?.dispose(); } catch { /* */ }
      try { await service!.stop(); } catch { /* */ }
      try { eventBus.destroy(); } catch { /* */ }
      try { await project.destroy(); } catch { /* */ }
      await fs.rm(testDir, { recursive: true, force: true });
    };

    return { client, service, eventBus, seedResource, dispose };
  } catch (err) {
    try { client?.dispose(); } catch { /* */ }
    try { if (service) await service.stop(); } catch { /* */ }
    try { eventBus.destroy(); } catch { /* */ }
    try { await project.destroy(); } catch { /* */ }
    await fs.rm(testDir, { recursive: true, force: true });
    throw err;
  }
}

/** Race a bus event match (filtered by predicate) against a timeout. */
async function waitForEvent<T>(
  obs: Observable<T>,
  predicate: (v: T) => boolean,
  timeoutMs: number = SETTLE_MS,
): Promise<void> {
  await firstValueFrom(
    race(
      obs.pipe(filter(predicate), take(1), map(() => true)),
      timer(timeoutMs).pipe(map(() => true)),
    ),
  );
}

describe('SemiontClient over LocalTransport', () => {
  describe('browse', () => {
    it('returns an empty list for an empty knowledge base', async () => {
      const h = await bootHarness();
      try {
        const result = await h.client.browseResources();
        expect(result.resources).toHaveLength(0);
        expect(result.total).toBe(0);
      } finally {
        await h.dispose();
      }
    });

    it('lists a seeded resource via browseResources', async () => {
      const h = await bootHarness();
      try {
        const id = await h.seedResource({ name: 'overview', content: 'hello world' });
        const result = await h.client.browseResources();
        expect(result.total).toBe(1);
        expect(result.resources).toHaveLength(1);
        const got = result.resources[0]!;
        expect(got['@id'] ?? got.id).toBe(id);
        expect(got.name).toBe('overview');
      } finally {
        await h.dispose();
      }
    });

    it('returns the seeded resource via browseResource(id)', async () => {
      const h = await bootHarness();
      try {
        const id = await h.seedResource({ name: 'doc', content: 'body' });
        const result = await h.client.browseResource(id);
        expect(result.resource).toBeDefined();
        expect(result.resource['@id'] ?? result.resource.id).toBe(id);
      } finally {
        await h.dispose();
      }
    });

    it('rejects browseResource for a non-existent id', async () => {
      const h = await bootHarness();
      try {
        const missing = makeResourceId('does-not-exist');
        await expect(h.client.browseResource(missing)).rejects.toThrow();
      } finally {
        await h.dispose();
      }
    });
  });

  describe('mark', () => {
    it('creates an annotation visible via browseAnnotations', async () => {
      const h = await bootHarness();
      try {
        const rId = await h.seedResource({ name: 'doc', content: 'hello world' });

        // markAnnotation returns once `mark:create-ok` fires, which the
        // assembly handler emits only after `mark:added` is published —
        // and `eventStore.appendEvent` materializes the view before
        // publishing the typed channel. So the view is current by the
        // time this resolves.
        const { annotationId } = await h.client.markAnnotation(rId, {
          motivation: 'highlighting',
          target: {
            source: rId as unknown as string,
            selector: [
              { type: 'TextPositionSelector', start: 0, end: 5 },
              { type: 'TextQuoteSelector', exact: 'hello' },
            ],
          },
        });

        const list = await h.client.browseAnnotations(rId);
        expect(list.annotations.length).toBeGreaterThan(0);
        expect(list.annotations.map((a) => a.id)).toContain(annotationId);
      } finally {
        await h.dispose();
      }
    });

    it('removes an annotation via deleteAnnotation', async () => {
      const h = await bootHarness();
      try {
        const rId = await h.seedResource({ name: 'doc', content: 'hello world' });

        const { annotationId: aIdStr } = await h.client.markAnnotation(rId, {
          motivation: 'highlighting',
          target: {
            source: rId as unknown as string,
            selector: [
              { type: 'TextPositionSelector', start: 0, end: 5 },
              { type: 'TextQuoteSelector', exact: 'hello' },
            ],
          },
        });
        const aId = makeAnnotationId(aIdStr);

        await h.client.deleteAnnotation(rId, aId);

        await waitForEvent(
          h.client.bus.get('mark:delete-ok') as unknown as Observable<{ annotationId: string }>,
          (e) => e.annotationId === aIdStr,
        );

        const list = await h.client.browseAnnotations(rId);
        expect(list.annotations.map((a) => a.id)).not.toContain(aIdStr);
      } finally {
        await h.dispose();
      }
    });
  });

  describe('bind', () => {
    it('links a reference annotation to a target resource', async () => {
      const h = await bootHarness();
      try {
        const sourceId = await h.seedResource({ name: 'src', content: 'see also: target' });
        const targetId = await h.seedResource({ name: 'target', content: 'target body' });

        const { annotationId: aIdStr } = await h.client.markAnnotation(sourceId, {
          motivation: 'linking',
          target: {
            source: sourceId as unknown as string,
            selector: [
              { type: 'TextPositionSelector', start: 10, end: 16 },
              { type: 'TextQuoteSelector', exact: 'target' },
            ],
          },
        });
        const aId = makeAnnotationId(aIdStr);

        await h.client.bindAnnotation(sourceId, aId, {
          operations: [
            {
              op: 'add',
              item: { type: 'SpecificResource', source: targetId as unknown as string, purpose: 'linking' },
            },
          ],
        });

        await waitForEvent(
          h.client.bus.get('bind:body-updated') as unknown as Observable<{ annotationId: string }>,
          (e) => e.annotationId === aIdStr,
        );

        const list = await h.client.browseAnnotations(sourceId);
        const linked = list.annotations.find((a) => a.id === aIdStr);
        expect(linked).toBeDefined();
        const bodies = Array.isArray(linked!.body) ? linked!.body : (linked!.body ? [linked!.body] : []);
        const linkedBody = bodies.find(
          (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'SpecificResource',
        ) as { source?: string } | undefined;
        expect(linkedBody?.source).toBe(targetId);
      } finally {
        await h.dispose();
      }
    });
  });

  describe('lifecycle', () => {
    it('addEntityType + listEntityTypes round-trips', async () => {
      const h = await bootHarness();
      try {
        const tag = makeEntityType('Person');
        await h.client.addEntityType(tag);

        // `mark:entity-type-added` carries a `StoredEvent` whose
        // `payload.entityType` echoes the tag; wait for it to
        // confirm Stower has appended + materialized the system view
        // before listing.
        await waitForEvent(
          h.client.bus.get('mark:entity-type-added') as unknown as Observable<{ payload?: { entityType?: string } }>,
          (e) => e.payload?.entityType === (tag as unknown as string),
        );

        const result = await h.client.listEntityTypes();
        expect(result.entityTypes).toContain(tag);
      } finally {
        await h.dispose();
      }
    });

    it('failure events are bridged into client.bus', async () => {
      const h = await bootHarness();
      try {
        const failed$ = (
          h.client.bus.get('browse:resource-failed') as unknown as Observable<{ message: string }>
        ).pipe(take(1));
        const observed = firstValueFrom(failed$);

        await expect(h.client.browseResource(makeResourceId('does-not-exist'))).rejects.toThrow();

        const ev = await observed;
        expect(ev.message).toBeTruthy();
      } finally {
        await h.dispose();
      }
    });

    it('client.dispose() does not throw and tears down the transport', async () => {
      const h = await bootHarness();
      try {
        await h.client.browseResources();
        expect(() => h.client.dispose()).not.toThrow();
      } finally {
        // Avoid double-disposing the client; harness.dispose() guards.
        await h.dispose();
      }
    });
  });
});
