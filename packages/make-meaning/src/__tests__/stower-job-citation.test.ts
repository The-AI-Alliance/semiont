/**
 * A write that fulfils a job cites it — and a worker's write that does not is
 * refused, not defaulted.
 *
 * "No `jobId` → self-initiated" is a true two-case rule for a person or an
 * autonomous agent: they really are their own requester. It would be a silent
 * lie for a worker that forgot the field — requester = executor = the model,
 * and the person who asked vanishes from the record, which is the defect this
 * exists to close. So the rule is keyed on the capability the gateway stamps:
 * an emitter carrying `WORKER_ROLE` in `_roles` must cite a job, or the batch
 * is refused with `mark:commit-failed` and nothing is appended.
 *
 * The fake store mirrors `stower-commit-idempotence.test.ts`: the view is
 * derived from what was appended, so the assertion "nothing landed" is read
 * off the same surface the real materializer would answer from.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus, WORKER_ROLE, type Annotation, type Logger, type ResourceId } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import { Stower } from '../stower';

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

const RID = 'res-job-citation';
const WORKER_AGENT = 'did:web:test:agents:ollama:gemma';
const PERSON = 'did:web:test:users:alice';
const JOB = 'job-42';

const annotation = (id: string) => ({ id, type: 'Annotation', motivation: 'highlighting' }) as unknown as Annotation;

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
        annotations: appended
          .filter((e) => e.type === 'mark:added')
          .map((e) => e.payload.annotation as Annotation),
        version: appended.length,
        updatedAt: new Date().toISOString(),
      },
    })),
  };
  const markAddedIds = () =>
    appended.filter((e) => e.type === 'mark:added').map((e) => String(e.payload.annotation.id));
  return { markAddedIds, stores: { eventStore: { appendEvent, viewStorage } } as never };
}

describe('a worker-role write must cite the job it fulfils', () => {
  let bus: EventBus;
  let stower: Stower;
  let store: ReturnType<typeof fakeStore>;
  let failed: Array<{ message: string }>;

  beforeEach(async () => {
    vi.clearAllMocks();
    bus = new EventBus();
    store = fakeStore();
    failed = [];
    bus.on('mark:commit-failed').subscribe((p) => { failed.push(p as { message: string }); });
    stower = new Stower(store.stores, bus, {} as SemiontProject, silentLogger);
    await stower.initialize();
  });

  afterEach(async () => {
    await stower.stop?.();
    bus.destroy();
  });

  /** The handler runs inside a concatMap; give the queue a turn. */
  const settle = () => new Promise((r) => setTimeout(r, 20));

  const commit = async (fields: Record<string, unknown>) => {
    bus.emit('mark:commit', {
      resourceId: RID,
      annotations: [annotation('a1')],
      ...fields,
    } as never, { correlationId: 'c1' });
    await settle();
  };

  it('refuses a WORKER_ROLE emitter that cites no job, and appends nothing', async () => {
    await commit({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE] });

    expect(failed).toHaveLength(1);
    expect(failed[0]!.message).toMatch(/jobId/);
    expect(store.markAddedIds()).toEqual([]);
  });

  it('accepts a WORKER_ROLE emitter that cites a job', async () => {
    await commit({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], jobId: JOB });

    expect(failed).toEqual([]);
    expect(store.markAddedIds()).toEqual(['a1']);
  });

  it('accepts a person citing no job — self-initiated work has no job to cite', async () => {
    await commit({ _userId: PERSON });

    expect(failed).toEqual([]);
    expect(store.markAddedIds()).toEqual(['a1']);
  });

  it('accepts an agent without the worker role citing no job — autonomous work (row 5)', async () => {
    // An agent token a non-worker minted carries no WORKER_ROLE, so the rule
    // does not reach it: it is its own requester, like a person.
    await commit({ _userId: WORKER_AGENT });

    expect(failed).toEqual([]);
    expect(store.markAddedIds()).toEqual(['a1']);
  });
});
