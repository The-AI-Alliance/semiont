# Jobs API Reference

## FsJobQueue

`FsJobQueue` is the filesystem-backed implementation of the `JobQueue` interface. The interface contract (`initialize`, `destroy`, `createJob`, `getJob`, `updateJob`, `completeJob`, `failJob`, `recordProgress`, `cancelPendingJobs`, `cancelJob`, `getStats`) is the same across backends; `listJobs`, `cleanupOldJobs`, and `recoverStaleRunningJobs` are `FsJobQueue`-specific methods not on the interface.

### Constructor

```typescript
import { FsJobQueue } from '@semiont/jobs';
import { EventBus, type Logger } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';

const eventBus = new EventBus();
const project = new SemiontProject('/path/to/project');
const queue = new FsJobQueue(project, logger, eventBus);
await queue.initialize();
```

**Parameters:**
- `project: SemiontProject` — jobs are stored under `project.jobsDir`
- `logger: Logger` — structured logger
- `eventBus?: EventBus` — optional EventBus for emitting `job:queued` events

### `initialize(): Promise<void>`

Creates status directories, announces any existing pending backlog on `job:queued` (restart recovery), and starts the maintenance intervals: a 30-second tick that re-announces pending jobs and recovers stale running jobs, and an hourly retention sweep that prunes terminal jobs older than 24 hours. Idempotent.

### `destroy(): void`

Stops the maintenance intervals.

### `createJob(job: AnyJob): Promise<void>`

Persists a job to `{project.jobsDir}/{status}/{id}.json`. If status is `pending`, the EventBus is provided, and job params include `resourceId`, emits `job:queued`.

```typescript
import type { PendingJob, GenerationParams } from '@semiont/jobs';
import { jobId, userId, resourceId, annotationId } from '@semiont/core';

const job: PendingJob<GenerationParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-abc123'),
    type: 'generation',
    userId: userId('user@example.com'),
    userName: 'Jane Doe',
    userEmail: 'jane@example.com',
    userDomain: 'example.com',
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
  },
  params: {
    referenceId: annotationId('ref-456'),
    sourceResourceId: resourceId('doc-789'),
    sourceResourceName: 'Source Document',
    annotation: { /* W3C Annotation */ },
    title: 'Generated Article',
    prompt: 'Write about AI',
    language: 'en-US',
  },
};

await queue.createJob(job);
```

### `getJob(jobId: JobId): Promise<AnyJob | null>`

Searches all status directories (`pending`, `running`, `complete`, `failed`, `cancelled`) for a job by ID. Returns `null` if not found.

```typescript
const job = await queue.getJob(jobId('job-abc123'));
if (job?.status === 'complete') {
  console.log(job.result);
}
```

### `updateJob(job: AnyJob, oldStatus?: JobStatus): Promise<void>`

Updates a job in place, or atomically moves it between status directories if `oldStatus` differs from `job.status`. A job moved back to `pending` (e.g. a retry) is re-announced on `job:queued`.

### `completeJob(jobId: JobId, result): Promise<boolean>`

Moves a running job to `complete` with the result and `completedAt`. Returns `false` (and changes nothing) if the job is missing or not running — duplicate `job:complete` events are harmless.

```typescript
const moved = await queue.completeJob(jobId('job-abc123'), { totalFound: 3, totalEmitted: 3, errors: 0 });
```

### `failJob(jobId: JobId, error): Promise<'retried' | 'failed' | null>`

Retry-or-fail a running job. While `retryCount < maxRetries` the job moves back to `pending` with the count bumped (and is re-announced for another worker to claim); after that it moves to `failed` with the error. Returns `null` if the job isn't running.

```typescript
const outcome = await queue.failJob(jobId('job-abc123'), 'inference timeout');
// 'retried' | 'failed' | null
```

### `recordProgress(jobId: JobId, progress): Promise<void>`

Writes progress into a running job's file, throttled to one write per 5 seconds per job. Beyond surfacing live progress to `job:status-requested`, each write refreshes the file's mtime — the heartbeat that stale-running recovery watches. A no-op for jobs that aren't running.

### `cancelPendingJobs(category: 'annotation' | 'generation'): Promise<number>`

Cancels all pending jobs in a category — the granularity of the `job:cancel-requested` UI signal (`'annotation'` covers every `*-annotation` type). Running jobs are left to finish. Returns the number cancelled.

```typescript
// Progress update (same status)
if (job.status === 'running') {
  const updated: RunningJob<GenerationParams, YieldProgress> = {
    ...job,
    progress: { stage: 'generating', percentage: 50, message: 'Generating...' },
  };
  await queue.updateJob(updated);
}

// Status transition (atomic move)
if (job.status === 'running') {
  const complete: CompleteJob<GenerationParams, GenerationResult> = {
    status: 'complete',
    metadata: job.metadata,
    params: job.params,
    startedAt: job.startedAt,
    completedAt: new Date().toISOString(),
    result: { resourceId: resourceId('doc-new'), resourceName: 'Article' },
  };
  await queue.updateJob(complete, 'running');
}
```

### `listJobs(filters?: JobQueryFilters): Promise<AnyJob[]>`

