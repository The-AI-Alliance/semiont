# Workers Guide

A worker is a standalone process that serves a single software-agent identity and turns queued jobs into Knowledge Base events. It opens an authenticated session, subscribes to a set of job types, and — whenever the bus announces a `job:queued` it is eligible to claim — fetches the resource, runs a **processor**, and emits the results.

Workers are **not** actors. They don't subscribe to a reducer; they claim jobs over the bus and dispatch by job type. But they emit the same EventBus commands as any other caller in the system. The **Stower** actor (in `@semiont/make-meaning`) handles all persistence to the Knowledge Base — a worker never writes to storage directly.

**See also**: [Type System Guide](./TYPES.md) for job state architecture and type narrowing patterns.

## The Processor Model

There is no per-job-type worker class. Adding support for a job type means writing a **pure function** — a processor — and wiring it into the worker process's dispatch. Everything that touches the bus, the session, or the queue lives in shared infrastructure; your code only takes content and parameters and returns annotations.

The moving parts:

| File | Role |
|------|------|
| `src/worker-main.ts` | Standalone entry point. Reads `~/.semiontconfig`, groups job types by `(provider, model)`, authenticates each agent, and starts one worker process per agent group. |
| `src/worker-process.ts` | `startWorkerProcess(config)` — claims jobs via the `JobClaimAdapter`, then `handleJobInner` dispatches by `jobType` to the right processor and emits lifecycle + `mark:create` events. |
| `src/processors.ts` | The `process*Job` functions. Pure: content + inference + params in, `{ annotations, result }` out. No bus, no queue, no I/O except calling inference. |
| `src/workers/annotation-detection.ts` | `AnnotationDetection` — the LLM detection logic the annotation processors call (`detectHighlights`, `detectComments`, `detectAssessments`, `detectTags`). |
| `src/fs-job-queue.ts` | `FsJobQueue` — the filesystem-backed queue jobs are claimed from. |

## How a Worker Runs

`worker-main.ts` is the host. For each distinct `(inferenceProvider, model)` configured under `[environments.<env>.workers]` in `~/.semiontconfig`, it:

1. Authenticates that agent against `/api/tokens/agent` (using `SEMIONT_WORKER_SECRET`).
2. Builds a `generator` — a W3C `Software` agent record — with `softwareToAgent({ domain, provider, model })`. This is stamped onto every annotation as `generator` and onto generated resources as `wasAttributedTo`.
3. Opens a `SemiontSession` (`@semiont/sdk`) authenticated *as that agent*, so every event the worker emits attributes to the agent at the bus seat.
4. Calls `startWorkerProcess`:

```typescript
const adapter = startWorkerProcess({
  session,                 // SemiontSession, authenticated as this agent
  jobTypes: group.jobTypes,// the job types this agent's engine serves
  inferenceClient,         // the (provider, model) inference client
  generator,               // the Software agent record
  logger,
});
```

`startWorkerProcess` creates a `JobClaimAdapter` over the session's transport actor. The adapter subscribes to the SSE `job:queued` stream, claims jobs whose `jobType` is in `jobTypes`, and surfaces each claimed job on `activeJob$`. For every claimed job, `startWorkerProcess` calls `handleJob → handleJobInner`, which does the actual fetch / process / emit.

## Built-in Job Types

`JobType` (in `src/types.ts`) enumerates the six types, each dispatched to one processor in `handleJobInner`:

| `jobType` | Processor | Returns |
|-----------|-----------|---------|
| `highlight-annotation` | `processHighlightJob` | `{ annotations, result }` |
| `comment-annotation` | `processCommentJob` | `{ annotations, result }` |
| `assessment-annotation` | `processAssessmentJob` | `{ annotations, result }` |
| `reference-annotation` | `processReferenceJob` | `{ annotations, result }` |
| `tag-annotation` | `processTagJob` | `{ annotations, result }` |
| `generation` | `processGenerationJob` | `{ content, title, format, result }` |

The five annotation processors share the same signature shape:

