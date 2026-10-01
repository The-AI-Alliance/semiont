# Jobs API Reference

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

### `createJobClaimAdapter(options): JobClaimAdapter`

The claim runtime itself is exported from the package root, with its types (`JobClaimAdapter`, `JobClaimAdapterOptions`, `ActiveJob`, `ClaimRefusal`, `WorkerVitals`), for a worker written outside this package. It takes a `BusRequestPrimitive` (`@semiont/core`) and the job types to claim:

```typescript
import { createJobClaimAdapter } from '@semiont/jobs';

const adapter = createJobClaimAdapter({
  bus: httpTransport.actor,             // HttpTransport's ActorStateUnit
  jobTypes: ['highlight-annotation'],
});
adapter.activeJob$.subscribe((job) => { /* null between jobs */ });
adapter.refused$.subscribe((refusal) => { /* a claim refused for a reason other than an empty queue */ });
adapter.start();
```

The caller emits the lifecycle events and reports each outcome with `adapter.completeJob()` or `adapter.failJob(jobId, message)`, which pulls the next job. The [`semiont-worker` skill](../../../docs/protocol/skills/semiont-worker/SKILL.md) walks through a complete worker.

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

A worker that is busy when a job is queued claims it at its next settle; the dispatcher's re-announce at each tick only covers a wake-up lost in transit to an idle worker. Duplicate announcements are harmless — a claim is by type, so a worker that finds nothing pending is declined and parks.

The dispatcher acts on the lifecycle commands as [docs/protocol/JOBS.md](../../../docs/protocol/JOBS.md) states: `job:complete` concludes the job, `job:fail` retries it or fails it for good, `job:checkpoint` records the units done, and `job:report-progress` is both live progress and a worker heartbeat.

Lifecycle events are emitted via `session.client.transport.emit(...)`; annotations persist through the **awaited `mark:commit`** operation, which the Stower actor in @semiont/make-meaning answers with `mark:commit-ok` only once every annotation is appended to the event log. Unit completion — and `job:complete` itself — gate on that acknowledgement, never on emission.
