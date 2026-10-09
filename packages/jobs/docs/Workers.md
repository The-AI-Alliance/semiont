# Workers Guide

A worker serves a single software-agent identity and turns queued jobs into Knowledge Base events; the worker host process runs one for each inference engine it is configured with. It opens an authenticated session, takes a set of jobs, and — whenever it is idle — claims the next pending job among them, reads the resource, runs a **processor**, and emits the results.

Workers are **not** actors. They don't subscribe to a reducer; they claim jobs over the bus and dispatch by what the job is: its type and, for a `mark` job, its motivation. But they emit the same EventBus commands as any other caller in the system. The Archivist's **Stower** handles all persistence to the Knowledge Base — a worker never writes to storage directly.

**See also**: [Job types](./JobTypes.md) for what each job carries, [Failure discipline](./FailureDiscipline.md) for how one fails, and the [worker service](../../../apps/worker/README.md) for running it: its port, its health endpoint, its configuration and its stall watchdog.

## The Processor Model

There is no per-job-type worker class. Adding support for a job type means writing a **pure function** — a processor — and wiring it into the worker process's dispatch. Everything that touches the bus, the session, or the queue lives in shared infrastructure; your code only takes content and parameters and returns annotations.

The moving parts:

| File | Role |
|------|------|
| `src/worker-main.ts` | Standalone entry point. Reads its configuration document, and starts one agent worker for each agent the document lists, all in its own process. |
| `src/worker-config.ts` | The configuration document ([`WorkerConfig`](../../../specs/src/components/schemas/WorkerConfig.json)): where `--config` names it, reading it, and what the worker refuses to start on. It parses no TOML and defaults nothing. |
| `src/worker-runtime.ts` | `startAgentWorker(options)` — signs in as one agent, opens its client, and calls `startWorkerProcess`. |
| `src/worker-process.ts` | `startWorkerProcess(config)` — claims jobs with the SDK's `job.claim`, then `handleJobInner` dispatches by `jobType` and motivation to the right processor, and has the held job commit each batch of annotations (`job.commit`) and say the lifecycle. |
| `src/processors.ts` | The `process*Job` functions. Content + inference + params in, `{ result }` out; annotations go out through the `onChunkComplete` callback as they are produced. No bus, no queue, no I/O except calling inference. |
| `src/workers/annotation-detection.ts` | `AnnotationDetection` — the LLM detection logic the annotation processors call (`detectHighlights`, `detectComments`, `detectAssessments`, `detectTags`). |
| `@semiont/sdk` | `job.claim` — asks the dispatcher for work over the bus and hands out each job the worker comes to hold. A held job says its own lifecycle, commits its own annotations and settles once. The worker never touches the queue itself. |

## How a Worker Runs

`worker-main.ts` is the host. For each agent its configuration document lists (a provider and a model, with the jobs that pair serves), it calls `startAgentWorker` (`src/worker-runtime.ts`), which:

1. Signs in (`startAgentSession`, `@semiont/sdk`): at the knowledge base's issuer as its own service account (`SEMIONT_OIDC_CLIENT_ID` / `SEMIONT_OIDC_CLIENT_SECRET`), then exchanging that token for this agent's at `/api/tokens/agent`. The session keeps the agent's token fresh for as long as the process runs.
2. Builds a `generator` — a W3C `Software` agent record — with `didToAgent(did)`, from the DID that exchange minted. This is sent as each annotation's `generator`; the knowledge base checks its identity against the verified emitter and derives `creator` and `wasAttributedTo` itself, from the job the write cites.
3. Opens a `SemiontClient` (`@semiont/sdk`) signed in *as that agent*, so every event the worker emits is attributed to the agent at the bus seat. Its transport's stream names `WORKER_CHANNELS`: what the claiming names, and the reply channels of what the worker awaits.
4. Calls `startWorkerProcess`:

```typescript
const claims = startWorkerProcess({
  client,                  // SemiontClient, signed in as this agent
  accepts: group.serves,   // the jobs this agent's engine serves, as a claim names them
  inferenceClient: group.client, // the (provider, model) inference client
  generator,               // the Software agent record
  logger,
});
```

`startWorkerProcess` reads the claims `client.job.claim` returns. The claiming **pulls**: it asks the dispatcher for the next job that matches `accepts` at every moment it becomes idle — at start, after each job settles, on a matching `job:queued` while parked, and on reconnect — and parks when told nothing is pending. It surfaces each claimed job on `activeJob$`, and for every one `startWorkerProcess` calls `handleJob → handleJobInner`, which does the actual fetch / process / emit.

