# JobQueue API Guide

The `JobQueue` class manages the lifecycle of jobs in a filesystem-based queue. Jobs are persisted as JSON files organized by status in separate directories.

## Table of Contents

- [Overview](#overview)
- [Initialization](#initialization)
- [Creating Jobs](#creating-jobs)
- [Retrieving Jobs](#retrieving-jobs)
- [Updating Jobs](#updating-jobs)
- [Querying Jobs](#querying-jobs)
- [Polling for Jobs](#polling-for-jobs)
- [Cleanup](#cleanup)
- [Singleton Pattern](#singleton-pattern)

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

const queue = new JobQueue({ dataDir: './data' });
await queue.initialize();
```

**Parameters:**
- `config.dataDir` - Base directory for job storage (jobs will be in `{dataDir}/jobs/`)

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
await initializeJobQueue({ dataDir: './data' });

// Get queue instance anywhere
const queue = getJobQueue();
```

**Why singleton?**
- Ensures consistent queue instance across your application
- Simplifies worker and route handler access
- Prevents multiple queues pointing to same directory

## Creating Jobs

### `createJob(job: Job): Promise<void>`

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
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
  },
  params: {
    referenceId: annotationId('ref-456'),
    sourceResourceId: resourceId('doc-789'),
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

**Common patterns:**

```typescript
// Generate unique job ID
import { nanoid } from 'nanoid';
const job: PendingJob<GenerationParams> = {
  status: 'pending',
  metadata: {
    id: jobId(`job-${nanoid()}`),
    type: 'generation',
    userId: userId('user@example.com'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
  },
  params: {
    // job-specific params
  },
};
```

## Retrieving Jobs

### `getJob(jobId: JobId): Promise<Job | null>`

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

**Performance:**
- O(1) if you know the status (directly read file)
- O(n) where n = number of status directories (max 5) if status unknown

## Updating Jobs

### `updateJob(job: Job, oldStatus?: JobStatus): Promise<void>`

Updates a job, optionally moving it between status directories.

```typescript
const job = await queue.getJob(jobId('job-abc123'));

if (!job) return;

// Simple update (same status) - create new object
if (job.status === 'running') {
  const updatedJob: RunningJob<GenerationParams, GenerationProgress> = {
    ...job,
    progress: { stage: 'generating', percentage: 50, message: 'Generating...' },
  };
  await queue.updateJob(updatedJob);
}

// Status change (atomic move) - transition to complete
if (job.status === 'running') {
  const completeJob: CompleteJob<GenerationParams, GenerationResult> = {
    status: 'complete',
    metadata: job.metadata,
    params: job.params,
    startedAt: job.startedAt,
    completedAt: new Date().toISOString(),
    result: {
      resourceId: resourceId('doc-new'),
      resourceName: 'Generated Article',
    },
  };
  await queue.updateJob(completeJob, 'running');
}
```

**Parameters:**
- `job` - Updated job object
- `oldStatus` - (Optional) Previous status for atomic move

**Behavior:**
- If `oldStatus` provided and different from `job.status`:
  - Deletes job from old status directory
  - Writes job to new status directory
  - Atomic (delete then write)
- If `oldStatus` not provided or same as `job.status`:
  - Overwrites job file in current directory

**Common patterns:**

```typescript
// Worker processing job - transition from pending to running
if (job.status === 'pending') {
  const runningJob: RunningJob<GenerationParams, GenerationProgress> = {
    status: 'running',
    metadata: job.metadata,
    params: job.params,
    startedAt: new Date().toISOString(),
    progress: { stage: 'starting', percentage: 0, message: 'Starting...' },
  };
  await queue.updateJob(runningJob, 'pending');
}

// Job completion - transition from running to complete
if (job.status === 'running') {
  const completeJob: CompleteJob<GenerationParams, GenerationResult> = {
    status: 'complete',
    metadata: job.metadata,
    params: job.params,
    startedAt: job.startedAt,
    completedAt: new Date().toISOString(),
    result: { resourceId: resourceId('doc-new'), resourceName: 'Article' },
  };
  await queue.updateJob(completeJob, 'running');
}

// Job failure - transition from running to failed
if (job.status === 'running') {
  const failedJob: FailedJob<GenerationParams> = {
    status: 'failed',
    metadata: job.metadata,
    params: job.params,
    startedAt: job.startedAt,
    completedAt: new Date().toISOString(),
    error: error.message,
  };
  await queue.updateJob(failedJob, 'running');
}

// Progress update (no status change) - immutable pattern
if (job.status === 'running') {
  const updatedJob: RunningJob<GenerationParams, GenerationProgress> = {
    ...job,
    progress: { stage: 'creating', percentage: 75, message: 'Creating resource...' },
  };
  await queue.updateJob(updatedJob); // oldStatus not needed
}
```

## Querying Jobs

### `queryJobs(filters?: JobQueryFilters): Promise<Job[]>`

Query jobs with optional filters.

```typescript
import type { JobQueryFilters } from '@semiont/jobs';

// Get all pending jobs
const pending = await queue.queryJobs({ status: 'pending' });

// Get all failed jobs
const failed = await queue.queryJobs({ status: 'failed' });

// Get jobs for specific user
const userJobs = await queue.queryJobs({
  status: 'complete',
  userId: userId('user@example.com'),
});

// Get all jobs (no filter)
const allJobs = await queue.queryJobs();
```

**Filter Options:**

```typescript
interface JobQueryFilters {
  status?: JobStatus;        // Filter by status
  type?: JobType;            // Filter by job type
  userId?: UserId;           // Filter by user ID
  resourceId?: ResourceId;   // Filter by resource ID (for detection jobs)
}
```

**Behavior:**
- If `status` provided: searches only that status directory
- If `status` not provided: searches all status directories
- Additional filters applied in-memory after loading jobs
- Returns empty array if no matches

**Performance:**
- O(n) where n = number of job files matching status
- All matching files are read and parsed

## Polling for Jobs

### `pollNextPendingJob(): Promise<Job | null>`

Gets the next pending job (FIFO order) from the in-memory queue.

```typescript
const next = await queue.pollNextPendingJob();

if (next) {
  console.log(`Processing job: ${next.id}`);
  // Process job
} else {
  console.log('No pending jobs');
}
```

**Behavior:**
- Shifts the next job from the in-memory pending queue (no filesystem I/O)
- Queue is populated at `initialize()` and kept in sync by `createJob()`, `updateJob()`, and `fs.watch`
- Returns `null` if queue is empty

**Worker pattern:**

```typescript
while (running) {
  const job = await queue.pollNextPendingJob();

  if (job) {
    await processJob(job);
  } else {
    // No jobs, wait before polling again
    await sleep(1000);
  }
}
```

**Concurrency:**
- Multiple workers can safely poll concurrently
- Once a worker moves job to `running`, other workers won't see it
- No explicit locking needed (status directories provide isolation)

## Cleanup and Lifecycle

### `destroy(): void`

Cleans up the filesystem watcher and internal timers. Call when shutting down the queue.

```typescript
queue.destroy();
```

**Behavior:**
- Closes the `fs.watch` watcher on the `pending/` directory
- Clears any pending debounce timers

## Cleanup

### `cleanupCompletedJobs(olderThan: number): Promise<number>`

Removes completed and failed jobs older than a timestamp.

```typescript
// Remove jobs completed more than 1 day ago
const oneDayAgo = Date.now() - 86400000;
const removed = await queue.cleanupCompletedJobs(oneDayAgo);
console.log(`Removed ${removed} old jobs`);

// Remove jobs completed more than 1 week ago
const oneWeekAgo = Date.now() - 7 * 86400000;
await queue.cleanupCompletedJobs(oneWeekAgo);
```

**Parameters:**
- `olderThan` - Unix timestamp in milliseconds

**Behavior:**
- Cleans up jobs in `complete/` and `failed/` directories
- Compares job's `completedAt` timestamp to `olderThan`
- Deletes job files matching criteria
- Returns count of deleted jobs
- Does NOT clean up `pending`, `running`, or `cancelled` jobs

**Common patterns:**

```typescript
// Cleanup on startup
await queue.cleanupCompletedJobs(Date.now() - 86400000);

// Periodic cleanup
setInterval(async () => {
  const removed = await queue.cleanupCompletedJobs(Date.now() - 86400000);
  console.log(`[Cleanup] Removed ${removed} old jobs`);
}, 3600000); // Every hour
```

## Singleton Pattern

### `initializeJobQueue(config: JobQueueConfig): Promise<JobQueue>`

Initialize the singleton job queue instance.

```typescript
import { initializeJobQueue } from '@semiont/jobs';

await initializeJobQueue({ dataDir: './data' });
```

**Behavior:**
- Creates new `JobQueue` instance
- Calls `initialize()` to create directories
- Stores instance in module-level variable
- Returns the initialized queue

**Best practices:**
- Call once at application startup
- Before starting any workers
- Before processing any HTTP requests that create jobs

### `getJobQueue(): JobQueue`

Get the singleton job queue instance.

```typescript
import { getJobQueue } from '@semiont/jobs';

const queue = getJobQueue();
await queue.createJob(job);
```

**Behavior:**
- Returns the singleton instance
- Throws error if queue not initialized

**Usage:**
- Workers: `const queue = getJobQueue()`
- Route handlers: `const queue = getJobQueue()`
- Services: `const queue = getJobQueue()`

## Error Handling

### File System Errors

```typescript
try {
  await queue.createJob(job);
} catch (error) {
  if (error.code === 'ENOENT') {
    // Directory doesn't exist (call initialize?)
  }
  if (error.code === 'EACCES') {
    // Permission denied
  }
  throw error;
}
```

### Job Not Found

```typescript
const job = await queue.getJob(jobId);
if (!job) {
  console.error('Job not found');
  // Job might have been cleaned up or never existed
}
```

### Concurrent Access

The status-directory pattern provides natural concurrency safety:

```typescript
// Worker A polls and gets job-123
const jobA = await queueA.pollNextPendingJob(); // job-123

// Worker A moves job-123 to running
jobA.status = 'running';
await queueA.updateJob(jobA, 'pending'); // Deletes from pending/

// Worker B polls (job-123 no longer in pending/)
const jobB = await queueB.pollNextPendingJob(); // Different job or null
```

No explicit locking needed - atomic file operations and status directories prevent race conditions.

## Performance Considerations

**Directory size limits:**
- Performance degrades with >1000 jobs per status directory
- Use cleanup for completed/failed jobs
- Consider splitting load across multiple queues for high throughput

**Polling overhead:**
- `pollNextPendingJob()` reads from an in-memory array — no filesystem I/O per poll
- The in-memory queue is populated once at startup and kept in sync via `createJob()`, `updateJob()`, and a debounced `fs.watch` listener on the `pending/` directory
- Workers can poll at high frequency without filesystem overhead

**File I/O:**
- Each job operation reads/writes JSON file
- For high-frequency updates, consider batching
- For real-time progress, emit events rather than frequent updates

## Examples

### Creating Multiple Jobs

```typescript
const jobs = await Promise.all(
  entityTypes.map(type => {
    const job: PendingJob<DetectionParams> = {
      status: 'pending',
      metadata: {
        id: jobId(`job-${nanoid()}`),
        type: 'detection',
        userId,
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      },
      params: {
        resourceId,
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
const failed = await queue.queryJobs({ status: 'failed' });

for (const job of failed) {
  if (job.status === 'failed' && job.metadata.retryCount < job.metadata.maxRetries) {
    // Create new pending job from failed job
    const retryJob: PendingJob<any> = {
      status: 'pending',
      metadata: {
        ...job.metadata,
        retryCount: job.metadata.retryCount + 1,
      },
      params: job.params,
    };
    await queue.updateJob(retryJob, 'failed');
    console.log(`Retrying job ${job.metadata.id} (attempt ${job.metadata.retryCount + 1})`);
  }
}
```

### Monitor Queue Depth

```typescript
async function getQueueStats() {
  const [pending, running, complete, failed] = await Promise.all([
    queue.queryJobs({ status: 'pending' }),
    queue.queryJobs({ status: 'running' }),
    queue.queryJobs({ status: 'complete' }),
    queue.queryJobs({ status: 'failed' }),
  ]);

  return {
    pending: pending.length,
    running: running.length,
    complete: complete.length,
    failed: failed.length,
  };
}
```
