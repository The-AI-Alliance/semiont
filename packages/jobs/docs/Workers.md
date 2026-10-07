# Workers Guide

A worker serves a single software-agent identity and turns queued jobs into Knowledge Base events; the worker host process runs one for each inference engine it is configured with. It opens an authenticated session, takes a set of jobs, and — whenever it is idle — claims the next pending job among them, reads the resource, runs a **processor**, and emits the results.

Workers are **not** actors. They don't subscribe to a reducer; they claim jobs over the bus and dispatch by what the job is: its type and, for a `mark` job, its motivation. But they emit the same EventBus commands as any other caller in the system. The Archivist's **Stower** handles all persistence to the Knowledge Base — a worker never writes to storage directly.

**See also**: [Job types](./JobTypes.md) for what each job carries, [Failure discipline](./FailureDiscipline.md) for how one fails, and the [worker service](../../../apps/worker/README.md) for running it: its port, its health endpoint, its configuration and its stall watchdog.

## The Processor Model

There is no per-job-type worker class. Adding support for a job type means writing a **pure function** — a processor — and wiring it into the worker process's dispatch. Everything that touches the bus, the session, or the queue lives in shared infrastructure; your code only takes content and parameters and returns annotations.

The moving parts:

| File | Role |
|------|------|
| `src/worker-main.ts` | Standalone entry point. Reads `~/.semiontconfig`, groups the jobs it serves by `(provider, model)`, and starts one agent worker per group, all in its own process. |
| `src/worker-runtime.ts` | `startAgentWorker(options)` — authenticates one agent, opens its session, and calls `startWorkerProcess`. |
| `src/worker-process.ts` | `startWorkerProcess(config)` — claims jobs via the `JobClaimAdapter`, then `handleJobInner` dispatches by `jobType` and motivation to the right processor, commits annotations in acknowledged batches (`mark:commit`), and emits the lifecycle events. |
| `src/processors.ts` | The `process*Job` functions. Content + inference + params in, `{ result }` out; annotations go out through the `onChunkComplete` callback as they are produced. No bus, no queue, no I/O except calling inference. |
| `src/workers/annotation-detection.ts` | `AnnotationDetection` — the LLM detection logic the annotation processors call (`detectHighlights`, `detectComments`, `detectAssessments`, `detectTags`). |
| `src/job-claim-adapter.ts` | `JobClaimAdapter` — asks the dispatcher for work over the bus and holds the claimed job. The worker never touches the queue itself. |

## How a Worker Runs

`worker-main.ts` is the host. For each distinct `(inferenceProvider, model)` configured under `[environments.<env>.workers]` in `~/.semiontconfig`, it calls `startAgentWorker` (`src/worker-runtime.ts`), which:

1. Authenticates at the knowledge base's issuer as its own service account (`SEMIONT_OIDC_CLIENT_ID` / `SEMIONT_OIDC_CLIENT_SECRET`), then exchanges that token for this agent's at `/api/tokens/agent`.
2. Builds a `generator` — a W3C `Software` agent record — with `didToAgent(did)`, from the DID that exchange minted. This is sent as each annotation's `generator`; the knowledge base checks its identity against the verified emitter and derives `creator` and `wasAttributedTo` itself, from the job the write cites.
3. Opens a `SemiontSession` (`@semiont/sdk`) authenticated *as that agent*, so every event the worker emits attributes to the agent at the bus seat.
4. Calls `startWorkerProcess`:

```typescript
const adapter = startWorkerProcess({
  session,                 // SemiontSession, authenticated as this agent
  accepts: group.serves,   // the jobs this agent's engine serves, as a claim names them
  inferenceClient: group.client, // the (provider, model) inference client
  generator,               // the Software agent record
  contentReads,            // resource bytes for detection, read from the Archivist
  logger,
});
```

`startWorkerProcess` creates a `JobClaimAdapter` over the session's transport actor. The adapter **pulls**: it asks the dispatcher for the next job that matches `accepts` at every moment it becomes idle — at start, after each job settles, on a matching `job:queued` while parked, and on reconnect — and parks when told nothing is pending. It surfaces each claimed job on `activeJob$`, and for every one `startWorkerProcess` calls `handleJob → handleJobInner`, which does the actual fetch / process / emit.

A job queued while a worker is busy is claimed at that worker's next settle. The dispatcher also announces pending jobs again at each tick, which covers a wake-up lost on its way to an idle worker. A repeated announcement is harmless: a claim names what it takes and no job, so a worker that finds nothing pending is declined and parks.

