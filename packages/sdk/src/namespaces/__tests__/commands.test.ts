import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resourceContextFor, annotationContextFor } from '../../__tests__/fixtures/gathered-context';
import { mockResource } from '../../__tests__/fixtures/resource';
import { EventBus, resourceId, annotationId, jobId, userId } from '@semiont/core';
import { MarkNamespace } from '../mark';
import { BindNamespace } from '../bind';
import { GatherNamespace } from '../gather';
import { MatchNamespace } from '../match';
import { YieldNamespace } from '../yield';
import { JobNamespace } from '../job';
import { JobFailedError } from '../job-status-poll';
import type { JobEvent, UploadProgress } from '../../awaitable';
import type { EventMap, IGatewayOperations, ITransport, IContentTransport, GatheredContext } from '@semiont/core';
import { inMemoryTransport, gatewayOperationSpies } from '../../__tests__/helpers/in-memory-transport';

const RID = resourceId('res-1');
const AID = annotationId('ann-1');
const JID = jobId('j1');
const UID = userId('did:web:test:users:u');
// What the dispatcher holds for job `j1` whatever its type and status.
const J1_STORED = { jobId: JID, userId: UID, created: '2026-01-01T00:00:00.000Z' };
// The job's resource is derived FROM the focus — these fixtures carry RID/AID so
// the derivation pins below compare against known values.
const CTX_RES = resourceContextFor('res-1');
const CTX_ANN = annotationContextFor('res-1', 'ann-1');
// The context a match.search for reference `ref-1` is run with.
const REF = annotationId('ref-1');
const CTX_REF = annotationContextFor('res-1', 'ref-1');

/** Answers the request being handled, on any channel, with that channel's payload. */
type Reply = <K extends keyof EventMap>(channel: K, payload: EventMap[K]) => void;

/**
 * Mock transport whose `emit(channel, payload, envelope)` looks up a handler
 * and lets it reply on the transport's internal bus, in a frame whose envelope
 * carries the request's `correlationId`. busRequest reads replies via
 * `frames(resultChannel)` and matches on that envelope; this lets tests script
 * per-call request/response round-trips without faking SSE. A reply is typed
 * by the channel it goes out on, so a scripted payload the spec does not
 * define does not compile.
 */
function createMockTransport(
  responses: Partial<Record<keyof EventMap, (reply: Reply) => void>> = {},
): { transport: ITransport; emitSpy: ReturnType<typeof vi.fn>; transportBus: EventBus } {
  const transportBus = new EventBus();
  const emitSpy = vi.fn();

  const replyTo = (correlationId: string): Reply =>
    <K extends keyof EventMap>(channel: K, payload: EventMap[K]) => {
      queueMicrotask(() => { transportBus.emit(channel, payload, { correlationId }); });
    };

  const transport: ITransport & IGatewayOperations = {
    ...inMemoryTransport({
      bus: transportBus,
      onEmit: (channel, payload, envelope) => {
        emitSpy(channel, payload, envelope);
        const handler = responses[channel];
        if (!handler) return;
        const correlationId = envelope?.correlationId;
        if (correlationId === undefined) {
          throw new Error(`mock transport: ${channel} has a scripted reply but was emitted with no correlationId to answer`);
        }
        handler(replyTo(correlationId));
      },
    }),
    ...gatewayOperationSpies(),
  };

  return { transport, emitSpy, transportBus };
}

function makeMockContent(): IContentTransport {
  return {
    putBinary: vi.fn().mockResolvedValue({ resourceId: 'res-new' }),
    getBinary: vi.fn(),
    getBinaryStream: vi.fn(),
    getResourceGraph: vi.fn(),
    dispose: vi.fn(),
  };
}

// ── Mark ────────────────────────────────────────────────────────────────────

