/**
 * Stower `mark:update-entity-types` vocabulary gate
 * (bugs/update-entity-types-skips-vocabulary-validation.md)
 *
 * Entity tags are a CONTROLLED VOCABULARY (ratified 2026-07-09). The direct
 * update path must enforce the same gate the job path already does — same
 * machinery (readEntityTypesProjection + validateEntityTypes), same
 * "Entity type not registered: …" message — with two boundary rules:
 *   - all-or-nothing per request: a mixed request must not half-land;
 *   - removals are NEVER vocabulary-gated: deleting a stale/unregistered
 *     legacy tag is the cleanup path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { firstValueFrom, race, timer } from 'rxjs';
import { filter, map, take } from 'rxjs/operators';
import { EventBus, resourceId, userId, type Logger, type ResourceId } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { getGraphDatabase } from '@semiont/graph';
import type { GraphServiceConfig } from '@semiont/core';
import { Stower } from '../stower';
import { createKnowledgeBase } from '../knowledge-base';
import { createTestProject } from './helpers/test-project';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

describe('Stower mark:update-entity-types vocabulary gate', () => {
  let teardown: () => Promise<void>;
  let project: SemiontProject;
  let eventStore: EventStore;
  let eventBus: EventBus;
  let stower: Stower;
  let rid: ResourceId;
  let cidCounter = 0;

  beforeEach(async () => {
    ({ project, teardown } = await createTestProject('stower-entity-types'));

    eventBus = new EventBus();
    eventStore = createEventStore(project, eventBus, mockLogger);
    const graphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
    const kb = await createKnowledgeBase(eventStore, project, graphDb, eventBus, mockLogger);
    stower = new Stower(kb, eventBus, project, mockLogger);
    await stower.initialize();

    // Registered vocabulary — seeded the same way the reader tests do.
    const systemDir = join(project.stateDir, 'projections', '__system__');
    await fs.mkdir(systemDir, { recursive: true });
    await fs.writeFile(join(systemDir, 'entitytypes.json'), JSON.stringify({ entityTypes: ['Person', 'Organization'] }));

    // A resource for the tags to live on (log-level, mirrors graph-consumer tests).
    rid = resourceId(`tags-res-${Date.now()}`);
    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: rid,
      userId: userId('user-1'),
      version: 1,
      payload: { name: 'Tagged', format: 'text/plain', contentChecksum: 'h1' },
    });
  });

  afterEach(async () => {
    await stower.stop();
    eventBus.destroy();
    await teardown();
  });

  function updateTags(current: string[], updated: string[]) {
    const correlationId = `uet-cid-${++cidCounter}`;
    const reply = firstValueFrom(
      race(
        eventBus.get('mark:update-entity-types-ok').pipe(
          filter((e) => e.correlationId === correlationId),
          map((e) => ({ kind: 'ok' as const, e })),
        ),
        eventBus.get('mark:update-entity-types-failed').pipe(
          filter((e) => e.correlationId === correlationId),
          map((e) => ({ kind: 'failed' as const, e })),
        ),
        timer(2000).pipe(
          map((): never => {
            throw new Error('no reply to mark:update-entity-types');
          }),
        ),
      ).pipe(take(1)),
    );
    eventBus.get('mark:update-entity-types').next({
      correlationId,
      _userId: 'user-1',
      resourceId: rid,
      currentEntityTypes: current,
      updatedEntityTypes: updated,
    });
    return reply.then((r) => ({ ...r, correlationId }));
  }

  async function tagEvents() {
    const events = await eventStore.log.getEvents(rid);
    return events.filter((e) => e.type === 'mark:entity-tag-added' || e.type === 'mark:entity-tag-removed');
  }

  it('rejects an unregistered add with the standard message and appends no events', async () => {
    const r = await updateTags([], ['Dragon']);
    if (r.kind !== 'failed') throw new Error('expected mark:update-entity-types-failed');
    expect(r.e.correlationId).toBe(r.correlationId);
    expect(r.e.message).toBe('Entity type not registered: Dragon');
    expect(await tagEvents()).toEqual([]);
  });

  it('is all-or-nothing: a mixed request appends nothing, not even the valid add', async () => {
    const r = await updateTags([], ['Person', 'Dragon']);
    if (r.kind !== 'failed') throw new Error('expected mark:update-entity-types-failed');
    expect(r.e.message).toBe('Entity type not registered: Dragon');
    expect(await tagEvents()).toEqual([]); // Person must NOT have half-landed
  });

  it('accepts adds within the registered vocabulary unchanged', async () => {
    const r = await updateTags([], ['Person', 'Organization']);
    expect(r.kind).toBe('ok');
    const events = await tagEvents();
    expect(events.map((e) => [e.type, e.payload.entityType])).toEqual([
      ['mark:entity-tag-added', 'Person'],
      ['mark:entity-tag-added', 'Organization'],
    ]);
  });

  it('never gates removals: an unregistered legacy tag can be removed', async () => {
    // 'LegacyGunk' is not in the vocabulary — removing it is the cleanup path
    // and must succeed; gating it would trap exactly the damage the gate prevents.
    const r = await updateTags(['LegacyGunk'], []);
    expect(r.kind).toBe('ok');
    const events = await tagEvents();
    expect(events.map((e) => [e.type, e.payload.entityType])).toEqual([
      ['mark:entity-tag-removed', 'LegacyGunk'],
    ]);
  });
});
