/**
 * `job.claim` — a worker's claims and the jobs it comes to hold.
 *
 * The rules are docs/protocol/WORKER-CONTRACT.md's, and the worker
 * conformance suite (tests/conformance/worker) holds them on the wire. These
 * are the same rules against a bus the test answers by hand, where a moment
 * between two frames can be chosen and a transport can be made to fail.
 *
 * The fake is built over a REAL `EventBus`: core's bus is typed per channel,
 * so the fake needs no cast and cannot be fed a payload production would
 * reject. A claim is answered by pushing `job:claimed` / `job:claim-failed`
 * at the correlationId the claim was sent under, and a commit the same way,
 * by hand or by the record the fake plays.
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, it, expect, expectTypeOf, beforeEach, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { ROOT_CONTEXT, context, propagation, trace as otelTrace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { getActiveTraceparent, withTraceparent } from '@semiont/observability';
import type { Annotation, BusRequestPrimitive } from '@semiont/core';
import { BusRequestError, EventBus, type BusEnvelope, type ConnectionState, type EventMap, annotationId, jobId as makeJobId, userId, resourceId } from '@semiont/core';
import { ClaimsObservable, JOB_CLAIM_CHANNELS, JOB_COMMIT_CHANNELS, willRetryAfter, type ClaimOptions, type ClaimRefusal, type HeldJob, type HeldJobStall, type HeldMarkJob, type HeldYieldJob, type JobFailure } from '../claims';

/** The job a `job:claimed` reply carries: running, under the claimant. */
type ClaimedJob = EventMap['job:claimed']['response'];
/** What a commit observed of the record, as a settle states it. */
type Durability = NonNullable<EventMap['job:complete']['durability']>;

/** An annotation as a worker hands one to a commit: already made, with its id. */
const annotation = (id: string): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId(id),
  motivation: 'highlighting',
  target: { source: resourceId('res-1'), selector: { type: 'TextQuoteSelector', exact: `the words of ${id}` } },
  created: '2026-01-01T00:00:00.000Z',
});

/** A running job as the dispatcher returns one from a claim, its metadata overridden by `metadata`. */
function runningJob(id: string, metadata: Partial<ClaimedJob['metadata']> = {}, params: Record<string, unknown> = {}): ClaimedJob {
  return {
    status: 'running',
    metadata: {
      id: makeJobId(id),
      type: 'mark',
      userId: userId('did:web:kb.example:users:u'),
      created: '2026-01-01T00:00:00.000Z',
      retryCount: 0,
      maxRetries: 1,
      ...metadata,
    },
    params: { resourceId: resourceId('res-1'), ...params },
    startedAt: '2026-01-01T00:00:01.000Z',
    progress: {},
  };
}