describe('MarkNamespace', () => {
  let eventBus: EventBus;
  let mark: MarkNamespace;

  beforeEach(() => {
    eventBus = new EventBus();
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
    });
    mark = new MarkNamespace(mock.transport, eventBus);
  });

  it('annotation() emits mark:create-request on bus', async () => {
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
      'mark:create-request': (reply) => reply('mark:create-ok', { response: { annotationId: annotationId('ann-new') } }),
    });
    const m = new MarkNamespace(mock.transport, eventBus);
    const result = await m.annotation({ motivation: 'highlighting', target: { source: RID } });
    expect(mock.emitSpy).toHaveBeenCalledWith('mark:create-request', expect.objectContaining({ resourceId: RID }), expect.objectContaining({ correlationId: expect.any(String) }));
    expect(result.annotationId).toBe('ann-new');
  });

  it('delete() emits mark:delete and resolves on mark:delete-ok', async () => {
    const mock = createMockTransport({
      'mark:delete': (reply) => reply('mark:delete-ok', { response: { annotationId: AID } }),
    });
    const m = new MarkNamespace(mock.transport, eventBus);
    await m.delete(RID, AID);
    expect(mock.emitSpy).toHaveBeenCalledWith('mark:delete', expect.objectContaining({ annotationId: AID, resourceId: RID }), expect.objectContaining({ correlationId: expect.any(String) }));
  });

  it('delete() REJECTS on mark:delete-failed — a delete failure is not silently dropped', async () => {
    const mock = createMockTransport();
    const m = new MarkNamespace(mock.transport, eventBus);
    const assertion = expect(m.delete(RID, AID)).rejects.toThrow(/denied/);
    await new Promise((r) => setTimeout(r, 10));
    const cid = mock.emitSpy.mock.calls[0]?.[2]?.correlationId as string;
    mock.transportBus.emit('mark:delete-failed', { message: 'denied' }, { correlationId: cid });
    await assertion;
  });

  it('archive() emits mark:archive and resolves on mark:archive-ok', async () => {
    const mock = createMockTransport({
      'mark:archive': (reply) => reply('mark:archive-ok', {}),
    });
    const m = new MarkNamespace(mock.transport, eventBus);
    await m.archive(RID);
    expect(mock.emitSpy).toHaveBeenCalledWith('mark:archive', expect.objectContaining({ resourceId: RID }), expect.objectContaining({ correlationId: expect.any(String) }));
  });

  it('archive() REJECTS on mark:archive-failed — an archive failure is not silently dropped', async () => {
    const mock = createMockTransport();
    const m = new MarkNamespace(mock.transport, eventBus);
    const assertion = expect(m.archive(RID)).rejects.toThrow(/archive boom/);
    await new Promise((r) => setTimeout(r, 10));
    const cid = mock.emitSpy.mock.calls[0]?.[2]?.correlationId as string;
    mock.transportBus.emit('mark:archive-failed', { message: 'archive boom' }, { correlationId: cid });
    await assertion;
  });

  it('unarchive() emits mark:unarchive and resolves on mark:unarchive-ok', async () => {
    const mock = createMockTransport({
      'mark:unarchive': (reply) => reply('mark:unarchive-ok', {}),
    });
    const m = new MarkNamespace(mock.transport, eventBus);
    await m.unarchive(RID);
    expect(mock.emitSpy).toHaveBeenCalledWith('mark:unarchive', expect.objectContaining({ resourceId: RID }), expect.objectContaining({ correlationId: expect.any(String) }));
  });

  it('unarchive() REJECTS on mark:unarchive-failed (a failure is never a silent no-op)', async () => {
    const mock = createMockTransport();
    const m = new MarkNamespace(mock.transport, eventBus);
    const assertion = expect(m.unarchive(RID)).rejects.toThrow(/file not found/);
    await new Promise((r) => setTimeout(r, 10));
    const cid = mock.emitSpy.mock.calls[0]?.[2]?.correlationId as string;
    mock.transportBus.emit('mark:unarchive-failed', { message: 'Cannot unarchive: file not found at x' }, { correlationId: cid });
    await assertion;
  });

  it('updateEntityTypes() emits mark:update-entity-types (diff payload) and resolves on -ok', async () => {
    const mock = createMockTransport({
      'mark:update-entity-types': (reply) => reply('mark:update-entity-types-ok', {}),
    });
    const m = new MarkNamespace(mock.transport, eventBus);
    await m.updateEntityTypes(RID, ['A'], ['A', 'B']);
    expect(mock.emitSpy).toHaveBeenCalledWith('mark:update-entity-types', expect.objectContaining({
      resourceId: RID,
      currentEntityTypes: ['A'],
      updatedEntityTypes: ['A', 'B'],
    }), expect.objectContaining({ correlationId: expect.any(String) }));
  });

  it('updateEntityTypes() REJECTS on mark:update-entity-types-failed — a tag write failure is not silently dropped', async () => {
    const mock = createMockTransport();
    const m = new MarkNamespace(mock.transport, eventBus);
    const assertion = expect(m.updateEntityTypes(RID, [], ['Person'])).rejects.toThrow(/rejected/);
    await new Promise((r) => setTimeout(r, 10));
    const cid = mock.emitSpy.mock.calls[0]?.[2]?.correlationId as string;
    mock.transportBus.emit('mark:update-entity-types-failed', { message: 'rejected by handler' }, { correlationId: cid });
    await assertion;
  });

  it('delegate() returns Observable that emits on job:report-progress', async () => {
    const progress: JobEvent[] = [];
    const completed = new Promise<void>((resolve) => {
      mark.delegate(RID, { motivation: 'linking', entityTypes: ['Person'] }).subscribe({
        next: (p) => progress.push(p),
        complete: () => resolve(),
      });
    });

    await new Promise((r) => setTimeout(r, 10));
    // Unified lifecycle: filter by the jobId (`j1`) assigned by job:create.
    // delegate() forwards the inner `progress` field as the Observable's `next`.
    eventBus.emit('job:report-progress', {
      jobId: JID, resourceId: RID, _userId: UID, jobType: 'mark',
      percentage: 50, progress: { percentage: 50, message: { code: 'detecting-entities', entityType: 'Person' } },
    });
    eventBus.emit('job:complete', {
      jobId: JID, resourceId: RID, _userId: UID, jobType: 'mark',
      result: { found: 3, persisted: 3 },
    });

    await completed;
    expect(progress.length).toBeGreaterThan(0);
  });

  it('delegate() falls back to job polling when SSE is silent', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
      'job:status-requested': (reply) => reply('job:status-result', {
        response: {
          ...J1_STORED, type: 'mark', status: 'complete',
          result: { found: 5, persisted: 5 },
        },
      }),
    });
    const m = new MarkNamespace(mock.transport, bus);

    const progress: JobEvent[] = [];
    let completed = false;
    m.delegate(RID, { motivation: 'highlighting' }).subscribe({
      next: (p) => progress.push(p),
      complete: () => { completed = true; },
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(16_000);

    expect(mock.emitSpy).toHaveBeenCalledWith('job:status-requested', expect.any(Object), expect.objectContaining({ correlationId: expect.any(String) }));
    expect(completed).toBe(true);

    bus.destroy();
    vi.useRealTimers();
  });

  it("delegate() awaited gives the mark job's completion, its result a mark job's", async () => {
    const done = mark.delegate(RID, { motivation: 'highlighting' }).run(() => {});
    await new Promise((r) => setTimeout(r, 10));
    eventBus.emit('job:complete', { jobId: JID, resourceId: RID, jobType: 'mark', result: { found: 3, persisted: 2, errors: 1 } });

    const completion = await done;
    // Typed by the verb: a mark job's result is its counts or a decline, so
    // one narrowing reads the counts.
    const counts = completion.result && 'found' in completion.result ? completion.result : undefined;
    expect(counts).toEqual({ found: 3, persisted: 2, errors: 1 });
  });

  it("delegate() errors when the job's status carries another verb's result: it is not the job that was delegated", async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
      'job:status-requested': (reply) => reply('job:status-result', {
        response: {
          ...J1_STORED, type: 'mark', status: 'complete',
          result: { resourceId: resourceId('res-made'), resourceName: 'Made', truncated: false },
        },
      }),
    });
    const m = new MarkNamespace(mock.transport, bus);

    let failure: unknown;
    let completed = false;
    m.delegate(RID, { motivation: 'highlighting' }).subscribe({
      error: (e) => { failure = e; },
      complete: () => { completed = true; },
    });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(16_000);

    expect(completed).toBe(false);
    // Not a failed job: the transport's code for a failure no other names.
    expect(failure).toMatchObject({ code: 'error', message: "The status of job j1 is not a completed mark job's" });

    bus.destroy();
    vi.useRealTimers();
  });

  it("delegate() errors on a job:complete of its job that is another verb's", async () => {
    const failed = new Promise<Error>((resolve) => {
      mark.delegate(RID, { motivation: 'highlighting' }).subscribe({ error: resolve });
    });
    await new Promise((r) => setTimeout(r, 10));
    eventBus.emit('job:complete', {
      jobId: JID, resourceId: RID, jobType: 'yield',
      result: { resourceId: resourceId('res-made'), resourceName: 'Made', truncated: false },
    });

    expect(await failed).toMatchObject({ code: 'error', message: "A job:complete of job j1 is not a completed mark job's" });
  });

  it('delegate() SSE completion wins over polling', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
    });
    const m = new MarkNamespace(mock.transport, bus);

    let completed = false;
    m.delegate(RID, { motivation: 'linking', entityTypes: ['Person'] }).subscribe({
      next: () => {},
      complete: () => { completed = true; },
    });

    await vi.advanceTimersByTimeAsync(100);
    bus.emit('job:complete', {
      jobId: JID, resourceId: RID, _userId: UID, jobType: 'mark',
      result: { found: 0, persisted: 0 },
    });
    expect(completed).toBe(true);

    bus.destroy();
    vi.useRealTimers();
  });

  it('delegate() progress resets poll timer', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
    });
    const m = new MarkNamespace(mock.transport, bus);

    m.delegate(RID, { motivation: 'highlighting' }).subscribe({ next: () => {}, error: () => {} });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(9_000);
    bus.emit('job:report-progress', {
      jobId: JID, resourceId: RID, _userId: UID, jobType: 'mark',
      percentage: 50, progress: { percentage: 50, message: { code: 'analyzing' } },
    });

    await vi.advanceTimersByTimeAsync(9_000);
    expect(mock.emitSpy).not.toHaveBeenCalledWith('job:status-requested', expect.any(Object));

    bus.destroy();
    vi.useRealTimers();
  });

  // ── Cancelling ONE job ──────────────────────────────────────────────
  // `cancelByType` takes every pending job of a type; a UI cancelling one running detection
  // needs to say WHICH. The gateway targets by jobId — this is the client
  // verb for it. Awaited, like its by-type sibling: the caller learns
  // whether anything was cancelled.

  it('cancel(jobId) targets one job and resolves the cancelled count', async () => {
    const bus = new EventBus();
    const mock = createMockTransport({
      'job:cancel-requested': (reply) => reply('job:cancel-ok', { response: { cancelled: 1 } }),
    });
    const j = new JobNamespace(mock.transport, bus);

    await expect(j.cancel(jobId('j-42'))).resolves.toBe(1);
    expect(mock.emitSpy).toHaveBeenCalledWith(
      'job:cancel-requested',
      expect.objectContaining({ jobId: 'j-42' }),
      expect.objectContaining({ correlationId: expect.any(String) }),
    );
    // Category-only cancellation is a different request; targeting must not
    // smuggle a jobType in and cancel the user's other work.
    const payload = mock.emitSpy.mock.calls.find(([ch]) => ch === 'job:cancel-requested')![1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('jobType');
    bus.destroy();
  });

  // ── A retryable failure is not the end ───────────────────────────────
  // The queue re-queues a transient failure while the budget has room, and
  // the work continues on a fresh worker. A stream that ended on every
  // `job:fail` would report a RECOVERING run as a failed one — and the
  // consumer would never see the completion that follows. `willRetry`
  // (stamped by the worker from the same predicate the queue applies) is
  // what separates the two.

  it('delegate() survives a retryable failure and completes on the later terminal', async () => {
    const bus = new EventBus();
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
    });
    const m = new MarkNamespace(mock.transport, bus);

    const events: string[] = [];
    let errored: Error | null = null;
    let completed = false;
    m.delegate(RID, { motivation: 'highlighting' }).subscribe({
      next: (e) => events.push(e.kind),
      error: (e: Error) => { errored = e; },
      complete: () => { completed = true; },
    });
    await new Promise((r) => setTimeout(r, 0));

    const fail = (willRetry: boolean) => bus.emit('job:fail', {
      jobId: JID, resourceId: RID, jobType: 'mark',
      error: 'transient blip', willRetry,
    });

    fail(true);
    expect(errored).toBeNull();          // the run is not over
    expect(completed).toBe(false);

    // Progress must keep flowing on the retried attempt, too — a
    // takeUntil(fail$) would silence it even when the stream survives.
    bus.emit('job:report-progress', {
      jobId: JID, resourceId: RID, jobType: 'mark',
      percentage: 20, progress: { percentage: 20 },
    });

    bus.emit('job:complete', {
      jobId: JID, resourceId: RID, jobType: 'mark',
    });

    expect(errored).toBeNull();
    expect(completed).toBe(true);
    expect(events).toContain('failed');   // surfaced as an EVENT, not a throw
    expect(events).toContain('progress'); // and the retry's progress arrived
    expect(events).toContain('complete');

    bus.destroy();
  });

  it('delegate() still errors when the failure IS terminal', async () => {
    const bus = new EventBus();
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
    });
    const m = new MarkNamespace(mock.transport, bus);

    const err = await new Promise<Error>((resolve) => {
      m.delegate(RID, { motivation: 'highlighting' }).subscribe({ error: resolve });
      setTimeout(() => bus.emit('job:fail', {
        jobId: JID, resourceId: RID, jobType: 'mark',
        error: 'budget spent', willRetry: false,
      }), 0);
    });
    expect(err.message).toBe('budget spent');
    // A failure a caller can route on: the code every SDK reports for it.
    expect(err).toBeInstanceOf(JobFailedError);
    expect((err as JobFailedError).code).toBe('job.failed');
    expect((err as JobFailedError).jobId).toBe('j1');
    bus.destroy();
  });

  it('delegate() treats an ABSENT willRetry as terminal — an older worker must not hang the stream', async () => {
    const bus = new EventBus();
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
    });
    const m = new MarkNamespace(mock.transport, bus);

    const err = await new Promise<Error>((resolve) => {
      m.delegate(RID, { motivation: 'highlighting' }).subscribe({ error: resolve });
      setTimeout(() => bus.emit('job:fail', {
        jobId: JID, resourceId: RID, jobType: 'mark',
        error: 'no field',
      }), 0);
    });
    expect(err.message).toBe('no field');
    bus.destroy();
  });

  it('delegate() ends as cancelled when the job\'s status says it was', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
      'job:status-requested': (reply) => reply('job:status-result', {
        response: { ...J1_STORED, type: 'mark', status: 'cancelled' },
      }),
    });
    const m = new MarkNamespace(mock.transport, bus);

    let failure: unknown;
    m.delegate(RID, { motivation: 'highlighting' }).subscribe({ error: (e) => { failure = e; } });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(16_000);

    expect(failure).toMatchObject({ name: 'JobCancelledError', code: 'job.cancelled', message: 'The job was cancelled', jobId: 'j1' });
    // Asked about once: a cancelled job is over.
    expect(mock.emitSpy.mock.calls.filter(([channel]) => channel === 'job:status-requested')).toHaveLength(1);
    bus.destroy();
    vi.useRealTimers();
  });

  it('delegate() reports a failure it learned from the job\'s status under the same code', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
      'job:status-requested': (reply) => reply('job:status-result', {
        response: { ...J1_STORED, type: 'mark', status: 'failed', error: 'worker gave up' },
      }),
    });
    const m = new MarkNamespace(mock.transport, bus);

    let failure: unknown;
    m.delegate(RID, { motivation: 'highlighting' }).subscribe({ error: (e) => { failure = e; } });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(16_000);

    expect(failure).toBeInstanceOf(JobFailedError);
    expect((failure as JobFailedError).code).toBe('job.failed');
    expect((failure as JobFailedError).message).toBe('worker gave up');
    bus.destroy();
    vi.useRealTimers();
  });
});

