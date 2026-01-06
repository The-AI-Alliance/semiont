# @semiont/jobs

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml)
[![npm version](https://img.shields.io/npm/v/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
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
  type GenerationJob,
} from '@semiont/jobs';
import { jobId } from '@semiont/api-client';
import { userId, resourceId } from '@semiont/core';

// 1. Initialize job queue
await initializeJobQueue({ dataDir: './data' });

// 2. Create a job
const jobQueue = getJobQueue();
const job: GenerationJob = {
  id: jobId('job-abc123'),
  type: 'generation',
  status: 'pending',
  userId: userId('user@example.com'),
  referenceId: annotationId('ref-123'),
  sourceResourceId: resourceId('doc-456'),
  title: 'Generated Article',
  created: new Date().toISOString(),
  retryCount: 0,
  maxRetries: 3,
};

await jobQueue.createJob(job);

// 3. Create a worker to process jobs
class MyGenerationWorker extends JobWorker {
  protected getWorkerName(): string {
    return 'MyGenerationWorker';
  }

  protected canProcessJob(job: Job): boolean {
    return job.type === 'generation';
  }

  protected async executeJob(job: Job): Promise<void> {
    const genJob = job as GenerationJob;
    console.log(`Generating resource: ${genJob.title}`);
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

Jobs are JSON documents that represent async work:

```typescript
import type { GenerationJob } from '@semiont/jobs';

const job: GenerationJob = {
  id: jobId('job-123'),
  type: 'generation',
  status: 'pending',
  userId: userId('user@example.com'),

  // Job-specific fields
  referenceId: annotationId('ref-456'),
  sourceResourceId: resourceId('doc-789'),
  title: 'AI Generated Article',
  prompt: 'Write about quantum computing',
  language: 'en-US',

  // Timestamps
  created: '2024-01-01T00:00:00Z',
  startedAt: undefined,      // Set when worker picks up job
  completedAt: undefined,    // Set when job finishes

  // Retry handling
  retryCount: 0,
  maxRetries: 3,
  error: undefined,          // Set if job fails

  // Progress tracking (optional)
  progress: {
    stage: 'generating',
    percentage: 45,
    message: 'Generating content...',
  },

  // Result (optional)
  result: {
    resourceId: resourceId('doc-new'),
    resourceName: 'Generated Article',
  },
};
```

### Job Types

The package supports multiple job types for different tasks:

```typescript
import type {
  DetectionJob,           // Entity detection in resources
  GenerationJob,          // AI content generation
  HighlightDetectionJob,  // Identify key passages
  AssessmentDetectionJob, // Generate evaluative comments
  CommentDetectionJob,    // Generate explanatory comments
  TagDetectionJob,        // Structural role detection
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
import { JobWorker, type Job } from '@semiont/jobs';

class CustomWorker extends JobWorker {
  // Worker identification
  protected getWorkerName(): string {
    return 'CustomWorker';
  }

  // Filter which jobs this worker processes
  protected canProcessJob(job: Job): boolean {
    return job.type === 'custom-type';
  }

  // Implement job processing logic
  protected async executeJob(job: Job): Promise<void> {
    // 1. Access job data
    const customJob = job as CustomJob;

    // 2. Perform async work
    const result = await doWork(customJob);

    // 3. Update job with results
    customJob.result = result;
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

Each job file contains the complete job object:

```json
{
  "id": "job-abc123",
  "type": "generation",
  "status": "complete",
  "userId": "user@example.com",
  "referenceId": "ref-456",
  "sourceResourceId": "doc-789",
  "title": "Generated Article",
  "created": "2024-01-01T00:00:00Z",
  "startedAt": "2024-01-01T00:01:00Z",
  "completedAt": "2024-01-01T00:05:00Z",
  "retryCount": 0,
  "maxRetries": 3,
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
  protected async executeJob(job: Job): Promise<void> {
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
  if (job.retryCount < job.maxRetries) {
    job.status = 'pending';
    job.retryCount++;
    delete job.error;
    await queue.updateJob(job, 'failed');
  }
}
```

## Testing

```typescript
import { initializeJobQueue, getJobQueue } from '@semiont/jobs';
import { describe, it, beforeEach } from 'vitest';

describe('Job queue', () => {
  beforeEach(async () => {
    await initializeJobQueue({ dataDir: './test-data' });
  });

  it('should create and retrieve jobs', async () => {
    const queue = getJobQueue();

    const job: GenerationJob = {
      id: jobId('test-1'),
      type: 'generation',
      status: 'pending',
      // ... other fields
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
import { JobWorker, type Job, type GenerationJob } from '@semiont/jobs';
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

  protected canProcessJob(job: Job): boolean {
    return job.type === 'generation';
  }

  protected async executeJob(job: Job): Promise<void> {
    const genJob = job as GenerationJob;

    // Report progress
    genJob.progress = {
      stage: 'generating',
      percentage: 0,
      message: 'Starting generation...',
    };
    await getJobQueue().updateJob(genJob);

    // Generate content
    const content = await this.inference.generate({
      prompt: genJob.prompt,
      context: genJob.context,
      temperature: genJob.temperature,
      maxTokens: genJob.maxTokens,
    });

    // Update progress
    genJob.progress = {
      stage: 'creating',
      percentage: 75,
      message: 'Creating resource...',
    };
    await getJobQueue().updateJob(genJob);

    // Create resource (simplified)
    const resourceId = await createResource(content, genJob.title);

    // Set result
    genJob.result = {
      resourceId,
      resourceName: genJob.title,
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

    if (job.progress) {
      console.log(`Progress: ${job.progress.percentage}%`);
      console.log(`Stage: ${job.progress.stage}`);
      console.log(`Message: ${job.progress.message}`);
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
