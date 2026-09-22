/**
 * A write that fulfils a job cites it, and everything the record says about
 * who requested and who produced it is DERIVED from the log — never taken
 * from the emitter (VERIFIED-PROVENANCE P1/P2).
 *
 * The join is local. The dispatcher's `job:assigned` (holder + requester) and
 * the worker's write both land on the same resource's log, so the Stower
 * reads its own store and nothing else: this must hold with the dispatcher's
 * KV lost and rebuilt from the log.
 *
 * Omission is refused, not defaulted. "No `jobId` → self-initiated" is a true
 * two-case rule for a person or an autonomous agent; for a worker that forgot
 * the field it would silently attribute the person's request to the model.
 * So the rule keys on the capability the gateway stamps.
 *
 * The fake store mirrors `stower-commit-idempotence.test.ts` and adds the raw
 * log the join reads. The view is derived from what was appended, so every
 * "what landed" assertion reads the surface the real materializer would.
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
const DISPATCHER = 'did:web:test:agents:semiont:dispatcher';
const WORKER_AGENT = 'did:web:test:agents:ollama:gemma';
const OTHER_AGENT = 'did:web:test:agents:anthropic:claude';
const PERSON = 'did:web:test:users:alice';
const JOB = 'job-42';

const annotation = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'Annotation', motivation: 'highlighting', ...extra }) as unknown as Annotation;

function fakeStore() {
  const appended: Array<{ type: string; resourceId: string; userId: string; payload: any }> = [];
  const appendEvent = vi.fn(async (event: { type: string; resourceId: string; userId: string; payload: any }) => {
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
  /** The raw log the Stower joins against — scoped by resource, as EventLog is. */
  const log = { getEvents: vi.fn(async (rid: ResourceId) => appended.filter((e) => String(e.resourceId) === String(rid))) };
  const markAdded = () => appended.filter((e) => e.type === 'mark:added').map((e) => e.payload.annotation as Annotation);
  const markAddedIds = () => markAdded().map((a) => String(a.id));
  /** The content store the resource handlers register bytes with; the checksum is all they read back. */
  const content = { register: vi.fn(async (_uri: string, checksum: string) => ({ checksum })) };
  return {
    appended, markAdded, markAddedIds, log,
    stores: { eventStore: { appendEvent, viewStorage, log }, content } as never,
  };
}

const ids = (agents: Array<{ '@id'?: string }> | { '@id'?: string } | undefined) =>
  Array.isArray(agents) ? agents.map((a) => a['@id']) : agents ? [agents['@id']] : [];