// ── Bind ────────────────────────────────────────────────────────────────────

describe('BindNamespace', () => {
  it('body() emits bind:update-body and resolves on bind:body-updated', async () => {
    const mock = createMockTransport({
      'bind:update-body': (reply) => reply('bind:body-updated', {}),
    });
    const bind = new BindNamespace(mock.transport, new EventBus());
    await bind.body(RID, AID, [{ op: 'add', item: { type: 'SpecificResource', source: resourceId('res-2') } }]);
    expect(mock.emitSpy).toHaveBeenCalledWith('bind:update-body', expect.objectContaining({
      annotationId: AID,
      resourceId: RID,
      operations: expect.any(Array),
    }), expect.objectContaining({ correlationId: expect.any(String) }));
  });

  it('body() REJECTS on bind:body-update-failed — a bind failure is not silently dropped', async () => {
    const mock = createMockTransport();
    const bind = new BindNamespace(mock.transport, new EventBus());
    const assertion = expect(
      bind.body(RID, AID, [{ op: 'add', item: { type: 'SpecificResource', source: resourceId('res-2') } }]),
    ).rejects.toThrow(/rejected/);
    await new Promise((r) => setTimeout(r, 10));
    const cid = mock.emitSpy.mock.calls[0]?.[2]?.correlationId as string;
    mock.transportBus.emit('bind:body-update-failed', { message: 'rejected by handler' }, { correlationId: cid });
    await assertion;
  });
});

