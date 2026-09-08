/**
 * `mark:commit` is at-least-once, and the event log is the system of record.
 *
 * COMMIT-ACK-FALSE-FAILURE V2. Two things were already idempotent by annotation
 * id — the resource view (`view-materializer.ts`) and the graph
 * (`weaver.ts`) — and both of them are PROJECTIONS. The log itself appends
 * whatever it is handed. So a re-committed batch leaves a green graph over a
 * doubled log, which is the failure mode hardest to notice and impossible to
 * undo.
 *
 * Two paths re-send a batch that already landed, and neither is exotic:
 *
 *   1. The acknowledgement is lost after a successful append. The unit is never
 *      checkpointed (`worker-process.ts` pushes to `committed` only AFTER the
 *      commit resolves), so the retry re-runs exactly the unit that landed.
 *   2. A batch fails partway. The Stower reports failure without a partial
 *      count and the worker retries the WHOLE unit, re-appending the prefix.
 *
 * These tests therefore assert on APPENDS, never on a projection: every
 * projection already passes them and would hide the defect.
 *
 * What is NOT under test here, deliberately: id determinism (pinned in
 * `@semiont/jobs`'s annotation-idempotence.test.ts and core's id tests) and the
 * projections' own at-least-once guards, which stay — delivery duplication and
 * log duplication are different concerns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus, type Annotation, type Logger, type ResourceId } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import { Stower } from '../stower';

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

const RID = 'res-commit-idem';
const USER = 'did:web:test:users:test';

const annotation = (id: string) => ({ id, type: 'Annotation', motivation: 'highlighting' }) as unknown as Annotation;

/**
 * An event log that behaves like the real one — it appends what it is told —
 * paired with the materialized view the real EventStore keeps in step with it.
 *
 * The view is DERIVED from the appended events here, exactly as
 * `materializeIncremental` derives it in production, so this fake cannot
 * accidentally answer a question the real store would answer differently.
 */
function fakeStore() {
  const appended: Array<{ type: string; payload: any }> = [];
  const appendEvent = vi.fn(async (event: { type: string; payload: any }) => {
    appended.push(event);
    return event;
  });
  const viewStorage = {
    get: vi.fn(async (_rid: ResourceId) => ({
      resource: {} as never,
      annotations: {
        resourceId: _rid,
        // Idempotent by id, as the materializer is.
        annotations: appended
          .filter((e) => e.type === 'mark:added')
          .map((e) => e.payload.annotation as Annotation)
          .filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i),
        version: appended.length,
        updatedAt: new Date().toISOString(),
      },
    })),
  };
  const markAddedIds = () =>
    appended.filter((e) => e.type === 'mark:added').map((e) => String(e.payload.annotation.id));

  return { appendEvent, viewStorage, appended, markAddedIds, stores: { eventStore: { appendEvent, viewStorage } } as never };
}

describe('mark:commit does not duplicate the event log', () => {
  let bus: EventBus;
  let stower: Stower;
  let store: ReturnType<typeof fakeStore>;

  beforeEach(async () => {
    vi.clearAllMocks();
    bus = new EventBus();
    store = fakeStore();
    stower = new Stower(store.stores, bus, {} as SemiontProject, silentLogger);
    await stower.initialize();
  });

  afterEach(async () => {
    await stower.stop?.();
    bus.destroy();
  });

  /** The handler runs inside a concatMap; give the queue a turn. */
  const settle = () => new Promise((r) => setTimeout(r, 20));

  const commit = async (ids: string[], correlationId = 'c1') => {
    bus.get('mark:commit').next({
      resourceId: RID,
      correlationId,
      annotations: ids.map(annotation),
      _userId: USER,
    } as never);
    await settle();
  };

  it('re-committing an identical batch appends nothing the second time', async () => {
    // The measured scenario: 1,673 annotations durable, acknowledgement lost,
    // job retried. Today this appends 1,673 more.
    await commit(['a1', 'a2', 'a3'], 'first');
    expect(store.markAddedIds()).toEqual(['a1', 'a2', 'a3']);

    await commit(['a1', 'a2', 'a3'], 'retry');

    expect(store.markAddedIds()).toEqual(['a1', 'a2', 'a3']);
  });

  it('a retried partial batch appends only the annotations still missing', async () => {
    // Path 2: the first commit died after `a1`, so the worker retried the unit
    // whole. `a1` must not land twice, and `a2`/`a3` must still land.
    await commit(['a1'], 'partial');

    await commit(['a1', 'a2', 'a3'], 'retry');

    expect(store.markAddedIds()).toEqual(['a1', 'a2', 'a3']);
  });

  it('still acknowledges the retry — a durable batch is a successful commit', async () => {
    // The worker cannot advance without an ack. A commit that appends nothing
    // because everything is already durable has SUCCEEDED, and saying so is
    // what stops the retry loop.
    const acks: any[] = [];
    bus.get('mark:commit-ok').subscribe((e) => acks.push(e));

    await commit(['a1', 'a2'], 'first');
    await commit(['a1', 'a2'], 'retry');

    expect(acks).toHaveLength(2);
    expect(acks[1].correlationId).toBe('retry');
    // `persisted` is the DURABLE count the schema promises ("every annotation
    // named by the command is in the event log"), not an append tally — so it
    // reads the same on the retry as on the first commit. A caller cannot tell
    // the two apart, and must not need to.
    expect(acks[1].response.persisted).toBe(2);
    expect(acks[1].response.annotationIds).toEqual(['a1', 'a2']);
  });

  it('appends in batch order and stops at the first failure', async () => {
    // A CROSS-PACKAGE invariant, gated here because this side owns it.
    // `batchIsDurable` in @semiont/jobs probes only the LAST annotation of a
    // batch and reads its presence as "the whole batch landed". That is sound
    // exactly while appends run in order and abort on the first failure — so
    // if someone parallelizes this loop, the worker's probe silently starts
    // reporting success over partial data. It fails here first instead.
    store.appendEvent.mockImplementation(async (event: any) => {
      if (event.payload?.annotation?.id === 'a2') throw new Error('disk full');
      store.appended.push(event);
      return event;
    });

    await commit(['a1', 'a2', 'a3'], 'partial');

    expect(store.markAddedIds()).toEqual(['a1']);
  });

  it('distinct annotations on one resource all land', async () => {
    // The guard on the guard: a dedupe keyed too coarsely (by resource, by
    // batch, by count) would silently collapse a real detection run into one
    // annotation and pass every test above.
    await commit(['a1', 'a2'], 'first');
    await commit(['b1', 'b2'], 'second');

    expect(store.markAddedIds()).toEqual(['a1', 'a2', 'b1', 'b2']);
  });
});
