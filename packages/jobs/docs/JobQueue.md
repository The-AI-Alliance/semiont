# JobQueue API Guide

The `JobQueue` class manages the lifecycle of jobs in a filesystem-based queue. Jobs are persisted as JSON files organized by status in separate directories.

## Overview

The JobQueue uses a status-directory pattern where jobs are stored in directories named after their status:

```
data/jobs/
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
import { JobQueue } from '@semiont/jobs';
import { EventBus, type Logger } from '@semiont/core';

const eventBus = new EventBus();
const queue = new JobQueue({ dataDir: './data' }, logger, eventBus);
await queue.initialize();
```

**Parameters:**
- `config: JobQueueConfig` — `{ dataDir: string }` base directory for job storage (jobs will be in `{dataDir}/jobs/`)
- `logger: Logger` — structured logger instance
- `eventBus?: EventBus` — optional EventBus for emitting `job:queued` events on job creation

**What `initialize()` does:**
- Creates status directories (`pending/`, `running/`, etc.)
- Loads existing pending jobs into an in-memory queue
- Starts `fs.watch` on the `pending/` directory to pick up external changes (debounced)
- Idempotent (safe to call multiple times)

### Singleton Helper

For most applications, use the singleton pattern:

```typescript
import { initializeJobQueue, getJobQueue } from '@semiont/jobs';

// Call once at application startup
await initializeJobQueue({ dataDir: './data' }, logger, eventBus);

// Get queue instance anywhere
const queue = getJobQueue();
```

## Creating Jobs

### `createJob(job: AnyJob): Promise<void>`

Creates a new job and persists it to the queue.

```typescript
import { getJobQueue } from '@semiont/jobs';
import type { PendingJob, GenerationParams } from '@semiont/jobs';
import { jobId } from '@semiont/api-client';
import { userId, resourceId, annotationId } from '@semiont/core';

const queue = getJobQueue();

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
- Writes job to `{dataDir}/jobs/{status}/{jobId}.json`
- Creates parent directories if needed
- Overwrites if job with same ID already exists at that status
- If status is `pending`, pushes to the in-memory queue for immediate worker pickup
- If EventBus provided and job params contain `resourceId`, emits `job:queued` event

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
- If `oldStatus` provided and different from `job.status`: deletes from old directory, writes to new directory, updates in-memory queue
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

## Polling for Jobs

### `pollNextPendingJob(predicate?): Promise<AnyJob | null>`

Gets the next pending job from the in-memory queue (FIFO). No filesystem I/O.

```typescript
// Get any pending job
const next = await queue.pollNextPendingJob();

// Get first pending job matching a predicate
const genJob = await queue.pollNextPendingJob(
  job => job.metadata.type === 'generation'
);
```

**Behavior:**
- Without predicate: shifts the first job from the in-memory queue
- With predicate: finds and removes the first matching job
- Queue is populated at `initialize()` and kept in sync by `createJob()`, `updateJob()`, and `fs.watch`
- Returns `null` if queue is empty (or no match)

**Concurrency:**
- Multiple workers can safely poll concurrently
- Once a worker moves job to `running`, other workers won't see it
- No explicit locking needed (status directories provide isolation)

## Cancelling Jobs

### `cancelJob(jobId: JobId): Promise<boolean>`

Cancels a pending or running job. Returns `false` if job doesn't exist or is already in a terminal state.

```typescript
const cancelled = await queue.cancelJob(jobId('job-abc123'));
```

## Cleanup and Lifecycle

### `destroy(): void`

Cleans up the filesystem watcher and internal timers. Call when shutting down.

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

### Retry Failed Jobs

```typescript
const failed = await queue.listJobs({ status: 'failed' });

for (const job of failed) {
  if (job.status === 'failed' && job.metadata.retryCount < job.metadata.maxRetries) {
    const retryJob: PendingJob<any> = {
      status: 'pending',
      metadata: {
        ...job.metadata,
        retryCount: job.metadata.retryCount + 1,
      },
      params: job.params,
    };
    await queue.updateJob(retryJob, 'failed');
  }
}
```

### Monitor Queue Depth

```typescript
const stats = await queue.getStats();
console.log(`Pending: ${stats.pending}, Running: ${stats.running}, Failed: ${stats.failed}`);
```

## Performance Considerations

**Polling overhead:**
- `pollNextPendingJob()` reads from an in-memory array — no filesystem I/O per poll
- The in-memory queue is populated once at startup and kept in sync via `createJob()`, `updateJob()`, and a debounced `fs.watch` listener
- Workers can poll at high frequency without filesystem overhead

**Directory size limits:**
- Performance degrades with >1000 jobs per status directory
- Use `cleanupOldJobs()` for completed/failed/cancelled jobs

**File I/O:**
- Each `createJob`/`updateJob`/`getJob` reads/writes a JSON file
- `listJobs` reads all files in matching status directories