// ── Gather ──────────────────────────────────────────────────────────────────

describe('GatherNamespace', () => {
  let eventBus: EventBus;
  let gather: GatherNamespace;
  let emitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = new EventBus();
    const mock = createMockTransport();
    emitSpy = mock.emitSpy;
    gather = new GatherNamespace(mock.transport, eventBus);
  });

  it('annotation() emits gather:requested on bus', () => {
    gather.annotation(RID, AID, { contextWindow: 2000 }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('gather:requested', expect.objectContaining({
        annotationId: AID,
        resourceId: RID,
        options: { contextWindow: 2000 },
      }), expect.objectContaining({ correlationId: expect.any(String) }));
      resolve();
    }, 20));
  });

  it('annotation() completes on gather:complete', async () => {
    const completed = new Promise<void>((resolve) => {
      gather.annotation(RID, AID).subscribe({ next: () => {}, complete: () => resolve() });
    });

    await new Promise((r) => setTimeout(r, 20));
    const call = emitSpy.mock.calls[0];
    const cid = call?.[2]?.correlationId;
    eventBus.emit('gather:complete', { annotationId: AID, response: CTX_ANN }, { correlationId: cid });
    await completed;
  });

  it('annotation() errors on gather:failed', async () => {
    const errored = new Promise<Error>((resolve) => {
      gather.annotation(RID, AID).subscribe({ error: (err) => resolve(err) });
    });

    await new Promise((r) => setTimeout(r, 20));
    const call = emitSpy.mock.calls[0];
    const cid = call?.[2]?.correlationId;
    eventBus.emit('gather:failed', { annotationId: AID, message: 'boom' }, { correlationId: cid });
    const err = await errored;
    expect(err.message).toContain('boom');
  });
});

// ── Match ───────────────────────────────────────────────────────────────────

