# Workers Guide

Workers are long-running processes that poll the job queue and execute jobs. The `JobWorker` abstract base class provides the polling loop, error handling, and lifecycle management — you implement the business logic.

Workers are **not** actors. They use a polling loop, not RxJS subscriptions. But they emit the same EventBus commands as any other caller in the system. The **Stower** actor (in `@semiont/make-meaning`) handles all persistence to the Knowledge Base.

**See also**: [Type System Guide](./TYPES.md) for job state architecture and type narrowing patterns.

## Overview

The `JobWorker` base class handles:

- Polling the in-memory job queue at configurable intervals
- Moving jobs from `pending` → `running` → `complete/failed`
- Error recovery with configurable backoff
- Graceful shutdown (finishes current job, up to 60s timeout)
- Retry logic for failed jobs (`retryCount < maxRetries` → back to pending)

You implement:

- Worker identification (`getWorkerName()`)
- Job filtering (`canProcessJob()`)
- Business logic (`executeJob()`)

## JobWorker Base Constructor

```typescript
constructor(
  jobQueue: JobQueue,
  pollIntervalMs: number = 1000,
  errorBackoffMs: number = 5000,
  logger: Logger
)
```

All built-in workers pass `undefined` for poll/backoff intervals to use defaults:

```typescript
super(jobQueue, undefined, undefined, logger);
```

## Built-in Workers

Six workers ship with `@semiont/jobs`:

| Worker | Job Type | Constructor |
|--------|----------|-------------|
| `ReferenceAnnotationWorker` | `reference-annotation` | `(jobQueue, config, inferenceClient, eventBus, contentFetcher, logger)` |
| `GenerationWorker` | `generation` | `(jobQueue, config, inferenceClient, eventBus, logger)` |
| `HighlightAnnotationWorker` | `highlight-annotation` | `(jobQueue, config, inferenceClient, eventBus, contentFetcher, logger)` |
| `AssessmentAnnotationWorker` | `assessment-annotation` | `(jobQueue, config, inferenceClient, eventBus, contentFetcher, logger)` |
| `CommentAnnotationWorker` | `comment-annotation` | `(jobQueue, config, inferenceClient, eventBus, contentFetcher, logger)` |
| `TagAnnotationWorker` | `tag-annotation` | `(jobQueue, config, inferenceClient, eventBus, contentFetcher, logger)` |

All annotation workers (except `GenerationWorker`) take a `ContentFetcher` — a function `(resourceId: ResourceId) => Promise<Readable | null>` — to access resource content on demand.

Workers emit EventBus commands (`mark:create`, `job:start`, `job:report-progress`, `job:complete`) — the Stower actor in `@semiont/make-meaning` handles persistence.

## Creating a Custom Worker

```typescript
import { JobWorker, type AnyJob } from '@semiont/jobs';
import type { JobQueue } from '@semiont/jobs';
import type { Logger } from '@semiont/core';

class MyWorker extends JobWorker {
  constructor(jobQueue: JobQueue, logger: Logger) {
    super(jobQueue, 2000, 10000, logger);
    //              ^^^^  ^^^^^
    //              poll   error backoff
  }

  protected getWorkerName(): string {
    return 'MyWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'generation';
  }

  protected async executeJob(job: AnyJob): Promise<any> {
    // Your processing logic — return result object
    return { processed: true };
  }
}
```

## Worker with Dependencies

```typescript
import { JobWorker, type AnyJob, type RunningJob, type GenerationParams, type YieldProgress, type GenerationResult } from '@semiont/jobs';
import type { JobQueue } from '@semiont/jobs';
import type { InferenceClient } from '@semiont/inference';
import type { EventBus, Logger } from '@semiont/core';

class MyGenerationWorker extends JobWorker {
  constructor(
    jobQueue: JobQueue,
    private inferenceClient: InferenceClient,
    private eventBus: EventBus,
    logger: Logger,
  ) {
    super(jobQueue, undefined, undefined, logger);
  }

  protected getWorkerName(): string {
    return 'MyGenerationWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'generation';
  }

  protected async executeJob(job: AnyJob): Promise<GenerationResult> {
    if (job.status !== 'running') throw new Error('Job must be running');

    const genJob = job as RunningJob<GenerationParams, YieldProgress>;

    // Emit start event on EventBus
    this.eventBus.get('job:start').next({
      jobId: genJob.metadata.id,
      jobType: genJob.metadata.type,
    });

    // Do work...
    const content = await this.inferenceClient.generateText(/* ... */);

    // Return result — base class handles transition to complete
    return {
      resourceId: resourceId('doc-new'),
      resourceName: genJob.params.title ?? 'Untitled',
    };
  }
}
```