An announcement carries the job description less its input: a `mark` job's params whole, and a `yield` job's without its `context`. The adapter checks it against its own claim with `jobMatchesFilter` (`@semiont/core`), the comparison the dispatcher makes, and asks only when it would be handed something.

A claim the dispatcher refuses for any reason other than an empty queue arrives on `refused$`. `bus.unauthorized` means this credential can never claim — the shipped worker exits on it so the operator sees why, rather than parking forever.

On `SIGTERM` or `SIGINT` the host disposes each agent's adapter and session, then closes its health server.

## A Worker Written Outside This Package

The claim runtime is exported from the package root, with its types (`JobClaimAdapter`, `JobClaimAdapterOptions`, `ActiveJob`, `ClaimRefusal`, `WorkerVitals`), for a worker that is not this one. It takes a `BusRequestPrimitive` (`@semiont/core`) and the jobs to claim, each a `JobFilter`: a partial job description, matched by the fields it states.

```typescript
import { createJobClaimAdapter } from '@semiont/jobs';

const adapter = createJobClaimAdapter({
  bus: httpTransport.actor,             // HttpTransport's ActorStateUnit
  accepts: [{ jobType: 'mark', params: { motivation: 'highlighting' } }],
});
adapter.activeJob$.subscribe((job) => { /* null between jobs */ });
adapter.refused$.subscribe((refusal) => { /* a claim refused for a reason other than an empty queue */ });
adapter.start();
```

The caller emits the lifecycle events itself and reports each outcome with `adapter.completeJob()` or `adapter.failJob(jobId, message)`, either of which pulls the next job. The [`semiont-worker` skill](../../../docs/builder/skills/semiont-worker/SKILL.md) walks through a complete worker, and [Jobs](../../../docs/protocol/JOBS.md) is the protocol it speaks.

## Built-in Jobs

`handleJobInner` dispatches each job to one processor: a `mark` job by its motivation (`isHeldMark`), a `yield` job by its type.

| `jobType` | Motivation | Processor | Returns |
|-----------|------------|-----------|---------|
| `mark` | `highlighting` | `processHighlightJob` | `{ result }` (annotations committed per chunk) |
| `mark` | `commenting` | `processCommentJob` | `{ result }` (annotations committed per chunk) |
| `mark` | `assessing` | `processAssessmentJob` | `{ result }` (annotations committed per chunk) |
| `mark` | `linking` | `processReferenceJob` | `{ result }` (annotations committed per chunk) |
| `mark` | `tagging` | `processTagJob` | `{ result }` (annotations committed per chunk) |
| `yield` | | `processGenerationJob` | `{ content, title, format, citations, truncated }` |

The highlighting, commenting, assessing and tagging processors share one signature shape:

```typescript sketch
process<X>Job(
  content: string,            // prepared by the worker process, not the processor
  inferenceClient: InferenceClient,
  params: HeldMarkParams<M>,         // that motivation's params, with what the dispatcher adds
  buildAnnotation: BuildAnnotation,  // (motivation, match, body?) => Annotation; carries the generator
  onProgress: OnProgress,
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  resumeCursors?: Record<string, UnitCursor>,   // where an earlier attempt left each unit
): Promise<ProcessorResult<JobDetectionResult>>  // `{ result }` only: found, persisted, errors
```

`processReferenceJob` runs several units (entity types) concurrently, so after `onProgress` it takes `logger`, an `onUnitComplete(entityType)` checkpoint callback, and an abort `signal`, then the optional `onChunkComplete` and `resumeCursors`.

Two things a processor does **not** do. It never returns annotations for the caller to write —
each chunk is committed through `onChunkComplete` as it is produced, so a retry resumes from
the cursor rather than re-running the job. And it never sees a user identity: an annotation
states what produced it, and who *requested* it is derived by the knowledge base from the job
the commit cites.

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
- `mark:commit` — one **awaited batch per unit of work**: `{ resourceId, annotations, jobId }`. This is a `busRequest`, not a fire-and-forget emit — it resolves only after the Stower has appended every annotation to the event log, and only then does the unit count as complete. A job type that minted annotations without waiting for this acknowledgement would silently lose them whenever the persistence sink was down; a census test (`worker-process.test.ts`, "no job type persists without an acknowledgement") fails on any job type that tries.
- `job:checkpoint` — after each committed chunk, carrying the completed units and each unfinished unit's cursor, so a crashed worker's retry resumes instead of re-paying.
- `job:complete` — once, with the processor's `result`, **after** the final commit resolved.
- `job:fail` — on error, with the message, the `failureClass`, and `willRetry`.