function fakeBus(initialState: ConnectionState = 'open') {
  // A correlated union, so `channel` narrows `payload` at every read site.
  // `trace` is the W3C `traceparent` of the span the emit was made in, when it was made in one.
  type Emitted = { [K in keyof EventMap]: { channel: K; payload: EventMap[K]; envelope: BusEnvelope | undefined; trace: string | undefined } }[keyof EventMap];
  const emits: Emitted[] = [];
  const eventBus = new EventBus();
  const state$ = new BehaviorSubject<ConnectionState>(initialState);
  /** Channels whose emit fails, as a transport that could not reach the gateway fails one. */
  const failing = new Set<keyof EventMap>();
  /** What a failing channel's emit fails with, when a case states it. */
  const thrown = new Map<keyof EventMap, unknown>();
  /** Channels this bus says its stream does not name. */
  const unnamed = new Set<keyof EventMap>();
  /**
   * The record, as a case has it played: what it does with a commit, and
   * what it answers when asked whether an annotation is on a resource. It
   * answers on the next tick, at the request's correlation id. As it starts
   * it answers neither, and a case answers by hand.
   */
  const record: { commit: 'acknowledged' | 'refused' | 'unanswered'; question: 'there' | 'not-there' | 'unanswered' } = { commit: 'unanswered', question: 'unanswered' };

  const bus: BusRequestPrimitive = {
    stream: <K extends keyof EventMap>(channel: K) => eventBus.on(channel),
    frames: <K extends keyof EventMap>(channel: K) => eventBus.frames(channel),
    isSubscribed: (channel) => !unnamed.has(channel),
    trackReply: () => () => {},
    state$,
    emit: vi.fn(async <K extends keyof EventMap>(channel: K, payload: EventMap[K], envelope?: BusEnvelope) => {
      // The pair is this call's own two arguments; the assertion is what buys
      // narrowing at every read site.
      const emitted = { channel, payload, envelope, trace: getActiveTraceparent()?.traceparent } as Emitted;
      emits.push(emitted);
      if (failing.has(channel)) throw thrown.get(channel) ?? new Error(`the gateway did not take ${channel}`);
      const correlationId = envelope?.correlationId;
      if (emitted.channel === 'mark:commit' && record.commit !== 'unanswered') {
        const ids = emitted.payload.annotations.map((committed) => committed.id);
        const acknowledged = record.commit === 'acknowledged';
        queueMicrotask(() => {
          if (acknowledged) eventBus.emit('mark:commit-ok', { response: { persisted: ids.length, annotationIds: ids } }, { correlationId });
          else eventBus.emit('mark:commit-failed', { message: 'the record could not append' }, { correlationId });
        });
      }
      if (emitted.channel === 'browse:annotation-requested' && record.question !== 'unanswered') {
        const asked = emitted.payload.annotationId;
        const there = record.question === 'there';
        queueMicrotask(() => {
          if (there) eventBus.emit('browse:annotation-result', { response: { annotation: annotation(asked), resource: null, resolvedResource: null } }, { correlationId });
          else eventBus.emit('browse:annotation-failed', { message: 'Annotation not found' }, { correlationId });
        });
      }
      return undefined;
    }),
  };

  const claims = () => emits.filter((e) => e.channel === 'job:claim');
  const cid = (i: number) => claims()[i]!.envelope?.correlationId;
  const commits = () => emits.flatMap((e) => (e.channel === 'mark:commit' ? [e] : []));
  const questions = () => emits.flatMap((e) => (e.channel === 'browse:annotation-requested' ? [e] : []));

  return {
    bus,
    state$,
    failing,
    thrown,
    unnamed,
    record,
    pushEvent: <K extends keyof EventMap>(channel: K, payload: EventMap[K], correlationId?: string) =>
      eventBus.emit(channel, payload, { correlationId }),
    /** Every `job:claim` emitted so far, in order. */
    claims,
    claimAt: (i: number): EventMap['job:claim'] => {
      const e = claims()[i];
      if (!e) throw new Error(`no job:claim at index ${i} (${claims().length} emitted)`);
      return e.payload as EventMap['job:claim'];
    },
    claimCidAt: cid,
    /** The trace claim `i` was made in: undefined for one made in none. */
    claimTraceAt: (i: number): string | undefined => {
      const e = claims()[i];
      if (!e) throw new Error(`no job:claim at index ${i} (${claims().length} emitted)`);
      return e.trace;
    },
    /** Every `mark:commit` sent so far, in order. */
    commits,
    /** Every `browse:annotation-requested` sent so far, in order: what an unacknowledged commit asks. */
    questions,
    /** Everything said that is not a request: the lifecycle, in order. */
    said: () => emits.filter((e) => e.channel !== 'job:claim' && e.channel !== 'mark:commit' && e.channel !== 'browse:annotation-requested'),
    /** Answer claim `i` with a running job. */
    grant: (i: number, id: string, metadata: Partial<ClaimedJob['metadata']> = {}, params: Record<string, unknown> = {}) =>
      eventBus.emit('job:claimed', { response: runningJob(id, metadata, params) }, { correlationId: cid(i) }),
    /** Answer claim `i` with the dispatcher's decline: nothing pending. */
    decline: (i: number) =>
      eventBus.emit('job:claim-failed', { message: 'No pending job of the requested types', code: 'none-pending' }, { correlationId: cid(i) }),
    /** Answer claim `i` with a refusal carrying `code` (or none). */
    refuse: (i: number, code?: EventMap['job:claim-failed']['code'], message = 'refused') =>
      eventBus.emit('job:claim-failed', code ? { message, code } : { message }, { correlationId: cid(i) }),
    /**
     * Answer claim `i` with a `job:claimed` that is not a claimed job. The
     * channel's type forbids exactly this, which is the point of the case, so
     * this is the one place a reply is asserted to be what it is not.
     */
    grantMalformed: (i: number, response: unknown) =>
      eventBus.emit('job:claimed', { response: response as ClaimedJob }, { correlationId: cid(i) }),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const after = (ms: number) => new Promise((r) => setTimeout(r, ms));

type JobFilter = EventMap['job:claim']['accepts'][number];
type Motivation = Extract<JobFilter, { jobType: 'mark' }>['params']['motivation'];
const YIELD: JobFilter = { jobType: 'yield' };
const mark = (motivation: Motivation): JobFilter => ({ jobType: 'mark', params: { motivation } });
/** A worker that takes every job: one filter for each. */
const EVERYTHING: JobFilter[] = [YIELD, mark('highlighting'), mark('commenting'), mark('assessing'), mark('linking'), mark('tagging')];

/** An announcement: the job description less its input, as the dispatcher sends one. */
const queued = (what: 'yield' | Motivation, jobId = 'j'): EventMap['job:queued'] => {
  const about = { jobId: makeJobId(jobId), resourceId: resourceId('r1'), userId: userId('did:u1') };
  return what === 'yield'
    ? { ...about, jobType: 'yield', params: { title: 'Ouranos', storageUri: 'file://generated/ouranos.md' } }
    : { ...about, jobType: 'mark', params: what === 'tagging' ? { motivation: what, schemaId: 'irac', categories: ['Issue'] }
      : what === 'linking' ? { motivation: what, entityTypes: ['Person'] } : { motivation: what } };
};

/** Read a worker's claims, keeping what it comes to hold and what it is told beside that. */
function reading(h: ReturnType<typeof fakeBus>, options: Partial<ClaimOptions> = {}) {
  const claims = new ClaimsObservable(h.bus, { accepts: EVERYTHING, ...options });
  const held: HeldJob[] = [];
  const refusals: ClaimRefusal[] = [];
  const stalls: HeldJobStall[] = [];
  const ended = { claims: false, refused: false, stalled: false };
  let failure: unknown;
  claims.refused$.subscribe({ next: (r) => refusals.push(r), complete: () => { ended.refused = true; } });
  claims.stalled$.subscribe({ next: (s) => stalls.push(s), complete: () => { ended.stalled = true; } });
  const subscription = claims.subscribe({ next: (job) => held.push(job), error: (e) => { failure = e; }, complete: () => { ended.claims = true; } });
  return { claims, held, refusals, stalls, ended, subscription, failure: () => failure };
}

/** Complete a held `mark` job that found nothing. A completion is its verb's, so the verb is narrowed first. */
function finish(job: HeldJob): Promise<void> {
  if (job.jobType !== 'mark') throw new Error(`${job.jobId} is not a mark job`);
  return job.complete({ found: 0, persisted: 0 });
}

/** A commit's wait, for a case that must not wait a minute for the record. */
const QUICK_COMMIT = { markCommitTimeoutMs: 20 };

/**
 * Commit one annotation, with the record played so that the commit observes
 * `how`. Resolves with nothing when the commit is established, and with what
 * it rejected with when it is not.
 */
function commitObserving(h: ReturnType<typeof fakeBus>, job: HeldJob, how: Durability, id = 'ann-1'): Promise<unknown> {
  h.record.commit = how === 'acknowledged' ? 'acknowledged' : 'unanswered';
  h.record.question = how === 'probe-confirmed' ? 'there' : how === 'probe-refused' ? 'not-there' : 'unanswered';
  return job.commit(resourceId('res-1'), [annotation(id)]).then(() => undefined, (error: unknown) => error);
}

/** Read, and be granted the first claim: the worker holds `id`. */
async function holding(h: ReturnType<typeof fakeBus>, id = 'j1', metadata: Partial<ClaimedJob['metadata']> = {}, params: Record<string, unknown> = {}, options: Partial<ClaimOptions> = {}) {
  const r = reading(h, options);
  h.grant(0, id, metadata, params);
  await tick();
  const job = r.held[0];
  if (!job) throw new Error('the worker holds nothing');
  return { ...r, job };
}

describe('job.claim — a worker claims when it becomes idle, and at no other time', () => {
  let h: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    h = fakeBus();
  });

  it('claims nothing until its claims are read', () => {
    new ClaimsObservable(h.bus, { accepts: [YIELD] });
    expect(h.claims()).toHaveLength(0);
  });

  it('claims once read, with no announcement, carrying what it accepts', () => {
    const r = reading(h, { accepts: [YIELD] });

    expect(h.claims()).toHaveLength(1);
    expect(h.claimAt(0)).toEqual({ accepts: [YIELD] });
    expect(typeof h.claimCidAt(0)).toBe('string');

    r.subscription.unsubscribe();
  });

  it('waits for the stream to open before the first claim', () => {
    const closed = fakeBus('connecting');
    const r = reading(closed);
    expect(closed.claims(), 'a claim on a closed stream would only be refused here').toHaveLength(0);

    closed.state$.next('open');
    expect(closed.claims()).toHaveLength(1);

    r.subscription.unsubscribe();
  });

  it('claims again as soon as a job is completed, with no timer and no announcement', async () => {
    const r = await holding(h);
    expect(h.claims()).toHaveLength(1);

    await finish(r.job);
    expect(h.claims()).toHaveLength(2);

    h.grant(1, 'j2');
    await tick();
    expect(r.held.map((job) => job.jobId)).toEqual(['j1', 'j2']);

    r.subscription.unsubscribe();
  });

  it('claims again as soon as a job is failed, and as soon as one is cancelled', async () => {
    const r = await holding(h);
    await r.job.fail('kaboom');
    expect(h.claims()).toHaveLength(2);

    h.grant(1, 'j2');
    await tick();
    await r.held[1]!.cancel();
    expect(h.claims()).toHaveLength(3);

    r.subscription.unsubscribe();
  });

  it('a matching job:queued while it holds nothing claims; one that matches no filter does not', async () => {
    const r = reading(h, { accepts: [mark('tagging')] });
    h.decline(0);
    await tick();

    h.pushEvent('job:queued', queued('yield'));
    expect(h.claims(), 'no round trip for a job type this worker does not take').toHaveLength(1);
    h.pushEvent('job:queued', queued('highlighting'));
    expect(h.claims(), 'nor for a mark job of another motivation').toHaveLength(1);

    h.pushEvent('job:queued', queued('tagging'));
    expect(h.claims()).toHaveLength(2);
    expect(h.claimAt(1).accepts).toEqual([mark('tagging')]);

    r.subscription.unsubscribe();
  });

  it('a job:queued while a job is held is ignored; the settle claims', async () => {
    const r = await holding(h);

    h.pushEvent('job:queued', queued('yield', 'j2'));
    expect(h.claims(), 'no claim while holding a job').toHaveLength(1);

    await finish(r.job);
    expect(h.claims(), 'the settle asks; the announcement needed no memory').toHaveLength(2);

    r.subscription.unsubscribe();
  });

  it('a job:queued during a claim in flight earns exactly one more claim', async () => {
    const r = reading(h);
    expect(h.claims()).toHaveLength(1);

    // Two announcements land while claim 0 is in flight: one bit, not a counter.
    h.pushEvent('job:queued', queued('yield', 'a'));
    h.pushEvent('job:queued', queued('yield', 'b'));
    expect(h.claims()).toHaveLength(1);

    h.decline(0);
    await tick();
    expect(h.claims(), 'exactly one more').toHaveLength(2);

    h.decline(1);
    await tick();
    expect(h.claims(), 'then nothing until the next idle moment').toHaveLength(2);

    r.subscription.unsubscribe();
  });

  it('none-pending is not a fault: nothing is reported, and nothing is held', async () => {
    const r = reading(h);
    h.decline(0);
    await tick();

    expect(r.refusals, 'an empty queue is not a fault').toEqual([]);
    expect(r.held).toEqual([]);
    expect(h.claims()).toHaveLength(1);

    r.subscription.unsubscribe();
  });

  it('claims on every edge into open: the stream opened again', async () => {
    const r = reading(h);
    h.decline(0);
    await tick();

    h.state$.next('reconnecting');
    expect(h.claims(), 'losing the stream claims nothing').toHaveLength(1);
    h.state$.next('open');
    expect(h.claims(), 'regaining it asks: whatever was queued in the gap is claimable now').toHaveLength(2);

    h.state$.next('open');
    expect(h.claims(), 'open to open is not an edge').toHaveLength(2);

    r.subscription.unsubscribe();
  });

  it('an unauthorized claim is reported as such; the worker holds nothing and does not ask again by itself', async () => {
    const r = reading(h);
    h.refuse(0, 'unauthorized', 'job:claim refused: the caller is not a worker for this knowledge base');
    await tick();

    expect(r.refusals).toEqual([{ code: 'bus.unauthorized', message: 'job:claim refused: the caller is not a worker for this knowledge base' }]);
    expect(r.held).toEqual([]);
    expect(h.claims()).toHaveLength(1);

    r.subscription.unsubscribe();
  });

  it('a refusal with no code is reported as bus.rejected', async () => {
    const r = reading(h);
    h.refuse(0, undefined, 'job:claim: job j9 names no resource to record its assignment under');
    await tick();

    expect(r.refusals).toEqual([{ code: 'bus.rejected', message: 'job:claim: job j9 names no resource to record its assignment under' }]);

    r.subscription.unsubscribe();
  });

  // WORKER-CONTRACT C9. A worker must not run what it cannot read, and must
  // not stop claiming because of it.
  const whole = runningJob('j1');
  it.each([
    ['nothing', undefined],
    ['no metadata', { ...whole, metadata: undefined }],
    ['no job id', { ...whole, metadata: { ...whole.metadata, id: undefined } }],
    ['no job type', { ...whole, metadata: { ...whole.metadata, type: undefined } }],
    ['a job type that is no verb', { ...whole, metadata: { ...whole.metadata, type: 'weave' } }],
    ['no parameters', { ...whole, params: undefined }],
  ])('a reply that names no job (%s) is refused here, never held, and the next announcement claims', async (_what, response) => {
    const r = reading(h);
    h.grantMalformed(0, response);
    await tick();

    expect(r.refusals, 'reported, as a failure of this worker\'s own and under no bus code').toEqual([
      { code: null, message: 'job:claimed names no job: it has no job id, no job type or no parameters' },
    ]);
    expect(r.held, 'never held, so never run').toEqual([]);

    h.pushEvent('job:queued', queued('yield'));
    await tick();
    expect(h.claims(), 'the worker is not left with a claim in flight').toHaveLength(2);

    r.subscription.unsubscribe();
  });

  // WORKER-CONTRACT C10. The table's wait is ten seconds; a caller that must
  // not wait it out states its own, as the transport's callers do.
  it('a claim nobody answers is given up after jobClaimTimeoutMs, reported, and the next announcement claims', async () => {
    const r = reading(h, { jobClaimTimeoutMs: 20 });

    await after(80);
    expect(r.refusals.map((refusal) => refusal.code)).toEqual(['bus.timeout']);

    h.pushEvent('job:queued', queued('yield'));
    await tick();
    expect(h.claims()).toHaveLength(2);

    r.subscription.unsubscribe();
  });

  it('JOB_CLAIM_CHANNELS is what a worker\'s stream names for its claims', () => {
    expect([...JOB_CLAIM_CHANNELS].sort()).toEqual(['job:cancel-requested', 'job:claim-failed', 'job:claimed', 'job:queued']);
  });

  it.each(['job:queued', 'job:cancel-requested', 'job:claimed', 'job:claim-failed'] as const)(
    'a stream that does not name %s cannot carry a worker\'s claims, and reading them fails at once',
    (channel) => {
      // A worker on such a stream would claim once and never be woken, or
      // never hear a cancellation, with nothing thrown and nothing logged.
      h.unnamed.add(channel);
      const r = reading(h);

      expect(r.failure()).toMatchObject({ code: 'bus.unsubscribed' });
      expect(String(r.failure())).toContain(channel);
      expect(h.claims()).toHaveLength(0);
    },
  );

  it('its claims are read once: a second reader is refused, and the first is not disturbed', async () => {
    const r = reading(h);
    let second: unknown;
    r.claims.subscribe({ error: (e) => { second = e; } });

    expect(String(second)).toContain('read once');
    expect(h.claims(), 'one worker, one claim').toHaveLength(1);

    h.grant(0, 'j1');
    await tick();
    expect(r.held.map((job) => job.jobId)).toEqual(['j1']);

    r.subscription.unsubscribe();
  });

  it('stopping ends the claiming: a later announcement, or the stream opening again, asks nothing', async () => {
    const r = reading(h);
    h.decline(0);
    await tick();

    await r.claims.stop();
    h.pushEvent('job:queued', queued('yield'));
    h.state$.next('reconnecting');
    h.state$.next('open');

    expect(h.claims()).toHaveLength(1);
    expect(r.ended, 'everything it was read by is told it has ended').toEqual({ claims: true, refused: true, stalled: true });
  });

  it('a claim answered after the worker stopped is failed, and not left held by nobody', async () => {
    // The job is this worker's at the dispatcher from the moment the claim is
    // granted, whether or not anybody here is left to run it.
    const r = reading(h);
    await r.claims.stop();

    h.grant(0, 'j1');
    await tick();

    expect(r.held).toEqual([]);
    expect(h.said().map(({ channel, payload }) => ({ channel, payload }))).toEqual([
      { channel: 'job:fail', payload: { resourceId: 'res-1', jobId: 'j1', jobType: 'mark', attempt: 1, error: 'The worker stopped while it held the job', willRetry: true } },
    ]);
  });

  it('a reader that stops reading stops the claiming', async () => {
    const r = reading(h);
    h.decline(0);
    await tick();

    r.subscription.unsubscribe();
    h.pushEvent('job:queued', queued('yield'));

    expect(h.claims()).toHaveLength(1);
    expect(r.ended.refused && r.ended.stalled).toBe(true);
  });
});

