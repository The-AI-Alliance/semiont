# Jobs API Reference

## FsJobQueue

`FsJobQueue` is the filesystem-backed implementation of the `JobQueue` interface; `JetStreamJobQueue` is the other. The interface contract (`initialize`, `destroy`, `createJob`, `getJob`, `claimNextJob`, `completeJob`, `failJob`, `checkpointUnits`, `recordProgress`, `cancelPendingJobs`, `cancelJob`, `getStats`) is the same for both drivers; `listJobs`, `cleanupOldJobs`, and `recoverStaleRunningJobs` are `FsJobQueue` methods not on the interface. There is no generic update: a job changes state only through the named transitions.

### Constructor

```typescript
import { FsJobQueue } from '@semiont/jobs';
import { EventBus, type Logger } from '@semiont/core';
import { SemiontState } from '@semiont/core/node';

const eventBus = new EventBus();
const state = new SemiontState({ name: 'my-kb' });
const queue = new FsJobQueue(state, logger, eventBus);
await queue.initialize();
```

**Parameters:**
- `state: SemiontState` — jobs are stored under `state.jobsDir`
- `logger: Logger` — structured logger
- `eventBus?: EventBus` — optional EventBus for emitting `job:queued` events

### `initialize(): Promise<void>`

Creates status directories and starts the hourly retention sweep that prunes terminal jobs older than 24 hours. With an EventBus it also announces any existing pending backlog on `job:queued` (restart recovery) and starts a 30-second tick that re-announces pending jobs and recovers stale running jobs. Idempotent.

### `destroy(): void`

Stops the maintenance intervals.

### `createJob(job: AnyJob): Promise<void>`

Persists a job to `{state.jobsDir}/{status}/{id}.json`. If status is `pending`, the EventBus is provided, and job params include `resourceId`, emits `job:queued`.

```typescript
import type { PendingJob, DetectionParams } from '@semiont/jobs';
import { jobId, userId, resourceId } from '@semiont/core';

const job: PendingJob<DetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-abc123'),
    type: 'reference-annotation',
    userId: userId('did:web:example.com:users:f47ac10b-58cc-4372-a567-0e02b2c3d479'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 1,
  },
  params: {
    resourceId: resourceId('doc-789'),
    entityTypes: ['Person', 'Organization'],
  },
};

await queue.createJob(job);
```

