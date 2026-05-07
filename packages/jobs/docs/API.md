# Jobs API Reference

## JobQueue

### Constructor

```typescript
import { JobQueue, type JobQueueConfig } from '@semiont/jobs';
import { EventBus, type Logger } from '@semiont/core';

const eventBus = new EventBus();
const queue = new JobQueue({ dataDir: './data' }, logger, eventBus);
await queue.initialize();
```

**Parameters:**
- `config: JobQueueConfig` — `{ dataDir: string }` base directory for job storage
- `logger: Logger` — structured logger
- `eventBus?: EventBus` — optional EventBus for emitting `job:queued` events

### `initialize(): Promise<void>`

Creates status directories and loads pending jobs into memory. Starts `fs.watch` on `pending/` for external change detection. Idempotent.

### `destroy(): void`

Closes the filesystem watcher and clears debounce timers.

### `createJob(job: AnyJob): Promise<void>`

Persists a job to `{dataDir}/jobs/{status}/{id}.json`. If status is `pending`, pushes to the in-memory queue. If EventBus is provided and job params include `resourceId`, emits `job:queued`.

```typescript
import type { PendingJob, GenerationParams } from '@semiont/jobs';
import { jobId } from '@semiont/api-client';
import { userId, resourceId, annotationId } from '@semiont/core';

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

Updates a job in place, or atomically moves it between status directories if `oldStatus` differs from `job.status`.

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
    startedAt: job:startedAt,
    completedAt: new Date().toISOString(),
    result: { resourceId: resourceId('doc-new'), resourceName: 'Article' },
  };
  await queue.updateJob(complete, 'running');
}
```

### `pollNextPendingJob(predicate?): Promise<AnyJob | null>`

Returns the next pending job from the in-memory queue (FIFO). No filesystem I/O. If a predicate is provided, returns the first matching job.

```typescript
// Any pending job
const next = await queue.pollNextPendingJob();

// Only generation jobs
const genJob = await queue.pollNextPendingJob(
  job => job.metadata.type === 'generation'
);
```

### `listJobs(filters?: JobQueryFilters): Promise<AnyJob[]>`

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

Removes completed, failed, and cancelled jobs older than the retention period. Returns count of deleted jobs.

```typescript
// Remove jobs older than 24 hours (default)
const removed = await queue.cleanupOldJobs();

// Remove jobs older than 1 week
const removed = await queue.cleanupOldJobs(168);
```

### `getStats(): Promise<{ pending, running, complete, failed, cancelled }>`

Returns job counts by status directory.

```typescript
const stats = await queue.getStats();
console.log(`${stats.pending} pending, ${stats.running} running`);
```

## Singleton

```typescript
import { initializeJobQueue, getJobQueue } from '@semiont/jobs';

// At startup
await initializeJobQueue({ dataDir: './data' }, logger, eventBus);

// Anywhere else
const queue = getJobQueue(); // Throws if not initialized
```

## JobWorker

Abstract base class for job processing. Handles polling, state transitions, retries, and error recovery.

### Constructor

```typescript
import { JobWorker } from '@semiont/jobs';

class MyWorker extends JobWorker {
  constructor(jobQueue: JobQueue, logger: Logger) {
    super(
      jobQueue,      // JobQueue instance
      1000,          // pollIntervalMs
      5000,          // errorBackoffMs
      logger         // Logger
    );
  }

  protected getWorkerName(): string { return 'MyWorker'; }
  protected canProcessJob(job: AnyJob): boolean { return job.metadata.type === 'generation'; }
  protected async executeJob(job: AnyJob): Promise<any> { /* processing logic */ }
}
```

### Abstract Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `getWorkerName()` | `(): string` | Worker name for logging |
| `canProcessJob(job)` | `(job: AnyJob): boolean` | Filter which jobs this worker handles |
| `executeJob(job)` | `(job: AnyJob): Promise<any>` | Job processing logic; return result object |

### Lifecycle Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `start()` | `(): Promise<void>` | Start polling loop (blocks until `stop()`) |
| `stop()` | `(): Promise<void>` | Graceful shutdown (waits up to 60s for current job) |

### Protected Helpers

| Method | Signature | Purpose |
|--------|-----------|---------|
| `updateJobProgress(job)` | `(job: AnyJob): Promise<void>` | Best-effort progress update (won't throw) |
| `emitCompletionEvent(job, result)` | `(job, result): Promise<void>` | Override to emit events on completion |
| `sleep(ms)` | `(ms: number): Promise<void>` | Async sleep utility |

### Processing Flow

```
Poll in-memory queue (via predicate from canProcessJob)
  ↓
Move job: pending → running
  ↓
Call executeJob(runningJob)
  ↓ success
Move job: running → complete (with returned result)
  ↓ error
If retryCount < maxRetries: running → pending (retry)
If retryCount >= maxRetries: running → failed (permanent)
```

## Storage

```
{dataDir}/jobs/
  pending/{jobId}.json
  running/{jobId}.json
  complete/{jobId}.json
  failed/{jobId}.json
  cancelled/{jobId}.json
```

Each job is a single JSON file. Status transitions are atomic (delete old file, write new file).