## Worker Lifecycle

### Starting

```typescript
const worker = new MyWorker(jobQueue, logger);

// Non-blocking start (runs in background)
worker.start();

// Or blocking (waits until stop() is called)
await worker.start();
```

`start()` enters a polling loop:
1. Polls queue via `pollNextPendingJob(predicate)` using `canProcessJob` as filter
2. If job found: transitions to running → calls `executeJob` → transitions to complete/failed
3. If no job: sleeps `pollIntervalMs`
4. On error: sleeps `errorBackoffMs`
5. Repeats until `stop()` is called

### Stopping

```typescript
await worker.stop();
```

Sets `running = false`, waits up to 60 seconds for the current job to finish. If the job takes longer, forces shutdown (job stays in `running` status for crash recovery).

## Processing Flow

```
Poll in-memory queue (no filesystem I/O)
  ↓
canProcessJob(job) — filter by job type
  ↓ (match found)
Move job: pending → running (via updateJob)
  ↓
executeJob(runningJob) — YOUR LOGIC
  ↓
emitCompletionEvent(job, result) — optional hook
  ↓ success
Move job: running → complete (with returned result)

  ↓ error (executeJob throws)
If retryCount < maxRetries:
  Move job: running → pending (increment retryCount)
If retryCount >= maxRetries:
  Move job: running → failed (permanent)
```

## Error Handling

The base class catches all errors from `executeJob` and handles retry/failure automatically:

```typescript
protected async executeJob(job: AnyJob): Promise<GenerationResult> {
  if (job.status !== 'running') throw new Error('Job must be running');
  const genJob = job as RunningJob<GenerationParams, YieldProgress>;

  try {
    const content = await this.inferenceClient.generateText(/* ... */);
    return { resourceId: resourceId('doc-new'), resourceName: genJob.params.title ?? '' };
  } catch (error) {
    // Add context, then re-throw for base class to handle
    this.logger.error('Generation failed', { jobId: genJob.metadata.id, error });
    throw error;
  }
}
```

## Progress Reporting

Update progress by creating an immutable updated job and calling `updateJobProgress`:

```typescript
protected async executeJob(job: AnyJob): Promise<GenerationResult> {
  if (job.status !== 'running') throw new Error('Job must be running');
  const genJob = job as RunningJob<GenerationParams, YieldProgress>;

  // Stage 1
  let current: RunningJob<GenerationParams, YieldProgress> = {
    ...genJob,
    progress: { stage: 'fetching', percentage: 25, message: 'Fetching source...' },
  };
  await this.updateJobProgress(current); // best-effort, won't throw

  // Stage 2
  current = { ...current, progress: { stage: 'generating', percentage: 50, message: 'Generating...' } };
  await this.updateJobProgress(current);

  // Return result
  return { resourceId: resourceId('doc-new'), resourceName: genJob.params.title ?? '' };
}
```

## Testing Workers

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import type { PendingJob, GenerationParams } from '@semiont/jobs';
import { jobId } from '@semiont/api-client';
import { userId, resourceId, annotationId } from '@semiont/core';

describe('MyWorker', () => {
  let queue: JobQueue;
  let worker: MyWorker;

  beforeEach(async () => {
    queue = new JobQueue({ dataDir: './test-data' }, mockLogger);
    await queue.initialize();
    worker = new MyWorker(queue, mockLogger);
  });

  it('should process generation jobs', async () => {
    const job: PendingJob<GenerationParams> = {
      status: 'pending',
      metadata: {
        id: jobId('test-1'),
        type: 'generation',
        userId: userId('user@test.com'),
        userName: 'Test User',
        userEmail: 'user@test.com',
        userDomain: 'test.com',
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      },
      params: {
        referenceId: annotationId('ref-1'),
        sourceResourceId: resourceId('doc-1'),
        sourceResourceName: 'Test Doc',
        annotation: { /* ... */ },
        title: 'Test Article',
        prompt: 'Test prompt',
        language: 'en-US',
      },
    };
    await queue.createJob(job);

    // Process manually (not via start())
    const retrieved = await queue.pollNextPendingJob();
    expect(retrieved).toBeTruthy();
    expect(worker['canProcessJob'](retrieved!)).toBe(true);
  });
});
```
