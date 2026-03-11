# Configuration Guide

Setup and deployment options for `@semiont/jobs`.

## Basic Setup

```typescript
import { JobQueue, initializeJobQueue } from '@semiont/jobs';
import { EventBus } from '@semiont/core';

// Direct construction
const eventBus = new EventBus();
const queue = new JobQueue({ dataDir: './data' }, logger, eventBus);
await queue.initialize();

// Or singleton pattern
await initializeJobQueue({ dataDir: './data' }, logger, eventBus);
```

### JobQueueConfig

```typescript
interface JobQueueConfig {
  dataDir: string;  // Base directory — jobs stored in {dataDir}/jobs/
}
```

## Directory Structure

```
{dataDir}/jobs/
  pending/        # Jobs waiting to be processed
  running/        # Jobs currently being processed
  complete/       # Successfully completed jobs
  failed/         # Failed jobs with error details
  cancelled/      # User-cancelled jobs
```

Created automatically by `initialize()`.

## Worker Configuration

### Poll Interval and Error Backoff

Workers inherit from `JobWorker`, which takes poll/backoff parameters:

```typescript
import { JobWorker, type AnyJob } from '@semiont/jobs';
import type { JobQueue } from '@semiont/jobs';
import type { Logger } from '@semiont/core';

class MyWorker extends JobWorker {
  constructor(jobQueue: JobQueue, logger: Logger) {
    super(
      jobQueue,
      1000,   // pollIntervalMs: check queue every 1 second
      5000,   // errorBackoffMs: wait 5 seconds after errors
      logger,
    );
  }

  protected getWorkerName(): string { return 'MyWorker'; }
  protected canProcessJob(job: AnyJob): boolean { return job.metadata.type === 'generation'; }
  protected async executeJob(job: AnyJob): Promise<any> { /* ... */ }
}
```

**Recommendations:**
- High-frequency queue (>10 jobs/min): 500ms–1000ms poll
- Normal queue (1-10 jobs/min): 1000ms–2000ms poll
- Low-frequency queue (<1 job/min): 5000ms–10000ms poll

All built-in annotation workers use default intervals (`undefined` → 1000ms poll, 5000ms backoff).

## Production Setup

### Worker Lifecycle

In production, workers are created by `startMakeMeaning()` in `@semiont/make-meaning`, which manages the full lifecycle:

```typescript
import { startMakeMeaning } from '@semiont/make-meaning';
import { EventBus } from '@semiont/core';

const eventBus = new EventBus();
const service = await startMakeMeaning(config, eventBus, logger);

// Workers are running. To stop:
await service.stop();
```

### Graceful Shutdown

```typescript
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, stopping...');
  await service.stop(); // Stops all workers, actors, and stores
  process.exit(0);
});
```

### Job Cleanup

```typescript
// Remove completed/failed/cancelled jobs older than 24 hours (default)
const removed = await queue.cleanupOldJobs();

// Custom retention
const removed = await queue.cleanupOldJobs(168); // 1 week in hours

// Periodic cleanup
setInterval(async () => {
  const removed = await queue.cleanupOldJobs(24);
  if (removed > 0) logger.info(`Cleaned up ${removed} old jobs`);
}, 3600000); // Every hour
```

### Health Checks

```typescript
async function healthCheck(): Promise<boolean> {
  try {
    const queue = getJobQueue();
    await queue.getStats();
    return true;
  } catch {
    return false;
  }
}
```

## Troubleshooting

### Jobs Stuck in Running

**Cause:** Worker crashed mid-processing or was killed without graceful shutdown.

**Solution:** On startup, move old running jobs back to pending:

```typescript
const running = await queue.listJobs({ status: 'running' });
const fiveMinutesAgo = Date.now() - 300000;

for (const job of running) {
  if (job.status === 'running' && new Date(job.startedAt).getTime() < fiveMinutesAgo) {
    logger.info(`Resetting stuck job: ${job.metadata.id}`);
    const pendingJob: PendingJob<any> = {
      status: 'pending',
      metadata: job.metadata,
      params: job.params,
    };
    await queue.updateJob(pendingJob, 'running');
  }
}
```

### Permission Errors

```bash
# Check directory ownership
ls -la data/jobs/

# Fix permissions
chmod -R 755 data/jobs/
```