describe('job.claim — the held job', () => {
  let h: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    h = fakeBus();
  });

  it('is the claimed record: its id, its type, its parameters whole, its budget, and no checkpoint on a first attempt', async () => {
    const { job, subscription } = await holding(h, 'j1', { retryCount: 1, maxRetries: 3 }, { motivation: 'highlighting', foo: 'bar' });

    expect(job).toMatchObject({
      jobId: 'j1',
      jobType: 'mark',
      resourceId: 'res-1',
      params: { resourceId: 'res-1', motivation: 'highlighting', foo: 'bar' },
      completedUnits: [],
      unitCursors: {},
      retryCount: 1,
      maxRetries: 3,
      attempt: 2,
      annotationId: undefined,
      settled: false,
    });
    expect(job.cancelled.aborted).toBe(false);

    subscription.unsubscribe();
  });

  // A held job is the record a `job:claimed` reply carries, as the spec types
  // it (`JobRunning`), read field by field. A field cannot be typed wider here
  // than the spec types it there: a job's type is a `JobType` and not text to
  // be recognised again, and its params are the record's params.
  it('each field has the type of the field it is read from', () => {
    expectTypeOf<HeldJob['jobId']>().toEqualTypeOf<ClaimedJob['metadata']['id']>();
    expectTypeOf<HeldJob['jobType']>().toEqualTypeOf<ClaimedJob['metadata']['type']>();
    expectTypeOf<HeldJob['resourceId']>().toEqualTypeOf<ClaimedJob['params']['resourceId']>();
    expectTypeOf<HeldJob['params']>().toEqualTypeOf<ClaimedJob['params']>();
    expectTypeOf<HeldJob['retryCount']>().toEqualTypeOf<ClaimedJob['metadata']['retryCount']>();
    expectTypeOf<HeldJob['maxRetries']>().toEqualTypeOf<ClaimedJob['metadata']['maxRetries']>();
    expectTypeOf<HeldJob['completedUnits']>().toEqualTypeOf<Readonly<NonNullable<ClaimedJob['metadata']['completedUnits']>>>();
    expectTypeOf<HeldJob['unitCursors']>().toEqualTypeOf<Readonly<NonNullable<ClaimedJob['metadata']['unitCursors']>>>();
  });

  it('carries the checkpoint earlier attempts left, as the record states it', async () => {
    const cursor = { next: 12_400, size: 560, found: 20, emitted: 18, errors: 0 };
    const { job, subscription } = await holding(h, 'j1', { completedUnits: ['Person', 'Date'], unitCursors: { Place: cursor } });

    expect(job.completedUnits).toEqual(['Person', 'Date']);
    expect(job.unitCursors).toEqual({ Place: cursor });

    subscription.unsubscribe();
  });

  it('a yield job focused on an annotation is anchored to it; one focused on a resource is anchored to none', async () => {
    const onAnnotation = await holding(h, 'j1', { type: 'yield' }, { context: { focus: { kind: 'annotation', annotation: { id: 'ann-7' } } } });
    expect(onAnnotation.job.annotationId).toBe(annotationId('ann-7'));
    onAnnotation.subscription.unsubscribe();

    const other = fakeBus();
    const onResource = await holding(other, 'j2', { type: 'yield' }, { context: { focus: { kind: 'resource' } } });
    expect(onResource.job.annotationId).toBeUndefined();
    onResource.subscription.unsubscribe();
  });

  it('says its whole lifecycle itself: a start, progress and checkpoints, and one completion that is its verb\'s', async () => {
    const { job, subscription } = await holding(h, 'j1', { retryCount: 1 });
    const cursor = { next: 1200, size: 800, found: 4, emitted: 3, errors: 0 };

    await job.start();
    await job.progress({ percentage: 40 });
    await job.checkpoint({ completedUnits: ['Person'], unitCursors: { Place: cursor } });
    expect(await commitObserving(h, job, 'acknowledged')).toBeUndefined();
    if (job.jobType !== 'mark') throw new Error('the record says mark');
    await job.complete({ found: 9, persisted: 7 });

    const identity = { resourceId: 'res-1', jobId: 'j1', jobType: 'mark', attempt: 2 };
    expect(h.said().map(({ channel, payload }) => ({ channel, payload }))).toEqual([
      { channel: 'job:start', payload: identity },
      { channel: 'job:report-progress', payload: { ...identity, percentage: 40, progress: { percentage: 40 } } },
      { channel: 'job:checkpoint', payload: { jobId: 'j1', completedUnits: ['Person'], unitCursors: { Place: cursor } } },
      { channel: 'job:complete', payload: { ...identity, result: { found: 9, persisted: 7 }, durability: 'acknowledged' } },
    ]);
    expect(h.said().every((e) => e.envelope === undefined), 'every lifecycle message is global and nobody\'s reply').toBe(true);
    expect(job.settled).toBe(true);

    subscription.unsubscribe();
  });

  it('a job anchored to an annotation says so on every message a follower routes by it', async () => {
    const { job, subscription } = await holding(h, 'j1', { type: 'yield', maxRetries: 0 }, { context: { focus: { kind: 'annotation', annotation: { id: 'ann-7' } } } });

    await job.start();
    await job.progress({ percentage: 5 });
    if (job.jobType !== 'yield') throw new Error('the record says yield');
    await job.complete({ resourceId: resourceId('res-new'), resourceName: 'Ouranos', truncated: false });

    const identity = { resourceId: 'res-1', jobId: 'j1', jobType: 'yield', attempt: 1, annotationId: 'ann-7' };
    expect(h.said().map(({ payload }) => payload)).toEqual([
      identity,
      { ...identity, percentage: 5, progress: { percentage: 5, annotationId: 'ann-7' } },
      { ...identity, result: { resourceId: 'res-new', resourceName: 'Ouranos', truncated: false } },
    ]);

    subscription.unsubscribe();
  });

  it('job:start is a held job\'s first message, said once', async () => {
    const { job, subscription } = await holding(h);

    await job.start();
    await expect(job.start()).rejects.toThrow(/first message/);

    const late = fakeBus();
    const other = await holding(late);
    await other.job.progress({ percentage: 1 });
    await expect(other.job.start()).rejects.toThrow(/first message/);
    expect(late.said().map((e) => e.channel)).toEqual(['job:report-progress']);

    subscription.unsubscribe();
    other.subscription.unsubscribe();
  });

  it('a failure says whether it will be retried, from the record\'s budget and the failure\'s class', async () => {
    const retried = await holding(h, 'j1', { retryCount: 0, maxRetries: 1 });
    await retried.job.fail('the model timed out', { completedUnits: ['Person'], unitCursors: { Place: { next: 1, size: 2, found: 3, emitted: 3, errors: 0 } } });
    expect(h.said()[0]).toMatchObject({
      channel: 'job:fail',
      payload: {
        resourceId: 'res-1', jobId: 'j1', jobType: 'mark', attempt: 1, error: 'the model timed out', willRetry: true,
        completedUnits: ['Person'], unitCursors: { Place: { next: 1, size: 2, found: 3, emitted: 3, errors: 0 } },
      },
    });
    expect(h.said()[0]!.payload, 'a class the worker does not know is not stated').not.toHaveProperty('failureClass');

    const known = fakeBus();
    const deterministic = await holding(known, 'j2', { retryCount: 0, maxRetries: 1 }, {}, QUICK_COMMIT);
    expect(await commitObserving(known, deterministic.job, 'probe-refused')).toMatchObject({ code: 'bus.timeout' });
    await deterministic.job.fail('the resource has no text', { failureClass: 'deterministic' });
    expect(known.said()[0]!.payload).toEqual({
      resourceId: 'res-1', jobId: 'j2', jobType: 'mark', attempt: 1, error: 'the resource has no text',
      failureClass: 'deterministic', durability: 'probe-refused', willRetry: false,
    });

    const spentBus = fakeBus();
    const spent = await holding(spentBus, 'j3', { retryCount: 1, maxRetries: 1 });
    await spent.job.fail('the model timed out');
    expect(spentBus.said()[0]!.payload).toMatchObject({ attempt: 2, willRetry: false });

    retried.subscription.unsubscribe();
    deterministic.subscription.unsubscribe();
    spent.subscription.unsubscribe();
  });

  it('a cancel says the units finished, and nothing the command does not name', async () => {
    const { job, subscription } = await holding(h);
    await job.cancel({ completedUnits: ['Person'] });

    expect(h.said().map(({ channel, payload }) => ({ channel, payload }))).toEqual([
      { channel: 'job:cancel', payload: { resourceId: 'res-1', jobId: 'j1', jobType: 'mark', completedUnits: ['Person'] } },
    ]);

    subscription.unsubscribe();
  });

  it('settles once: a second settle is refused and says nothing', async () => {
    const { job, subscription } = await holding(h);
    await finish(job);

    await expect(job.fail('too late')).rejects.toThrow(/already settled/);
    await expect(job.cancel()).rejects.toThrow(/already settled/);
    await expect(finish(job)).rejects.toThrow(/already settled/);
    await expect(job.progress({ percentage: 99 })).rejects.toThrow(/already settled/);

    expect(h.said().map((e) => e.channel)).toEqual(['job:complete']);
    expect(h.claims(), 'one settle, one claim after it').toHaveLength(2);

    subscription.unsubscribe();
  });

  it('a settle the gateway did not take still releases the job: the caller is told, and the worker claims', async () => {
    // Otherwise a worker whose completion could not be sent holds the job
    // forever, and claims nothing again.
    const { job, subscription } = await holding(h);
    h.failing.add('job:complete');

    await expect(finish(job)).rejects.toThrow(/did not take job:complete/);

    expect(job.settled).toBe(true);
    expect(h.claims()).toHaveLength(2);

    subscription.unsubscribe();
  });

  it('a cancellation that names the held job is signalled to the work; one that names another job is not', async () => {
    const { job, subscription } = await holding(h);

    h.pushEvent('job:cancel-requested', { jobId: makeJobId('j7') });
    expect(job.cancelled.aborted).toBe(false);

    h.pushEvent('job:cancel-requested', { jobId: makeJobId('j1') });
    expect(job.cancelled.aborted).toBe(true);

    subscription.unsubscribe();
  });

  it('a cancellation that arrives after the job settled signals nothing', async () => {
    const { job, subscription } = await holding(h);
    await finish(job);

    h.pushEvent('job:cancel-requested', { jobId: makeJobId('j1') });
    expect(job.cancelled.aborted).toBe(false);

    subscription.unsubscribe();
  });

  it('a worker that stops while it holds a job fails it, saying so, and leaves it to its retry budget', async () => {
    const { job, claims } = await holding(h, 'j1', { retryCount: 0, maxRetries: 1 });

    await claims.stop();

    expect(job.settled).toBe(true);
    expect(h.said().map(({ channel, payload }) => ({ channel, payload }))).toEqual([
      { channel: 'job:fail', payload: { resourceId: 'res-1', jobId: 'j1', jobType: 'mark', attempt: 1, error: 'The worker stopped while it held the job', willRetry: true } },
    ]);
    expect(h.claims(), 'and claims nothing more').toHaveLength(1);
  });

  it('a reader that stops reading while a job is held fails it the same way', async () => {
    const { subscription } = await holding(h);

    subscription.unsubscribe();
    await tick();

    expect(h.said().map((e) => e.channel)).toEqual(['job:fail']);
  });

  it('a worker that stops after settling says nothing more, and stopping twice is one stop', async () => {
    const { job, claims } = await holding(h);
    await finish(job);
    h.decline(1);
    await tick();

    await claims.stop();
    await claims.stop();

    expect(h.said().map((e) => e.channel)).toEqual(['job:complete']);
  });

  it('a stop whose failure the gateway did not take still stops', async () => {
    const { claims } = await holding(h);
    h.failing.add('job:fail');

    await expect(claims.stop()).resolves.toBeUndefined();
  });
});

