# Configuration Guide

Setup and deployment options for the job worker in `@semiont/jobs`.

The job queue is not in this package. It belongs to the dispatcher
([apps/dispatcher](../../../apps/dispatcher/README.md)), a service of the stack, and what it does
with each job is [docs/protocol/JOBS.md](../../../docs/protocol/JOBS.md). A worker reaches it only
over the bus.

## Worker Configuration

### Job Claiming (pull on idle, not polling)

Workers do not poll the queue. The worker process opens a `SemiontSession`, and a `JobClaimAdapter` (created internally by `startWorkerProcess`, in this package's `src/job-claim-adapter.ts`) sends `job:claim` for its job types whenever it becomes idle — at start, after each job settles, on a matching `job:queued` while parked, and on reconnect. The dispatcher answers with a claimed job or a decline, and the adapter parks until the next of those moments. There is no poll interval or error-backoff to tune.

A job queued while every eligible worker is busy is claimed at the next settle. The dispatcher also re-announces pending jobs at every tick, which covers a wake-up lost in transit to an idle worker.

Each agent serves the `jobTypes` it is configured for — driven by the per-`(provider, model)` worker entries in `~/.semiontconfig`. Multiple job types that share an inference engine share one agent (one software-agent identity, one session); different engines run as separate agents in the same worker process.

`startWorkerProcess` is internal to the package — `startAgentWorker` (`src/worker-runtime.ts`) calls it once per agent group:

```typescript
const adapter = startWorkerProcess({
  session,          // SemiontSession authenticated as this worker's agent
  jobTypes,         // string[] — job types this agent claims
  inferenceClient,
  generator,
  contentReads,     // resource bytes for detection, read from the Archivist
  logger,
});
```

### Graceful Shutdown

The worker process handles its own `SIGTERM`/`SIGINT` — disposing each agent's `JobClaimAdapter` and session, then closing the health server.

### Health Checks

The worker process exposes an HTTP `/health` endpoint (port `24100`) that reports the number of running agents and each agent's vitals:

```bash
curl -s http://localhost:24100/health
# {"status":"ok","agents":2,"workers":[…]}
```

## Troubleshooting

### Jobs Stuck in Running

**Cause:** A worker process crashed mid-processing or was killed without graceful shutdown.

**Recovery is automatic.** A worker's progress reports and checkpoints refresh its job's liveness; the dispatcher's sweep fails any running job that has gone without either for longer than its window, retrying it while `retryCount < maxRetries` and failing it after that with `worker presumed dead`. A legitimately long-running job stays safe as long as its worker reports progress within the window.
