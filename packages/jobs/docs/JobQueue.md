# JobQueue API Guide

The `FsJobQueue` class manages the lifecycle of jobs in a filesystem-based queue. Jobs are persisted as JSON files organized by status in separate directories. (`JobQueue` is the interface it implements.)

## Overview

The FsJobQueue uses a status-directory pattern where jobs are stored in directories named after their status:

```
{project.jobsDir}/
  ├── pending/      # Jobs waiting to be processed
  ├── running/      # Jobs currently being processed
  ├── complete/     # Successfully completed jobs
  ├── failed/       # Failed jobs (with error details)
  └── cancelled/    # Cancelled jobs
```

Jobs transition between statuses by moving between directories (atomic delete + write).

## Initialization

### Constructor

```typescript
import { FsJobQueue } from '@semiont/jobs';
import { EventBus, type Logger } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';

const eventBus = new EventBus();
const queue = new FsJobQueue(project, logger, eventBus);
await queue.initialize();
```

**Parameters:**
- `project: SemiontProject` — the project whose `project.jobsDir` is used as the base directory for job storage (status subdirectories live under it)
- `logger: Logger` — structured logger instance
- `eventBus?: EventBus` — optional EventBus for emitting `job:queued` events on job creation

**What `initialize()` does:**
- Creates status directories (`pending/`, `running/`, etc.)
- Announces any existing pending jobs on `job:queued` (restart catch-up)
- Starts a 30-second maintenance tick: re-announces all pending jobs and recovers stale running jobs (no heartbeat for 30 minutes → retry-or-fail)
- Starts an hourly retention sweep: terminal jobs older than 24 hours are deleted
- Idempotent (safe to call multiple times)

## Creating Jobs

### `createJob(job: AnyJob): Promise<void>`

Creates a new job and persists it to the queue.

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

**Behavior:**
- Writes job to `{project.jobsDir}/{status}/{jobId}.json`
- Creates parent directories if needed
- Overwrites if job with same ID already exists at that status
- If status is `pending`, the EventBus is provided, and job params contain `resourceId`, emits a `job:queued` announcement for immediate worker pickup

## Retrieving Jobs

### `getJob(jobId: JobId): Promise<AnyJob | null>`

Retrieves a job by ID, searching all status directories.

```typescript
const job = await queue.getJob(jobId('job-abc123'));

if (job) {
  console.log(`Job status: ${job.status}`);
  console.log(`Job type: ${job.metadata.type}`);
  console.log(`User: ${job.metadata.userId}`);

  // Type-safe access based on status
  if (job.status === 'running') {
    console.log(`Progress: ${job.progress.percentage}%`);
  }
  if (job.status === 'complete') {
    console.log(`Result: ${JSON.stringify(job.result)}`);
  }
} else {
  console.log('Job not found');
}
```

**Behavior:**
- Searches status directories in order: `pending`, `running`, `complete`, `failed`, `cancelled`
- Returns first match (jobs should only exist in one status)
- Returns `null` if job not found in any directory

## Updating Jobs

### `updateJob(job: AnyJob, oldStatus?: JobStatus): Promise<void>`

Updates a job, optionally moving it between status directories.

```typescript
const job = await queue.getJob(jobId('job-abc123'));
if (!job) return;

// Simple update (same status) — immutable pattern
if (job.status === 'running') {
  const updatedJob: RunningJob<GenerationParams, YieldProgress> = {
    ...job,
    progress: { stage: 'generating', percentage: 50, message: 'Generating...' },
  };
  await queue.updateJob(updatedJob);
}

// Status transition (atomic move)
if (job.status === 'running') {
  const completeJob: CompleteJob<GenerationParams, GenerationResult> = {
    status: 'complete',
    metadata: job.metadata,
    params: job.params,
    startedAt: job.startedAt,
    completedAt: new Date().toISOString(),
    result: { resourceId: resourceId('doc-new'), resourceName: 'Generated Article' },
  };
  await queue.updateJob(completeJob, 'running');
}
```

**Parameters:**
- `job` — Updated job object
- `oldStatus` — (Optional) Previous status for atomic move

**Behavior:**
- If `oldStatus` provided and different from `job.status`: deletes from old directory, writes to new directory; a job moved back to `pending` (e.g. a retry) is re-announced on `job:queued`
- If `oldStatus` not provided or same as `job.status`: overwrites job file in current directory

## Listing Jobs

### `listJobs(filters?: JobQueryFilters): Promise<AnyJob[]>`

Lists jobs with optional filters. Reads from filesystem.

```typescript
import type { JobQueryFilters } from '@semiont/jobs';

// Get all pending jobs
const pending = await queue.listJobs({ status: 'pending' });

// Get all failed jobs
const failed = await queue.listJobs({ status: 'failed' });

// Get jobs for specific user
const userJobs = await queue.listJobs({
  userId: userId('user@example.com'),
  limit: 10,
});

// Get all jobs (no filter)
const allJobs = await queue.listJobs();
```

**Filter Options:**

```typescript
interface JobQueryFilters {
  status?: JobStatus;
  type?: JobType;
  userId?: UserId;
  limit?: number;    // Default: 100
  offset?: number;   // Default: 0
}
```