A job queued while a worker is busy is claimed at that worker's next settle. The dispatcher also announces pending jobs again at each tick, which covers a wake-up lost on its way to an idle worker. A repeated announcement is harmless: a claim names what it takes and no job, so a worker that finds nothing pending is declined and parks.

An announcement carries the job description less its input: a `mark` job's params whole, and a `yield` job's without its `context`. The claiming checks it against its own claim with `jobMatchesFilter` (`@semiont/core`), the comparison the dispatcher makes, and asks only when it would be handed something.

A claim the dispatcher refuses for any reason other than an empty queue arrives on `refused$`. `bus.unauthorized` means this credential can never claim — the shipped worker exits on it so the operator sees why, rather than parking forever.

A held job that shows no activity for `heldJobStallMs` is reported on `stalled$`, and the shipped worker exits on that too: a wedged worker never settles, so it never claims again.

On `SIGTERM` or `SIGINT` the host stops each agent's claims, which fails a job still held so the queue retries it at once, then disposes its client and closes its health server.

## A Worker Written Outside This Package

The worker's side of the queue is the SDK's, for a worker that is not this one: `client.job.claim({ accepts })` (`@semiont/sdk`), with the jobs to claim, each a `JobFilter`: a partial job description, matched by the dispatcher against each pending job.

```typescript
const claims = client.job.claim({
  accepts: [{ jobType: 'mark', params: { motivation: 'highlighting' } }],
});
claims.refused$.subscribe((refusal) => { /* a claim refused for a reason other than an empty queue */ });
claims.subscribe((job) => { /* held until it is settled */ });
```

A held job says its own lifecycle (`job.start()`, `job.progress(...)`, `job.checkpoint(...)`) and settles once, with `job.complete(result)`, `job.fail(message)` or `job.cancel()`, each of which says the outcome and claims the next job. The [`semiont-worker` skill](../../../docs/builder/skills/semiont-worker/SKILL.md) walks through a complete worker, [Jobs](../../../docs/protocol/JOBS.md) is what the dispatcher does with each message, and the [worker contract](../../../docs/protocol/WORKER-CONTRACT.md) is what a worker promises it.

## Built-in Jobs

`handleJobInner` dispatches each job to one processor: a `mark` job by its motivation (`isHeldMark`), a `yield` job by its type.

| `jobType` | Motivation | Processor | Returns |
|-----------|------------|-----------|---------|
| `mark` | `highlighting` | `processHighlightJob` | `{ result }` (annotations committed per chunk), or `{ cancelled }` |
| `mark` | `commenting` | `processCommentJob` | `{ result }` (annotations committed per chunk), or `{ cancelled }` |
| `mark` | `assessing` | `processAssessmentJob` | `{ result }` (annotations committed per chunk), or `{ cancelled }` |
| `mark` | `linking` | `processReferenceJob` | `{ result }` (annotations committed per chunk), or `{ cancelled }` |
| `mark` | `tagging` | `processTagJob` | `{ result }` (annotations committed per chunk), or `{ cancelled }` |
| `yield` | | `processGenerationJob` | `{ content, title, format, citations, truncated }`, or `{ cancelled: true }` |

The highlighting, commenting, assessing and tagging processors share one signature shape:

```typescript sketch
process<X>Job(
  content: string,            // prepared by the worker process, not the processor
  offsets: TextOffsets,       // the content's conversions (`textOffsets(content)`), made once with it
  inferenceClient: InferenceClient,
  params: HeldMarkParams<M>,         // that motivation's params, with what the dispatcher adds
  buildAnnotation: BuildAnnotation,  // (motivation, match, body?) => Annotation; carries the generator
  onProgress: OnProgress,
  logger: Logger,             // what it reads of a reply, and what it cannot anchor, are log lines
  signal: AbortSignal,        // the held job's cancellation (`job.cancelled`)
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  resumeCursors?: Record<string, UnitCursor>,   // where an earlier attempt left each unit
): Promise<ProcessorResult<JobDetectionResult>>  // `{ result }`: found, persisted, errors; or `{ cancelled }`
```

`processReferenceJob` runs several units (entity types) concurrently, so between `signal` and `onChunkComplete` it takes an `onUnitComplete(entityType)` checkpoint callback. After `resumeCursors` it takes `completedUnits`, the entity types earlier attempts finished: it does not ask about them again, and counts each by its cursor.