// WORKER-CONTRACT § Committing annotations (A1, A4, A5, A6).
describe('job.claim — a held job commits for itself', () => {
  let h: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    h = fakeBus();
  });

  /** The last thing the worker said of the job: its settle. */
  const settle = (of: ReturnType<typeof fakeBus> = h) => {
    const last = of.said().at(-1);
    if (!last) throw new Error('the worker has said nothing');
    return last;
  };

  it('JOB_COMMIT_CHANNELS is what a worker\'s stream names for its commits', () => {
    expect([...JOB_COMMIT_CHANNELS].sort()).toEqual(['browse:annotation-failed', 'browse:annotation-result', 'mark:commit-failed', 'mark:commit-ok']);
  });

  it('sends the batch as a request that cites the job and names the resource it is given, and is established when the record acknowledges it, and not before', async () => {
    const { job, subscription } = await holding(h);
    const batch = [annotation('ann-1'), annotation('ann-2')];

    let established = false;
    // A job commits on more than one resource: here, on one that is not its own.
    const commit = job.commit(resourceId('res-new'), batch).then(() => { established = true; });

    expect(h.commits().map(({ payload }) => payload)).toEqual([{ resourceId: 'res-new', annotations: batch, jobId: 'j1' }]);
    expect(typeof h.commits()[0]!.envelope?.correlationId, 'a request, answered at its correlation id').toBe('string');

    await after(30);
    expect(established, 'the gateway taking the message says nothing of the record').toBe(false);

    h.pushEvent('mark:commit-ok', { response: { persisted: 2, annotationIds: batch.map((a) => a.id) } }, h.commits()[0]!.envelope?.correlationId);
    await commit;

    expect(established).toBe(true);
    expect(h.questions(), 'nothing is asked of a commit the record acknowledged').toEqual([]);
    expect(h.said(), 'a commit is no lifecycle message').toEqual([]);

    await finish(job);
    expect(settle().payload).toMatchObject({ durability: 'acknowledged' });

    subscription.unsubscribe();
  });

  it('a batch of no annotations is no commit: nothing is sent, and the job states nothing of its commits', async () => {
    const { job, subscription } = await holding(h);

    await expect(job.commit(resourceId('res-1'), [])).resolves.toBeUndefined();
    expect(h.commits()).toEqual([]);

    await finish(job);
    expect(settle().payload).toEqual({ resourceId: 'res-1', jobId: 'j1', jobType: 'mark', attempt: 1, result: { found: 0, persisted: 0 } });

    subscription.unsubscribe();
  });

  it('a job that committed nothing states nothing when it fails', async () => {
    const { job, subscription } = await holding(h);

    await job.fail('the model timed out');
    expect(settle().payload).not.toHaveProperty('durability');

    subscription.unsubscribe();
  });

  it('a commit the record refuses fails with the record\'s reason: nothing is asked, and nothing is observed', async () => {
    const { job, subscription } = await holding(h, 'j1', {}, {}, QUICK_COMMIT);
    h.record.commit = 'refused';

    const refused = await job.commit(resourceId('res-1'), [annotation('ann-1')]).then(() => undefined, (error: unknown) => error);

    expect(refused).toBeInstanceOf(BusRequestError);
    expect(refused).toMatchObject({ code: 'bus.rejected', message: 'the record could not append' });
    await after(60);
    expect(h.questions(), 'the record has answered').toEqual([]);

    await job.fail('the record could not append');
    expect(settle().payload).toEqual({ resourceId: 'res-1', jobId: 'j1', jobType: 'mark', attempt: 1, error: 'the record could not append', willRetry: true });

    subscription.unsubscribe();
  });

  it('a commit nobody acknowledges asks whether the batch\'s last annotation is on the resource; answered with it, the commit is established', async () => {
    const { job, subscription } = await holding(h, 'j1', {}, {}, QUICK_COMMIT);
    h.record.question = 'there';

    await expect(job.commit(resourceId('res-new'), [annotation('ann-1'), annotation('ann-2')])).resolves.toBeUndefined();

    expect(h.questions().map(({ payload }) => payload), 'the last, on the resource the batch was for').toEqual([{ resourceId: 'res-new', annotationId: 'ann-2' }]);
    expect(typeof h.questions()[0]!.envelope?.correlationId).toBe('string');
    expect(h.commits(), 'the record is asked what it holds; the batch is not sent again').toHaveLength(1);

    await finish(job);
    expect(settle().payload).toMatchObject({ durability: 'probe-confirmed' });

    subscription.unsubscribe();
  });

  it('answered that it is not there, the commit fails as its unanswered request did, and the job\'s failure says what was observed', async () => {
    const { job, subscription } = await holding(h, 'j1', {}, {}, QUICK_COMMIT);

    const failed = await commitObserving(h, job, 'probe-refused');

    // The failure of the `mark:commit` request itself, and not one made of
    // it, nor the question's: its class, its code, its message, and the
    // request it names.
    expect(failed).toBeInstanceOf(BusRequestError);
    expect(failed).toMatchObject({
      name: 'BusRequestError',
      code: 'bus.timeout',
      message: 'Bus request timed out after 20ms on mark:commit-ok',
      details: { channel: 'mark:commit', correlationId: h.commits()[0]!.envelope?.correlationId },
    });
    expect(h.questions()).toHaveLength(1);

    await job.fail('the commit was not established');
    expect(settle().payload).toEqual({
      resourceId: 'res-1', jobId: 'j1', jobType: 'mark', attempt: 1, error: 'the commit was not established', durability: 'probe-refused', willRetry: true,
    });

    subscription.unsubscribe();
  });

  it('not answered, it waits as long again, fails the same way, and says that nobody answered', async () => {
    const { job, subscription } = await holding(h, 'j1', {}, {}, { markCommitTimeoutMs: 60 });

    const began = performance.now();
    const failed = await commitObserving(h, job, 'probe-unreachable');
    const waited = performance.now() - began;

    expect(failed).toBeInstanceOf(BusRequestError);
    expect(failed).toMatchObject({ code: 'bus.timeout', message: 'Bus request timed out after 60ms on mark:commit-ok', details: { channel: 'mark:commit' } });
    expect(h.questions()).toHaveLength(1);
    expect(waited, 'the acknowledgement\'s wait, and then the answer\'s').toBeGreaterThanOrEqual(110);

    await job.fail('the commit was not established');
    expect(settle().payload).toMatchObject({ durability: 'probe-unreachable' });

    subscription.unsubscribe();
  });

  // The question's failure is read by the code it carries, never by its
  // class: a second copy of the library anywhere in the tree makes a class
  // check fail silently, and a refusal would be said as "nobody answered".
  it.each([
    ['carries bus.rejected, whatever its class', 'probe-refused', Object.assign(new Error('Annotation not found'), { code: 'bus.rejected' })],
    ['carries another code', 'probe-unreachable', Object.assign(new Error('Bus closed before emit'), { code: 'bus.closed' })],
    ['carries no code', 'probe-unreachable', new Error('the gateway did not take the question')],
  ] as const)('a question whose failure %s is observed as %s', async (_what, observed, failure) => {
    const { job, subscription } = await holding(h, 'j1', {}, {}, QUICK_COMMIT);
    h.failing.add('browse:annotation-requested');
    h.thrown.set('browse:annotation-requested', failure);

    const failed = await job.commit(resourceId('res-1'), [annotation('ann-1')]).then(() => undefined, (error: unknown) => error);

    expect(failed, 'the commit\'s own failure, never the question\'s').toMatchObject({ code: 'bus.timeout', details: { channel: 'mark:commit' } });
    await job.fail('the commit was not established');
    expect(settle().payload).toMatchObject({ durability: observed });

    subscription.unsubscribe();
  });

  it('any other failure of the commit\'s request is thrown as it is: nothing is asked, and nothing is observed', async () => {
    const { job, subscription } = await holding(h, 'j1', {}, {}, QUICK_COMMIT);
    h.failing.add('mark:commit');

    await expect(job.commit(resourceId('res-1'), [annotation('ann-1')])).rejects.toThrow(/did not take mark:commit/);
    await after(60);
    expect(h.questions()).toEqual([]);

    await job.fail('the gateway did not take the commit');
    expect(settle().payload).not.toHaveProperty('durability');

    subscription.unsubscribe();
  });

  it('a worker whose stream does not name JOB_COMMIT_CHANNELS claims as any other, and its commit fails as a request on an unnamed reply channel does', async () => {
    for (const channel of JOB_COMMIT_CHANNELS) h.unnamed.add(channel);
    const { job, failure, subscription } = await holding(h);
    expect(failure(), 'a worker that never commits names nothing more').toBeUndefined();

    await expect(job.commit(resourceId('res-1'), [annotation('ann-1')])).rejects.toMatchObject({ code: 'bus.unsubscribed' });
    expect(h.commits()).toEqual([]);

    subscription.unsubscribe();
  });

  it('a settled job commits nothing', async () => {
    const { job, subscription } = await holding(h);
    await finish(job);

    await expect(job.commit(resourceId('res-1'), [annotation('ann-1')])).rejects.toThrow(/already settled/);
    expect(h.commits()).toEqual([]);

    subscription.unsubscribe();
  });

  // A6. The job remembers the weakest of what its commits observed:
  // acknowledged, then established by asking, then not established. The two
  // ways of not being established are equally weak, and the first seen is kept.
  describe('what its settle says of its commits', () => {
    const ESTABLISHED: [Durability[], Durability][] = [
      [['acknowledged'], 'acknowledged'],
      [['acknowledged', 'acknowledged'], 'acknowledged'],
      [['probe-confirmed'], 'probe-confirmed'],
      [['acknowledged', 'probe-confirmed'], 'probe-confirmed'],
      [['probe-confirmed', 'acknowledged'], 'probe-confirmed'],
      [['acknowledged', 'probe-confirmed', 'acknowledged'], 'probe-confirmed'],
    ];
    const NOT_ESTABLISHED: [Durability[], Durability][] = [
      [['probe-refused'], 'probe-refused'],
      [['probe-unreachable'], 'probe-unreachable'],
      [['acknowledged', 'probe-refused'], 'probe-refused'],
      [['probe-confirmed', 'probe-unreachable'], 'probe-unreachable'],
      [['probe-refused', 'acknowledged'], 'probe-refused'],
      [['probe-unreachable', 'probe-confirmed'], 'probe-unreachable'],
      [['probe-refused', 'probe-unreachable'], 'probe-refused'],
      [['probe-unreachable', 'probe-refused'], 'probe-unreachable'],
    ];

    /** Hold a job and commit once for each of `observed`, in order. */
    async function committed(observed: Durability[]) {
      const r = await holding(h, 'j1', {}, {}, QUICK_COMMIT);
      for (const [i, how] of observed.entries()) {
        const failed = await commitObserving(h, r.job, how, `ann-${i}`);
        if (how === 'acknowledged' || how === 'probe-confirmed') expect(failed, `${how} establishes the commit`).toBeUndefined();
        else expect(failed, `${how} does not`).toMatchObject({ code: 'bus.timeout' });
      }
      expect(h.commits()).toHaveLength(observed.length);
      return r;
    }

    it.each([...ESTABLISHED, ...NOT_ESTABLISHED])('commits that observed %j: a completion says %s', async (observed, weakest) => {
      const { job, subscription } = await committed(observed);

      await finish(job);
      expect(settle()).toMatchObject({ channel: 'job:complete', payload: { durability: weakest } });

      subscription.unsubscribe();
    });

    it.each(NOT_ESTABLISHED)('commits that observed %j: a failure says %s', async (observed, weakest) => {
      const { job, subscription } = await committed(observed);

      await job.fail('the commit was not established');
      expect(settle()).toMatchObject({ channel: 'job:fail', payload: { durability: weakest } });

      subscription.unsubscribe();
    });

    it.each(ESTABLISHED)('commits that observed %j, all established: a failure for another reason says nothing of them', async (observed) => {
      const { job, subscription } = await committed(observed);

      await job.fail('the model timed out');
      expect(settle().channel).toBe('job:fail');
      expect(settle().payload).not.toHaveProperty('durability');

      subscription.unsubscribe();
    });

    it('a cancel says nothing of them', async () => {
      const { job, subscription } = await committed(['probe-refused']);

      await job.cancel();
      expect(settle().payload).toEqual({ resourceId: 'res-1', jobId: 'j1', jobType: 'mark' });

      subscription.unsubscribe();
    });

    it('a worker that stops while it holds a job whose commit was not established says so as it fails it', async () => {
      const { claims } = await committed(['probe-unreachable']);

      await claims.stop();
      expect(settle().payload).toMatchObject({ error: 'The worker stopped while it held the job', durability: 'probe-unreachable' });
    });

    // The job states what its commits observed; its caller is given no way to
    // state it for it.
    it('is the held job\'s alone to say', () => {
      expectTypeOf<Parameters<HeldMarkJob['complete']>>().toEqualTypeOf<[result: Parameters<HeldMarkJob['complete']>[0]]>();
      expectTypeOf<Parameters<HeldYieldJob['complete']>>().toEqualTypeOf<[result: Parameters<HeldYieldJob['complete']>[0]]>();
      expectTypeOf<JobFailure>().not.toHaveProperty('durability');
    });
  });
});