The processor itself emits nothing. It calls `onProgress(percentage, message, extra?)`; the worker process turns each call into a `job:report-progress` event.

## Adding a Job

Suppose you want a `mark` job for another motivation, `describing`. Three edits, no new classes:

### 1. State the job in the spec

A job description is the spec's, so the job starts there:

- `Motivation.json` lists `describing`.
- `DescribingJobParams.json` states what the job takes, beside the other five: closed, with `motivation` its one value. It joins `MarkJobParams`' members and its mapping, and `specs/src/openapi.json`'s registry.
- `ArchivistRoster.workers.mark` gains the key, so the directory can say who serves it.

`lint:spec-jobs` and the Archivist's gate hold each of those lists to `Motivation`, so a step left out fails. There is no result schema to add: every `mark` job reports a `MarkJobResult`, its counts (`JobDetectionResult`) or a decline. There is no progress type either: every job reports `JobProgress`. A new progress message, or a new `kind` on `complete-created`, is a spec change plus client copy.

Regenerating gives the worker everything else: the params type, and `MARK_MOTIVATIONS` in `@semiont/core`.

```typescript
// Generated from the spec into @semiont/core:
interface DescribingJobParams {
  motivation: 'describing';
  instructions?: string;
  language?: string;
  sourceLanguage?: string;
}

// What a worker is handed (src/types.ts): those, and what the dispatcher adds.
type Held = HeldMarkParams<'describing'>;   // DescribingJobParams & { resourceId: ResourceId }
```

### 2. Write the processor

