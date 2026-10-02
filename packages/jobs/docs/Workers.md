# Workers Guide

A worker is a standalone process that serves a single software-agent identity and turns queued jobs into Knowledge Base events. It opens an authenticated session, serves a set of job types, and — whenever it is idle — claims the next pending job of those types, reads the resource, runs a **processor**, and emits the results.

Workers are **not** actors. They don't subscribe to a reducer; they claim jobs over the bus and dispatch by job type. But they emit the same EventBus commands as any other caller in the system. The **Stower** actor (in `@semiont/make-meaning`) handles all persistence to the Knowledge Base — a worker never writes to storage directly.

**See also**: [Type System Guide](./TYPES.md) for job state architecture and type narrowing patterns.

## The Processor Model

There is no per-job-type worker class. Adding support for a job type means writing a **pure function** — a processor — and wiring it into the worker process's dispatch. Everything that touches the bus, the session, or the queue lives in shared infrastructure; your code only takes content and parameters and returns annotations.

The moving parts:

| File | Role |
|------|------|
| `src/worker-main.ts` | Standalone entry point. Reads `~/.semiontconfig`, groups job types by `(provider, model)`, authenticates each agent, and starts one worker process per agent group. |
| `src/worker-process.ts` | `startWorkerProcess(config)` — claims jobs via the `JobClaimAdapter`, then `handleJobInner` dispatches by `jobType` to the right processor, commits annotations in acknowledged batches (`mark:commit`), and emits the lifecycle events. |
| `src/processors.ts` | The `process*Job` functions. Content + inference + params in, `{ result }` out; annotations go out through the `onChunkComplete` callback as they are produced. No bus, no queue, no I/O except calling inference. |
| `src/workers/annotation-detection.ts` | `AnnotationDetection` — the LLM detection logic the annotation processors call (`detectHighlights`, `detectComments`, `detectAssessments`, `detectTags`). |
| `src/job-claim-adapter.ts` | `JobClaimAdapter` — asks the dispatcher for work over the bus and holds the claimed job. The worker never touches the queue itself. |

## How a Worker Runs

`worker-main.ts` is the host. For each distinct `(inferenceProvider, model)` configured under `[environments.<env>.workers]` in `~/.semiontconfig`, it:

1. Authenticates at the knowledge base's issuer as its own service account (`SEMIONT_OIDC_CLIENT_ID` / `SEMIONT_OIDC_CLIENT_SECRET`), then exchanges that token for this agent's at `/api/tokens/agent`.
2. Builds a `generator` — a W3C `Software` agent record — with `softwareToAgent({ domain, provider, model })`. This is sent as each annotation's `generator`; the knowledge base checks its identity against the verified emitter and derives `creator` and `wasAttributedTo` itself, from the job the write cites.
3. Opens a `SemiontSession` (`@semiont/sdk`) authenticated *as that agent*, so every event the worker emits attributes to the agent at the bus seat.
4. Calls `startWorkerProcess`:

```typescript
const adapter = startWorkerProcess({
  session,                 // SemiontSession, authenticated as this agent
  jobTypes: group.jobTypes,// the job types this agent's engine serves
  inferenceClient,         // the (provider, model) inference client
  generator,               // the Software agent record
  contentReads,            // resource bytes for detection, read from the Archivist
  logger,
});
```

`startWorkerProcess` creates a `JobClaimAdapter` over the session's transport actor. The adapter **pulls**: it asks the dispatcher for the next job of `jobTypes` at every moment it becomes idle — at start, after each job settles, on a matching `job:queued` while parked, and on reconnect — and parks when told nothing is pending. It surfaces each claimed job on `activeJob$`, and for every one `startWorkerProcess` calls `handleJob → handleJobInner`, which does the actual fetch / process / emit.

A claim the dispatcher refuses for any reason other than an empty queue arrives on `refused$`. `bus.unauthorized` means this credential can never claim — the shipped worker exits on it so the operator sees why, rather than parking forever.

## Built-in Job Types

`JobType` (in `src/types.ts`) enumerates the six types, each dispatched to one processor in `handleJobInner`:

| `jobType` | Processor | Returns |
|-----------|-----------|---------|
| `highlight-annotation` | `processHighlightJob` | `{ result }` (annotations committed per chunk) |
| `comment-annotation` | `processCommentJob` | `{ result }` (annotations committed per chunk) |
| `assessment-annotation` | `processAssessmentJob` | `{ result }` (annotations committed per chunk) |
| `reference-annotation` | `processReferenceJob` | `{ result }` (annotations committed per chunk) |
| `tag-annotation` | `processTagJob` | `{ result }` (annotations committed per chunk) |
| `generation` | `processGenerationJob` | `{ content, title, format, citations, result }` |

