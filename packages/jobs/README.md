# @semiont/jobs

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+jobs%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=jobs)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=jobs)
[![npm version](https://img.shields.io/npm/v/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
[![License](https://img.shields.io/npm/l/@semiont/jobs.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Filesystem-based job queue and worker infrastructure for [Semiont](https://github.com/The-AI-Alliance/semiont) - provides async job processing, background workers, and long-running task management.

## What is a Job Queue?

A job queue is a pattern for processing work asynchronously outside of the HTTP request/response cycle. Jobs are persisted to storage, processed by workers, and can be monitored for progress and completion.

**Benefits:**
- **Decoupled processing** - HTTP responses return immediately while work continues
- **Reliability** - Jobs are persisted to disk and survive process restarts
- **Progress tracking** - Long-running tasks can report status updates
- **Retry logic** - Failed jobs can be retried with exponential backoff
- **Scalability** - Multiple workers can process jobs concurrently

## Installation

```bash
npm install @semiont/jobs
```

**Prerequisites:**
- Node.js >= 20.18.1
- `@semiont/core` and `@semiont/api-client` (peer dependencies)

## Quick Start

```typescript
import {
  JobQueue,
  initializeJobQueue,
  getJobQueue,
  JobWorker,
  type PendingJob,
  type RunningJob,
  type GenerationParams,
  type AnyJob,
} from '@semiont/jobs';
import { jobId } from '@semiont/api-client';
import { userId, resourceId, annotationId } from '@semiont/core';

// 1. Initialize job queue
await initializeJobQueue({ dataDir: './data' });

// 2. Create a job
const jobQueue = getJobQueue();
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
    referenceId: annotationId('ref-123'),
    sourceResourceId: resourceId('doc-456'),
    title: 'Generated Article',
    prompt: 'Write about AI',
    language: 'en-US',
  },
};

await jobQueue.createJob(job);

// 3. Create a worker to process jobs
class MyGenerationWorker extends JobWorker {
  protected getWorkerName(): string {
    return 'MyGenerationWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'generation';
  }

  protected async executeJob(job: AnyJob): Promise<void> {
    // Type guard ensures job is running
    if (job.status !== 'running') {
      throw new Error('Job must be running');
    }

    const genJob = job as RunningJob<GenerationParams>;
    console.log(`Generating resource: ${genJob.params.title}`);
    // Your processing logic here
  }
}

// 4. Start worker
const worker = new MyGenerationWorker();
await worker.start();
```

## Architecture

The jobs package follows a simple status-directory pattern:

```
data/
  jobs/
    pending/        ← Jobs waiting to be processed
      job-123.json
      job-456.json
    running/        ← Jobs currently being processed
      job-789.json
    complete/       ← Successfully completed jobs
      job-111.json
    failed/         ← Failed jobs (with error info)
      job-222.json
    cancelled/      ← Cancelled jobs
      job-333.json
```

**Key Components:**

- **JobQueue** - Manages job lifecycle and persistence
- **JobWorker** - Abstract base class for workers that process jobs
- **Job Types** - Strongly-typed job definitions for different task types

## Core Concepts

### Jobs

Jobs use discriminated unions based on their status, ensuring type safety and preventing invalid state access:

```typescript
import type { PendingJob, RunningJob, CompleteJob, GenerationParams, GenerationProgress, GenerationResult } from '@semiont/jobs';

// Pending job - waiting to be processed
const pendingJob: PendingJob<GenerationParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-123'),
    type: 'generation',
    userId: userId('user@example.com'),
    created: '2024-01-01T00:00:00Z',
    retryCount: 0,
    maxRetries: 3,
  },
  params: {
    referenceId: annotationId('ref-456'),
    sourceResourceId: resourceId('doc-789'),
    title: 'AI Generated Article',
    prompt: 'Write about quantum computing',
    language: 'en-US',
  },
};

// Running job - currently being processed
const runningJob: RunningJob<GenerationParams, GenerationProgress> = {
  status: 'running',
  metadata: { /* same as above */ },
  params: { /* same as above */ },
  startedAt: '2024-01-01T00:01:00Z',
  progress: {
    stage: 'generating',
    percentage: 45,
    message: 'Generating content...',
  },
};

// Complete job - successfully finished
const completeJob: CompleteJob<GenerationParams, GenerationResult> = {
  status: 'complete',
  metadata: { /* same as above */ },
  params: { /* same as above */ },
  startedAt: '2024-01-01T00:01:00Z',
  completedAt: '2024-01-01T00:05:00Z',
  result: {
    resourceId: resourceId('doc-new'),
    resourceName: 'Generated Article',
  },
};

// TypeScript prevents accessing progress on pending jobs!
// pendingJob.progress  // ❌ Compile error
// runningJob.progress  // ✅ Available
// completeJob.result   // ✅ Available
```

### Job Types

The package supports multiple job types for different tasks, each with their own parameter types:

```typescript
import type {
  DetectionParams,           // Entity detection in resources
  GenerationParams,          // AI content generation
  HighlightDetectionParams,  // Identify key passages
  AssessmentDetectionParams, // Generate evaluative comments
  CommentDetectionParams,    // Generate explanatory comments
  TagDetectionParams,        // Structural role detection
} from '@semiont/jobs';
```

### Job Status

Jobs progress through status states stored as directories:

```typescript
type JobStatus =
  | 'pending'    // Waiting to be processed
  | 'running'    // Currently being processed
  | 'complete'   // Successfully finished
  | 'failed'     // Failed with error
  | 'cancelled'  // Cancelled by user
```

### Workers

Workers poll the queue and process jobs:

```typescript
import { JobWorker, type AnyJob, type RunningJob, type CustomParams } from '@semiont/jobs';

class CustomWorker extends JobWorker {
  // Worker identification
  protected getWorkerName(): string {
    return 'CustomWorker';
  }

  // Filter which jobs this worker processes
  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'custom-type';
  }

  // Implement job processing logic
  protected async executeJob(job: AnyJob): Promise<void> {
    // 1. Type guard - job must be running
    if (job.status !== 'running') {
      throw new Error('Job must be running');
    }

    // 2. Access typed job data
    const customJob = job as RunningJob<CustomParams>;
    const params = customJob.params;

    // 3. Perform async work
    const result = await doWork(params);

    // 4. Create updated job with result (immutable pattern)
    const updatedJob: RunningJob<CustomParams> = {
      ...customJob,
      progress: { stage: 'complete', percentage: 100 },
    };
    await this.updateJobProgress(updatedJob);
  }
}
```

## Documentation

📚 **[Job Queue Guide](./docs/JobQueue.md)** - JobQueue API and job management

👷 **[Workers Guide](./docs/Workers.md)** - Building custom workers

📝 **[Job Types Guide](./docs/JobTypes.md)** - All job type definitions and usage

⚙️ **[Configuration Guide](./docs/Configuration.md)** - Setup and options

## Key Features

- **Type-safe** - Full TypeScript support with discriminated union types
- **Filesystem-based** - No external database required (JSON files for jobs)
- **Status directories** - Jobs organized by status for easy polling
- **Atomic operations** - Safe concurrent access to job files
- **Progress tracking** - Jobs can report progress updates during processing
- **Retry logic** - Built-in retry handling with configurable max attempts
- **Framework-agnostic** - Pure TypeScript, no web framework dependencies

## Use Cases

✅ **AI generation** - Long-running LLM inference tasks

✅ **Background processing** - Resource analysis, entity detection

✅ **Worker microservices** - Separate processes for compute-intensive work

✅ **CLI tools** - Command-line tools that queue batch operations

✅ **Testing** - Isolated job queues for unit/integration tests

❌ **Not for frontend** - Backend infrastructure only (workers need filesystem access)

## API Overview

### JobQueue

```typescript
const queue = getJobQueue();

// Create job
await queue.createJob(job);

// Get job by ID
const job = await queue.getJob(jobId);

// Poll for next pending job
const next = await queue.pollNextPendingJob();

// Update job status
job.status = 'complete';
await queue.updateJob(job, 'running');

// Query jobs by status
const pending = await queue.queryJobs({ status: 'pending' });
const failed = await queue.queryJobs({ status: 'failed' });

// Cleanup old jobs
await queue.cleanupCompletedJobs(Date.now() - 86400000); // 1 day ago
```

### JobWorker

```typescript
// Create worker
class MyWorker extends JobWorker {
  constructor() {
    super(
      1000,  // Poll interval (ms)
      5000   // Error backoff (ms)
    );
  }

  protected getWorkerName(): string {
    return 'MyWorker';
  }

  protected canProcessJob(job: Job): boolean {
    return job.type === 'my-type';
  }

  protected async executeJob(job: Job): Promise<void> {
    // Process job
  }
}

// Start worker
const worker = new MyWorker();
await worker.start();

// Stop worker (graceful shutdown)
await worker.stop();
```

### Singleton Pattern

```typescript
import { initializeJobQueue, getJobQueue } from '@semiont/jobs';

// Initialize once at startup
await initializeJobQueue({ dataDir: './data' });

// Get queue instance anywhere
const queue = getJobQueue();
```

## Storage Format

Jobs are stored as individual JSON files:

```
data/
  jobs/
    pending/
      job-abc123.json
    running/
      job-def456.json
    complete/
      job-ghi789.json
```

Each job file contains the complete job object using the discriminated union structure:

```json
{
  "status": "complete",
  "metadata": {
    "id": "job-abc123",
    "type": "generation",
    "userId": "user@example.com",
    "created": "2024-01-01T00:00:00Z",
    "retryCount": 0,
    "maxRetries": 3
  },
  "params": {
    "referenceId": "ref-456",
    "sourceResourceId": "doc-789",
    "title": "Generated Article",
    "prompt": "Write about AI",
    "language": "en-US"
  },
  "startedAt": "2024-01-01T00:01:00Z",
  "completedAt": "2024-01-01T00:05:00Z",
  "result": {
    "resourceId": "doc-new",
    "resourceName": "Generated Article"
  }
}
```

## Performance

- **Polling-based** - Workers poll pending directory at configurable intervals
- **Filesystem limits** - Performance degrades with >1000 pending jobs per directory
- **Atomic moves** - Jobs move between status directories atomically (delete + write)
- **No locks needed** - Status-based organization prevents race conditions

**Scaling considerations:**
- Multiple workers can run concurrently (same or different machines)
- Workers use `pollNextPendingJob()` for FIFO processing
- Completed jobs should be cleaned up periodically
- For high throughput (>1000 jobs/min), consider Redis/database-backed queue

## Error Handling

### Worker Error Recovery

```typescript
class ResilientWorker extends JobWorker {
  protected async executeJob(job: AnyJob): Promise<void> {
    if (job.status !== 'running') {
      throw new Error('Job must be running');
    }

    try {
      await doWork(job);
    } catch (error) {
      // JobWorker base class handles:
      // 1. Moving job to 'failed' status
      // 2. Recording error message
      // 3. Retry logic (if retryCount < maxRetries)
      throw error; // Let base class handle it
    }
  }
}
```

### Manual Retry

```typescript
const queue = getJobQueue();
const failedJobs = await queue.queryJobs({ status: 'failed' });

for (const job of failedJobs) {
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
  }
}
```

## Testing

```typescript
import { initializeJobQueue, getJobQueue } from '@semiont/jobs';
import type { PendingJob, GenerationParams } from '@semiont/jobs';
import { describe, it, beforeEach } from 'vitest';

describe('Job queue', () => {
  beforeEach(async () => {
    await initializeJobQueue({ dataDir: './test-data' });
  });

  it('should create and retrieve jobs', async () => {
    const queue = getJobQueue();

    const job: PendingJob<GenerationParams> = {
      status: 'pending',
      metadata: {
        id: jobId('test-1'),
        type: 'generation',
        userId: userId('user@test.com'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      },
      params: {
        referenceId: annotationId('ref-1'),
        sourceResourceId: resourceId('doc-1'),
        title: 'Test',
        prompt: 'Test prompt',
        language: 'en-US',
      },
    };

    await queue.createJob(job);
    const retrieved = await queue.getJob(jobId('test-1'));

    expect(retrieved).toEqual(job);
  });
});
```

## Examples

### Building a Background Worker

```typescript
import { JobWorker, type AnyJob, type RunningJob, type GenerationParams, type GenerationProgress } from '@semiont/jobs';
import { InferenceService } from './inference';

class GenerationWorker extends JobWorker {
  private inference: InferenceService;

  constructor(inference: InferenceService) {
    super(1000, 5000);
    this.inference = inference;
  }

  protected getWorkerName(): string {
    return 'GenerationWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'generation';
  }

  protected async executeJob(job: AnyJob): Promise<void> {
    // Type guard
    if (job.status !== 'running') {
      throw new Error('Job must be running');
    }

    const genJob = job as RunningJob<GenerationParams, GenerationProgress>;

    // Report progress (create new object - immutable pattern)
    const updatedJob1: RunningJob<GenerationParams, GenerationProgress> = {
      ...genJob,
      progress: {
        stage: 'generating',
        percentage: 0,
        message: 'Starting generation...',
      },
    };
    await getJobQueue().updateJob(updatedJob1);

    // Generate content
    const content = await this.inference.generate({
      prompt: genJob.params.prompt,
      context: genJob.params.context,
      temperature: genJob.params.temperature,
      maxTokens: genJob.params.maxTokens,
    });

    // Update progress
    const updatedJob2: RunningJob<GenerationParams, GenerationProgress> = {
      ...updatedJob1,
      progress: {
        stage: 'creating',
        percentage: 75,
        message: 'Creating resource...',
      },
    };
    await getJobQueue().updateJob(updatedJob2);

    // Create resource (simplified)
    const resourceId = await createResource(content, genJob.params.title);

    // Set result (will be handled by base class transition to complete)
    return {
      resourceId,
      resourceName: genJob.params.title,
    };
  }
}
```

### Progress Monitoring

```typescript
import { getJobQueue } from '@semiont/jobs';

async function monitorJob(jobId: JobId): Promise<void> {
  const queue = getJobQueue();

  while (true) {
    const job = await queue.getJob(jobId);

    if (!job) {
      console.log('Job not found');
      break;
    }

    console.log(`Status: ${job.status}`);

    // Type-safe progress access - only available on running jobs
    if (job.status === 'running') {
      console.log(`Progress: ${job.progress.percentage}%`);
      console.log(`Stage: ${job.progress.stage}`);
      console.log(`Message: ${job.progress.message || 'Processing...'}`);
    }

    // Type-safe result access - only available on complete jobs
    if (job.status === 'complete') {
      console.log(`Result: ${JSON.stringify(job.result)}`);
    }

    // Type-safe error access - only available on failed jobs
    if (job.status === 'failed') {
      console.log(`Error: ${job.error}`);
    }

    if (job.status === 'complete' || job.status === 'failed') {
      break;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
```

## License

Apache-2.0

## Related Packages

- [`@semiont/api-client`](../api-client/) - API types and utilities
- [`@semiont/core`](../core/) - Domain types and utilities
- [`@semiont/event-sourcing`](../event-sourcing/) - Event persistence
- [`semiont-backend`](../../apps/backend/) - Backend API server

## Learn More

- [Background Jobs Pattern](https://www.enterpriseintegrationpatterns.com/patterns/messaging/MessageQueueing.html) - Queue-based processing
- [Job Types Guide](./docs/JobTypes.md) - Detailed job type documentation
- [Workers Guide](./docs/Workers.md) - Building custom workers