describe('job.claim — vitals', () => {
  let h: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    h = fakeBus();
  });

  it('start empty', () => {
    expect(new ClaimsObservable(h.bus, { accepts: EVERYTHING }).vitals()).toEqual({
      lastQueuedEventAt: null,
      lastClaimAt: null,
      lastFinishedAt: null,
      lastActivityAt: null,
      activeJob: null,
      jobsCompleted: 0,
    });
  });

  it('record the claim, the activity and the completion', async () => {
    const { job, claims, subscription } = await holding(h, 'jv1');

    const claimed = claims.vitals();
    expect(claimed.lastQueuedEventAt, 'no announcement was needed to claim').toBeNull();
    expect(claimed.lastClaimAt).not.toBeNull();
    expect(claimed.lastActivityAt).toBe(claimed.lastClaimAt);
    expect(claimed.activeJob).toEqual({ jobId: 'jv1', type: 'mark', since: claimed.lastClaimAt });
    expect(claimed.lastFinishedAt).toBeNull();

    await finish(job);

    const done = claims.vitals();
    expect(done.activeJob).toBeNull();
    expect(done.jobsCompleted).toBe(1);
    expect(done.lastFinishedAt).not.toBeNull();

    subscription.unsubscribe();
  });

  it('stamp every job:queued received, matching or not', async () => {
    const r = reading(h, { accepts: [YIELD] });

    h.pushEvent('job:queued', queued('commenting', 'jx'));

    expect(r.claims.vitals().lastQueuedEventAt).not.toBeNull();
    expect(h.claims(), 'still filtered: only the first claim').toHaveLength(1);

    r.subscription.unsubscribe();
  });

  it('count a progress report and a checkpoint as activity', async () => {
    const { job, claims, subscription } = await holding(h);
    const claimedAt = claims.vitals().lastActivityAt!;

    await after(5);
    await job.progress({ percentage: 10 });
    const reported = claims.vitals().lastActivityAt!;
    expect(Date.parse(reported)).toBeGreaterThan(Date.parse(claimedAt));

    await after(5);
    await job.checkpoint({ completedUnits: [] });
    expect(Date.parse(claims.vitals().lastActivityAt!)).toBeGreaterThan(Date.parse(reported));

    subscription.unsubscribe();
  });

  it('a failure and a cancel stamp the finish and count no completion', async () => {
    const r = await holding(h);
    await r.job.fail('kaboom');
    h.grant(1, 'j2');
    await tick();
    await r.held[1]!.cancel();

    const v = r.claims.vitals();
    expect(v.activeJob).toBeNull();
    expect(v.lastFinishedAt).not.toBeNull();
    expect(v.jobsCompleted).toBe(0);

    r.subscription.unsubscribe();
  });
});

