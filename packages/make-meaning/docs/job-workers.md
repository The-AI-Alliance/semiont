# Job Workers

Annotation and generation workers live in **[@semiont/jobs](../../jobs/README.md)**, not in this package. This document describes how they integrate with the make-meaning actor model.

## Overview

Workers run in a separate **worker process** (the worker pool — [worker-main.ts](../../jobs/src/worker-main.ts) → [startAgentWorker](../../jobs/src/worker-runtime.ts) → [startWorkerProcess](../../jobs/src/worker-process.ts)). The process claims pending jobs over the bus through a `JobClaimAdapter` (reactive, SSE-driven — not a local polling loop) and emits `mark:create` commands on the bus when it produces annotations. Generated resource *content* never travels on the bus — the generation path uploads it via `session.client.yield.resource()` and the gateway emits `yield:create` internally. Every bus emit goes through a `SemiontSession` (`session.client.transport.emit(...)`), so the worker is an ordinary bus participant authenticated as a software agent.

A job whose `job:queued` announcement found no idle eligible worker is not lost: the gateway's `FsJobQueue` re-announces all pending jobs every 30 seconds (and immediately at startup), so backlog is claimed as soon as a worker frees up or reconnects.

The worker's lifecycle events are mirrored into the queue files by the job command handlers (`registerJobCommandHandlers`): `job:complete` moves the job to `complete/`; `job:fail` retries it (re-queue + re-announce) while `retryCount < maxRetries`, then lands it in `failed/`; `job:report-progress` is written into the running file as live progress and doubles as a worker heartbeat — a running job with no heartbeat for 30 minutes is presumed orphaned and fed through the same retry-or-fail path. `job:cancel-requested` cancels pending jobs of the requested `jobType`. Terminal jobs are pruned after 24 hours.

Workers never persist directly — the **Stower** actor subscribes to the emitted commands and handles all persistence (`eventStore.appendEvent()`). In the gateway deployment the Stower runs inside the **Archivist** service (`archivist-main`), not the gateway. Both make-meaning composition roots — [`startMakeMeaning()`](../src/service.ts) (standalone/scripting, all actors in-process) and [`startMakeMeaningGateway()`](../src/service.ts) (the gateway, which hosts no actors) — own a `JobQueue` and register the bus command handlers; neither instantiates workers.

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

The AI detection logic lives in the [`AnnotationDetection`](../../jobs/src/workers/annotation-detection.ts) class for the highlight/assessment/comment/tag motivations (one static method each); entity-reference extraction lives in [`extractEntities()`](../../jobs/src/workers/detection/entity-extractor.ts); generation synthesis lives in [`generateResourceFromTopic()`](../../jobs/src/workers/generation/resource-generation.ts). Processors orchestrate those calls and shape the results into W3C annotations.

## Processor Signature

The annotation processors share a signature:

```typescript
async function processHighlightJob(
  content: string,
  inferenceClient: InferenceClient,
  params: HighlightDetectionParams,
  buildAnnotation: BuildAnnotation,  // media-appropriate (motivation, match, body?) → Annotation
  onProgress: OnProgress,
): Promise<ProcessorResult<HighlightDetectionResult>>  // { result }; annotations go out per chunk
```

`buildAnnotation` comes from [`prepareDetection`](../../jobs/src/workers/detection/prepare-detection.ts): character-offset anchoring for plain text, page-geometry anchoring when the extraction carries positioned runs (PDFs). Processors stay media-agnostic — they see `.text` and the builder, never a layer or a media type. `processReferenceJob` additionally takes a `logger`. `processGenerationJob` differs — it returns synthesized content rather than annotations:

```typescript
async function processGenerationJob(
  inferenceClient: InferenceClient,
  params: GenerationJobParams,        // options + the gathered context; the context's
                                      // focus is what anchors the job
  onProgress: OnProgress,
  logger: Logger,
): Promise<{
  content: Uint8Array;                // bytes — the output media type decides the encoding
  title: string;
  format: SupportedMediaType;
  citations: GenerationCitation[];    // only under `cite`
  result: GenerationResult;
}>
```

The `generator` is a W3C `Agent` with `@type: "Software"` that identifies this worker's agent identity (inference provider + model). It is built once at worker startup and carried on the [`WorkerProcessConfig`](../../jobs/src/worker-process.ts); processors never receive it (or `InferenceConfig`) directly — it reaches annotations through the `buildAnnotation` closure, which `prepareDetection` builds from the `generator` alone. No user identity is threaded through: who *requested* the work is the knowledge base's to derive, never the worker's to state.

## EventBus Integration

The worker process emits commands on the bus through its session; the Stower subscribes and handles persistence.

### Annotation Creation

