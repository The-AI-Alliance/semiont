# Jobs API Reference

## Overview

The `@semiont/jobs` package provides a filesystem-based job queue for long-running operations with atomic state transitions, progress tracking, and automatic retry.

## JobQueue

### Initialization

```typescript
import { JobQueue } from '@semiont/jobs';

const queue = new JobQueue({
  dataDir: '/path/to/data/jobs',
  maxRetries: 3,
  retentionPeriod: 24 * 60 * 60 * 1000 // 24 hours
});

await queue.initialize();
```

### Creating Jobs

```typescript
const job = await queue.createJob({
  type: 'detection',
  userId: 'user-123',
  resourceId: 'doc-456',
  entityTypes: ['Person', 'Organization'],
  maxRetries: 3
});

console.log(job.id); // job-abc123xyz
console.log(job.status); // 'pending'
```

### Job Status Management

```typescript
// Get job by ID
const job = await queue.getJob('job-abc123xyz');

// Update job status (atomic operation)
await queue.updateJobStatus('job-abc123xyz', 'running');

// Update progress
await queue.updateJobProgress('job-abc123xyz', {
  percentage: 50,
  message: 'Processing entity types...',
  currentStep: 2,
  totalSteps: 4
});

// Complete job with result
await queue.completeJob('job-abc123xyz', {
  totalProcessed: 100,
  errors: 0
});

// Fail job with error
await queue.failJob('job-abc123xyz', new Error('Processing failed'));
```

### Querying Jobs

```typescript
// List jobs with filters
const pendingJobs = await queue.listJobs({
  status: 'pending',
  type: 'detection',
  userId: 'user-123',
  limit: 10,
  offset: 0
});

// Get queue statistics
const stats = await queue.getStats();
// {
//   pending: 5,
//   running: 2,
//   complete: 100,
//   failed: 3,
//   cancelled: 1
// }

// Poll for next pending job (FIFO)
const nextJob = await queue.pollNextPendingJob('detection');
```

### Maintenance

```typescript
// Clean up old completed/failed jobs
await queue.cleanupOldJobs();

// Cancel a running job
await queue.cancelJob('job-abc123xyz');
```

## JobWorker Base Class

### Creating a Worker

```typescript
import { JobWorker } from '@semiont/jobs';

class MyWorker extends JobWorker {
  getWorkerName(): string {
    return 'my-worker';
  }

  canProcessJob(job: Job): boolean {
    return job.type === 'my-job-type';
  }

  async executeJob(job: Job): Promise<void> {
    // Process the job
    for (let i = 0; i < 100; i++) {
      await this.doWork(i);

      // Update progress
      await this.updateJobProgress({
        percentage: i,
        message: `Processing item ${i}...`
      });
    }
  }
}
```

### Running Workers

```typescript
const worker = new MyWorker({
  queue,
  pollInterval: 1000, // Check for jobs every second
  errorBackoff: 5000  // Back off on errors
});

// Start processing jobs
await worker.start();

// Graceful shutdown
await worker.stop();
```

## Job Types

### DetectionJob

Job for detecting entities in documents.

```typescript
interface DetectionJob {
  id: string;
  type: 'detection';
  status: JobStatus;
  userId: string;
  resourceId: string;
  entityTypes: string[];
  progress?: {
    totalEntityTypes: number;
    processedEntityTypes: number;
    currentEntityType?: string;
    entitiesFound: number;
    entitiesEmitted: number;
  };
  result?: {
    totalFound: number;
    totalEmitted: number;
    errors: number;
  };
  created: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
}
```

### GenerationJob

Job for generating documents from annotations.

```typescript
interface GenerationJob {
  id: string;
  type: 'generation';
  status: JobStatus;
  userId: string;
  referenceId: string;
  sourceResourceId: string;
  prompt?: string;
  title?: string;
  entityTypes?: string[];
  language?: string;
  progress?: {
    stage: 'fetching' | 'generating' | 'creating' | 'linking';
    percentage: number;
    message?: string;
  };
  result?: {
    resourceId: string;
    resourceName: string;
  };
  created: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
}
```

## Storage Structure

Jobs are stored in different directories based on status:

```
dataDir/
├── pending/       # Jobs waiting to be processed
├── running/       # Jobs currently being processed
├── complete/      # Successfully completed jobs
├── failed/        # Jobs that failed after retries
└── cancelled/     # Jobs cancelled by user or system
```

Each job is stored as a JSON file named by its ID.

## Worker Patterns

### Retry Logic

```typescript
class RetryableWorker extends JobWorker {
  async executeJob(job: Job): Promise<void> {
    try {
      await this.doWork(job);
    } catch (error) {
      if (this.isRetryable(error)) {
        throw error; // Will be retried
      } else {
        // Non-retryable error
        await this.failJob(job.id, error);
      }
    }
  }

  isRetryable(error: Error): boolean {
    return error.code === 'NETWORK_ERROR' ||
           error.code === 'TIMEOUT';
  }
}
```

### Progress Tracking

```typescript
class ProgressiveWorker extends JobWorker {
  async executeJob(job: Job): Promise<void> {
    const items = await this.getItems(job);
    const total = items.length;

    for (let i = 0; i < total; i++) {
      await this.processItem(items[i]);

      await this.updateJobProgress({
        percentage: Math.round((i + 1) / total * 100),
        message: `Processing item ${i + 1} of ${total}`,
        currentItem: i + 1,
        totalItems: total
      });
    }
  }
}
```

### Batch Processing

```typescript
class BatchWorker extends JobWorker {
  async executeJob(job: Job): Promise<void> {
    const batchSize = 10;
    const items = await this.getItems(job);

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await Promise.all(batch.map(item => this.processItem(item)));

      await this.updateJobProgress({
        percentage: Math.round((i + batchSize) / items.length * 100)
      });
    }
  }
}
```

## Best Practices

1. **Atomic Operations**: Use atomic file moves for state transitions
2. **Progress Updates**: Update progress regularly for long-running jobs
3. **Error Handling**: Distinguish between retryable and non-retryable errors
4. **Graceful Shutdown**: Always wait for current job to complete
5. **Resource Cleanup**: Clean up old jobs regularly
6. **Idempotency**: Make job execution idempotent when possible