describe('job.claim — a held job that shows no activity is stalled', () => {
  const QUICK = { heldJobStallMs: 40, heldJobStallCheckMs: 10 };
  let h: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    h = fakeBus();
  });

  it('is reported once, with the job and how long it has been silent', async () => {
    const { stalls, claims, subscription } = await holding(h, 'j1', {}, {}, QUICK);
    const { lastActivityAt, activeJob } = claims.vitals();

    await after(150);

    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ jobId: 'j1', jobType: 'mark', heldSince: activeJob!.since, lastActivityAt, thresholdMs: 40 });
    expect(stalls[0]!.silentForMs).toBeGreaterThan(40);

    subscription.unsubscribe();
  });

  it('a job that keeps reporting is never stalled, however long it runs', async () => {
    const { job, stalls, subscription } = await holding(h, 'j1', {}, {}, QUICK);

    for (let i = 0; i < 8; i++) {
      await after(15);
      await job.progress({ percentage: i });
    }

    expect(stalls).toEqual([]);
    subscription.unsubscribe();
  });

  it('an idle worker is never stalled', async () => {
    const r = reading(h, QUICK);
    h.decline(0);
    await after(120);

    expect(r.stalls).toEqual([]);
    r.subscription.unsubscribe();
  });

  it('a job settled before the threshold is never reported', async () => {
    const { job, stalls, subscription } = await holding(h, 'j1', {}, {}, QUICK);
    await finish(job);
    h.decline(1);

    await after(120);

    expect(stalls).toEqual([]);
    subscription.unsubscribe();
  });
});