**Every job stops for a cancellation**, at its next stopping place and not at once ([WORKER-SERVICE.md § Cancellation](../../../docs/protocol/WORKER-SERVICE.md#cancellation)). A detection stops after the chunk it is on: that chunk is committed and checkpointed, no other is cut, nothing more is reported, and the processor returns `{ cancelled: { completedUnits } }`, the units it had finished. A generation stops once its model has answered, before anything is uploaded. The request to the provider is not aborted when a cancellation arrives, so a cancelled job holds its agent until the model answers or the call's ten-minute bound ends it.

**Every offset counts Unicode code points**: a span's `start` and `end`, a cursor's `next`, and every length worked out from them, as the wire states them ([W3C-SELECTORS.md](../../../docs/protocol/W3C-SELECTORS.md#textpositionselector)). A JavaScript string is indexed in UTF-16 code units, which is another count after the first character outside the Basic Multilingual Plane, so nothing here takes an offset for a string's position. `offsets` is the content's `TextOffsets`, which converts between the two: it is made once, where the content is first held (`prepareDetection`), and handed to every function that cuts, searches or slices the content.

Two things a processor does **not** do. It never returns annotations for the caller to write —
each chunk is committed through `onChunkComplete` as it is produced, so a retry resumes from
the cursor rather than re-running the job. And it never sees a user identity: an annotation
states what produced it, and who *requested* it is derived by the knowledge base from the job
the commit cites.

`ProcessorResult<R>` is `{ result: R }`, or `{ cancelled: { completedUnits } }` for a job a cancellation stopped. The annotations a processor commits are W3C Web Annotation objects shaped by the `buildAnnotation` closure it is handed — `buildTextAnnotation` for text, `buildPdfAnnotation` for geometry-bearing media. Both builders enforce write-time invariants, so a mis-anchored selector throws loudly instead of corrupting the KB: the span's `start` and `end` are two whole numbers inside the text, and its `prefix` and `suffix` are what the text has on either side; the text builder also holds the text from `start` to `end` to be `exact`, and the PDF builder the text its rectangles cover to contain it ([`builder-cases.json`](../../../specs/src/annotations/builder-cases.json)).

Generation is the odd one out — it produces *content*, not annotations:

```typescript
processGenerationJob(
  inferenceClient: InferenceClient,
  params: GenerationJobParams,
  onProgress: OnProgress,
  logger: Logger,
  signal: AbortSignal,              // the held job's cancellation (`job.cancelled`)
): Promise<{ cancelled: true } | {  // cancelled by the time its model had answered: nothing was made
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
  (rid) => client.browse.resourceAnchoredText(rid),
);
```

Text media types are read as bytes through `contentReads`; geometry-bearing types such as PDF get the Smelter's canonical anchored text instead. A resource with nothing to detect over completes the job with a `declined` result rather than running a processor.

If you need the resource's text, the worker process hands it to you; if you need something else from the KB, reach for `config.client`.

## How a Worker Emits

The held job says the lifecycle and commits the annotations, and `handleJobInner` asks it to:

- `job:start` — once, when the job is picked up.
- `job:report-progress` — driven by the processor's `onProgress` callback. The dispatcher stores it as the running job's `progress` and the UI renders it; Stower ignores it.
- `mark:commit` — one **awaited batch per unit of work**: `{ resourceId, annotations, jobId }`, sent by `job.commit(resourceId, annotations)`, which cites the job itself. This is a `busRequest`, not a fire-and-forget emit — it resolves only after the Stower has appended every annotation to the event log, and only then does the unit count as complete. A job type that minted annotations without waiting for this acknowledgement would silently lose them whenever the persistence sink was down; a census test (`worker-process.test.ts`, "no job type persists without an acknowledgement") fails on any job type that tries.
- `browse:annotation-requested` — only when a commit is not acknowledged within `markCommitTimeoutMs`: the held job asks whether the batch's last annotation is on the resource. Answered with it, the commit is established, since a lost acknowledgement is not a lost batch. Otherwise `job.commit` rejects with the failure of its unanswered `mark:commit`, and the job fails.
- `job:checkpoint` — after each committed chunk, carrying the units this attempt completed and the cursor of each unit the job has begun, a finished unit's among them, so a crashed worker's retry resumes instead of re-paying and still counts the whole job.
- `job:complete` — once, with the processor's `result`, **after** the final commit resolved. The held job adds `durability`: the weakest of how its commits were established, `acknowledged` or `probe-confirmed`. A job that committed nothing states none.
- `job:fail` — on error, with the message, the `failureClass`, and `willRetry`. When a commit was not established the held job adds `durability`, what that commit observed: `probe-refused` or `probe-unreachable`.

The processor itself emits nothing. It calls `onProgress(percentage, message, extra?)`; the worker process turns each call into a `job:report-progress` event.

## Adding a Job

Suppose you want a `mark` job for another motivation, `describing`. Three edits, no new classes:

### 1. State the job in the spec

A job description is the spec's, so the job starts there:

- `Motivation.json` lists `describing`.
- `DescribingJobParams.json` states what the job takes, beside the other five: closed, with `motivation` its one value. It joins `MarkJobParams`' members and its mapping, and `specs/src/openapi.json`'s registry.
- `ArchivistRoster.workers.mark` gains the key, so the directory can say who serves it.

`lint:spec-jobs` and the Archivist's gate hold each of those lists to `Motivation`, so a step left out fails. There is no result schema to add: every `mark` job reports a `MarkJobResult`, its counts (`JobDetectionResult`) or a decline. There is no progress type either: every job reports `JobProgress`. `complete-created` states the job's motivation, so each client needs a noun for the new one in its copy. A new progress message is a spec change plus client copy.

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

In `src/processors.ts`, add a function that takes content + inference + params, commits what it produces through `onChunkComplete`, and returns `{ result }`, or `{ cancelled }` when a cancellation stopped it. Shape each annotation with the `buildAnnotation` closure it is handed (never `buildTextAnnotation` directly — the closure is what carries this worker's `generator` and the media-appropriate selector), dedupe with `makeSpanDeduper()`, and put detection logic in `AnnotationDetection`:

```typescript
export async function processDescribeJob(
  content: string,
  offsets: TextOffsets,
  inferenceClient: InferenceClient,
  params: HeldMarkParams<'describing'>,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  logger: Logger,
  signal: AbortSignal,
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  resumeCursors?: Record<string, UnitCursor>,
): Promise<ProcessorResult<JobDetectionResult>> {
  // Cancelled before it began: nothing is asked, and nothing is reported.
  if (signal.aborted) return { cancelled: { completedUnits: [] } };

  onProgress(10, { code: 'loading' });
  onProgress(30, { code: 'analyzing' });

  const bodyLanguage = params.language ?? 'en';
  const dedupe = makeSpanDeduper();
  // Seeded from the cursor, so a resumed job reports the whole document's.
  const prior = resumeCursors?.['describing'];
  let found = prior?.found ?? 0;
  let persisted = prior?.emitted ?? 0;
  let errors = prior?.errors ?? 0;
  let next = prior?.next ?? 0;   // where the walk stands

  // The detection loop stops between chunks once `signal` is aborted.
  await AnnotationDetection.detectDescriptions(
    content, offsets, inferenceClient, logger, signal, params.instructions, params.language, params.sourceLanguage, undefined, prior,
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
      next = cursor.next;
    },
  );

  // A cancelled job reports no completion. Its one unit is finished, and named, when its walk reached the end of the text.
  if (signal.aborted) return { cancelled: { completedUnits: next >= offsets.length ? ['describing'] : [] } };

  onProgress(100, { code: 'complete-created', count: persisted, motivation: params.motivation });

  // `errors` is stated only when something could not be anchored.
  return { result: { found, persisted, ...(errors > 0 ? { errors } : {}) } };
}
```

Then export it from `src/index.ts` next to the other `process*Job` functions.

### 3. Add a dispatch branch

In `src/worker-process.ts`, add a branch to `handleJobInner`. `isHeldMark` says the job is this one and narrows its params. The branch hands the processor the prepared text, its `offsets`, the `buildAnnotation` closure and `commitChunk` — the shared durability write, which commits a chunk and then records its cursor, in that order — and reports completion only after it returns:

```typescript
} else if (job.jobType === 'mark' && isHeldMark(params, 'describing')) {
  return settle(job, await processDescribeJob(
    ready!.text, ready!.offsets, inferenceClient, params,
    ready!.buildAnnotation, onProgress, config.logger, signal,
    // The durability write, per chunk, awaited. `commitChunk` calls
    // `job.commit(resourceId, annotations)` — the batch CITES the job, which
    // is how the knowledge base derives who requested it — and only then
    // records the unit's cursor. job:complete comes after: a
    // success claim emitted first would report work that may never have persisted.
    commitChunk,
    job.unitCursors,
  ));
  // The branch narrowed the job to a `mark` job, so `settle` takes a `mark`
  // job's result: it says job:complete, or job:cancel with the units finished
  // when a cancellation stopped the processor, and releases the job together.
}
```

The host needs no edit: `src/worker-main.ts` walks `MARK_MOTIVATIONS`, so it claims the job once the spec lists the motivation and the config says who serves it (`workers.mark.describing`, else `workers.mark`, else `workers.default`). Finally, take a position in the persistence census (`worker-process.test.ts`, `JOB_TYPE_COVERAGE` — typed total over the jobs a worker runs, so forgetting is a compile error): either an `exercise` entry proving your job commits before completing, or a `coveredBy` pointer to where that is pinned instead. That's the whole extension path — no base class, no lifecycle methods to override.

> A `yield` job follows a different tail: alongside its committed annotations (provenance on the source resource, citations on the derived one — two commits, keyed by resource), the branch uploads the generated content via `client.yield.resource(...)` and reports the new `resourceId` on `job:complete`. Mirror a `mark` branch unless you're producing a new resource.

## Lifecycle and Failure Handling

You write no claim loop. `startWorkerProcess` owns it:

```
idle (start · settle · wake-up · reconnect)  →  job.claim claims the jobs it serves
  ↓
the claims hand out a held job  →  handleJob → handleJobInner
  ↓
job.start()
  ↓
prepareDetection()  (annotation jobs)
  ↓
process<X>Job(...)  — YOUR LOGIC, reports via onProgress
  ↓ per chunk: await job.commit(...) (acknowledged)  →  job.checkpoint(...)
  ↓ success
job.complete(result)   — says job:complete, and the worker claims again

  ↓ a cancellation stopped it (the processor returned `{ cancelled }`)
job.cancel(...)        — says job:cancel, with the units finished, and the worker claims again

  ↓ error (anything throws)
job.fail(message, ...) — says job:fail, with willRetry, and the worker claims again
```

The subscription in `startWorkerProcess` wraps `handleJob` in a `.catch` that fails the held job, so any throw from your processor surfaces as a clean failure. `handleJob` also records an OpenTelemetry span (`job:<type>`) and a job-outcome metric around each run — you get that for free by living inside `handleJobInner`.

At the dispatcher, `job:fail` feeds a retry-or-fail path: the job is re-queued (and re-announced) while `retryCount < maxRetries` — unless the worker classified the failure `deterministic` (truncation at the subdivision floor, unsupported media, a model window too small for the job, a format the worker does not generate, a 4xx other than 408 or 429, a job the worker is not configured for or has no processor for), in which case it fails for good at once rather than paying for a retry that cannot succeed. The event's `completedUnits` and `unitCursors` are merged into job metadata so the retry resumes. Your `onProgress` calls double as a heartbeat — a running job that reports nothing within the dispatcher's window is presumed orphaned and recovered the same way, so call `onProgress` at meaningful stages rather than never.

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
onProgress(100, { code: 'complete-created', count, motivation: params.motivation });
```

The message vocabulary is the spec's `JobProgressMessage`; each client renders the codes in its own language. The third argument carries the other `JobProgress` fields the progress UI renders — `processReferenceJob` passes `current` / `processed` / `total`, `entitiesFound`, `completedItems`, and `requestParams`. Anything describing the run rather than the moment must be passed on every call, because each report replaces the last. Stower ignores progress; the dispatcher stores the latest as the running job's `progress`.

## Testing a Processor

Because processors are pure, you test them with no bus, no session, and no queue. Mock `AnnotationDetection` (the LLM call), feed in content that actually contains your spans (the `buildTextAnnotation` invariant checks that the text from `start` to `end` is `exact`), and assert on the committed annotations and the `onProgress` calls:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { resourceId, textOffsets, type Annotation, type components } from '@semiont/core';
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
    const offsets = textOffsets(content);
    // One chunk: one span anchored in the text, and one proposed that was not.
    vi.mocked(AnnotationDetection.detectDescriptions).mockImplementation(async (...args) => {
      const onChunk = args[args.length - 1] as (m: unknown[], cursor: { next: number; size: number }, dropped: number) => Promise<void>;
      await onChunk([{ exact: 'important passage', start: 3, end: 20, description: 'a key point' }], { next: offsets.length, size: 500 }, 1);
      return [];
    });

    const progress = vi.fn();
    const committed: Annotation[] = [];
    const { result } = await processDescribeJob(
      content, offsets, inferenceClient, { motivation: 'describing', resourceId: RID },
      (motivation, match, body) => buildTextAnnotation(content, offsets, RID, GENERATOR, motivation, match, body),
      progress,
      async (annotations) => { committed.push(...annotations); },
    );

    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      motivation: 'describing',
      target: expect.objectContaining({ source: RID }),
    });
    expect(result).toEqual({ found: 2, persisted: 1, errors: 1 });
    expect(progress).toHaveBeenLastCalledWith(100, { code: 'complete-created', count: 1, motivation: 'describing' });
  });
});
```

To exercise the claim → fetch → process → emit → complete orchestration end to end, test `handleJob` from `worker-process.ts` with a fake client whose `transport.emit` is a spy and answers `job:claim`, so the job it runs is a real held job — but that's the only place you need to mock the bus. The processor stays pure.