The processor returns a W3C `Annotation` carrying body, target, `created` and `generator` — and nothing about who asked for it. The worker process commits a batch with `mark:commit`, citing the job it holds:

```typescript
await busRequest(actor, 'mark:commit', { resourceId, annotations, jobId });
```

`jobId` is what makes the annotation attributable. The Stower reads the dispatcher's `job:assigned` record for that job on this resource's log, checks that the job's recorded holder is the emitter, and derives the rest:

- **`creator`** — the **requester**: the DID that emitted the `job:create` this batch fulfils, as the dispatcher recorded it. Never sent by the worker; a payload that names `creator` is **refused**.
- **`generator`** — the software that produced the annotation (W3C Web Annotation §3.2.1). The worker may supply it to carry the model's parameters, but its identity must be the emitter's own — a `generator` naming anyone else is refused, and one omitted is filled in from the verified emitter.
- **`wasAttributedTo`** — both parties (PROV-O), `[creator, generator]`, collapsed to one when requester and producer are the same agent (autonomous work).

A worker-role emitter that cites no `jobId` is refused rather than attributed to the model alone: "no job → self-initiated" is true for a person or an autonomous agent, and a silent lie for a worker that forgot the field.

### Job Lifecycle

`job:start` / `job:report-progress` / `job:complete` / `job:fail` are the one unified lifecycle family:

```typescript
await emitEvent(session, 'job:start',  { jobId, resourceId, jobType /*, annotationId? */ });
   emitEvent(session, 'job:report-progress', { ...lifecycleBase, percentage, progress });  // ephemeral
await emitEvent(session, 'job:complete', { jobId, resourceId, jobType, result });
await emitEvent(session, 'job:fail',     { jobId, resourceId, jobType, error });
```

No `userId` in the payloads: the lifecycle commands declare only `_userId`, injected by the gateway from the authenticated session. Stower persists `start` / `complete` / `fail` as domain events (`job:started`, `job:completed`, `job:failed`); `job:report-progress` is ephemeral UI feedback and Stower ignores it. Annotation-focus jobs (today: `generation` triggered from a reference — the id is derived from the generation context's focus) carry that `annotationId` through every lifecycle payload so the UI can attach visual feedback to that annotation; resource-scoped jobs (bulk detection, resource-focus generation) leave it unset.

## Instantiation

Workers are launched by the worker pool, [worker-main.ts](../../jobs/src/worker-main.ts), which groups job types by `(inferenceProvider, model)` and calls [`startAgentWorker`](../../jobs/src/worker-runtime.ts) for each group. That function:

1. Authenticates as a **software agent** (`authenticateAgent(...)` → agent DID + token, with refresh)
2. Opens a [`SemiontSession`](../../sdk/docs/STATE-UNITS.md) on that identity (`await session.ready`)
3. Builds the `generator` descriptor from the minted DID (`didToAgent(did)` — the `Software` agent the knowledge base checks its writes against)
4. Calls `startWorkerProcess(...)`:

```typescript
const adapter = startWorkerProcess({
  session,
  jobTypes: group.jobTypes,
  inferenceClient: group.client,
  generator,
  anchoredTextStore: anchoredTextStoreOverTransport(content, logger),  // extraction cache (PERSIST-ANCHORS)
  logger,
});
```

Before dispatching a detection job, the worker process fetches the resource descriptor through its session (`session.client.browse.resource(resourceId).fresh()`), then `prepareDetection` fetches the bytes (`session.client.browse.resourceRepresentation(resourceId)`) and gets text from them. It never reads KB storage directly.

**How it gets that text depends on whether the bytes carry any** (READ-VS-EXTRACT). Those are two operations, not one, and they no longer share a registry:

- **Decoding** — a charset-aware `Buffer → string` for text media. Microseconds, deterministic, no artifact to persist, and anyone holding bytes can do it. It is `decodeRepresentation` in `@semiont/core`, called directly.
- **Deriving** — parsing a PDF, OCR-ing it when there is no text layer. Minutes, non-deterministic across engine versions, and it produces exactly one canonical artifact. Reached through `derivingExtractorFor(mediaType)` in `@semiont/content`, and **callable only with the store that persists its output** — which is why the Smelter owns it.

The type decides which applies: `textSourceOf(format)` returns `'decode' | 'pdf-text-layer' | 'none'`. Derived text is cached in the anchored-text store, so a detection pass reuses what the Smelter already produced rather than re-deriving it.

## See Also

- [@semiont/jobs README](../../jobs/README.md) — Job queue, worker process, job types
- [@semiont/jobs Workers Guide](../../jobs/docs/Workers.md) — Building custom workers
- [Architecture](./architecture.md) — Actor model and data flow