describe('MatchNamespace', () => {
  let eventBus: EventBus;
  let match: MatchNamespace;
  let emitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = new EventBus();
    const mock = createMockTransport();
    emitSpy = mock.emitSpy;
    match = new MatchNamespace(mock.transport, eventBus);
  });

  it('search() emits match:search-requested on bus', () => {
    match.search(RID, REF, CTX_REF).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('match:search-requested', expect.objectContaining({
        resourceId: RID,
        referenceId: 'ref-1',
      }), expect.objectContaining({ correlationId: expect.any(String) }));
      resolve();
    }, 20));
  });

  it('search() completes on match:search-results', async () => {
    const completed = new Promise<void>((resolve) => {
      match.search(RID, REF, CTX_REF).subscribe({ next: () => {}, complete: () => resolve() });
    });
    await new Promise((r) => setTimeout(r, 20));
    const call = emitSpy.mock.calls[0];
    const cid = call?.[2]?.correlationId;
    eventBus.emit('match:search-results', { referenceId: REF, response: [] }, { correlationId: cid });
    await completed;
  });

  it('search() errors on match:search-failed', async () => {
    const errored = new Promise<Error>((resolve) => {
      match.search(RID, REF, CTX_REF).subscribe({ error: (err) => resolve(err) });
    });
    await new Promise((r) => setTimeout(r, 20));
    const call = emitSpy.mock.calls[0];
    const cid = call?.[2]?.correlationId;
    eventBus.emit('match:search-failed', { referenceId: REF, error: 'no results' }, { correlationId: cid });
    const err = await errored;
    expect(err.message).toContain('no results');
  });
});

// ── Yield ───────────────────────────────────────────────────────────────────

describe('JobNamespace', () => {
  it('cancelByType resolves with the cancelled count from job:cancel-ok', async () => {
    const mock = createMockTransport({
      'job:cancel-requested': (reply) => reply('job:cancel-ok', { response: { cancelled: 3 } }),
    });
    const job = new JobNamespace(mock.transport, new EventBus());
    const count = await job.cancelByType('yield');
    expect(count).toBe(3);
    expect(mock.emitSpy).toHaveBeenCalledWith('job:cancel-requested', expect.objectContaining({ jobType: 'yield' }), expect.objectContaining({ correlationId: expect.any(String) }));
  });

  it('cancelByType REJECTS on job:cancel-failed (a queue error is not swallowed)', async () => {
    const mock = createMockTransport();
    const job = new JobNamespace(mock.transport, new EventBus());
    const assertion = expect(job.cancelByType('mark')).rejects.toThrow(/queue down/);
    await new Promise((r) => setTimeout(r, 10));
    const cid = mock.emitSpy.mock.calls[0]?.[2]?.correlationId as string;
    mock.transportBus.emit('job:cancel-failed', { message: 'queue down' }, { correlationId: cid });
    await assertion;
  });
});

describe('JobNamespace.pollUntilComplete', () => {
  it('a job that does not end within the time allowed fails as a timeout, under its code', async () => {
    vi.useFakeTimers();
    const mock = createMockTransport({
      'job:status-requested': (reply) => reply('job:status-result', {
        response: { ...J1_STORED, type: 'mark', status: 'running' },
      }),
    });
    const job = new JobNamespace(mock.transport, new EventBus());

    const polling = job.pollUntilComplete(jobId('j1'), { interval: 10, timeout: 50 });
    const refusal = expect(polling).rejects.toMatchObject({ code: 'bus.timeout' });
    await vi.advanceTimersByTimeAsync(200);
    await refusal;
    vi.useRealTimers();
  });
});

