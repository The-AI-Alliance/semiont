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
import { EventBus, type Logger, type TagSchema } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
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
}

function makeJobQueue(): MockJobQueue {
  return {
    createJob: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(null),
    updateJob: vi.fn().mockResolvedValue(undefined),
  };
}

async function writeTagSchemasProjection(project: SemiontProject, schemas: TagSchema[]): Promise<void> {
  const dir = join(project.stateDir, 'projections', '__system__');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'tagschemas.json'), JSON.stringify({ tagSchemas: schemas }));
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
});