describe('a write that fulfils a job cites it, and its provenance is derived from the log', () => {
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

  /** The dispatcher's record of an accepted claim, under its own identity. */
  const assigned = async (fields: { holder: string; requester: string; jobId?: string }) => {
    bus.emit('job:assign', {
      jobId: fields.jobId ?? JOB,
      jobType: 'highlight-annotation',
      resourceId: RID,
      holder: fields.holder,
      requester: fields.requester,
      _userId: DISPATCHER,
    } as never);
    await settle();
  };

  const commit = async (fields: Record<string, unknown>, annotations: Annotation[] = [annotation('a1')]) => {
    bus.emit('mark:commit', { resourceId: RID, annotations, ...fields } as never, { correlationId: 'c1' });
    await settle();
  };

  describe('citing the job', () => {
    it('refuses a WORKER_ROLE emitter that cites no job, and appends nothing', async () => {
      await commit({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE] });

      expect(failed).toHaveLength(1);
      expect(failed[0]!.message).toMatch(/jobId/);
      expect(store.markAddedIds()).toEqual([]);
    });

    it('accepts a person citing no job — self-initiated work has no job to cite', async () => {
      await commit({ _userId: PERSON });

      expect(failed).toEqual([]);
      expect(store.markAddedIds()).toEqual(['a1']);
    });

    it('accepts an agent without the worker role citing no job — autonomous work (row 5)', async () => {
      await commit({ _userId: WORKER_AGENT });

      expect(failed).toEqual([]);
      expect(store.markAddedIds()).toEqual(['a1']);
    });
  });

  describe('the join against job:assigned', () => {
    it('persists the dispatcher\'s job:assigned under the dispatcher\'s identity', async () => {
      await assigned({ holder: WORKER_AGENT, requester: PERSON });

      const rec = (await store.log.getEvents(RID as ResourceId)).find((e) => e.type === 'job:assigned');
      expect(rec).toMatchObject({ userId: DISPATCHER, payload: { jobId: JOB, holder: WORKER_AGENT, requester: PERSON } });
    });

    it('derives creator from the requester and generator from the executor, both parties attributed', async () => {
      await assigned({ holder: WORKER_AGENT, requester: PERSON });
      await commit({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], jobId: JOB });

      expect(failed).toEqual([]);
      const [a] = store.markAdded();
      expect(a).toBeDefined();
      expect(a!.creator).toMatchObject({ '@type': 'Person', '@id': PERSON });
      expect(a!.generator).toMatchObject({ '@type': 'Software', '@id': WORKER_AGENT });
      expect(ids(a!.wasAttributedTo)).toEqual([PERSON, WORKER_AGENT]);
    });

    it('keeps a supplied generator\'s parameters when its identity is the executor\'s', async () => {
      await assigned({ holder: WORKER_AGENT, requester: PERSON });
      const generator = { '@type': 'Software', '@id': WORKER_AGENT, name: 'gemma', provider: 'ollama', model: 'gemma', parameters: { temperature: 0.1 } };
      await commit({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], jobId: JOB }, [annotation('a1', { generator })]);

      expect(failed).toEqual([]);
      const [a] = store.markAdded();
      expect(a!.generator).toMatchObject({ '@id': WORKER_AGENT, parameters: { temperature: 0.1 } });
    });

    it('refuses a commit citing a job whose recorded holder is someone else', async () => {
      await assigned({ holder: OTHER_AGENT, requester: PERSON });
      await commit({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], jobId: JOB });

      expect(failed).toHaveLength(1);
      expect(failed[0]!.message).toMatch(/holder/);
      expect(store.markAddedIds()).toEqual([]);
    });

    it('refuses a commit citing a job this resource\'s log holds no assignment for', async () => {
      await commit({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], jobId: JOB });

      expect(failed).toHaveLength(1);
      expect(failed[0]!.message).toMatch(/assign/);
      expect(store.markAddedIds()).toEqual([]);
    });
  });

  describe('nothing about identity is taken from the payload', () => {
    it('refuses a worker that sends creator — the assertion this design exists to prevent', async () => {
      await assigned({ holder: WORKER_AGENT, requester: PERSON });
      const creator = { '@type': 'Person', '@id': 'did:web:test:users:mallory', name: 'mallory' };
      await commit({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], jobId: JOB }, [annotation('a1', { creator })]);

      expect(failed).toHaveLength(1);
      expect(failed[0]!.message).toMatch(/creator/);
      expect(store.markAddedIds()).toEqual([]);
    });

    it('refuses a generator whose identity is not the executor', async () => {
      await assigned({ holder: WORKER_AGENT, requester: PERSON });
      const generator = { '@type': 'Software', '@id': OTHER_AGENT, name: 'claude' };
      await commit({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], jobId: JOB }, [annotation('a1', { generator })]);

      expect(failed).toHaveLength(1);
      expect(failed[0]!.message).toMatch(/not the executor/);
      expect(store.markAddedIds()).toEqual([]);
    });

    it('a person\'s own annotation is attributed to the person alone, derived the same way', async () => {
      await commit({ _userId: PERSON });

      const [a] = store.markAdded();
      expect(a!.creator).toMatchObject({ '@type': 'Person', '@id': PERSON });
      expect(a!.generator).toBeUndefined();
      expect(ids(a!.wasAttributedTo)).toEqual([PERSON]);
    });

    it('refuses a multi-agent generator on mark:commit — derivation binds one generator to the executor', async () => {
      await assigned({ holder: WORKER_AGENT, requester: PERSON });
      const generator = [{ '@type': 'Software', '@id': WORKER_AGENT, name: 'gemma' }];
      await commit({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], jobId: JOB }, [annotation('a1', { generator })]);

      expect(failed).toHaveLength(1);
      expect(failed[0]!.message).toMatch(/multi-agent/);
      expect(store.markAddedIds()).toEqual([]);
    });
  });

  describe('the assembled path (mark:create) refuses the same assertions', () => {
    let createFailed: Array<{ message: string }>;

    beforeEach(() => {
      createFailed = [];
      bus.on('mark:create-failed').subscribe((p) => { createFailed.push(p as { message: string }); });
    });

    const markCreate = async (fields: Record<string, unknown>, ann: Annotation = annotation('a1')) => {
      bus.emit('mark:create', { resourceId: RID, annotation: ann, ...fields } as never, { correlationId: 'm1' });
      await settle();
    };

    it('refuses an annotation that names its creator', async () => {
      const creator = { '@type': 'Person', '@id': 'did:web:test:users:mallory', name: 'mallory' };
      await markCreate({ _userId: PERSON }, annotation('a1', { creator }));

      expect(createFailed).toHaveLength(1);
      expect(createFailed[0]!.message).toMatch(/creator/);
      expect(store.markAddedIds()).toEqual([]);
    });

    it('refuses a multi-agent generator', async () => {
      const generator = [{ '@type': 'Software', '@id': WORKER_AGENT, name: 'gemma' }];
      await markCreate({ _userId: WORKER_AGENT }, annotation('a1', { generator }));

      expect(createFailed).toHaveLength(1);
      expect(createFailed[0]!.message).toMatch(/multi-agent/);
      expect(store.markAddedIds()).toEqual([]);
    });

    it('derives the emitter as creator, and as generator when the emitter is software', async () => {
      await markCreate({ _userId: WORKER_AGENT });

      expect(createFailed).toEqual([]);
      const [a] = store.markAdded();
      expect(a!.creator).toMatchObject({ '@type': 'Software', '@id': WORKER_AGENT });
      expect(a!.generator).toMatchObject({ '@type': 'Software', '@id': WORKER_AGENT });
      expect(ids(a!.wasAttributedTo)).toEqual([WORKER_AGENT]);
    });
  });

  describe('job:assign is a gateway-stamped command like any other', () => {
    it('records nothing when the stamp is missing — a programming error, surfaced as a pipeline error', async () => {
      bus.emit('job:assign', {
        jobId: JOB, jobType: 'highlight-annotation', resourceId: RID, holder: WORKER_AGENT, requester: PERSON,
      } as never);
      await settle();

      expect(store.appended.find((e) => e.type === 'job:assigned')).toBeUndefined();
      expect(silentLogger.error).toHaveBeenCalledWith('Stower pipeline error', expect.objectContaining({
        error: expect.objectContaining({ message: expect.stringMatching(/_userId/) }),
      }));
    });
  });

  describe('a generated resource cites the job; its provenance is derived from the SOURCE resource\'s log', () => {
    // A generation's job events sit on the resource it generates FROM
    // (`lifecycleBase.resourceId`), while the yield:create targets a resource
    // that does not exist yet. So the join reads the source's log, which the
    // command names in generatedFrom.resourceId.
    const SOURCE = 'res-source';
    let createFailed: Array<{ message: string }>;

    beforeEach(() => {
      createFailed = [];
      bus.on('yield:create-failed').subscribe((p) => { createFailed.push(p as { message: string }); });
    });

    const assignedOn = async (rid: string, fields: { holder: string; requester: string }) => {
      bus.emit('job:assign', {
        jobId: JOB, jobType: 'generation', resourceId: rid,
        holder: fields.holder, requester: fields.requester, _userId: DISPATCHER,
      } as never);
      await settle();
    };

    const create = async (fields: Record<string, unknown>) => {
      bus.emit('yield:create', {
        name: 'gen.md', storageUri: 'file://gen.md', contentChecksum: 'sha-gen', byteSize: 3, format: 'text/markdown',
        ...fields,
      } as never, { correlationId: 'y1' });
      await settle();
    };

    const yieldCreated = () => store.appended.find((e) => e.type === 'yield:created');

    it('derives creator from the requester on the source\'s assignment, generator from the executor', async () => {
      await assignedOn(SOURCE, { holder: WORKER_AGENT, requester: PERSON });
      await create({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], jobId: JOB, generatedFrom: { resourceId: SOURCE } });

      expect(createFailed).toEqual([]);
      const e = yieldCreated();
      expect(e).toBeDefined();
      expect(e!.payload.creator).toMatchObject({ '@type': 'Person', '@id': PERSON });
      expect(e!.payload.generator).toMatchObject({ '@type': 'Software', '@id': WORKER_AGENT });
      expect(ids(e!.payload.wasAttributedTo)).toEqual([PERSON, WORKER_AGENT]);
    });

    it('refuses a WORKER_ROLE emitter that cites no job — the same rule as mark:commit', async () => {
      await create({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], generatedFrom: { resourceId: SOURCE } });

      expect(createFailed).toHaveLength(1);
      expect(createFailed[0]!.message).toMatch(/jobId/);
      expect(yieldCreated()).toBeUndefined();
    });

    it('refuses a multi-agent generator — derivation binds one generator to the executor', async () => {
      await assignedOn(SOURCE, { holder: WORKER_AGENT, requester: PERSON });
      const generator = [{ '@type': 'Software', '@id': WORKER_AGENT, name: 'gemma' }];
      await create({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], jobId: JOB, generatedFrom: { resourceId: SOURCE }, generator });

      expect(createFailed).toHaveLength(1);
      expect(createFailed[0]!.message).toMatch(/multi-agent/);
      expect(yieldCreated()).toBeUndefined();
    });

    it('refuses a create citing a job that does not name the source its job was assigned on', async () => {
      await assignedOn(SOURCE, { holder: WORKER_AGENT, requester: PERSON });
      await create({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], jobId: JOB });

      expect(createFailed).toHaveLength(1);
      expect(createFailed[0]!.message).toMatch(/source/);
      expect(yieldCreated()).toBeUndefined();
    });

    it('refuses a create citing a job whose recorded holder on the source is someone else', async () => {
      await assignedOn(SOURCE, { holder: OTHER_AGENT, requester: PERSON });
      await create({ _userId: WORKER_AGENT, _roles: [WORKER_ROLE], jobId: JOB, generatedFrom: { resourceId: SOURCE } });

      expect(createFailed).toHaveLength(1);
      expect(createFailed[0]!.message).toMatch(/holder/);
      expect(yieldCreated()).toBeUndefined();
    });

    it('a person\'s own upload is attributed to the person alone', async () => {
      await create({ _userId: PERSON });

      expect(createFailed).toEqual([]);
      const e = yieldCreated();
      expect(e!.payload.creator).toMatchObject({ '@type': 'Person', '@id': PERSON });
      expect(e!.payload.generator).toBeUndefined();
      expect(ids(e!.payload.wasAttributedTo)).toEqual([PERSON]);
    });

    it('a clone is attributed to the cloner alone — a clone is never job-fulfilling', async () => {
      bus.emit('yield:clone-persist', {
        name: 'copy.md', storageUri: 'file://copy.md', contentChecksum: 'sha-copy', byteSize: 3, format: 'text/markdown',
        parentResourceId: SOURCE, _userId: PERSON,
      } as never, { correlationId: 'k1' });
      await settle();

      const e = store.appended.find((ev) => ev.type === 'yield:cloned');
      expect(e).toBeDefined();
      expect(e!.payload.creator).toMatchObject({ '@type': 'Person', '@id': PERSON });
      expect(ids(e!.payload.wasAttributedTo)).toEqual([PERSON]);
    });
  });
});
