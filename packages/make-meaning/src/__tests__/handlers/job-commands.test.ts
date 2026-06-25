/**
 * Job-commands dispatcher tests.
 *
 * Specifically tests the tag-schema resolution path added in Stage 2 of
 * .plans/TAG-SCHEMAS-GAP.md. When a `job:create` arrives with
 * `jobType: 'tag-annotation'`, the dispatcher must:
 *
 *   1. Read `params.schemaId` (caller-supplied).
 *   2. Look it up in the per-KB tag-schemas projection.
 *   3. Embed the resolved `TagSchema` in the worker's `params.schema`.
 *   4. Drop `params.schemaId` (the worker contract uses the embedded shape).
 *
 * If the schemaId isn't registered, the dispatcher must reject
 * synchronously with `Tag schema not registered: <id>` via
 * `job:create-failed` — the post-Stage-2 contract that there's no silent
 * build-time fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { firstValueFrom, filter, race, timer, take } from 'rxjs';
import { EventBus, jobId, userId, resourceId, type Logger, type TagSchema } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import { FsJobQueue } from '@semiont/jobs';
import { registerJobCommandHandlers } from '../../handlers/job-commands';
import { createTestProject } from '../helpers/test-project';

const silentLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

const TEST_USER_DID = 'did:web:test:users:test';

const SCHEMA: TagSchema = {
  id: 'schema-under-test',
  name: 'Schema Under Test',
  description: 'Pre-registered schema for dispatcher tests.',
  domain: 'test',
  tags: [
    { name: 'A', description: 'cat A', examples: ['ex1'] },
    { name: 'B', description: 'cat B', examples: ['ex2'] },
  ],
};

interface MockJobQueue {
  createJob: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
  updateJob: ReturnType<typeof vi.fn>;
  completeJob: ReturnType<typeof vi.fn>;
  failJob: ReturnType<typeof vi.fn>;
  recordProgress: ReturnType<typeof vi.fn>;
  cancelPendingJobs: ReturnType<typeof vi.fn>;
}

function makeJobQueue(): MockJobQueue {
  return {
    createJob: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(null),
    updateJob: vi.fn().mockResolvedValue(undefined),
    completeJob: vi.fn().mockResolvedValue(true),
    failJob: vi.fn().mockResolvedValue('failed'),
    recordProgress: vi.fn().mockResolvedValue(undefined),
    cancelPendingJobs: vi.fn().mockResolvedValue(0),
  };
}

async function writeTagSchemasProjection(project: SemiontProject, schemas: TagSchema[]): Promise<void> {
  const dir = join(project.stateDir, 'projections', '__system__');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'tagschemas.json'), JSON.stringify({ tagSchemas: schemas }));
}

async function writeEntityTypesProjection(project: SemiontProject, entityTypes: string[]): Promise<void> {
  const dir = join(project.stateDir, 'projections', '__system__');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'entitytypes.json'), JSON.stringify({ entityTypes }));
}

interface JobCreatedEvent {
  correlationId: string;
  response: { jobId: string };
}
interface JobCreateFailedEvent {
  correlationId: string;
  message: string;
}

describe('registerJobCommandHandlers — tag-annotation dispatcher', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;
  let eventBus: EventBus;
  let jobQueue: MockJobQueue;

  beforeEach(async () => {
    ({ project, teardown } = await createTestProject('job-commands-dispatcher'));
    eventBus = new EventBus();
    jobQueue = makeJobQueue();
    registerJobCommandHandlers(eventBus, jobQueue as never, project, silentLogger);
  });

  afterEach(async () => {
    eventBus.destroy();
    await teardown();
  });

  it('resolves a registered schemaId and embeds the TagSchema in worker params', async () => {
    await writeTagSchemasProjection(project, [SCHEMA]);

    const created$ = (
      eventBus.get('job:created') as never as import('rxjs').Observable<JobCreatedEvent>
    ).pipe(
      filter((e) => e.correlationId === 'cid-1'),
      take(1),
    );
    const failed$ = (
      eventBus.get('job:create-failed') as never as import('rxjs').Observable<JobCreateFailedEvent>
    ).pipe(
      filter((e) => e.correlationId === 'cid-1'),
      take(1),
    );

    eventBus.get('job:create').next({
      correlationId: 'cid-1',
      jobType: 'tag-annotation',
      resourceId: 'rid-test',
      params: {
        schemaId: SCHEMA.id,
        categories: ['A'],
      },
      _userId: TEST_USER_DID,
    } as never);

    // Whichever side fires first wins — we expect job:created.
    const result = await firstValueFrom(race(created$, failed$, timer(2_000)));
    expect(result, 'job:created should fire (dispatcher resolved the schema)').toBeDefined();
    expect((result as JobCreatedEvent).response?.jobId, 'job:created carries a jobId').toBeTruthy();

    // Verify the dispatcher's resolution shape on the queued job.
    expect(jobQueue.createJob).toHaveBeenCalledTimes(1);
    const queuedJob = jobQueue.createJob.mock.calls[0][0] as {
      params: { schema?: TagSchema; schemaId?: string; categories: string[] };
    };
    expect(queuedJob.params.schema, 'worker params must carry the resolved TagSchema').toBeDefined();
    expect(queuedJob.params.schema!.id).toBe(SCHEMA.id);
    expect(queuedJob.params.schema!.tags.map((t) => t.name)).toEqual(['A', 'B']);
    expect(
      queuedJob.params.schemaId,
      'worker params must NOT carry the raw schemaId — the embedded schema is the contract',
    ).toBeUndefined();
    expect(queuedJob.params.categories).toEqual(['A']);
  });

  it('rejects synchronously with `Tag schema not registered` when the schemaId is unknown', async () => {
    // No projection written — `readTagSchemasProjection` returns [] and
    // the dispatcher can't resolve any schemaId.
    const failed$ = (
      eventBus.get('job:create-failed') as never as import('rxjs').Observable<JobCreateFailedEvent>
    ).pipe(
      filter((e) => e.correlationId === 'cid-2'),
      take(1),
    );

    eventBus.get('job:create').next({
      correlationId: 'cid-2',
      jobType: 'tag-annotation',
      resourceId: 'rid-test',
      params: {
        schemaId: 'definitely-not-registered',
        categories: ['A'],
      },
      _userId: TEST_USER_DID,
    } as never);

    const result = await firstValueFrom(race(failed$, timer(2_000)));
    expect(result, 'job:create-failed should fire').toBeDefined();
    expect((result as JobCreateFailedEvent).message).toMatch(/Tag schema not registered/);
    expect(jobQueue.createJob).not.toHaveBeenCalled();
  });

  it('rejects when tag-annotation params omit schemaId entirely', async () => {
    await writeTagSchemasProjection(project, [SCHEMA]);

    // The "missing schemaId" path throws synchronously inside the
    // subscriber's async callback (no `await` before the throw), so the
    // failed event fires in the same tick as the .next(). Subscribe
    // BEFORE emitting and collect; otherwise the event is gone by the
    // time `firstValueFrom` runs.
    const failedEvents: JobCreateFailedEvent[] = [];
    const sub = (eventBus.get('job:create-failed') as never as import('rxjs').Observable<JobCreateFailedEvent>)
      .subscribe((e) => {
        if (e.correlationId === 'cid-3') failedEvents.push(e);
      });

    eventBus.get('job:create').next({
      correlationId: 'cid-3',
      jobType: 'tag-annotation',
      resourceId: 'rid-test',
      params: { categories: ['A'] },
      _userId: TEST_USER_DID,
    } as never);

    // Yield the microtask queue so the async subscriber's catch fires.
    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]!.message).toMatch(/tag-annotation requires schemaId/);
    expect(jobQueue.createJob).not.toHaveBeenCalled();
  });

  it('does NOT touch the projection for non-tag-annotation jobTypes', async () => {
    // Non-tagging jobs go through the existing path unchanged. Use a
    // generation job which has no schemaId at all.
    const created$ = (
      eventBus.get('job:created') as never as import('rxjs').Observable<JobCreatedEvent>
    ).pipe(
      filter((e) => e.correlationId === 'cid-4'),
      take(1),
    );

    eventBus.get('job:create').next({
      correlationId: 'cid-4',
      jobType: 'generation',
      resourceId: 'rid-test',
      params: { title: 'Test' },
      _userId: TEST_USER_DID,
    } as never);

    const result = await firstValueFrom(race(created$, timer(2_000)));
    expect(result, 'job:created should fire for generation jobs').toBeDefined();
    expect(jobQueue.createJob).toHaveBeenCalledTimes(1);
    const queuedJob = jobQueue.createJob.mock.calls[0][0] as { params: Record<string, unknown> };
    expect(queuedJob.params.schema, 'generation jobs must not get a TagSchema injected').toBeUndefined();
    expect(queuedJob.params.schemaId).toBeUndefined();
  });

  it('sets maxRetries to 0 for generation (non-idempotent) and 1 for detection', async () => {
    const gen$ = (eventBus.get('job:created') as never as import('rxjs').Observable<JobCreatedEvent>)
      .pipe(filter((e) => e.correlationId === 'cid-retry-gen'), take(1));
    eventBus.get('job:create').next({
      correlationId: 'cid-retry-gen', jobType: 'generation', resourceId: 'rid-test',
      params: { title: 'T' }, _userId: TEST_USER_DID,
    } as never);
    await firstValueFrom(race(gen$, timer(2_000)));
    const genJob = jobQueue.createJob.mock.calls.at(-1)![0] as { metadata: { maxRetries: number } };
    expect(genJob.metadata.maxRetries, 'generation must not retry — re-rolling is not a replay').toBe(0);

    const ref$ = (eventBus.get('job:created') as never as import('rxjs').Observable<JobCreatedEvent>)
      .pipe(filter((e) => e.correlationId === 'cid-retry-ref'), take(1));
    eventBus.get('job:create').next({
      correlationId: 'cid-retry-ref', jobType: 'reference-annotation', resourceId: 'rid-test',
      params: {}, _userId: TEST_USER_DID,
    } as never);
    await firstValueFrom(race(ref$, timer(2_000)));
    const refJob = jobQueue.createJob.mock.calls.at(-1)![0] as { metadata: { maxRetries: number } };
    expect(refJob.metadata.maxRetries, 'detection keeps one self-heal retry').toBe(1);
  });
});

describe('registerJobCommandHandlers — entity-type validation', () => {
  // Symmetric to the tag-schema dispatcher rejection: when a caller
  // supplies `entityTypes` that aren't in the per-KB entity-type
  // projection, the dispatcher rejects synchronously rather than
  // letting the worker stamp an annotation (or synthesized resource)
  // with a tag that isn't part of the KB's declared vocabulary.
  //
  // Validation applies to the two jobTypes that surface entityTypes
  // in their params:
  //  - `reference-annotation` (mark.assist linking)
  //  - `generation` (yield.fromAnnotation, post-Stage-2 of TAG-SCHEMAS-GAP)
  //
  // Other jobTypes don't carry entityTypes through params; the check
  // is a no-op for them.

  let project: SemiontProject;
  let teardown: () => Promise<void>;
  let eventBus: EventBus;
  let jobQueue: MockJobQueue;

  beforeEach(async () => {
    ({ project, teardown } = await createTestProject('job-commands-entity-validation'));
    eventBus = new EventBus();
    jobQueue = makeJobQueue();
    registerJobCommandHandlers(eventBus, jobQueue as never, project, silentLogger);
  });

  afterEach(async () => {
    eventBus.destroy();
    await teardown();
  });

  it('reference-annotation: accepts entityTypes that are all registered', async () => {
    await writeEntityTypesProjection(project, ['Person', 'Organization', 'Location']);

    const created$ = (
      eventBus.get('job:created') as never as import('rxjs').Observable<JobCreatedEvent>
    ).pipe(
      filter((e) => e.correlationId === 'cid-ref-ok'),
      take(1),
    );

    eventBus.get('job:create').next({
      correlationId: 'cid-ref-ok',
      jobType: 'reference-annotation',
      resourceId: 'rid-test',
      params: { entityTypes: ['Person', 'Organization'] },
      _userId: TEST_USER_DID,
    } as never);

    const result = await firstValueFrom(race(created$, timer(2_000)));
    expect(result, 'job:created should fire').toBeDefined();
    expect(jobQueue.createJob).toHaveBeenCalledTimes(1);
  });

  it('reference-annotation: rejects when any entityType is unregistered, listing the missing ones', async () => {
    await writeEntityTypesProjection(project, ['Person', 'Organization']);

    const failedEvents: JobCreateFailedEvent[] = [];
    const sub = (eventBus.get('job:create-failed') as never as import('rxjs').Observable<JobCreateFailedEvent>)
      .subscribe((e) => {
        if (e.correlationId === 'cid-ref-bad') failedEvents.push(e);
      });

    eventBus.get('job:create').next({
      correlationId: 'cid-ref-bad',
      jobType: 'reference-annotation',
      resourceId: 'rid-test',
      params: { entityTypes: ['Person', 'NotRegistered', 'AlsoMissing'] },
      _userId: TEST_USER_DID,
    } as never);

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]!.message).toMatch(/Entity type not registered/);
    // Both unknown tags should appear in the message — operators need
    // to see the full set, not just the first one.
    expect(failedEvents[0]!.message).toMatch(/NotRegistered/);
    expect(failedEvents[0]!.message).toMatch(/AlsoMissing/);
    expect(jobQueue.createJob).not.toHaveBeenCalled();
  });

  it('generation: accepts entityTypes that are all registered', async () => {
    await writeEntityTypesProjection(project, ['Character', 'Hero']);

    const created$ = (
      eventBus.get('job:created') as never as import('rxjs').Observable<JobCreatedEvent>
    ).pipe(
      filter((e) => e.correlationId === 'cid-gen-ok'),
      take(1),
    );

    eventBus.get('job:create').next({
      correlationId: 'cid-gen-ok',
      jobType: 'generation',
      resourceId: 'rid-test',
      params: { title: 'X', entityTypes: ['Character', 'Hero'] },
      _userId: TEST_USER_DID,
    } as never);

    const result = await firstValueFrom(race(created$, timer(2_000)));
    expect(result).toBeDefined();
    expect(jobQueue.createJob).toHaveBeenCalledTimes(1);
  });

  it('generation: rejects when entityTypes contain an unregistered tag', async () => {
    await writeEntityTypesProjection(project, ['Character']);

    const failedEvents: JobCreateFailedEvent[] = [];
    const sub = (eventBus.get('job:create-failed') as never as import('rxjs').Observable<JobCreateFailedEvent>)
      .subscribe((e) => {
        if (e.correlationId === 'cid-gen-bad') failedEvents.push(e);
      });

    eventBus.get('job:create').next({
      correlationId: 'cid-gen-bad',
      jobType: 'generation',
      resourceId: 'rid-test',
      params: { title: 'X', entityTypes: ['Character', 'UnknownThing'] },
      _userId: TEST_USER_DID,
    } as never);

    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]!.message).toMatch(/Entity type not registered: UnknownThing/);
    expect(jobQueue.createJob).not.toHaveBeenCalled();
  });

  it('reference-annotation: omitting entityTypes skips the check (no projection read required)', async () => {
    // No entitytypes.json projection written — validation should be
    // a no-op when the caller doesn't supply entityTypes at all.
    const created$ = (
      eventBus.get('job:created') as never as import('rxjs').Observable<JobCreatedEvent>
    ).pipe(
      filter((e) => e.correlationId === 'cid-ref-noet'),
      take(1),
    );

    eventBus.get('job:create').next({
      correlationId: 'cid-ref-noet',
      jobType: 'reference-annotation',
      resourceId: 'rid-test',
      params: {},
      _userId: TEST_USER_DID,
    } as never);

    const result = await firstValueFrom(race(created$, timer(2_000)));
    expect(result, 'job:created should fire').toBeDefined();
    expect(jobQueue.createJob).toHaveBeenCalledTimes(1);
  });

  it('reference-annotation: empty entityTypes array skips the check', async () => {
    const created$ = (
      eventBus.get('job:created') as never as import('rxjs').Observable<JobCreatedEvent>
    ).pipe(
      filter((e) => e.correlationId === 'cid-ref-empty'),
      take(1),
    );

    eventBus.get('job:create').next({
      correlationId: 'cid-ref-empty',
      jobType: 'reference-annotation',
      resourceId: 'rid-test',
      params: { entityTypes: [] },
      _userId: TEST_USER_DID,
    } as never);

    const result = await firstValueFrom(race(created$, timer(2_000)));
    expect(result).toBeDefined();
    expect(jobQueue.createJob).toHaveBeenCalledTimes(1);
  });
});

describe('registerJobCommandHandlers — queue lifecycle sync', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;
  let eventBus: EventBus;
  let jobQueue: MockJobQueue;

  beforeEach(async () => {
    ({ project, teardown } = await createTestProject('job-commands-lifecycle'));
    eventBus = new EventBus();
    jobQueue = makeJobQueue();
    registerJobCommandHandlers(eventBus, jobQueue as never, project, silentLogger);
  });

  afterEach(async () => {
    eventBus.destroy();
    await teardown();
  });

  it('moves the queue file on job:complete', async () => {
    eventBus.get('job:complete').next({
      resourceId: 'rid-1',
      jobId: 'job-c1',
      jobType: 'reference-annotation',
      result: { totalFound: 2, totalEmitted: 2, errors: 0 },
    } as never);

    await vi.waitFor(() => {
      expect(jobQueue.completeJob).toHaveBeenCalledWith('job-c1', { totalFound: 2, totalEmitted: 2, errors: 0 });
    });
  });

  it('passes an empty result to completeJob when job:complete carries none', async () => {
    eventBus.get('job:complete').next({
      resourceId: 'rid-1',
      jobId: 'job-c2',
      jobType: 'reference-annotation',
    } as never);

    await vi.waitFor(() => {
      expect(jobQueue.completeJob).toHaveBeenCalledWith('job-c2', {});
    });
  });

  it('routes job:fail through the queue retry-or-fail path', async () => {
    eventBus.get('job:fail').next({
      resourceId: 'rid-1',
      jobId: 'job-f1',
      jobType: 'generation',
      error: 'boom',
    } as never);

    await vi.waitFor(() => {
      expect(jobQueue.failJob).toHaveBeenCalledWith('job-f1', 'boom');
    });
  });

  it('mirrors job:report-progress into the queue', async () => {
    eventBus.get('job:report-progress').next({
      resourceId: 'rid-1',
      jobId: 'job-p1',
      jobType: 'generation',
      percentage: 40,
      progress: { stage: 'generating', percentage: 40, message: 'Generating...' },
    } as never);

    await vi.waitFor(() => {
      expect(jobQueue.recordProgress).toHaveBeenCalledWith(
        'job-p1',
        { stage: 'generating', percentage: 40, message: 'Generating...' },
      );
    });
  });

  it('falls back to the bare percentage when job:report-progress has no progress object', async () => {
    eventBus.get('job:report-progress').next({
      resourceId: 'rid-1',
      jobId: 'job-p2',
      jobType: 'generation',
      percentage: 55,
    } as never);

    await vi.waitFor(() => {
      expect(jobQueue.recordProgress).toHaveBeenCalledWith('job-p2', { percentage: 55 });
    });
  });

  it('cancels pending jobs of the requested category on job:cancel-requested', async () => {
    eventBus.get('job:cancel-requested').next({ jobType: 'annotation' } as never);

    await vi.waitFor(() => {
      expect(jobQueue.cancelPendingJobs).toHaveBeenCalledWith('annotation');
    });
  });
});

describe('registerJobCommandHandlers — lifecycle integration (real FsJobQueue)', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;
  let eventBus: EventBus;
  let queue: FsJobQueue;

  // The seam between the bus handlers and the queue was silently broken
  // for the life of the system (nothing ever moved jobs out of running/),
  // so this suite exercises the real path: bus event -> handler -> real
  // FsJobQueue -> file moves on disk.

  function runningJob(id: string) {
    return {
      status: 'running' as const,
      metadata: {
        id: jobId(id),
        type: 'reference-annotation',
        userId: userId(TEST_USER_DID),
        userName: 'Test User',
        userEmail: 'test@test.local',
        userDomain: 'test.local',
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      },
      params: { resourceId: resourceId('res-int'), entityTypes: [] },
      startedAt: new Date().toISOString(),
      progress: {},
    };
  }

  beforeEach(async () => {
    ({ project, teardown } = await createTestProject('job-commands-integration'));
    eventBus = new EventBus();
    queue = new FsJobQueue(project, silentLogger, eventBus);
    await queue.initialize();
    registerJobCommandHandlers(eventBus, queue, project, silentLogger);
  });

  afterEach(async () => {
    queue.destroy();
    eventBus.destroy();
    await teardown();
  });

  it('job:complete on the bus moves the running job file to complete/ with the result', async () => {
    await queue.createJob(runningJob('job-int-complete') as never);

    eventBus.get('job:complete').next({
      resourceId: 'res-int',
      jobId: 'job-int-complete',
      jobType: 'reference-annotation',
      result: { totalFound: 1, totalEmitted: 1, errors: 0 },
    } as never);

    await vi.waitFor(async () => {
      const job = await queue.getJob(jobId('job-int-complete'));
      expect(job?.status).toBe('complete');
    });

    const job = await queue.getJob(jobId('job-int-complete'));
    if (job?.status === 'complete') {
      expect(job.result).toEqual({ totalFound: 1, totalEmitted: 1, errors: 0 });
    }
  });

  it('job:fail on the bus re-queues the running job with a bumped retryCount and re-announces it', async () => {
    await queue.createJob(runningJob('job-int-fail') as never);

    const announced: { jobId: string }[] = [];
    eventBus.get('job:queued').subscribe((event) => {
      announced.push(event as { jobId: string });
    });

    eventBus.get('job:fail').next({
      resourceId: 'res-int',
      jobId: 'job-int-fail',
      jobType: 'reference-annotation',
      error: 'inference timeout',
    } as never);

    await vi.waitFor(async () => {
      const job = await queue.getJob(jobId('job-int-fail'));
      expect(job?.status).toBe('pending');
    });

    const job = await queue.getJob(jobId('job-int-fail'));
    expect(job?.metadata.retryCount).toBe(1);
    expect(announced.map((e) => e.jobId)).toContain(jobId('job-int-fail'));
  });
});