describe('YieldNamespace', () => {
  let eventBus: EventBus;
  let content: IContentTransport;
  let yld: YieldNamespace;
  let emitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = new EventBus();
    content = makeMockContent();
    const mock = createMockTransport({
      'yield:clone-token-requested': (reply) => reply('yield:clone-token-generated', {
        response: { token: 'tok', expiresAt: '2026-01-01', resource: mockResource('res-1') },
      }),
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
    });
    emitSpy = mock.emitSpy;
    yld = new YieldNamespace(mock.transport, eventBus, content);
  });

  it('resource() delegates to content.putBinary', async () => {
    const result = await yld.resource({ name: 'doc', file: new File(['hi'], 'doc.txt'), format: 'text/plain', storageUri: 'file://x' });
    expect(content.putBinary).toHaveBeenCalled();
    expect(result.resourceId).toBe('res-new');
  });

  it('resource() emits started → progress* → finished as the upload runs', async () => {
    // Capture the onProgress hook so we can drive byte progress from
    // outside the namespace, simulating what HttpContentTransport's XHR
    // path would feed in.
    let captured: { onProgress?: (e: { bytesUploaded: number; totalBytes: number }) => void } = {};
    let resolveUpload!: (value: { resourceId: string }) => void;
    const uploadPromise = new Promise<{ resourceId: string }>((r) => { resolveUpload = r; });
    (content.putBinary as ReturnType<typeof vi.fn>).mockImplementation((_req: unknown, opts: typeof captured) => {
      captured = opts ?? {};
      return uploadPromise;
    });

    const events: UploadProgress[] = [];
    const file = Buffer.from(new Uint8Array(1024)); // 1 KB pre-flight size
    yld.resource({ name: 'doc', file, format: 'text/plain', storageUri: 'file://x' }).subscribe({
      next: (e) => events.push(e),
    });

    // `started` fires synchronously on subscribe.
    expect(events).toEqual([{ phase: 'started', totalBytes: 1024 }]);

    // Drive a couple of progress events through the captured hook.
    captured.onProgress?.({ bytesUploaded: 512, totalBytes: 1024 });
    captured.onProgress?.({ bytesUploaded: 1024, totalBytes: 1024 });

    expect(events).toEqual([
      { phase: 'started', totalBytes: 1024 },
      { phase: 'progress', bytesUploaded: 512, totalBytes: 1024 },
      { phase: 'progress', bytesUploaded: 1024, totalBytes: 1024 },
    ]);

    // Resolve the upload; `finished` fires.
    resolveUpload({ resourceId: 'res-new' });
    await uploadPromise;
    // Allow the .then() callback to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(events.at(-1)).toMatchObject({ phase: 'finished' });
    expect(events.filter((e) => e.phase === 'progress')).toHaveLength(2);
  });

  it('resource() falls back to pre-flight totalBytes when the transport reports total=0', async () => {
    let captured: { onProgress?: (e: { bytesUploaded: number; totalBytes: number }) => void } = {};
    (content.putBinary as ReturnType<typeof vi.fn>).mockImplementation((_req: unknown, opts: typeof captured) => {
      captured = opts ?? {};
      return new Promise(() => { /* never resolves; we only assert progress shape here */ });
    });

    const events: UploadProgress[] = [];
    yld.resource({
      name: 'doc',
      file: Buffer.from(new Uint8Array(2048)),
      format: 'text/plain',
      storageUri: 'file://x',
    }).subscribe({ next: (e) => events.push(e) });

    captured.onProgress?.({ bytesUploaded: 256, totalBytes: 0 });

    expect(events.at(-1)).toEqual({ phase: 'progress', bytesUploaded: 256, totalBytes: 2048 });
  });

  it('resource() aborts the in-flight upload when the subscriber unsubscribes', () => {
    let capturedSignal: AbortSignal | undefined;
    (content.putBinary as ReturnType<typeof vi.fn>).mockImplementation(
      (_req: unknown, opts: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal;
        return new Promise(() => { /* never resolves */ });
      },
    );

    const sub = yld.resource({
      name: 'doc',
      file: Buffer.from('xx'),
      format: 'text/plain',
      storageUri: 'file://x',
    }).subscribe({ next: () => {} });

    expect(capturedSignal?.aborted).toBe(false);
    sub.unsubscribe();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('delegate(annotation focus) sends NO ids — the context is the wire truth', () => {
    yld.delegate({ title: 'T', storageUri: 'file://x', context: CTX_ANN }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      const call = emitSpy.mock.calls.find((c: unknown[]) => c[0] === 'job:create');
      const payload = call![1] as Record<string, unknown>;
      expect(payload.jobType).toBe('yield');
      // The server derives both ids from params.context.focus; a
      // caller-supplied id is REJECTED there, so the sdk must not send
      // either.
      expect('resourceId' in payload).toBe(false);
      const params = payload.params as Record<string, unknown>;
      expect('referenceId' in params).toBe(false);
      expect(params.context).toBe(CTX_ANN);
      resolve();
    }, 20));
  });

  it('delegate throws loudly on a context with no usable focus — never guesses', () => {
    // The one place a cast remains, deliberately: it models a context whose
    // type history was severed (wire JSON, storage, a hand-built object).
    expect(() => yld.delegate({ title: 'T', storageUri: 'file://x', context: {} as GatheredContext }))
      .toThrow(/gather\.resource|gather\.annotation/);
  });

  it('delegate(resource focus) sends NO ids; the context rides in params', () => {
    yld.delegate({ title: 'T', storageUri: 'file://x', context: CTX_RES }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      const call = emitSpy.mock.calls.find((c: unknown[]) => c[0] === 'job:create');
      const payload = call![1] as Record<string, unknown>;
      expect(payload.jobType).toBe('yield');
      expect('resourceId' in payload).toBe(false);
      const params = payload.params as Record<string, unknown>;
      expect('referenceId' in params).toBe(false);
      expect(params.context).toBe(CTX_RES);
      resolve();
    }, 20));
  });

  it('delegate({ outputMediaType }) [resource focus] carries outputMediaType into job:create params', () => {
    yld.delegate({ title: 'T', storageUri: 'file://x', outputMediaType: 'text/plain', context: CTX_RES }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('job:create', expect.objectContaining({
        params: expect.objectContaining({ outputMediaType: 'text/plain' }),
      }), expect.objectContaining({ correlationId: expect.any(String) }));
      resolve();
    }, 20));
  });

  it('delegate({ outputMediaType }) [annotation focus] carries outputMediaType into job:create params', () => {
    yld.delegate({ title: 'T', storageUri: 'file://x', outputMediaType: 'text/plain', context: CTX_ANN }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('job:create', expect.objectContaining({
        params: expect.objectContaining({ outputMediaType: 'text/plain' }),
      }), expect.objectContaining({ correlationId: expect.any(String) }));
      resolve();
    }, 20));
  });

  it('delegate({ task, structure }) [resource focus] carries both into job:create params', () => {
    // The Q&A recipe these options exist for: task frames the ask, structure
    // forces the shape. The worker's template branches on both.
    yld.delegate({ title: 'T', storageUri: 'file://x', task: 'answer', structure: 'prose', context: CTX_RES }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('job:create', expect.objectContaining({
        params: expect.objectContaining({ task: 'answer', structure: 'prose' }),
      }), expect.objectContaining({ correlationId: expect.any(String) }));
      resolve();
    }, 20));
  });

  it('delegate({ task, structure }) [annotation focus] carries both — including an open-union custom string', () => {
    // structure 'chat' is the third canonical; task exercises the
    // (string & {}) escape hatch — the SDK must pass it through verbatim.
    yld.delegate({ title: 'T', storageUri: 'file://x', task: 'translate to French', structure: 'chat', context: CTX_ANN }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('job:create', expect.objectContaining({
        params: expect.objectContaining({ task: 'translate to French', structure: 'chat' }),
      }), expect.objectContaining({ correlationId: expect.any(String) }));
      resolve();
    }, 20));
  });

  it('unset task/structure reach job:create as undefined — the SDK invents no defaults', () => {
    // Unset structure ⇒ the worker emits NO structure directive. That
    // only holds if the SDK leaves the fields untouched (undefined keys
    // vanish at JSON serialization on the wire).
    yld.delegate({ title: 'T', storageUri: 'file://x', context: CTX_RES }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      const call = emitSpy.mock.calls.find((c: unknown[]) => c[0] === 'job:create');
      const params = (call![1] as { params: Record<string, unknown> }).params;
      expect(params.task).toBeUndefined();
      expect(params.structure).toBeUndefined();
      resolve();
    }, 20));
  });

  it('delegate({ cite: true }) [resource focus] carries cite into job:create params', () => {
    yld.delegate({ title: 'T', storageUri: 'file://x', cite: true, context: CTX_RES }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('job:create', expect.objectContaining({
        params: expect.objectContaining({ cite: true }),
      }), expect.objectContaining({ correlationId: expect.any(String) }));
      resolve();
    }, 20));
  });

  it('delegate({ cite: true }) [annotation focus] carries cite into job:create params', () => {
    yld.delegate({ title: 'T', storageUri: 'file://x', cite: true, context: CTX_ANN }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('job:create', expect.objectContaining({
        params: expect.objectContaining({ cite: true }),
      }), expect.objectContaining({ correlationId: expect.any(String) }));
      resolve();
    }, 20));
  });

  it('unset cite reaches job:create as undefined — the resolver gates on presence', () => {
    // The worker parses/strips [[..]] tokens ONLY when cite is set: double-
    // bracketed text is legitimate content otherwise. An SDK-invented
    // default would corrupt non-citing generations.
    yld.delegate({ title: 'T', storageUri: 'file://x', context: CTX_RES }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      const call = emitSpy.mock.calls.find((c: unknown[]) => c[0] === 'job:create');
      const params = (call![1] as { params: Record<string, unknown> }).params;
      expect(params.cite).toBeUndefined();
      resolve();
    }, 20));
  });

  it('delegate({ entityTypes }) carries entityTypes through into job:create params', () => {
    // entityTypes must survive from the caller's params to the
    // bus payload: dropped there, synthesized resources go un-stamped at
    // schema-layer queries.
    yld.delegate({
      title: 'T',
      storageUri: 'file://x',
      entityTypes: ['Character', 'Hero'],
      context: CTX_ANN,
    }).subscribe(() => {});
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(emitSpy).toHaveBeenCalledWith('job:create', expect.objectContaining({
        jobType: 'yield',
        params: expect.objectContaining({
          entityTypes: ['Character', 'Hero'],
        }),
      }), expect.objectContaining({ correlationId: expect.any(String) }));
      resolve();
    }, 20));
  });

  it('delegate() emits progress and completes on job:complete', async () => {
    const progress: JobEvent[] = [];
    const completed = new Promise<void>((resolve) => {
      yld.delegate({ title: 'T', storageUri: 'file://x', context: CTX_ANN }).subscribe({
        next: (p) => progress.push(p),
        complete: () => resolve(),
      });
    });

    await new Promise((r) => setTimeout(r, 20));
    eventBus.emit('job:report-progress', {
      jobId: JID, resourceId: RID, _userId: UID, jobType: 'yield',
      percentage: 50, progress: { percentage: 50, message: { code: 'generating-resource' } },
    });
    eventBus.emit('job:complete', {
      jobId: JID, resourceId: RID, _userId: UID, jobType: 'yield',
      result: { resourceId: resourceId('res-new'), resourceName: 'T', truncated: false },
    });

    await completed;
    expect(progress.length).toBeGreaterThanOrEqual(1);
  });

  it('cloneToken() uses bus request', async () => {
    const result = await yld.cloneToken(RID);
    expect(result).toEqual({ token: 'tok', expiresAt: '2026-01-01', resource: mockResource('res-1') });
  });

  it('delegate() falls back to job polling when SSE is silent', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
      'job:status-requested': (reply) => reply('job:status-result', {
        response: {
          ...J1_STORED, type: 'yield', status: 'complete',
          result: { resourceId: resourceId('res-poll'), resourceName: 'T', truncated: false },
        },
      }),
    });
    const y = new YieldNamespace(mock.transport, bus, makeMockContent());

    const progress: unknown[] = [];
    let completed = false;
    y.delegate({ title: 'T', storageUri: 'file://x', context: annotationContextFor('res-1', 'ann-1') }).subscribe({
      next: (p) => progress.push(p),
      complete: () => { completed = true; },
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(16_000);

    expect(mock.emitSpy).toHaveBeenCalledWith('job:status-requested', expect.any(Object), expect.objectContaining({ correlationId: expect.any(String) }));
    expect(completed).toBe(true);

    bus.destroy();
    vi.useRealTimers();
  });

  it('delegate() SSE completion wins over polling', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const mock = createMockTransport({
      'job:create': (reply) => reply('job:created', { response: { jobId: JID } }),
    });
    const y = new YieldNamespace(mock.transport, bus, makeMockContent());

    let completed = false;
    y.delegate({ title: 'T', storageUri: 'file://x', context: annotationContextFor('res-1', 'ann-1') }).subscribe({
      next: () => {},
      complete: () => { completed = true; },
    });

    await vi.advanceTimersByTimeAsync(100);
    bus.emit('job:complete', {
      jobId: JID, resourceId: RID, _userId: UID, jobType: 'yield',
      result: { resourceId: resourceId('res-new'), resourceName: 'T', truncated: false },
    });
    expect(completed).toBe(true);

    bus.destroy();
    vi.useRealTimers();
  });
});

