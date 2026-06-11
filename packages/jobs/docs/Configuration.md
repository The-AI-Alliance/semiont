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

Announcements have built-in catch-up: the backend re-announces pending jobs every 30 seconds (and immediately at startup), so a job queued while every eligible worker was busy or disconnected is claimed as soon as one frees up.

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

Retention is automatic: `initialize()` starts an hourly sweep that deletes completed/failed/cancelled jobs older than 24 hours. For ad-hoc pruning with a different window, call `cleanupOldJobs` directly:

```typescript
const removed = await queue.cleanupOldJobs(168); // 1 week in hours
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

**Recovery is automatic.** Progress writes refresh the running file's mtime (a heartbeat); the 30-second maintenance tick recovers any running job whose file hasn't been touched for 30 minutes, retrying it (re-queued and re-announced) while `retryCount < maxRetries` and failing it after that with `worker presumed dead`. A legitimately long-running job stays safe as long as its worker reports progress within the window.

### Permission Errors

```bash
# Check directory ownership (jobs live under project.jobsDir)
ls -la "$XDG_STATE_HOME/semiont/<project-name>/jobs/"

# Fix permissions
chmod -R 755 "$XDG_STATE_HOME/semiont/<project-name>/jobs/"
```