**Behavior:**
- If `status` provided: searches only that status directory
- If `status` not provided: searches all status directories
- Results sorted by creation time (newest first)
- Pagination via `limit` and `offset`

## Job Announcement and Catch-up

Workers never poll the queue. The queue *announces* pending jobs on the EventBus `job:queued` channel, and workers claim them over the bus (`job:claim`), which the backend's claim handler serves via `getJob` + `updateJob`.

A pending job is announced:

- **On creation** — `createJob()` emits `job:queued` immediately
- **On retry** — `updateJob()` re-announces a job moved back to `pending`
- **On startup** — `initialize()` announces every job already in `pending/` (restart recovery)
- **Every 30 seconds** — an interval re-announces all pending jobs, so a job whose announcement found no idle eligible worker (all busy, worker offline or mid-reconnect) is claimed as soon as a worker frees up

**Concurrency:**
- Duplicate announcements are harmless: a claim for a job that has already moved to `running` fails with "Job already claimed", so two workers cannot win the same job

## Job Lifecycle Sync

The queue exposes transition methods that the backend's bus handlers (in `@semiont/make-meaning`) call when workers emit lifecycle events:

### `completeJob(jobId, result): Promise<boolean>`

`job:complete` → moves `running/` → `complete/` with the result and `completedAt`. Returns `false` if the job isn't running (duplicate events are harmless).

### `failJob(jobId, error): Promise<'retried' | 'failed' | null>`

`job:fail` → retry-or-fail. While `metadata.retryCount < metadata.maxRetries`, the job moves back to `pending/` with the count bumped and is re-announced for another worker. After that it moves to `failed/` with the error.

### `recordProgress(jobId, progress): Promise<void>`

`job:report-progress` → written into the `running/` file (throttled to one write per 5s per job). The write doubles as a worker heartbeat: the file's mtime is what stale-running recovery checks.

### `recoverStaleRunningJobs(): Promise<number>`

Runs on the 30-second maintenance tick. A `running/` file untouched for 30 minutes means the worker died mid-job; it goes through the same retry-or-fail path as `failJob` with the error `worker presumed dead`.

## Cancelling Jobs

### `cancelJob(jobId: JobId): Promise<boolean>`

Cancels a pending or running job. Returns `false` if job doesn't exist or is already in a terminal state.

```typescript
const cancelled = await queue.cancelJob(jobId('job-abc123'));
```

### `cancelPendingJobs(category: 'annotation' | 'generation'): Promise<number>`

Cancels all *pending* jobs in a category — `'annotation'` covers every `*-annotation` type. This is what the `job:cancel-requested` UI signal maps to. Running jobs are left to finish (interrupting a worker mid-inference would need a worker-side kill channel that doesn't exist).

## Cleanup and Lifecycle

### `destroy(): void`

Stops the maintenance intervals. Call when shutting down.

```typescript
queue.destroy();
```

### `cleanupOldJobs(retentionHours?: number): Promise<number>`

Removes completed, failed, and cancelled jobs older than the retention period. Default: 24 hours.

```typescript
// Default 24-hour retention
const removed = await queue.cleanupOldJobs();

// Custom 1-week retention
const removed = await queue.cleanupOldJobs(168);
```

### `getStats(): Promise<{ pending, running, complete, failed, cancelled }>`

Returns job counts by status.

```typescript
const stats = await queue.getStats();
console.log(`${stats.pending} pending, ${stats.running} running`);
```

## Common Patterns

### Creating Multiple Jobs

```typescript
await Promise.all(
  entityTypes.map(type => {
    const job: PendingJob<DetectionParams> = {
      status: 'pending',
      metadata: {
        id: jobId(`job-${nanoid()}`),
        type: 'reference-annotation',
        userId: userId('user@example.com'),
        userName: 'Jane Doe',
        userEmail: 'jane@example.com',
        userDomain: 'example.com',
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      },
      params: {
        resourceId: resourceId('doc-456'),
        entityTypes: [type],
        includeDescriptiveReferences: true,
      },
    };
    return queue.createJob(job);
  })
);
```

### Retries

Retries are automatic: `failJob` re-queues a failed job (with `retryCount` bumped and a fresh `job:queued` announcement) until `maxRetries` is exhausted, and only then lands it in `failed/`. A job in `failed/` has used all its retries — re-queue one manually only if you've fixed the underlying cause:

```typescript
const retryJob: PendingJob<any> = {
  status: 'pending',
  metadata: { ...job.metadata, retryCount: 0 },
  params: job.params,
};
await queue.updateJob(retryJob, 'failed'); // re-announced automatically
```

### Monitor Queue Depth

```typescript
const stats = await queue.getStats();
console.log(`Pending: ${stats.pending}, Running: ${stats.running}, Failed: ${stats.failed}`);
```

## Performance Considerations

**Announcement overhead:**
- The 30-second re-announce tick reads every file in `pending/` — cheap while the pending backlog stays small, which it should: jobs are claimed as soon as an eligible worker is idle

**Directory size limits:**
- Performance degrades with >1000 jobs per status directory
- Use `cleanupOldJobs()` for completed/failed/cancelled jobs

**File I/O:**
- Each `createJob`/`updateJob`/`getJob` reads/writes a JSON file
- `listJobs` reads all files in matching status directories