The highlight, comment, assessment, and tag processors share one signature shape:

```typescript
process<X>Job(
  content: string,            // prepared by the worker process, not the processor
  inferenceClient: InferenceClient,
  params: <X>DetectionParams,
  buildAnnotation: BuildAnnotation,  // (motivation, match, body?) => Annotation; carries the generator
  onProgress: OnProgress,
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  resumeCursors?: Record<string, UnitCursor>,   // where an earlier attempt left each unit
): Promise<ProcessorResult<Job<X>AnnotationResult>>  // `{ result }` only
```

`processReferenceJob` runs several units (entity types) concurrently, so after `onProgress` it takes `logger`, an `onUnitComplete(entityType)` checkpoint callback, and an abort `signal`, then the optional `onChunkComplete` and `resumeCursors`.

Two things a processor does **not** do. It never returns annotations for the caller to write —
each chunk is committed through `onChunkComplete` as it is produced, so a retry resumes from
the cursor rather than re-running the job (CHUNK-GRAIN-RESUME). And it never sees a user
identity: an annotation states what produced it, and who *requested* it is derived by the
knowledge base from the job the commit cites (VERIFIED-PROVENANCE).

`ProcessorResult<R>` is `{ result: R }`. The annotations a processor commits are W3C Web Annotation objects shaped by the `buildAnnotation` closure it is handed — `buildTextAnnotation` for text, `buildPdfAnnotation` for geometry-bearing media. The text builder enforces a write-time invariant (`content.substring(start, end) === exact`) so a mis-anchored selector throws loudly instead of corrupting the KB.

Generation is the odd one out — it produces *content*, not annotations:

```typescript
processGenerationJob(
  inferenceClient: InferenceClient,
  params: GenerationJobParams,
  onProgress: OnProgress,
  logger: Logger,
): Promise<{
  content: Uint8Array;              // bytes, not a string — the output media type decides
  title: string;
  format: SupportedMediaType;       // validated against the registry's `generatable` types;
                                    // an unsupported request FAILS the job, never falls back
  citations: GenerationCitation[];  // populated only under `cite`; minted as W3C linking
                                    // annotations on the derived resource after upload
  truncated: boolean;               // the model stopped at the maxTokens ceiling: the artifact
                                    // is cut off. The worker states it in the job's result,
                                    // which it builds once the upload has given the resource an id
}>
```

## Where Content Comes From

Annotation processors receive `content` as their first argument — they never fetch it. The **worker process** prepares it inside `handleJobInner` with `prepareDetection`, which returns the text together with the media-appropriate `buildAnnotation`:

```typescript
const source = await prepareDetection(
  mediaType, config.contentReads, resourceId, generator,
  (rid) => session.client.browse.resourceAnchoredText(rid),
);
```

Text media types are read as bytes through `contentReads`; geometry-bearing types such as PDF get the Smelter's canonical anchored text instead. A resource with nothing to detect over completes the job with a `declined` result rather than running a processor.

If you need the resource's text, the worker process hands it to you; if you need something else from the KB, reach for `session.client`.

## How a Worker Emits

Workers emit lifecycle and annotation commands directly on the session's transport. `handleJobInner` does this through a small `emitEvent` helper that wraps `session.client.transport.emit(...)`:

- `job:start` — once, when the job is picked up.
- `job:report-progress` — driven by the processor's `onProgress` callback. The dispatcher stores it as the running job's `progress` and the UI renders it; Stower ignores it.
- `mark:commit` — one **awaited batch per unit of work**: `{ resourceId, annotations }`. This is a `busRequest`, not a fire-and-forget emit — it resolves only after the Stower has appended every annotation to the event log, and only then does the unit count as complete. A job type that minted annotations without waiting for this acknowledgement would silently lose them whenever the persistence sink was down; a census test (`worker-process.test.ts`, "no job type persists without an acknowledgement") fails on any job type that tries.
- `job:checkpoint` — after each committed chunk, carrying the completed units and each unfinished unit's cursor, so a crashed worker's retry resumes instead of re-paying.
- `job:complete` — once, with the processor's `result`, **after** the final commit resolved.
- `job:fail` — on error, with the message, the `failureClass`, and `willRetry`.

The processor itself emits nothing. It calls `onProgress(percentage, message, extra?)`; the worker process turns each call into a `job:report-progress` event.

## Adding a Custom Job Type

Suppose you want a `summary-annotation` job. Three edits, no new classes:

### 1. Add the `JobType`