Generation params carry no `resourceId` of their own — the `job:create`
dispatcher derives it from `context.focus` and stamps it in, which is what
satisfies the `job:queued` condition above. See
[JobTypes.md](./JobTypes.md#generation-generation).

### `getJob(jobId: JobId): Promise<AnyJob | null>`

Searches all status directories (`pending`, `running`, `complete`, `failed`, `cancelled`) for a job by ID. Returns `null` if not found.

```typescript
const job = await queue.getJob(jobId('job-abc123'));
if (job?.status === 'complete') {
  console.log(job.result);
}
```

### `claimNextJob(types: string[]): Promise<{ job: RunningAnyJob } | { declined: 'none-available' }>`

Atomically claims a pending job whose type is in `types` (an empty `types` accepts any type): it moves to `running` with `startedAt` stamped and `progress: {}`. No ordering among matching pending jobs is promised. Finding nothing is a decline, not an error.

```typescript
const claim = await queue.claimNextJob(['reference-annotation']);
if ('job' in claim) {
  console.log(claim.job.metadata.id, claim.job.startedAt);
}
```

### `completeJob(jobId: JobId, result): Promise<boolean>`

Moves a running job to `complete` with the result and `completedAt`. Returns `false` (and changes nothing) if the job is missing or not running — duplicate `job:complete` events are harmless.

```typescript
const moved = await queue.completeJob(jobId('job-abc123'), { kind: 'reference-annotation', totalFound: 3, totalEmitted: 3, errors: 0 });
```

### `failJob(jobId: JobId, error, completedUnits?, failureClass?, unitCursors?): Promise<'retried' | 'failed' | null>`

Retry-or-fail a running job. While `retryCount < maxRetries` **and the failure is not classified `'deterministic'`**, the job moves back to `pending` with the count bumped (and is re-announced for another worker to claim); a deterministic failure — one the worker knows cannot succeed on an identical second attempt — moves straight to `failed` without spending the budget. `completedUnits` (work units the failed attempt already persisted) is unioned into `metadata.completedUnits`, and `unitCursors` (how far each unfinished unit got) merged per unit into `metadata.unitCursors`, surviving the retry rebuild so the next attempt resumes rather than restarts. Returns `null` if the job isn't running.

```typescript
const outcome = await queue.failJob(jobId('job-abc123'), 'inference timeout', ['Person'], 'transient');
// 'retried' | 'failed' | null
```

### `checkpointUnits(jobId: JobId, completedUnits: string[], unitCursors?): Promise<void>`

Persists a running job's checkpoint as work lands: `completedUnits` is unioned into `metadata.completedUnits` and `unitCursors` merged monotonically per unit into `metadata.unitCursors` (a completed unit drops its cursor). Unthrottled; a no-op for jobs that aren't running. A worker that dies without emitting `job:fail` therefore loses at most its in-flight chunk.

### `recordProgress(jobId: JobId, progress: StoredProgress): Promise<void>`

Replaces a running job's `progress` with the reported `JobProgress`, throttled to one write per 5 seconds per job. Beyond surfacing live progress to `job:status-requested`, each write refreshes the file's mtime — the heartbeat that stale-running recovery watches. A no-op for jobs that aren't running.

### `cancelPendingJobs(category: JobCategory): Promise<number>`

Cancels all pending jobs in a category — the granularity of the `job:cancel-requested` UI signal. `JobCategory` (`'generation' | 'annotation'`) comes from `@semiont/core`, generated from `specs/src/jobs/storage.json`; `'annotation'` covers every `*-annotation` type. Running jobs are left to finish. Returns the number cancelled.

```typescript
const cancelled = await queue.cancelPendingJobs('annotation');
```

### `listJobs(filters?: JobQueryFilters): Promise<AnyJob[]>`

> `FsJobQueue`-specific — not part of the `JobQueue` interface.

Lists jobs with optional filters. Reads from filesystem, sorted by creation time (newest first), with pagination.

```typescript
const pending = await queue.listJobs({ status: 'pending' });
const userJobs = await queue.listJobs({ userId: userId('did:web:example.com:users:f47ac10b-58cc-4372-a567-0e02b2c3d479'), limit: 10 });
const allJobs = await queue.listJobs();
```

**Filter options:**

```typescript
interface JobQueryFilters {
  status?: JobStatus;
  type?: JobType;
  userId?: UserId;
  limit?: number;   // Default: 100
  offset?: number;   // Default: 0
}
```

### `cancelJob(jobId: JobId): Promise<boolean>`

Cancels a pending or running job by moving it to `cancelled` status. Returns `false` if the job doesn't exist or is already in a terminal state.

```typescript
const cancelled = await queue.cancelJob(jobId('job-abc123'));
```

### `cleanupOldJobs(retentionMs: number): Promise<number>`

> `FsJobQueue`-specific — not part of the `JobQueue` interface. `JetStreamJobQueue` holds the same contract through `pruneTerminalJobs(retentionMs)`.

Removes completed, failed, and cancelled jobs whose `completedAt` is older than `retentionMs`. Returns count of deleted jobs. Runs automatically on `TERMINAL_JOB_SWEEP_INTERVAL_MS` with `TERMINAL_JOB_RETENTION_MS` — the one window both drivers share, exported from `job-queue-interface.ts`. The parameter has no default: a second copy of that number is a second number.

```typescript
// Remove jobs older than 1 week
const removed = await queue.cleanupOldJobs(7 * 24 * 60 * 60 * 1000);
```

### `recoverStaleRunningJobs(): Promise<number>`

> Not part of the `JobQueue` interface (`JetStreamJobQueue` has its own).

Recovers running jobs orphaned by a dead worker: any `running/` file whose mtime is older than 30 minutes is fed through the same retry-or-fail path as `failJob`. Progress writes refresh the mtime, so a worker that reports within the window is never recovered out from under itself. Runs automatically on the 30-second maintenance tick when an EventBus is provided.

### `getStats(): Promise<{ pending, running, complete, failed, cancelled }>`

Returns job counts by status directory.

```typescript
const stats = await queue.getStats();
console.log(`${stats.pending} pending, ${stats.running} running`);
```

## Worker Process

Workers run as a separate process. `worker-main.ts` authenticates as a software agent, opens a `SemiontSession` (from `@semiont/sdk`), builds a `generator` (a W3C `Software` agent under its own DID), and calls `startWorkerProcess(...)`.

### `startWorkerProcess(config): JobClaimAdapter`

`startWorkerProcess` lives in `src/worker-process.ts` and is internal to the package — the `worker-main.ts` entry point calls it once per agent group. It is not exported from the package root.

```typescript
const adapter = startWorkerProcess({
  session,          // SemiontSession authenticated as this worker's agent
  jobTypes,         // string[] — job types this agent serves
  inferenceClient,  // InferenceClient
  generator,        // this agent's W3C `Software` record, sent as annotation `generator`
  contentReads,     // ContentReads — resource bytes for detection, read from the Archivist
  logger,
});
```

`startWorkerProcess` claims jobs over the bus via a `JobClaimAdapter`, which pulls: it sends `job:claim` whenever it becomes idle (at start, after each job settles, on a matching `job:queued` while parked, on reconnect) — not on a poll interval. When a job is claimed, it dispatches by `jobType` to the matching `process*Job` function in `src/processors.ts`:

| Job Type | Processor |
|----------|-----------|
| `reference-annotation` | `processReferenceJob` |
| `generation` | `processGenerationJob` |
| `highlight-annotation` | `processHighlightJob` |
| `assessment-annotation` | `processAssessmentJob` |
| `comment-annotation` | `processCommentJob` |
| `tag-annotation` | `processTagJob` |

### Processors

Each processor is transport-agnostic. Detection processors take `(content, inferenceClient, params, buildAnnotation, onProgress, onChunkComplete, resumeCursors?)` — `processReferenceJob` additionally takes `logger`, an `onUnitComplete` checkpoint callback and an abort `signal`, and its `onChunkComplete` is optional — and return `{ result }`. Annotations are committed per chunk through `onChunkComplete`, not returned, and no user identity reaches a processor. `processGenerationJob` takes `(inferenceClient, params, onProgress, logger)` and returns `{ content, title, format, citations, result }`. Detection logic lives in the `AnnotationDetection` class (`src/workers/annotation-detection.ts`); generation synthesis in `generateResourceFromTopic()` (`src/workers/generation/resource-generation.ts`).

### Processing Flow

```
idle → job:claim → JobClaimAdapter receives a running job (or a decline, and parks)
  ↓
emit job:start
  ↓
prepareDetection(...) → text + buildAnnotation   (detection job types)
  ↓
process*Job(...) — per chunk: await mark:commit (acknowledged), emit job:checkpoint
  ↓
emit job:complete (with result)
  ↓ on error
emit job:fail; adapter.failJob(jobId, message)
```

`prepareDetection` reads the resource's bytes through `contentReads` for text media types, and consults the Smelter's canonical anchored text (`session.client.browse.resourceAnchoredText`) for geometry-bearing types such as PDF.

A worker that is busy when a job is queued claims it at its next settle; the 30-second re-announce only covers a wake-up lost in transit to an idle worker. Duplicate announcements are harmless — a claim is by type, so a worker that finds nothing pending is declined and parks.

At the dispatcher, the lifecycle commands are mirrored into the queue (see `@semiont/make-meaning`'s job command handlers): `job:complete` → `completeJob`, `job:fail` → `failJob` (retry or `failed`), `job:checkpoint` → `checkpointUnits`, and `job:report-progress` → `recordProgress`, which is both live progress and a worker heartbeat.

Lifecycle events are emitted via `session.client.transport.emit(...)`; annotations persist through the **awaited `mark:commit`** operation, which the Stower actor in @semiont/make-meaning answers with `mark:commit-ok` only once every annotation is appended to the event log. Unit completion — and `job:complete` itself — gate on that acknowledgement, never on emission.

## Storage

```
{state.jobsDir}/
  pending/{jobId}.json
  running/{jobId}.json
  complete/{jobId}.json
  failed/{jobId}.json
  cancelled/{jobId}.json
```

Each job is a single JSON file. Status transitions are atomic (delete old file, write new file).