> `FsJobQueue`-specific — not part of the `JobQueue` interface.

Lists jobs with optional filters. Reads from filesystem, sorted by creation time (newest first), with pagination.

```typescript
const pending = await queue.listJobs({ status: 'pending' });
const userJobs = await queue.listJobs({ userId: userId('user@example.com'), limit: 10 });
const allJobs = await queue.listJobs();
```

**Filter options:**

```typescript
interface JobQueryFilters {
  status?: JobStatus;
  type?: JobType;
  userId?: UserId;
  limit?: number;   // Default: 100
  offset?: number;   // Default: 0
}
```

### `cancelJob(jobId: JobId): Promise<boolean>`

Cancels a pending or running job by moving it to `cancelled` status. Returns `false` if the job doesn't exist or is already in a terminal state.

```typescript
const cancelled = await queue.cancelJob(jobId('job-abc123'));
```

### `cleanupOldJobs(retentionHours?: number): Promise<number>`

> `FsJobQueue`-specific — not part of the `JobQueue` interface.

Removes completed, failed, and cancelled jobs older than the retention period. Returns count of deleted jobs. Runs automatically every hour with the default 24-hour retention; call it directly only for ad-hoc pruning.

```typescript
// Remove jobs older than 1 week
const removed = await queue.cleanupOldJobs(168);
```

### `recoverStaleRunningJobs(): Promise<number>`

> `FsJobQueue`-specific — not part of the `JobQueue` interface.

Recovers running jobs orphaned by a dead worker: any `running/` file whose mtime is older than 30 minutes is fed through the same retry-or-fail path as `failJob`. Progress writes refresh the mtime, so a worker that reports within the window is never recovered out from under itself. Runs automatically on the 30-second maintenance tick.

### `getStats(): Promise<{ pending, running, complete, failed, cancelled }>`

Returns job counts by status directory.

```typescript
const stats = await queue.getStats();
console.log(`${stats.pending} pending, ${stats.running} running`);
```

## Worker Process

Workers run as a separate process. `worker-main.ts` authenticates as a software agent, opens a `SemiontSession` (from `@semiont/sdk`), builds a `generator` (W3C SoftwareAgent), and calls `startWorkerProcess(...)`.

### `startWorkerProcess(config): JobClaimAdapter`

`startWorkerProcess` lives in `src/worker-process.ts` and is internal to the package — the `worker-main.ts` entry point calls it once per agent group. It is not exported from the package root.

```typescript
const adapter = startWorkerProcess({
  session,          // SemiontSession authenticated as this worker's agent
  jobTypes,         // string[] — job types this agent serves
  inferenceClient,  // InferenceClient
  generator,        // W3C SoftwareAgent stamped as annotation `generator`
  logger,
});
```

`startWorkerProcess` claims jobs over the bus via a `JobClaimAdapter` — a reactive, SSE-driven `job:queued` subscription, not a poll-interval loop. When a job is claimed, it dispatches by `jobType` to the matching `process*Job` function in `src/processors.ts`:

| Job Type | Processor |
|----------|-----------|
| `reference-annotation` | `processReferenceJob` |
| `generation` | `processGenerationJob` |
| `highlight-annotation` | `processHighlightJob` |
| `assessment-annotation` | `processAssessmentJob` |
| `comment-annotation` | `processCommentJob` |
| `tag-annotation` | `processTagJob` |

### Processors

Each processor is transport-agnostic. Detection processors take `(content, inferenceClient, params, userId, generator, onProgress)` and return `{ annotations, result }`; `processGenerationJob` takes `(inferenceClient, params, onProgress, logger)` and returns the synthesized resource. Detection logic lives in the `AnnotationDetection` class (`src/workers/annotation-detection.ts`); generation synthesis in `generateResourceFromTopic()` (`src/workers/generation/resource-generation.ts`).

### Processing Flow

```
SSE job:queued → JobClaimAdapter claims job atomically
  ↓
emit job:start
  ↓
session.client.browse.resourceContent(resourceId)   (detection job types)
  ↓
process*Job(...) → annotations + result
  ↓
emit mark:create per annotation; emit job:complete
  ↓ on error
emit job:fail; adapter.failJob(jobId, message)
```

A pending job whose announcement found no idle eligible worker (all busy, worker offline or mid-reconnect, backend restart) is re-announced every 30 seconds, so backlog drains as soon as a worker frees up. Duplicate announcements are harmless — claims on a job that already moved to `running` fail with "Job already claimed".

On the backend, the lifecycle events are mirrored into the queue files (see `@semiont/make-meaning`'s job command handlers): `job:complete` moves the file to `complete/`, `job:fail` retries or moves it to `failed/`, and `job:report-progress` is written into the running file as both live progress and a worker heartbeat.

Lifecycle and `mark:create` events are emitted via `session.client.transport.emit(...)`. The Stower actor in @semiont/make-meaning persists them.

## Storage

```
{project.jobsDir}/
  pending/{jobId}.json
  running/{jobId}.json
  complete/{jobId}.json
  failed/{jobId}.json
  cancelled/{jobId}.json
```

Each job is a single JSON file. Status transitions are atomic (delete old file, write new file).