In `src/types.ts`, extend the union and the `JOB_TYPES` set, and add the params type alongside the existing ones. The spec owns the rest: add the type to `specs/src/components/schemas/JobType.json`, place it in a category in `specs/src/jobs/storage.json`, and add its result schema (with a single-valued `kind`) to the `JobResult` union; the result type is then generated into `@semiont/core`. There is no progress type to add — every job reports `JobProgress`. A new progress message, or a new `kind` on `complete-created`, is a spec change plus client copy.

```typescript
export type JobType =
  | 'reference-annotation' | 'generation' | 'highlight-annotation'
  | 'assessment-annotation' | 'comment-annotation' | 'tag-annotation'
  | 'summary-annotation';

export interface SummaryDetectionParams {
  resourceId: ResourceId;
  instructions?: string;
  language?: string;
}

// Generated from the spec into @semiont/core:
interface JobSummaryAnnotationResult {
  kind: 'summary-annotation';
  summariesFound: number;
  summariesCreated: number;
}
```

### 2. Write the processor

In `src/processors.ts`, add a function that takes content + inference + params, commits what it produces through `onChunkComplete`, and returns `{ result }`. Shape each annotation with the `buildAnnotation` closure it is handed (never `buildTextAnnotation` directly — the closure is what carries this worker's `generator` and the media-appropriate selector), dedupe with `makeSpanDeduper()`, and put detection logic in `AnnotationDetection`:

```typescript
export async function processSummaryJob(
  content: string,
  inferenceClient: InferenceClient,
  params: SummaryDetectionParams,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  resumeCursors?: Record<string, UnitCursor>,
): Promise<ProcessorResult<JobSummaryAnnotationResult>> {
  onProgress(10, { code: 'loading' });
  onProgress(30, { code: 'analyzing' });

  const summaries = await AnnotationDetection.detectSummaries(
    content, inferenceClient, params.instructions, params.language,
  );

  onProgress(60, { code: 'creating-annotations', count: summaries.length });

  const bodyLanguage = params.language ?? 'en';
  const dedupe = makeSpanDeduper();
  const annotations = dedupe(summaries.map((s) =>
    buildAnnotation('summarizing', s, [
      { type: 'TextualBody', value: s.summary, purpose: 'summarizing', format: 'text/plain', language: bodyLanguage },
    ]),
  ));

  // The durability write: awaited, so the cursor never leads the log. A
  // chunking processor calls this once per chunk; a whole-document one, once.
  await onChunkComplete(annotations, { unit: 'whole', cursor: /* where this unit ended */ });

  onProgress(100, { code: 'complete-created', count: annotations.length, kind: 'summary' });

  return {
    result: { kind: 'summary-annotation', summariesFound: summaries.length, summariesCreated: annotations.length },
  };
}
```

Then export it from `src/index.ts` next to the other `process*Job` functions.

### 3. Add a dispatch branch

In `src/worker-process.ts`, add a branch to `handleJobInner`. The branch hands the processor the prepared text, the `buildAnnotation` closure and `commitChunk` — the shared durability write, which commits a chunk and then records its cursor, in that order — and reports completion only after it returns:

```typescript
} else if (jobType === 'summary-annotation') {
  const { result } = await processSummaryJob(
    ready!.text, inferenceClient, asJobParams<SummaryDetectionParams>(job.params),
    ready!.buildAnnotation, onProgress,
    // The durability write, per chunk, awaited. `commitChunk` calls
    // `commitAnnotations(session, resourceId, annotations, jobId)` — the batch
    // CITES the job, which is how the knowledge base derives who requested it —
    // and only then records the unit's cursor. job:complete comes after: a
    // success claim emitted first would report work that may never have persisted.
    commitChunk,
    job.unitCursors,
  );
  await emitEvent(session, 'job:complete', {
    ...terminalBase(),
    result,
  });
  adapter.completeJob();
}
```

Finally, add `'summary-annotation'` to `ALL_JOB_TYPES` in `src/worker-main.ts` so the host actually subscribes to it, and take a position in the persistence census (`worker-process.test.ts`, `JOB_TYPE_COVERAGE` — typed total over `JobType`, so forgetting is a compile error): either an `exercise` entry proving your type commits before completing, or a `coveredBy` pointer to where that is pinned instead. That's the whole extension path — no base class, no lifecycle methods to override.

> Generation jobs follow a different tail: alongside its committed annotations (provenance on the source resource, citations on the derived one — two commits, keyed by resource), the branch uploads the generated content via `session.client.yield.resource(...)` and reports the new `resourceId` on `job:complete`. Mirror an annotation branch unless you're producing a new resource.

## Lifecycle and Failure Handling

You write no claim loop. `startWorkerProcess` owns it:

```
idle (start · settle · wake-up · reconnect)  →  JobClaimAdapter claims by type
  ↓
activeJob$ emits  →  handleJob → handleJobInner
  ↓
emit job:start
  ↓
prepareDetection()  (annotation jobs)
  ↓
process<X>Job(...)  — YOUR LOGIC, reports via onProgress
  ↓ per chunk: await mark:commit (acknowledged)  →  emit job:checkpoint
  ↓ success
emit job:complete  →  adapter.completeJob()

  ↓ error (anything throws)
emit job:fail  →  adapter.failJob(jobId, message)
```

The subscription in `startWorkerProcess` wraps `handleJob` in a `.catch` that emits `job:fail` and calls `adapter.failJob`, so any throw from your processor surfaces as a clean failure. `handleJob` also records an OpenTelemetry span (`job:<type>`) and a job-outcome metric around each run — you get that for free by living inside `handleJobInner`.

At the dispatcher, `job:fail` feeds a retry-or-fail path: the job is re-queued (and re-announced) while `retryCount < maxRetries` — unless the worker classified the failure `deterministic` (truncation at the subdivision floor, unsupported media, non-throttle 4xx), in which case it fails for good at once rather than paying for a retry that cannot succeed. The event's `completedUnits` and `unitCursors` are merged into job metadata so the retry resumes. Your `onProgress` calls double as a heartbeat — a running job that reports nothing within the dispatcher's window is presumed orphaned and recovered the same way, so call `onProgress` at meaningful stages rather than never.

## Reporting Progress

Progress is a callback, not a queue mutation. The worker process hands your processor an `onProgress`:

```typescript
export type OnProgress = (
  percentage: number,
  message: JobProgressMessage,         // a code plus typed params, never a sentence
  extra?: Partial<JobProgress>,        // the other JobProgress fields
) => void;
```

Call it at meaningful stages — the worker process forwards each call as a `job:report-progress` event whose progress is one `JobProgress`, the same shape for every job type:

```typescript
onProgress(10, { code: 'loading' });
onProgress(60, { code: 'creating-annotations', count });
onProgress(100, { code: 'complete-created', count, kind: 'highlight' });
```

The message vocabulary is the spec's `JobProgressMessage`; each client renders the codes in its own language. The third argument carries the other `JobProgress` fields the progress UI renders — `processReferenceJob` passes `current` / `processed` / `total`, `entitiesFound`, `completedItems`, and `requestParams`. Anything describing the run rather than the moment must be passed on every call, because each report replaces the last. Stower ignores progress; the dispatcher stores the latest as the running job's `progress`.

## Testing a Processor

Because processors are pure, you test them with no bus, no session, and no queue. Mock `AnnotationDetection` (the LLM call), feed in content that actually contains your spans (the `buildTextAnnotation` invariant checks `content.substring(start, end) === exact`), and assert on the returned annotations and the `onProgress` calls:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { resourceId, type components } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';

type Agent = components['schemas']['Agent'];

vi.mock('../workers/annotation-detection', () => ({
  AnnotationDetection: { detectSummaries: vi.fn() },
}));

import { AnnotationDetection } from '../workers/annotation-detection';
import { processSummaryJob, buildTextAnnotation } from '../processors';

const RID = resourceId('res-test');
const GENERATOR: Agent = {
  '@type': 'Software',
  '@id': 'did:web:test.local:agents:test:test',
  name: 'test test', provider: 'test', model: 'test',
};
const inferenceClient = { generateText: vi.fn() } as unknown as InferenceClient;

describe('processSummaryJob', () => {
  it('produces summarizing annotations and reports progress', async () => {
    const content = 'an important passage worth summarizing.';
    vi.mocked(AnnotationDetection.detectSummaries).mockResolvedValue([
      { exact: 'important passage', start: 3, end: 20, summary: 'a key point' },
    ]);

    const progress = vi.fn();
    const committed: Annotation[] = [];
    const { result } = await processSummaryJob(
      content, inferenceClient, { resourceId: RID },
      (motivation, match, body) => buildTextAnnotation(content, RID, GENERATOR, motivation, match, body),
      progress,
      async (annotations) => { committed.push(...annotations); },
    );

    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      motivation: 'summarizing',
      target: expect.objectContaining({ source: RID }),
    });
    expect(result).toEqual({ kind: 'summary-annotation', summariesFound: 1, summariesCreated: 1 });
    expect(progress).toHaveBeenLastCalledWith(100, { code: 'complete-created', count: 1, kind: 'summary' });
  });
});
```

To exercise the claim → fetch → process → emit → complete orchestration end to end, test `handleJob` from `worker-process.ts` with a fake adapter and a fake session whose `transport.emit` is a spy — but that's the only place you need to mock the bus. The processor stays pure.