```typescript
process<X>Job(
  content: string,            // fetched by the worker process, not the processor
  inferenceClient: InferenceClient,
  params: <X>DetectionParams,
  userId: string,             // DID of the human who initiated the work
  generator: Agent,           // the agent stamped as `generator`
  onProgress: OnProgress,
  logger?: Logger,            // processReferenceJob takes this; others don't
): Promise<ProcessorResult<<X>DetectionResult>>
```

`ProcessorResult<R>` is `{ annotations: Record<string, unknown>[]; result: R }`. The annotations are W3C Web Annotation objects built by the processor's internal `buildTextAnnotation` helper, which enforces a write-time invariant (`content.substring(start, end) === exact`) so a mis-anchored selector throws loudly instead of corrupting the KB.

Generation is the odd one out — it produces *content*, not annotations:

```typescript
processGenerationJob(
  inferenceClient: InferenceClient,
  params: GenerationParams,
  onProgress: OnProgress,
  logger: Logger,
): Promise<{ content: string; title: string; format: string; result: GenerationResult }>
```

## Where Content Comes From

Annotation processors receive `content` as their first argument — they never fetch it. The **worker process** fetches it, inside `handleJobInner`:

```typescript
const fetchContent = async (): Promise<string> => {
  return session.client.browse.resourceContent(resourceId);
};
```

If you need the resource's text, the worker process hands it to you; if you need something else from the KB, reach for `session.client`.

## How a Worker Emits

Workers emit lifecycle and annotation commands directly on the session's transport. `handleJobInner` does this through a small `emitEvent` helper that wraps `session.client.transport.emit(...)`:

- `job:start` — once, when the job is picked up.
- `job:report-progress` — driven by the processor's `onProgress` callback (ephemeral; Stower ignores it, the UI renders it).
- `mark:create` — one per produced annotation: `{ annotation, userId, resourceId }`.
- `job:complete` — once, with the processor's `result`.
- `job:fail` — on error, with the message.

The processor itself emits nothing. It calls `onProgress(percentage, message, stage, extra?)`; the worker process turns each call into a `job:report-progress` event.

## Adding a Custom Job Type

Suppose you want a `summary-annotation` job. Three edits, no new classes:

### 1. Add the `JobType`

In `src/types.ts`, extend the union and add the params / result / progress shapes alongside the existing ones:

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

export interface SummaryDetectionResult {
  summariesFound: number;
  summariesCreated: number;
}
```

### 2. Write the processor

In `src/processors.ts`, add a pure function that takes content + inference + params and returns `{ annotations, result }`. Lean on the existing helpers (`buildTextAnnotation`, `dedupeAnnotations`) and put detection logic in `AnnotationDetection`:

```typescript
export async function processSummaryJob(
  content: string,
  inferenceClient: InferenceClient,
  params: SummaryDetectionParams,
  userId: string,
  generator: Agent,
  onProgress: OnProgress,
): Promise<ProcessorResult<SummaryDetectionResult>> {
  onProgress(10, 'Loading resource...', 'analyzing');
  onProgress(30, 'Analyzing text...', 'analyzing');

  const summaries = await AnnotationDetection.detectSummaries(
    content, inferenceClient, params.instructions, params.language,
  );

  onProgress(60, `Creating ${summaries.length} annotations...`, 'creating');

  const bodyLanguage = params.language ?? 'en';
  const annotations = dedupeAnnotations(summaries.map((s) =>
    buildTextAnnotation(content, params.resourceId, userId, generator, 'summarizing', s, [
      { type: 'TextualBody', value: s.summary, purpose: 'summarizing', format: 'text/plain', language: bodyLanguage },
    ]),
  ));

  onProgress(100, `Complete! Created ${annotations.length} summaries`, 'creating');

  return {
    annotations,
    result: { summariesFound: summaries.length, summariesCreated: annotations.length },
  };
}
```

Then export it from `src/index.ts` next to the other `process*Job` functions.

### 3. Add a dispatch branch

In `src/worker-process.ts`, add a branch to `handleJobInner`. The branch fetches content, calls the processor, emits one `mark:create` per annotation, then `job:complete`:

```typescript
} else if (jobType === 'summary-annotation') {
  const content = await fetchContent();
  const { annotations, result } = await processSummaryJob(
    content, inferenceClient, job.params as never, userId, generator, onProgress,
  );
  for (const ann of annotations) {
    await emitEvent(session, 'mark:create', { annotation: ann, userId, resourceId });
  }
  await emitEvent(session, 'job:complete', {
    ...lifecycleBase,
    result: result as never,
  });
  adapter.completeJob();

}
```

Finally, add `'summary-annotation'` to `ALL_JOB_TYPES` in `src/worker-main.ts` so the host actually subscribes to it. That's the whole extension path — no base class, no lifecycle methods to override.

> Generation jobs follow a different tail: instead of emitting `mark:create`, the branch uploads the generated content via `session.client.yield.resource(...)` and reports the new `resourceId` on `job:complete`. Mirror an annotation branch unless you're producing a new resource.

## Lifecycle and Failure Handling

You don't write a polling loop. `startWorkerProcess` owns it:

```
job:queued (SSE)  →  JobClaimAdapter claims a matching job
  ↓