In `src/processors.ts`, add a function that takes content + inference + params, commits what it produces through `onChunkComplete`, and returns `{ result }`. Shape each annotation with the `buildAnnotation` closure it is handed (never `buildTextAnnotation` directly — the closure is what carries this worker's `generator` and the media-appropriate selector), dedupe with `makeSpanDeduper()`, and put detection logic in `AnnotationDetection`:

```typescript
export async function processDescribeJob(
  content: string,
  inferenceClient: InferenceClient,
  params: HeldMarkParams<'describing'>,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  resumeCursors?: Record<string, UnitCursor>,
): Promise<ProcessorResult<JobDetectionResult>> {
  onProgress(10, { code: 'loading' });
  onProgress(30, { code: 'analyzing' });

  const bodyLanguage = params.language ?? 'en';
  const dedupe = makeSpanDeduper();
  // Seeded from the cursor, so a resumed job reports the whole document's.
  const prior = resumeCursors?.['describing'];
  let found = prior?.found ?? 0;
  let persisted = prior?.emitted ?? 0;
  let errors = prior?.errors ?? 0;

  await AnnotationDetection.detectDescriptions(
    content, inferenceClient, params.instructions, params.language, params.sourceLanguage, undefined, prior,
    // Each chunk: the spans anchored in the text, and how many proposed ones were not.
    async (matches, cursor, dropped) => {
      found += matches.length + dropped;
      errors += dropped;
      const fresh = dedupe(matches.map((d) =>
        buildAnnotation('describing', d, [
          { type: 'TextualBody', value: d.description, purpose: 'describing', format: 'text/plain', language: bodyLanguage },
        ]),
      ));
      persisted += fresh.length;
      onProgress(60, { code: 'creating-annotations', count: persisted });
      // The durability write: awaited, so the cursor never leads the log. The
      // cursor carries the unit's three tallies with its position.
      await onChunkComplete(fresh, { unit: 'describing', cursor: { ...cursor, found, emitted: persisted, errors } });
    },
  );

  onProgress(100, { code: 'complete-created', count: persisted, kind: 'description' });

  // `errors` is stated only when something could not be anchored.
  return { result: { found, persisted, ...(errors > 0 ? { errors } : {}) } };
}
```

Then export it from `src/index.ts` next to the other `process*Job` functions.

### 3. Add a dispatch branch

In `src/worker-process.ts`, add a branch to `handleJobInner`. `isHeldMark` says the job is this one and narrows its params. The branch hands the processor the prepared text, the `buildAnnotation` closure and `commitChunk` — the shared durability write, which commits a chunk and then records its cursor, in that order — and reports completion only after it returns:

```typescript
} else if (jobType === 'mark' && isHeldMark(params, 'describing')) {
  const { result } = await processDescribeJob(
    ready!.text, inferenceClient, params,
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
    jobType,       // narrowed by the branch: a completion is its verb's
    result,
  });
  adapter.completeJob();
}
```

The host needs no edit: `src/worker-main.ts` walks `MARK_MOTIVATIONS`, so it claims the job once the spec lists the motivation and the config says who serves it (`workers.mark.describing`, else `workers.mark`, else `workers.default`). Finally, take a position in the persistence census (`worker-process.test.ts`, `JOB_TYPE_COVERAGE` — typed total over the jobs a worker runs, so forgetting is a compile error): either an `exercise` entry proving your job commits before completing, or a `coveredBy` pointer to where that is pinned instead. That's the whole extension path — no base class, no lifecycle methods to override.

> A `yield` job follows a different tail: alongside its committed annotations (provenance on the source resource, citations on the derived one — two commits, keyed by resource), the branch uploads the generated content via `session.client.yield.resource(...)` and reports the new `resourceId` on `job:complete`. Mirror a `mark` branch unless you're producing a new resource.

## Lifecycle and Failure Handling

You write no claim loop. `startWorkerProcess` owns it:

```
idle (start · settle · wake-up · reconnect)  →  JobClaimAdapter claims the jobs it serves
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

At the dispatcher, `job:fail` feeds a retry-or-fail path: the job is re-queued (and re-announced) while `retryCount < maxRetries` — unless the worker classified the failure `deterministic` (truncation at the subdivision floor, unsupported media, a 4xx other than 408 or 429), in which case it fails for good at once rather than paying for a retry that cannot succeed. The event's `completedUnits` and `unitCursors` are merged into job metadata so the retry resumes. Your `onProgress` calls double as a heartbeat — a running job that reports nothing within the dispatcher's window is presumed orphaned and recovered the same way, so call `onProgress` at meaningful stages rather than never.

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

Because processors are pure, you test them with no bus, no session, and no queue. Mock `AnnotationDetection` (the LLM call), feed in content that actually contains your spans (the `buildTextAnnotation` invariant checks `content.substring(start, end) === exact`), and assert on the committed annotations and the `onProgress` calls:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { resourceId, type Annotation, type components } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';

type Agent = components['schemas']['Agent'];

vi.mock('../workers/annotation-detection', () => ({
  AnnotationDetection: { detectDescriptions: vi.fn() },
}));

import { AnnotationDetection } from '../workers/annotation-detection';
import { processDescribeJob, buildTextAnnotation } from '../processors';

const RID = resourceId('res-test');
const GENERATOR: Agent = {
  '@type': 'Software',
  '@id': 'did:web:test.local:agents:test:test',
  name: 'test test', provider: 'test', model: 'test',
};
const inferenceClient = { generateText: vi.fn() } as unknown as InferenceClient;

describe('processDescribeJob', () => {
  it('produces describing annotations, counts what was proposed, and reports progress', async () => {
    const content = 'an important passage worth describing.';
    // One chunk: one span anchored in the text, and one proposed that was not.
    vi.mocked(AnnotationDetection.detectDescriptions).mockImplementation(async (...args) => {
      const onChunk = args[args.length - 1] as (m: unknown[], cursor: { next: number; size: number }, dropped: number) => Promise<void>;
      await onChunk([{ exact: 'important passage', start: 3, end: 20, description: 'a key point' }], { next: content.length, size: 500 }, 1);
      return [];
    });

    const progress = vi.fn();
    const committed: Annotation[] = [];
    const { result } = await processDescribeJob(
      content, inferenceClient, { motivation: 'describing', resourceId: RID },
      (motivation, match, body) => buildTextAnnotation(content, RID, GENERATOR, motivation, match, body),
      progress,
      async (annotations) => { committed.push(...annotations); },
    );

    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      motivation: 'describing',
      target: expect.objectContaining({ source: RID }),
    });
    expect(result).toEqual({ found: 2, persisted: 1, errors: 1 });
    expect(progress).toHaveBeenLastCalledWith(100, { code: 'complete-created', count: 1, kind: 'description' });
  });
});
```

To exercise the claim → fetch → process → emit → complete orchestration end to end, test `handleJob` from `worker-process.ts` with a fake adapter and a fake session whose `transport.emit` is a spy — but that's the only place you need to mock the bus. The processor stays pure.