// WORKER-CONTRACT T1. A trace crosses an await only where a context manager
// is installed, and is read as a `traceparent` only where a propagator is: a
// process that exports installs both, and so does this block, for as long as
// it runs. A frame is delivered inside the span of its arrival, which is what
// `inTrace` stands in for; so is a span of the worker's own code.
describe('job.claim — each job has a trace of its own', () => {
  const trace = (digit: number) => `00-${String(digit).repeat(32)}-${String(digit).repeat(16)}-01`;
  const inTrace = <T>(traceparent: string, work: () => T): T => withTraceparent({ traceparent }, work);
  let h: ReturnType<typeof fakeBus>;

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });
  afterAll(() => {
    propagation.disable();
    context.disable();
  });
  beforeEach(() => {
    h = fakeBus();
  });

  /** Read a worker's claims, keeping each job it is handed and the trace it was handed over in. */
  function readingTraces() {
    const claims = new ClaimsObservable(h.bus, { accepts: EVERYTHING });
    const held: HeldJob[] = [];
    const handedIn: Array<string | undefined> = [];
    const subscription = claims.subscribe((job) => {
      held.push(job);
      handedIn.push(getActiveTraceparent()?.traceparent);
    });
    return { held, handedIn, subscription };
  }

  it('makes its first claim in no trace, whatever span its claims are first read in', () => {
    const r = inTrace(trace(9), () => readingTraces());

    expect(h.claims()).toHaveLength(1);
    expect(h.claimTraceAt(0)).toBeUndefined();

    r.subscription.unsubscribe();
  });

  it('hands a job over in the trace of the reply that carried it', async () => {
    const r = readingTraces();

    inTrace(trace(1), () => h.grant(0, 'j1'));
    await tick();

    expect(r.handedIn).toEqual([trace(1)]);
    r.subscription.unsubscribe();
  });

  it('a held job states the trace its reply arrived in, and none for a reply that arrived in none', async () => {
    const r = readingTraces();
    inTrace(trace(1), () => h.grant(0, 'j1'));
    await tick();
    expect(r.held[0]!.trace).toEqual({ traceparent: trace(1) });

    await inTrace(trace(7), () => finish(r.held[0]!));
    h.grant(1, 'j2');
    await tick();
    expect(r.held[1]!.trace, 'not that of the job settled before it').toBeUndefined();

    r.subscription.unsubscribe();
  });

  it('the trace a held job states is a carrier OpenTelemetry\'s propagation takes as it is', async () => {
    const r = readingTraces();
    inTrace(trace(1), () => h.grant(0, 'j1'));
    await tick();

    const continued = propagation.extract(ROOT_CONTEXT, r.held[0]!.trace);

    expect(otelTrace.getSpanContext(continued)?.traceId).toBe('1'.repeat(32));
    r.subscription.unsubscribe();
  });

  it('claims from no span of the job it settled, and hands the next job over in its own reply\'s trace', async () => {
    const r = readingTraces();
    inTrace(trace(1), () => h.grant(0, 'j1'));
    await tick();

    // The worker's code settles the job inside a span of its own for it.
    await inTrace(trace(7), () => finish(r.held[0]!));
    expect(h.claims()).toHaveLength(2);
    expect(h.claimTraceAt(1)).toBeUndefined();

    inTrace(trace(2), () => h.grant(1, 'j2'));
    await tick();
    expect(r.held.map((job) => job.jobId)).toEqual(['j1', 'j2']);
    expect(r.handedIn).toEqual([trace(1), trace(2)]);

    r.subscription.unsubscribe();
  });

  it('claims from no span of a job it failed, or cancelled', async () => {
    const r = readingTraces();
    h.grant(0, 'j1');
    await tick();

    await inTrace(trace(7), () => r.held[0]!.fail('kaboom'));
    expect(h.claimTraceAt(1)).toBeUndefined();

    h.grant(1, 'j2');
    await tick();
    await inTrace(trace(8), () => r.held[1]!.cancel());
    expect(h.claimTraceAt(2)).toBeUndefined();

    r.subscription.unsubscribe();
  });

  it('hands a job whose reply arrived in no trace over in none: not in that of the job settled before it', async () => {
    const r = readingTraces();
    inTrace(trace(1), () => h.grant(0, 'j1'));
    await tick();
    await inTrace(trace(7), () => finish(r.held[0]!));

    h.grant(1, 'j2');
    await tick();

    expect(r.handedIn).toEqual([trace(1), undefined]);
    r.subscription.unsubscribe();
  });

  it('hands a job over in its own reply\'s trace when another worker\'s reply arrives beside it', async () => {
    const r = readingTraces();

    inTrace(trace(3), () => h.pushEvent('job:claimed', { response: runningJob('theirs') }, 'another-workers-claim'));
    inTrace(trace(1), () => h.grant(0, 'j1'));
    inTrace(trace(4), () => h.pushEvent('job:claimed', { response: runningJob('theirs-too') }, 'another-workers-claim'));
    await tick();

    expect(r.held.map((job) => job.jobId)).toEqual(['j1']);
    expect(r.handedIn).toEqual([trace(1)]);
    r.subscription.unsubscribe();
  });

  it('makes the claim an announcement wakes in no trace: not in that of the announcement', async () => {
    const r = readingTraces();
    h.decline(0);
    await tick();

    inTrace(trace(5), () => h.pushEvent('job:queued', queued('yield')));

    expect(h.claims()).toHaveLength(2);
    expect(h.claimTraceAt(1)).toBeUndefined();
    r.subscription.unsubscribe();
  });

  it('makes the claim a reopened stream causes in no trace', async () => {
    const r = readingTraces();
    h.decline(0);
    await tick();

    h.state$.next('reconnecting');
    inTrace(trace(6), () => h.state$.next('open'));

    expect(h.claims()).toHaveLength(2);
    expect(h.claimTraceAt(1)).toBeUndefined();
    r.subscription.unsubscribe();
  });
});

