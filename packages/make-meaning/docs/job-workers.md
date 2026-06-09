# Job Workers

Annotation and generation workers live in **[@semiont/jobs](../../jobs/README.md)**, not in this package. This document describes how they integrate with the make-meaning actor model.

## Overview

Workers run in a separate **worker process** (the worker pool — [worker-main.ts](../../jobs/src/worker-main.ts) → [startWorkerProcess](../../jobs/src/worker-process.ts)). The process claims pending jobs over the bus through a `JobClaimAdapter` (reactive, SSE-driven — not a local polling loop) and emits commands on the bus when it produces annotations or resources. Every emit goes through a `SemiontSession` (`session.client.transport.emit(...)`), so the worker is an ordinary bus participant authenticated as a software agent.

Workers never persist directly — the **Stower** actor subscribes to the emitted commands and handles all persistence (`eventStore.appendEvent()`). On the backend side, [`startMakeMeaning()`](../src/service.ts) owns the `JobQueue` and registers the bus command handlers; it does **not** instantiate workers.

## Available Workers

Each job type is handled by a `process*Job` function in [packages/jobs/src/processors.ts](../../jobs/src/processors.ts). There are no per-type worker classes — the worker process dispatches by `jobType`.

| Job Type | Processor | What it does |
|----------|-----------|-------------|
| `reference-annotation` | `processReferenceJob` | Detects entity references using AI inference |
| `generation` | `processGenerationJob` | Generates new resources from a reference annotation |
| `highlight-annotation` | `processHighlightJob` | Identifies key passages for highlighting |
| `assessment-annotation` | `processAssessmentJob` | Generates evaluative assessments |
| `comment-annotation` | `processCommentJob` | Generates explanatory comments |
| `tag-annotation` | `processTagJob` | Detects structural role tags (IRAC, IMRAD, etc.) |

The AI detection logic itself lives in the [`AnnotationDetection`](../../jobs/src/workers/annotation-detection.ts) class (one static method per motivation); generation synthesis lives in [`generateResourceFromTopic()`](../../jobs/src/workers/generation/resource-generation.ts). Processors orchestrate those calls and shape the results into W3C annotations.

## Processor Signature

The annotation processors share a signature:

```typescript
async function processHighlightJob(
  content: string,
  inferenceClient: InferenceClient,
  params: HighlightDetectionParams,
  userId: string,
  generator: Agent,            // Pre-built W3C SoftwareAgent for attribution
  onProgress: OnProgress,
): Promise<ProcessorResult<HighlightDetectionResult>>  // { annotations, result }
```

`processReferenceJob` and `processTagJob` additionally take a `logger`. `processGenerationJob` differs — it returns synthesized content rather than annotations:

```typescript
async function processGenerationJob(
  inferenceClient: InferenceClient,
  params: GenerationParams,
  onProgress: OnProgress,
  logger: Logger,
): Promise<{ content: string; title: string; format: string; result: GenerationResult }>
```

The `generator` is a W3C `Agent` with `@type: "SoftwareAgent"` that identifies which inference provider and model produced the annotation. It is built once at worker-process startup and carried on the [`WorkerProcessConfig`](../../jobs/src/worker-process.ts) — processors never receive or read `InferenceConfig` directly.

## EventBus Integration

The worker process emits commands on the bus through its session; the Stower subscribes and handles persistence.

### Annotation Creation

For each detected annotation, the processor returns a full W3C `Annotation` (with `creator`, `generator`, and `created`), and the worker process emits `mark:create`:

```typescript
await emitEvent(session, 'mark:create', { annotation, userId, resourceId });
// emitEvent → session.client.transport.emit('mark:create', { ... })
```

- **`creator`** — built from `JobMetadata` fields (`userName`, `userEmail`, `userDomain`) via `userToAgent()`. Identifies the agent that requested the job.
- **`generator`** — the pre-built `SoftwareAgent` from `WorkerProcessConfig.generator`. Identifies the software (inference provider, model) that produced the annotation. Conforms to W3C Web Annotation §3.2.1.

### Job Lifecycle

`job:start` / `job:report-progress` / `job:complete` / `job:fail` are the one unified lifecycle family:

```typescript
await emitEvent(session, 'job:start',  { jobId, resourceId, userId, jobType /*, annotationId? */ });
   emitEvent(session, 'job:report-progress', { ...lifecycleBase, percentage, progress });  // ephemeral
await emitEvent(session, 'job:complete', { jobId, resourceId, userId, jobType, result });
await emitEvent(session, 'job:fail',     { jobId, resourceId, userId, jobType, error });
```

Stower persists `start` / `complete` / `fail` as domain events (`job:started`, `job:completed`, `job:failed`); `job:report-progress` is ephemeral UI feedback and Stower ignores it. Annotation-scoped jobs (today: `generation`, triggered from a reference) carry the source `annotationId` through every lifecycle payload so the UI can attach visual feedback to that annotation.

## Instantiation

Workers are launched by the worker pool, [worker-main.ts](../../jobs/src/worker-main.ts). For each `(inferenceProvider, model)` group it:

1. Authenticates as a **software agent** (`authenticateAgent(...)` → agent DID + token, with refresh)
2. Opens a [`SemiontSession`](../../sdk/docs/STATE-UNITS.md) on that identity (`await session.ready`)
3. Builds the `generator` descriptor (the `SoftwareAgent` stamped on annotations)
4. Calls `startWorkerProcess(...)`:

```typescript
const adapter = startWorkerProcess({
  session,
  jobTypes: group.jobTypes,
  inferenceClient: group.client,
  generator,
  logger,
});
```

The worker process fetches resource content through its session — `session.client.browse.resourceContent(resourceId)` — before dispatching to the processor. It does not read KB storage directly.

## See Also

- [@semiont/jobs README](../../jobs/README.md) — Job queue, worker process, job types
- [@semiont/jobs Workers Guide](../../jobs/docs/Workers.md) — Building custom workers
- [Architecture](./architecture.md) — Actor model and data flow
