# Configuration Guide

Setup and deployment options for `@semiont/jobs`.

## Basic Setup

```typescript
import { FsJobQueue } from '@semiont/jobs';
import { EventBus } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';

const eventBus = new EventBus();
const project = new SemiontProject('/path/to/project');
const queue = new FsJobQueue(project, logger, eventBus);
await queue.initialize();
```

### SemiontProject

`FsJobQueue` takes a `SemiontProject` and stores jobs under `project.jobsDir` (`{stateDir}/jobs/`). The project computes all of its paths from the project root and XDG environment variables at construction time:

```typescript
const project = new SemiontProject('/path/to/project');
project.jobsDir; // → {XDG_STATE_HOME}/semiont/{name}/jobs/
```

## Directory Structure

```
{project.jobsDir}/
  pending/        # Jobs waiting to be processed
  running/        # Jobs currently being processed
  complete/       # Successfully completed jobs
  failed/         # Failed jobs with error details
  cancelled/      # User-cancelled jobs
```

Created automatically by `initialize()`.

## Worker Configuration

### Job Claiming (SSE, not polling)

Workers do not poll the queue. The worker process opens a `SemiontSession` and a `JobClaimAdapter` (created internally by `startWorkerProcess`, in this package's `src/job-claim-adapter.ts`) subscribes to the bus `job:queued` channel over SSE. When a job is queued, the adapter is pushed the event, claims the job atomically, and dispatches it by `jobType`. There is no poll interval or error-backoff to tune.

Each worker process serves the `jobTypes` it is configured for — driven by the per-`(provider, model)` worker entries in `~/.semiontconfig`. Multiple job types that share an inference engine share one worker process (and one software-agent identity); different engines run as separate processes.

`startWorkerProcess` is internal to the package — the `worker-main.ts` entry point calls it once per agent group:

```typescript
const adapter = startWorkerProcess({
  session,          // SemiontSession authenticated as this worker's agent
  jobTypes,         // string[] — job types this agent claims
  inferenceClient,
  generator,
  logger,
});
```

## Production Setup

### Service vs. Worker Process

The job queue and the workers run in different processes:

- `startMakeMeaning(project, config, eventBus, logger, options?)` in `@semiont/make-meaning` creates the `FsJobQueue` and registers the bus command handlers. It does **not** create or manage annotation workers.
- Workers run as a **separate process**, started by `worker-main.ts` → `startWorkerProcess(...)`. That process authenticates as a software agent, claims jobs over the bus, and emits lifecycle events back.

```typescript
import { startMakeMeaning } from '@semiont/make-meaning';
import { EventBus } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';

const eventBus = new EventBus();
const project = new SemiontProject('/path/to/project');
const service = await startMakeMeaning(project, config, eventBus, logger);

// Queue + handlers are running. To stop:
await service.stop();
```

### Graceful Shutdown

The make-meaning service stops the knowledge system and its subscriptions:

```typescript
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, stopping...');
  await service.stop();
  process.exit(0);
});
```

The worker process handles its own `SIGTERM`/`SIGINT` — disposing each agent's `JobClaimAdapter` and session, then closing the health server.

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

The worker process exposes an HTTP `/health` endpoint (port `9090`) that reports the number of running agents:

```bash
curl -s http://localhost:9090/health
# {"status":"ok","agents":2}
```

For the queue itself, call `queue.getStats()` to report job counts by status.

## Troubleshooting

### Jobs Stuck in Running

**Cause:** A worker process crashed mid-processing or was killed without graceful shutdown.

**Solution:** On startup, use `FsJobQueue`'s `listJobs` to find stale running jobs and move them back to pending:

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
# Check directory ownership (jobs live under project.jobsDir)
ls -la "$XDG_STATE_HOME/semiont/<project-name>/jobs/"

# Fix permissions
chmod -R 755 "$XDG_STATE_HOME/semiont/<project-name>/jobs/"
```