activeJob$ emits  →  handleJob → handleJobInner
  ↓
emit job:start
  ↓
fetchContent()  (annotation jobs)
  ↓
process<X>Job(...)  — YOUR LOGIC, reports via onProgress
  ↓ success
emit mark:create (×N)  →  emit job:complete  →  adapter.completeJob()

  ↓ error (anything throws)
emit job:fail  →  adapter.failJob(jobId, message)
```

The subscription in `startWorkerProcess` wraps `handleJob` in a `.catch` that emits `job:fail` and calls `adapter.failJob`, so any throw from your processor surfaces as a clean failure. `handleJob` also records an OpenTelemetry span (`job:<type>`) and a job-outcome metric around each run — you get that for free by living inside `handleJobInner`.

## Reporting Progress

Progress is a callback, not a queue mutation. The worker process hands your processor an `onProgress`:

```typescript
export type OnProgress = (
  percentage: number,
  message: string,
  stage: string,
  extra?: Partial<JobProgress>,        // job-type-specific UI fields
) => void;
```

Call it at meaningful stages — the worker process forwards each call as a `job:report-progress` event:

```typescript
onProgress(10, 'Loading resource...', 'analyzing');
onProgress(60, `Creating ${count} annotations...`, 'creating');
onProgress(100, `Complete! Created ${count} summaries`, 'creating');
```

The fourth argument carries extra fields the progress UI renders (e.g. `processReferenceJob` passes `currentEntityType`, `completedEntityTypes`, `requestParams`). Progress events are ephemeral — Stower ignores them.

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
import { processSummaryJob } from '../processors';

const RID = resourceId('res-test');
const USER_DID = 'did:web:test.local:users:alice%40test.local';
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
    const result = await processSummaryJob(
      content, inferenceClient, { resourceId: RID }, USER_DID, GENERATOR, progress,
    );

    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]).toMatchObject({
      motivation: 'summarizing',
      target: expect.objectContaining({ source: RID }),
    });
    expect(result.result).toEqual({ summariesFound: 1, summariesCreated: 1 });
    expect(progress).toHaveBeenLastCalledWith(100, expect.stringContaining('1 summaries'), 'creating');
  });
});
```

To exercise the claim → fetch → process → emit → complete orchestration end to end, test `handleJob` from `worker-process.ts` with a fake adapter and a fake session whose `transport.emit` is a spy — but that's the only place you need to mock the bus. The processor stays pure.

## Testing the Queue

`FsJobQueue` is filesystem-backed, so its tests build a throwaway `SemiontProject` over a temp directory. The constructor is `(project, logger, eventBus?)` — there is no `dataDir` option:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FsJobQueue } from '@semiont/jobs';
import { SemiontProject } from '@semiont/core/node';
import { EventBus } from '@semiont/core';

const mockLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

describe('FsJobQueue', () => {
  let tempDir: string;
  let project: SemiontProject;
  let queue: FsJobQueue;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-queue-test-'));
    project = new SemiontProject(tempDir);
    queue = new FsJobQueue(project, mockLogger, new EventBus());
    await queue.initialize();
  });

  afterEach(async () => {
    queue.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('claims a pending job', async () => {
    // create a pending job, then poll it back out…
  });
});
```

`project.jobsDir` (under the project's XDG state dir) is where the queue lays out its `pending` / `running` / `complete` / `failed` / `cancelled` directories.
