# Job Workers

Annotation and generation workers live in **[@semiont/jobs](../../jobs/README.md)**, not in this package. This document describes how they integrate with the make-meaning actor model.

## Overview

Workers run in a separate **worker process** (the worker pool — [worker-main.ts](../../jobs/src/worker-main.ts) → [startAgentWorker](../../jobs/src/worker-runtime.ts) → [startWorkerProcess](../../jobs/src/worker-process.ts)). The process claims pending jobs over the bus through a `JobClaimAdapter`, which pulls whenever the worker is idle (start, settle, a matching wake-up, reconnect) rather than running a timer, and commits the annotations it produces with `mark:commit` on the bus. Generated resource *content* never travels on the bus — the generation path uploads it via `session.client.yield.resource()`; the gateway forwards the upload to the Archivist, which stores the bytes and emits `yield:create` on its own bus. Every bus emit goes through a `SemiontSession` (`session.client.transport.emit(...)`), so the worker is an ordinary bus participant authenticated as a software agent.

A job created while every eligible worker was busy is not lost, and needs no re-announcement to be found: each worker pulls the moment its current job settles. The queue's 30-second tick re-announces pending jobs as insurance against a wake-up lost in transit to an *idle* worker — the one case pull cannot cover, since an idle worker has nothing to settle. On a healthy stack it never acts.

Jobs run on the stack. The queue and the nine `job:*` channels belong to the **dispatcher**
([apps/dispatcher](../../../apps/dispatcher/README.md)), a service of its own; the worker's lifecycle
commands reach it over the bus, and what it does with each — completion, the retry rule, progress as a
heartbeat, the sweep for a worker gone silent, cancellation, retention — is
[docs/protocol/JOBS.md](../../../docs/protocol/JOBS.md). The in-process root
[`startMakeMeaning()`](../src/service.ts) runs no jobs: a script that runs them runs the stack and
uses the SDK: `semiont.mark` and `semiont.yield` start jobs, and `semiont.job` follows them.

Workers never persist directly — the **Stower** actor subscribes to the emitted commands and handles all
persistence (`eventStore.appendEvent()`). In the stack the Stower runs inside the **Archivist** service
(`archivist-main`). Neither the Archivist nor the dispatcher instantiates workers.

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
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,  // the durability write
  resumeCursors?: Record<string, UnitCursor>,  // where earlier attempts left each unit
): Promise<ProcessorResult<JobHighlightAnnotationResult>>  // { result }; annotations go out per chunk
```

`buildAnnotation` comes from [`prepareDetection`](../../jobs/src/workers/detection/prepare-detection.ts): character-offset anchoring for plain text, page-geometry anchoring when the extraction carries positioned runs (PDFs). Processors stay media-agnostic — they see `.text` and the builder, never a layer or a media type. `processReferenceJob` additionally takes a `logger`, an `onUnitComplete` checkpoint callback and an optional `AbortSignal`. `processGenerationJob` differs — it returns synthesized content rather than annotations:

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
  truncated: boolean;
}>
```

The `generator` is a W3C `Agent` with `@type: "Software"` that identifies this worker's agent identity (inference provider + model). It is built once at worker startup and carried on the [`WorkerProcessConfig`](../../jobs/src/worker-process.ts); processors never receive it (or `InferenceConfig`) directly — it reaches annotations through the `buildAnnotation` closure, which `prepareDetection` builds from the `generator` alone. No user identity is threaded through: who *requested* the work is the knowledge base's to derive, never the worker's to state.

## EventBus Integration

The worker process emits commands on the bus through its session; the Stower subscribes and handles persistence.

### Annotation Creation

The processor produces W3C `Annotation`s carrying body, target, `created` and `generator` — and nothing about who asked for them. The worker process commits a batch with `mark:commit`, citing the job it holds:

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
2. Opens a [`SemiontSession`](../../../docs/builder/STATE-UNITS.md) on that identity (`await session.ready`)
3. Builds the `generator` descriptor from the minted DID (`didToAgent(did)` — the `Software` agent the knowledge base checks its writes against)
4. Calls `startWorkerProcess(...)`:

```typescript
const adapter = startWorkerProcess({
  session,
  jobTypes: group.jobTypes,
  inferenceClient: group.client,
  generator,
  contentReads,  // byte reads, for decode-path media only
  logger,
});
```

Before dispatching a detection job, the worker process fetches the resource descriptor through its session (`session.client.browse.resource(resourceId).fresh()`), then `prepareDetection` resolves the text the media type calls for. For decode-path media it reads the bytes from the Archivist through the injected `contentReads` and decodes them. For geometry-bearing media (PDF) it fetches no bytes and runs no OCR: it consults the Smelter's anchored text (`session.client.browse.resourceAnchoredText(resourceId)`). It never reads KB storage directly.

**How the text is obtained depends on whether the bytes carry any**. Those are two operations, not one, and they share no registry:

- **Decoding** — a charset-aware `Buffer → string` for text media. Microseconds, deterministic, no artifact to persist, and anyone holding bytes can do it. It is `decodeRepresentation` in `@semiont/core`, called directly.
- **Deriving** — parsing a PDF, OCR-ing it when there is no text layer. Minutes, non-deterministic across engine versions, and it produces exactly one canonical artifact. Reached through `derivingExtractorFor(mediaType)` in `@semiont/content`, and **callable only with the store that persists its output** — which is why the Smelter owns it.

The type decides which applies: `textSourceOf(format)` returns `'decode' | 'pdf-text-layer' | 'none'`. Derived text is cached in the anchored-text store, so a detection pass reuses what the Smelter already produced rather than re-deriving it.

## See Also

- [@semiont/jobs README](../../jobs/README.md) — Worker process, job types
- [docs/protocol/JOBS.md](../../../docs/protocol/JOBS.md) — The dispatcher's job protocol
- [@semiont/jobs Workers Guide](../../jobs/docs/Workers.md) — Building custom workers
- [Architecture](./architecture.md) — Actor model and data flow