// Two consumers must never disagree about whether a failure is the end: the
// queue ACTS on the answer, and the worker REPORTS it on `job:fail` as
// `willRetry`. Every implementation runs specs/src/jobs/retry-cases.json.
describe('willRetryAfter (specs/src/jobs/retry-cases.json)', () => {
  interface RetryCase {
    why: string;
    retryCount: number;
    maxRetries: number;
    failureClass?: NonNullable<JobFailure['failureClass']>;
    retries: boolean;
  }
  const { cases } = JSON.parse(readFileSync(new URL('../../../../specs/src/jobs/retry-cases.json', import.meta.url), 'utf8')) as { cases: RetryCase[] };

  it('has cases to run', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.why, c] as const))('%s', (_why, c) => {
    expect(willRetryAfter({ retryCount: c.retryCount, maxRetries: c.maxRetries }, c.failureClass)).toBe(c.retries);
  });

  it.each(cases.map((c) => [c.why, c] as const))('a held job\'s failure says the same: %s', async (_why, c) => {
    const h = fakeBus();
    const { job, subscription } = await holding(h, 'j1', { retryCount: c.retryCount, maxRetries: c.maxRetries });
    await job.fail('it failed', c.failureClass === undefined ? {} : { failureClass: c.failureClass });

    expect(h.said()[0]!.payload).toMatchObject({ willRetry: c.retries });
    subscription.unsubscribe();
  });
});
