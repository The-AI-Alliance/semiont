# @semiont/jobs

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+jobs%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=jobs)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=jobs)
[![npm version](https://img.shields.io/npm/v/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
[![License](https://img.shields.io/npm/l/@semiont/jobs.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The job worker for [Semiont](https://github.com/The-AI-Alliance/semiont): the processors for each job type, the job types, and the worker process that claims jobs over the bus. The job queue is the dispatcher's ([apps/dispatcher](../../apps/dispatcher/README.md)), and what it does with a job is [docs/protocol/JOBS.md](../../docs/protocol/JOBS.md).

## Architecture Context

Workers run in a separate process and connect to the knowledge base's gateway over HTTP/SSE using a `SemiontSession` (from `@semiont/sdk`), with a `JobClaimAdapter` on the session's bus connection. Whenever a worker is idle it claims the next pending job of its types with `job:claim` (a `job:queued` announcement wakes a parked worker), and it emits its lifecycle events onto the bus via `session.client.transport.emit(...)`. The gateway relays them over SSE to the dispatcher, the Stower and clients such as the Browser.

## Installation

```bash
npm install @semiont/jobs
```

**Dependencies:**
- `@semiont/core` — Core types, the bus protocol (`busRequest`, `BusRequestPrimitive`), the config loader
- `@semiont/sdk` — `SemiontSession`, `SemiontClient` (worker process)
- `@semiont/http-transport` — `HttpTransport`, `HttpContentTransport`
- `@semiont/inference` — InferenceClient for AI operations
- `@semiont/content` — Resource bytes read from the Archivist (`archivistContentReads`), PDF text-layer extraction, the output byte budget
- `@semiont/event-sourcing` — Annotation id generation
- `@semiont/observability` — Spans and job-outcome metrics

## Quick Start

A job is created on the bus (`job:create`), answered by the dispatcher, and claimed by a worker. A
client starts one through the SDK — `semiont.mark.assist(...)` for an annotation pass,
`semiont.yield.fromContext(...)` for generation — and follows it with `semiont.job`. A worker is this
package's `worker-main`, run as the `semiont-worker` image.

## Job Types

```typescript
type JobType =
  | 'reference-annotation'     // Entity reference detection
  | 'generation'               // AI content generation
  | 'highlight-annotation'     // Key passage highlighting
  | 'assessment-annotation'    // Evaluative assessments
  | 'comment-annotation'       // Explanatory comments
  | 'tag-annotation'           // Structural role tagging
```

## Job Metadata

All jobs share common metadata:

```typescript
interface JobMetadata {
  id: JobId;
  type: JobType;
  userId: UserId;         // Who requested it — the verified DID, the job's only identity
  created: string;
  retryCount: number;
  maxRetries: number;
  completedUnits?: string[];  // Checkpoint: work units already persisted —
                              // the retry skips them
  unitCursors?: Record<string, UnitCursor>;  // How far each unfinished unit got
}
```

`userId` is the job's only identity — the DID the gateway verified on the `job:create`. The dispatcher records it as the requester when it accepts a claim, and that record is what lets the knowledge base attribute a write citing this job; a worker never states it. `completedUnits` and `unitCursors` are written by the dispatcher, from `job:checkpoint` (as work lands) and from `job:fail`, merged across attempts — see Failure discipline below.

## Progress

A running job's `progress` is `StoredProgress`: the last `JobProgress` its worker reported with `job:report-progress`, or `{}` before the first report. It is one shape for every job type — the spec's `JobRunning.progress` — so there are no per-type progress types. See [Job Types Guide](./docs/JobTypes.md#progress).

## Annotation Workers

The worker process (`worker-main.ts` → `startAgentWorker` in `worker-runtime.ts` → `startWorkerProcess` in `worker-process.ts`) claims jobs over the bus via a `JobClaimAdapter` and dispatches by `jobType` to a processor function. There are no per-type worker classes; each job type maps to one `process*Job` function:

| Job Type | Processor |
|----------|-----------|
| `reference-annotation` | `processReferenceJob` |
| `generation` | `processGenerationJob` |
| `highlight-annotation` | `processHighlightJob` |
| `assessment-annotation` | `processAssessmentJob` |
| `comment-annotation` | `processCommentJob` |
| `tag-annotation` | `processTagJob` |

Detection logic lives in the `AnnotationDetection` class (`src/workers/annotation-detection.ts`) and, for references, in `extractEntities` (`src/workers/detection/entity-extractor.ts`); generation synthesis in `generateResourceFromTopic()` (`src/workers/generation/resource-generation.ts`). Processors never fetch content themselves — the worker process prepares it with `prepareDetection` (bytes through `contentReads` for text media, the Smelter's anchored text for geometry-bearing media such as PDF) and passes it in.

Workers emit lifecycle events via `session.client.transport.emit('job:start' | 'job:report-progress' | 'job:checkpoint' | 'job:complete' | 'job:fail', payload)` and persist annotations through the **awaited `mark:commit` operation** — a batch per unit of work that resolves only once the Stower actor in @semiont/make-meaning has appended every annotation to the event log. Unit completion and `job:complete` gate on that acknowledgement, never on emission, so a down persistence sink is a retryable failure instead of silent loss. The dispatcher's job command handlers mirror the lifecycle events into the queue (completion, checkpoints, retry-on-failure with `maxRetries`, progress-as-heartbeat). `job:fail` carries the fields the worker computes: `completedUnits` and `unitCursors` (the checkpoint), `failureClass`, and `willRetry` — see Failure discipline.

## Failure discipline

Long inference work fails in bounded, classified, resumable ways:

- **Every inference call is bounded and truly cancelled.** A call gets 10 minutes (`INFERENCE_TIMEOUT_MS`); at the bound the worker aborts it at the transport (`AbortSignal` through the provider SDK to the socket — milliseconds to rejection, no zombie billing on) and fails the job with a typed `InferenceTimeoutError`. An in-flight heartbeat reports elapsed-time liveness every 15 s during long calls.
- **Budgets are derived, never tuned** (`workers/detection/detection-chunking.ts`). Input:output allocation is 1:2 per entity type asked for (`input ≤ outputBudget / (2 × typesPerCall)`), and **every** provider gets a duration cap: per-call output is bounded at what the provider's worst-case rate finishes in HALF the bound — the published rate when there is one, a conservative assumed floor (`ASSUMED_OUTPUT_TOKENS_PER_HOUR`, 30 tok/s) for rate-silent providers like Ollama, where an unbounded budget turns a model repetition loop into an hour-long transient burn.
- **Size-shaped failures subdivide in place** (`callChunkSubdividing`). Five failure families descend, each with its own floor: a **truncation** descends by size and gets one same-size re-roll at the floor; a **timeout** descends two levels then propagates; an **`'unknown'`-stop unreadable response** (garbage output with no stop reason — measured size-correlated on real documents) descends by size and propagates at the floor; an **unreadable response from a model that finished** (`end_turn`) descends two levels then propagates, as a timeout does; and a **flagged under-report** (below) descends by size, and at the floor its salvage — everything it did find, every span write-time-verified — is **accepted loudly** rather than discarded. A piece that cannot actually shrink is at its floor regardless of arithmetic: at temperature 0, an identical re-run returns the identical failure. Sub-piece overlap duplicates fall to the existing span-keyed dedupe.
- **Successful-looking extractions are verified** (`assertYieldNotCollapsed`). A local model can return a clean, schema-conforming response carrying a fraction of the entities present — deterministic and otherwise invisible. When the provider declares `verifyDetectionYield` (all real providers do), each chunk's item count is checked against a cheap count call over the same text; an extraction under half the count is flagged and subdivided. Every anchoring outcome and every call — including flagged and failed ones — is recorded to `semiont.detection.*` metrics (`@semiont/observability`).
- **Entity types run concurrently up to the provider's declared capacity** (`client.maxConcurrency`): a hosted API with rate headroom runs several types at once; a local single-model server runs them sequentially, because concurrent requests only split one GPU. Jobs never switches on provider identity — both behaviors are capabilities declared on the `InferenceClient`.
- **Failures are classified at the worker, where errors are still typed** (`failure-class.ts`). Only KNOWN-deterministic failures — truncation at the subdivision floor, unsupported media, a 4xx other than 408 or 429 — skip the retry budget; everything unrecognized stays retryable. The class rides `job:fail` as `failureClass`.
- **Retries resume from the checkpoint.** Every detection job commits its annotations chunk by chunk; each committed chunk's cursor rides `job:checkpoint` and `job:fail` into `metadata.unitCursors`, and reference-annotation also records each finished entity type in `metadata.completedUnits`. The retry skips the completed units and resumes each unfinished one from its cursor.

## Adding a Job Type

Workers are not subclassed. To add a job type:

1. Add the new type to the spec: its name in `JobType.json` (`JobType` in `src/types.ts` is generated from it), its category in `specs/src/jobs/storage.json`, and its result schema in the `JobResult` union. Add its params type in `src/types.ts`. There is no progress type — every job reports `JobProgress`.
2. Add a `process*Job` function in `src/processors.ts` that runs the inference, commits its annotations through the per-chunk callback and returns the result.
3. Dispatch the new `jobType` to that processor in `handleJobInner()` in `src/worker-process.ts`.

Processors are transport-agnostic: they take content, an `InferenceClient`, the job params, a `buildAnnotation` closure (which carries the `generator` — the worker's own `Software` agent), an `onProgress` callback and a per-chunk commit callback, and return a result. No user identity reaches a processor: an annotation states what produced it, and who requested it is derived by the knowledge base from the job the commit cites. The worker process handles claiming, content fetching, committing, and lifecycle event emission.

## Discriminated Unions

Jobs use TypeScript discriminated unions for type safety:

```typescript
function handleJob(job: AnyJob) {
  if (job.status === 'running') {
    console.log(job.progress);    // Available — StoredProgress, `{}` until the first report
    // console.log(job.result);   // Compile error
  }
  if (job.status === 'complete') {
    console.log(job.result);      // Available
    // console.log(job.progress); // Compile error
  }
}
```

## Storage Format

The dispatcher keeps one `JobRecord` per job in a JetStream key-value bucket, in the layout
`specs/src/jobs/storage.json` states. A worker never reads it: it sees a job only as the dispatcher
hands it over on `job:claimed`.

## Documentation

- **[Workers Guide](./docs/Workers.md)** — Building custom workers
- **[Job Types Guide](./docs/JobTypes.md)** — All job type definitions
- **[Type System Guide](./docs/TYPES.md)** — Discriminated unions and type safety
- **[Configuration Guide](./docs/Configuration.md)** — Running a worker
- **[API Reference](./docs/API.md)** — Complete API reference

## License

Apache-2.0

## Related Packages

- [`@semiont/core`](../core/) — Domain types, `SemiontProject`, EventBus, `BusRequestPrimitive`
- [`@semiont/sdk`](../sdk/) — `SemiontSession`, `SemiontClient`
- [`@semiont/http-transport`](../http-transport/) — `HttpTransport`, `HttpContentTransport`
- [`@semiont/inference`](../inference/) — AI inference client
- [`@semiont/make-meaning`](../make-meaning/) — Actor model, Knowledge Base, service orchestration