// ── Late-rejection guards ──────────────────────────────────────────────────
//
// Four namespaces guard their `.catch` handlers against firing
// `subscriber.error` on an already-closed subscriber:
//
//   gather.ts  — `transport.emit('gather:requested', …).catch(...)` checks
//                `subscriber.closed`
//   match.ts   — `transport.emit('match:search-requested', …).catch(...)`
//                checks `subscriber.closed`
//   mark.ts    — `dispatchAssist(...).catch(...)` checks the local `done`
//                flag set by cleanup()
//   yield.ts   — `busRequest('job:create', …).catch(...)` checks the local
//                `done` flag set by cleanup()
//
// Without the guards, a rejection that arrived after consumer disposal
// (e.g. `semiont.dispose()` completing the actor's `events$` Subject
// while a fire-and-forget bus call is still pending) lands as an
// uncaught exception via RxJS's host-error machinery. With the guards,
// the rejection is silently dropped — the consumer is gone and there's
// no one to receive the error.
//
// Each pair below: (1) guard fires → no error after unsubscribe;
// (2) guard does NOT fire when the consumer is still subscribed → error
// propagates as expected.

function makeDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Build a transport whose `emit` always returns the supplied promise. */
function makeDeferredEmitTransport(emitPromise: Promise<unknown>): { transport: ITransport; emitSpy: ReturnType<typeof vi.fn>; bus: EventBus } {
  const bus = new EventBus();
  const emitSpy = vi.fn().mockReturnValue(emitPromise);
  const transport: ITransport & IGatewayOperations = {
    ...inMemoryTransport({
      onEmit: (channel, payload, envelope) => { void emitSpy(channel, payload, envelope); },
    }),
    ...gatewayOperationSpies(),
  };
  return { transport, emitSpy, bus };
}

