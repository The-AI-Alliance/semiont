# Workers Guide

Workers are long-running processes that poll the job queue and execute jobs. The `JobWorker` abstract base class provides the polling loop, error handling, and lifecycle management - you implement the business logic.

**See also**: [Type System Guide](./TYPES.md) for job state architecture and type narrowing patterns.

## Table of Contents

- [Overview](#overview)
- [Creating a Worker](#creating-a-worker)
- [Worker Lifecycle](#worker-lifecycle)
- [Job Processing](#job-processing)
- [Error Handling](#error-handling)
- [Progress Reporting](#progress-reporting)
- [Retry Logic](#retry-logic)
- [Testing Workers](#testing-workers)
- [Production Deployment](#production-deployment)

## Overview

The `JobWorker` base class handles:

- ✅ Polling the in-memory job queue at configurable intervals
- ✅ Moving jobs from `pending` → `running` → `complete/failed`
- ✅ Error recovery with exponential backoff
- ✅ Graceful shutdown (finishes current job)
- ✅ Retry logic for failed jobs

You implement:

- ✅ Worker identification (`getWorkerName()`)
- ✅ Job filtering (`canProcessJob()`)
- ✅ Business logic (`executeJob()`)

## Creating a Worker

### Basic Worker

```typescript
import { JobWorker, type AnyJob, type RunningJob, type GenerationParams, type GenerationProgress } from '@semiont/jobs';

class GenerationWorker extends JobWorker {
  // 1. Identify your worker
  protected getWorkerName(): string {
    return 'GenerationWorker';
  }

  // 2. Filter which jobs to process
  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'generation';
  }

  // 3. Implement processing logic
  protected async executeJob(job: AnyJob): Promise<void> {
    // Type guard - job must be running
    if (job.status !== 'running') {
      throw new Error('Job must be running');
    }

    const genJob = job as RunningJob<GenerationParams, GenerationProgress>;
    console.log(`Generating: ${genJob.params.title}`);

    // Your business logic here
    // - Call AI APIs
    // - Create resources
    // - Return result (base class handles completion)
  }
}

// Start worker
const worker = new GenerationWorker();
await worker.start();
```

### Worker with Dependencies

```typescript
import { JobWorker, type AnyJob, type RunningJob, type GenerationParams, type GenerationProgress, type GenerationResult } from '@semiont/jobs';
import type { Config } from '../config';
import { InferenceService } from '../services/inference';

class GenerationWorker extends JobWorker {
  private config: Config;
  private inference: InferenceService;

  constructor(config: Config) {
    super(
      1000,  // pollIntervalMs - how often to check for jobs
      5000   // errorBackoffMs - wait time after errors
    );
    this.config = config;
    this.inference = new InferenceService(config);
  }

  protected getWorkerName(): string {
    return 'GenerationWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'generation';
  }

  protected async executeJob(job: AnyJob): Promise<GenerationResult> {
    // Type guard
    if (job.status !== 'running') {
      throw new Error('Job must be running');
    }

    const genJob = job as RunningJob<GenerationParams, GenerationProgress>;

    // Use injected dependencies - access params not flat fields
    const content = await this.inference.generate({
      prompt: genJob.params.prompt,
      temperature: genJob.params.temperature,
    });

    // Return result - base class handles transition to complete
    return {
      resourceId: await this.createResource(content),
      resourceName: genJob.params.title,
    };
  }

  private async createResource(content: string): Promise<ResourceId> {
    // Implementation
  }
}
```

## Worker Lifecycle

### Starting Workers

```typescript
const worker = new GenerationWorker(config);

// Start worker (non-blocking, runs in background)
await worker.start();

// Worker is now polling queue in infinite loop
console.log('Worker started');
```

**What `start()` does:**
1. Sets `running = true`
2. Enters polling loop
3. Polls queue → processes job → repeats
4. Continues until `stop()` is called

**Blocking behavior:**
- `start()` returns a Promise that only resolves when worker stops
- Call without `await` to start in background: `worker.start()`
- Or run in separate process/container

### Stopping Workers

```typescript
// Graceful shutdown
await worker.stop();

// Worker:
// 1. Sets running = false
// 2. Waits for current job to finish (up to 60 seconds)
// 3. Exits polling loop
```

**Timeout handling:**
- Default timeout: 60 seconds
- If job takes longer, forced shutdown (job stays in `running` status)
- Next worker start will find job in `running` and could retry

### Signal Handling

```typescript
// Production pattern: handle SIGTERM/SIGINT
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, stopping workers...');
  await Promise.all([
    generationWorker.stop(),
    detectionWorker.stop(),
    // ... other workers
  ]);
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, stopping workers...');
  await Promise.all([
    generationWorker.stop(),
    detectionWorker.stop(),
  ]);
  process.exit(0);
});
```

## Job Processing

### Processing Flow

The `JobWorker` base class handles the following flow automatically:

```
1. Poll in-memory queue (no filesystem I/O)
   ↓
2. Get next pending job
   ↓
3. Check canProcessJob() ← YOU IMPLEMENT
   ↓ (if true)
4. Move job to 'running'
   ↓
5. Set job.startedAt
   ↓
6. Call executeJob() ← YOU IMPLEMENT
   ↓
7a. Success: Move to 'complete', set completedAt
7b. Error: Move to 'failed', set error message
   ↓
8. Return to step 1
```

### Type-Safe Job Access

```typescript
protected async executeJob(job: AnyJob): Promise<void> {
  // Status guard first
  if (job.status !== 'running') {
    throw new Error('Job must be running');
  }

  // Type narrowing by job type
  if (job.metadata.type === 'generation') {
    const genJob = job as RunningJob<GenerationParams, GenerationProgress>;
    // TypeScript knows genJob.params has generation-specific fields
    console.log(genJob.params.title);
    console.log(genJob.params.prompt);
    // TypeScript knows genJob.progress is available
    console.log(genJob.progress.stage);
  }

  // Or use type guard
  if (this.isGenerationJob(job)) {
    console.log(job.params.title); // TypeScript knows type
  }
}

private isGenerationJob(job: AnyJob): job is RunningJob<GenerationParams, GenerationProgress> {
  return job.status === 'running' && job.metadata.type === 'generation';
}
```

### Updating Job State

```typescript
import { getJobQueue } from '@semiont/jobs';

protected async executeJob(job: AnyJob): Promise<GenerationResult> {
  // Type guard
  if (job.status !== 'running') {
    throw new Error('Job must be running');
  }

  const genJob = job as RunningJob<GenerationParams, GenerationProgress>;
  const queue = getJobQueue();

  // Update progress (immutable pattern - create new object)
  const updatedJob1: RunningJob<GenerationParams, GenerationProgress> = {
    ...genJob,
    progress: {
      stage: 'fetching',
      percentage: 25,
      message: 'Fetching source content...',
    },
  };
  await queue.updateJob(updatedJob1);

  // Do work
  const source = await fetchSource(genJob.params.sourceResourceId);

  // Update progress again
  const updatedJob2: RunningJob<GenerationParams, GenerationProgress> = {
    ...updatedJob1,
    progress: {
      stage: 'generating',
      percentage: 50,
      message: 'Generating content...',
    },
  };
  await queue.updateJob(updatedJob2);

  // Generate
  const content = await this.inference.generate(source, genJob.params.prompt);

  // Return final result - base class handles transition to complete
  return {
    resourceId: await this.createResource(content),
    resourceName: genJob.params.title,
  };
}
```

## Error Handling

### Automatic Error Handling

The `JobWorker` base class catches errors and automatically:

1. Moves job to `failed` status
2. Sets `job.error` to error message
3. Sets `job.completedAt` timestamp
4. Implements retry logic (if `retryCount < maxRetries`)

```typescript
protected async executeJob(job: AnyJob): Promise<void> {
  // Type guard
  if (job.status !== 'running') {
    throw new Error('Job must be running');
  }

  // If this throws an error, base class handles it
  await riskyOperation();

  // Job will automatically move to 'failed' status
  // A FailedJob will be created with error message
}
```

### Custom Error Handling

```typescript
protected async executeJob(job: AnyJob): Promise<GenerationResult> {
  // Type guard
  if (job.status !== 'running') {
    throw new Error('Job must be running');
  }

  const genJob = job as RunningJob<GenerationParams, GenerationProgress>;

  try {
    const content = await this.inference.generate(genJob.params.prompt);
    return {
      resourceId: await this.createResource(content),
      resourceName: genJob.params.title,
    };
  } catch (error) {
    // Add context to error
    if (error.code === 'RATE_LIMIT') {
      throw new Error(`Rate limited by AI service: ${error.message}`);
    }

    // Log detailed error
    console.error('[GenerationWorker] Generation failed:', {
      jobId: genJob.metadata.id,
      error: error.message,
      stack: error.stack,
    });

    // Re-throw to let base class handle status update
    throw error;
  }
}
```

### Retry Logic

```typescript
// Jobs have built-in retry configuration in metadata
const job: PendingJob<GenerationParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-123'),
    type: 'generation',
    userId: userId('user@example.com'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3, // Will retry up to 3 times
  },
  params: {
    // generation params
  },
};

// Base class automatically handles retries:
// 1. If metadata.retryCount < metadata.maxRetries: move back to 'pending'
// 2. If metadata.retryCount >= metadata.maxRetries: move to 'failed' (final)
```

**Customizing retries:**

```typescript
protected async executeJob(job: AnyJob): Promise<void> {
  // Type guard
  if (job.status !== 'running') {
    throw new Error('Job must be running');
  }

  try {
    await doWork(job);
  } catch (error) {
    // Check retry eligibility
    if (job.metadata.retryCount < job.metadata.maxRetries) {
      console.log(`Will retry (attempt ${job.metadata.retryCount + 1}/${job.metadata.maxRetries})`);
    } else {
      console.log('Max retries reached, job failed permanently');
    }

    // Let base class handle retry logic
    throw error;
  }
}
```

### Error Backoff

```typescript
class MyWorker extends JobWorker {
  constructor() {
    super(
      1000,  // Normal poll interval
      5000   // Error backoff (wait 5s after error before polling again)
    );
  }
}

// Prevents tight error loops if queue has bad jobs
// Worker sleeps 5s after error before next poll
```

## Progress Reporting

### Progress Structure

```typescript
// Update job progress during execution (immutable pattern)
if (job.status === 'running') {
  const updatedJob: RunningJob<GenerationParams, GenerationProgress> = {
    ...job,
    progress: {
      stage: 'generating',  // Current stage
      percentage: 50,        // 0-100
      message: 'Optional description',
    },
  };
  await getJobQueue().updateJob(updatedJob);
}
```

### Multi-Stage Progress

```typescript
protected async executeJob(job: AnyJob): Promise<GenerationResult> {
  // Type guard
  if (job.status !== 'running') {
    throw new Error('Job must be running');
  }

  const genJob = job as RunningJob<GenerationParams, GenerationProgress>;
  const queue = getJobQueue();

  // Stage 1: Fetching
  let currentJob = { ...genJob, progress: { stage: 'fetching', percentage: 0, message: 'Fetching source...' } };
  await queue.updateJob(currentJob);
  const source = await fetchSource(genJob.params.sourceResourceId);

  // Stage 2: Generating
  currentJob = { ...currentJob, progress: { stage: 'generating', percentage: 33, message: 'Generating content...' } };
  await queue.updateJob(currentJob);
  const content = await this.inference.generate(source);

  // Stage 3: Creating
  currentJob = { ...currentJob, progress: { stage: 'creating', percentage: 66, message: 'Creating resource...' } };
  await queue.updateJob(currentJob);
  const resourceId = await this.createResource(content);

  // Stage 4: Linking
  currentJob = { ...currentJob, progress: { stage: 'linking', percentage: 90, message: 'Linking to source...' } };
  await queue.updateJob(currentJob);
  await this.linkToSource(resourceId, genJob.params.sourceResourceId);

  // Return final result
  return { resourceId, resourceName: genJob.params.title };
}
```

### Progress Throttling

```typescript
protected async executeJob(job: AnyJob): Promise<void> {
  // Type guard
  if (job.status !== 'running') {
    throw new Error('Job must be running');
  }

  const detectionJob = job as RunningJob<DetectionParams, DetectionProgress>;
  const queue = getJobQueue();

  let lastProgressUpdate = 0;
  const MIN_UPDATE_INTERVAL = 1000; // 1 second
  let currentJob = detectionJob;

  for (let i = 0; i < entities.length; i++) {
    await processEntity(entities[i]);

    // Throttle progress updates (immutable pattern)
    const now = Date.now();
    if (now - lastProgressUpdate > MIN_UPDATE_INTERVAL) {
      currentJob = {
        ...currentJob,
        progress: {
          processedEntities: i + 1,
          totalEntities: entities.length,
          percentage: Math.round(((i + 1) / entities.length) * 100),
        },
      };
      await queue.updateJob(currentJob);
      lastProgressUpdate = now;
    }
  }
}
```

## Retry Logic

### Automatic Retries

```typescript
// Base class implements:
if (job.metadata.retryCount < job.metadata.maxRetries) {
  // Create new pending job for retry
  const retryJob: PendingJob<any> = {
    status: 'pending',
    metadata: {
      ...job.metadata,
      retryCount: job.metadata.retryCount + 1,
    },
    params: job.params,
  };
  await queue.updateJob(retryJob, 'running');
} else {
  // Create failed job - no more retries
  const failedJob: FailedJob<any> = {
    status: 'failed',
    metadata: job.metadata,
    params: job.params,
    startedAt: job.startedAt,
    completedAt: new Date().toISOString(),
    error: error.message,
  };
  await queue.updateJob(failedJob, 'running');
}
```

### Exponential Backoff

```typescript
class RetryWorker extends JobWorker {
  protected async executeJob(job: Job): Promise<void> {
    try {
      await doWork(job);
    } catch (error) {
      if (this.shouldRetryWithBackoff(job, error)) {
        // Calculate delay: 2^retryCount * 1000ms
        const delayMs = Math.pow(2, job.retryCount) * 1000;

        console.log(`Retry in ${delayMs}ms (attempt ${job.retryCount + 1})`);

        // Wait before re-queuing
        await this.sleep(delayMs);
      }

      throw error; // Let base class handle retry logic
    }
  }

  private shouldRetryWithBackoff(job: Job, error: any): boolean {
    // Only backoff for transient errors
    return (
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.message.includes('Rate limit')
    );
  }
}
```

## Testing Workers

### Unit Testing

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { initializeJobQueue, getJobQueue } from '@semiont/jobs';
import { GenerationWorker } from './generation-worker';

describe('GenerationWorker', () => {
  beforeEach(async () => {
    await initializeJobQueue({ dataDir: './test-data' });
  });

  it('should process generation jobs', async () => {
    const worker = new GenerationWorker(testConfig);
    const queue = getJobQueue();

    // Create test job
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
        title: 'Test Article',
        prompt: 'Test prompt',
        language: 'en-US',
      },
    };
    await queue.createJob(job);

    // Process job manually (not via start())
    const retrieved = await queue.pollNextPendingJob();
    expect(retrieved).toBeTruthy();

    if (retrieved && worker['canProcessJob'](retrieved)) {
      // Transition to running before executing
      const runningJob: RunningJob<GenerationParams, GenerationProgress> = {
        status: 'running',
        metadata: retrieved.metadata,
        params: retrieved.params,
        startedAt: new Date().toISOString(),
        progress: { stage: 'starting', percentage: 0, message: 'Starting...' },
      };
      await queue.updateJob(runningJob, 'pending');

      await worker['executeJob'](runningJob);

      // Verify results
      const completed = await queue.getJob(jobId('test-1'));
      expect(completed?.status).toBe('complete');
      if (completed?.status === 'complete') {
        expect(completed.result).toBeDefined();
      }
    }
  });
});
```

### Integration Testing

```typescript
describe('Worker integration', () => {
  it('should process job end-to-end', async () => {
    const worker = new GenerationWorker(testConfig);
    const queue = getJobQueue();

    // Create job
    const job = { /* ... */ };
    await queue.createJob(job);

    // Start worker in background
    const workerPromise = worker.start();

    // Wait for completion (with timeout)
    await waitForJobCompletion(job.id, 10000);

    // Stop worker
    await worker.stop();

    // Verify
    const completed = await queue.getJob(job.id);
    expect(completed?.status).toBe('complete');
  });
});

async function waitForJobCompletion(
  jobId: JobId,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();
  const queue = getJobQueue();

  while (Date.now() - start < timeoutMs) {
    const job = await queue.getJob(jobId);
    if (job?.status === 'complete' || job?.status === 'failed') {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error('Job did not complete within timeout');
}
```

## Production Deployment

### Separate Worker Process

```typescript
// worker.ts
import { initializeJobQueue } from '@semiont/jobs';
import { GenerationWorker } from './workers/generation-worker';
import { DetectionWorker } from './workers/detection-worker';

async function main() {
  // Initialize queue
  await initializeJobQueue({ dataDir: process.env.DATA_DIR });

  // Create workers
  const generationWorker = new GenerationWorker(config);
  const detectionWorker = new DetectionWorker(config);

  // Handle shutdown
  process.on('SIGTERM', async () => {
    console.log('Shutting down workers...');
    await Promise.all([
      generationWorker.stop(),
      detectionWorker.stop(),
    ]);
    process.exit(0);
  });

  // Start workers
  console.log('Starting workers...');
  await Promise.all([
    generationWorker.start(),
    detectionWorker.start(),
  ]);
}

main().catch(console.error);
```

### Docker Deployment

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

# Run worker process
CMD ["node", "dist/worker.js"]
```

### Scaling Workers

```yaml
# docker-compose.yml
services:
  worker-generation:
    image: my-app-worker
    environment:
      WORKER_TYPE: generation
    volumes:
      - ./data:/app/data
    deploy:
      replicas: 3  # Run 3 generation workers

  worker-detection:
    image: my-app-worker
    environment:
      WORKER_TYPE: detection
    volumes:
      - ./data:/app/data
    deploy:
      replicas: 2  # Run 2 detection workers
```

### Monitoring

```typescript
class MonitoredWorker extends JobWorker {
  private processedCount = 0;
  private errorCount = 0;

  protected async executeJob(job: AnyJob): Promise<void> {
    // Type guard
    if (job.status !== 'running') {
      throw new Error('Job must be running');
    }

    try {
      await doWork(job);
      this.processedCount++;
    } catch (error) {
      this.errorCount++;
      throw error;
    }
  }

  // Expose metrics
  getMetrics() {
    return {
      processed: this.processedCount,
      errors: this.errorCount,
      errorRate: this.errorCount / (this.processedCount + this.errorCount),
    };
  }
}

// Periodic metrics logging
setInterval(() => {
  const metrics = worker.getMetrics();
  console.log('[Metrics]', metrics);
}, 60000); // Every minute
```