// Each test pins the late-rejection-after-unsubscribe path. The converse
// (rejection while still subscribed → error propagates) is covered for
// gather/match by the `gather:failed` / `match:search-failed` tests above;
// mark/yield rely on the same promise-then-catch shape so a separate
// positive test would be duplicative.

describe('late-rejection guards', () => {
  it('gather.annotation does NOT propagate a rejection after the consumer unsubscribes', async () => {
    const { promise, reject } = makeDeferred<void>();
    const { transport, bus } = makeDeferredEmitTransport(promise);
    const gather = new GatherNamespace(transport, new EventBus());

    const errors: Error[] = [];
    const sub = gather.annotation(RID, AID).subscribe({
      next: () => {},
      error: (e: Error) => errors.push(e),
    });

    sub.unsubscribe();
    reject(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 10));

    expect(errors).toHaveLength(0);
    bus.destroy();
  });

  it('match.search does NOT propagate a rejection after the consumer unsubscribes', async () => {
    const { promise, reject } = makeDeferred<void>();
    const { transport, bus } = makeDeferredEmitTransport(promise);
    const match = new MatchNamespace(transport, new EventBus());

    const errors: Error[] = [];
    const sub = match.search(RID, REF, CTX_REF).subscribe({
      next: () => {},
      error: (e: Error) => errors.push(e),
    });

    sub.unsubscribe();
    reject(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 10));

    expect(errors).toHaveLength(0);
    bus.destroy();
  });

  it('mark.delegate does NOT propagate a late job:create rejection after the consumer unsubscribes', async () => {
    // dispatchAssist round-trips on 'job:create' / 'job:created'. Make
    // the underlying emit() pend indefinitely, then reject after the
    // consumer has torn down — exercises the `done` guard set by
    // cleanup() in the delegation's teardown.
    const { promise, reject } = makeDeferred<void>();
    const { transport, bus } = makeDeferredEmitTransport(promise);
    const mark = new MarkNamespace(transport, new EventBus());

    const errors: Error[] = [];
    const sub = mark
      .delegate(RID, { motivation: 'linking', entityTypes: ['Person'] })
      .subscribe({
        next: () => {},
        error: (e: Error) => errors.push(e),
      });

    sub.unsubscribe();
    reject(new Error('bus disposed mid-flight'));
    await new Promise((r) => setTimeout(r, 10));

    expect(errors).toHaveLength(0);
    bus.destroy();
  });

  it('yield.delegate does NOT propagate a late busRequest rejection after the consumer unsubscribes', async () => {
    const { promise, reject } = makeDeferred<void>();
    const { transport, bus } = makeDeferredEmitTransport(promise);
    const yld = new YieldNamespace(transport, new EventBus(), makeMockContent());

    const errors: Error[] = [];
    const sub = yld
      .delegate({ title: 'T', storageUri: 'file://x', context: annotationContextFor('res-1', 'ann-1') })
      .subscribe({
        next: () => {},
        error: (e: Error) => errors.push(e),
      });

    sub.unsubscribe();
    reject(new Error('bus disposed mid-flight'));
    await new Promise((r) => setTimeout(r, 10));

    expect(errors).toHaveLength(0);
    bus.destroy();
  });
});

/**
 * `yield.resource()` must work where the Node global `Buffer` does not
 * exist: a bare `data.file instanceof Buffer` throws `ReferenceError:
 * Buffer is not defined` synchronously in browsers (Buffer is not a
 * browser global).
 *
 * The Buffer branch is gated on a runtime check
 * (`typeof Buffer !== 'undefined'`); these tests pin that behavior
 * by deleting `globalThis.Buffer` and verifying the upload path
 * works for File-shaped inputs.
 */
describe('YieldNamespace.resource — runtime fallback when Buffer is unavailable', () => {
  let bufferGlobal: PropertyDescriptor | undefined;
  let eventBus: EventBus;
  let content: IContentTransport;
  let yld: YieldNamespace;

  beforeEach(() => {
    eventBus = new EventBus();
    content = makeMockContent();
    const mock = createMockTransport();
    yld = new YieldNamespace(mock.transport, eventBus, content);

    // Remove the `Buffer` global to model a browser runtime. Its property
    // descriptor is saved so it can be put back exactly for sibling tests
    // that depend on `Buffer.from(...)`.
    bufferGlobal = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
    Reflect.deleteProperty(globalThis, 'Buffer');
  });

  afterEach(() => {
    if (bufferGlobal) Object.defineProperty(globalThis, 'Buffer', bufferGlobal);
  });

  it('emits started → finished with a File-shaped input when Buffer is undefined', async () => {
    // Browser shape: a File, no Buffer involvement.
    const file = new File([new Uint8Array(4096)], 'doc.bin');

    const events: UploadProgress[] = [];
    const errors: unknown[] = [];
    yld.resource({ name: 'doc', file, format: 'text/plain', storageUri: 'file://x' }).subscribe({
      next: (e) => events.push(e),
      error: (e) => errors.push(e),
    });

    // Without the typeof guard this throws `Buffer is not defined`
    // synchronously before `started` ever fires. With it, the Buffer
    // branch is short-circuited and the size is read from `.size`.
    expect(events[0]).toEqual({ phase: 'started', totalBytes: 4096 });
    expect(errors).toEqual([]);

    // Let the mocked putBinary resolve and `finished` to fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(events.at(-1)).toMatchObject({ phase: 'finished' });
  });

  it('passes the File through to content.putBinary unchanged', async () => {
    const file = new File([new Uint8Array(1024)], 'doc.bin');
    yld.resource({ name: 'doc', file, format: 'text/plain', storageUri: 'file://x' }).subscribe();

    await new Promise((r) => setTimeout(r, 0));
    expect(content.putBinary).toHaveBeenCalledWith(
      expect.objectContaining({ file, name: 'doc' }),
      expect.objectContaining({ onProgress: expect.any(Function), signal: expect.any(AbortSignal) }),
    );
  });
});
