# Job Types

What a job is in the worker: its state, the six types, and what each one's params, result and progress mean.

The types themselves are in [`src/types.ts`](../src/types.ts). The job-type list, each result, the generation params and the progress shape are the spec's, generated into `@semiont/core`. This page says what the types cannot.

## A job is its state

A job is a union discriminated by `status`, so what it carries follows from the state it is in. Every state has `metadata` and `params`.

| `status` | Also carries |
|---|---|
| `pending` | Nothing more |
| `running` | `startedAt`, `progress` |
| `complete` | `startedAt`, `completedAt`, `result` |
| `failed` | `completedAt`, `error`, and `startedAt` when it had started |
| `cancelled` | `completedAt`, and `startedAt` when it had started |

`Job<P, R>` is that union for one type's params `P` and result `R`. Each job type is an alias of it, `AnyJob` is the union of the six, and `RunningAnyJob` is what a claim returns: a worker only ever holds a job that is running.

Progress is not a type parameter. It has one shape for every job type, and a job that has just been claimed has reported none:

```typescript
import { type AnyJob } from '@semiont/jobs';

function describe(job: AnyJob): string {
  switch (job.status) {
    case 'pending':   return 'waiting';
    case 'running':   return 'percentage' in job.progress ? `${job.progress.percentage}%` : 'started';
    case 'complete':  return 'done';
    case 'failed':    return job.error;
    case 'cancelled': return 'cancelled';
  }
}
```

`isPendingJob`, `isRunningJob`, `isCompleteJob`, `isFailedJob` and `isCancelledJob` narrow the same way.

## Metadata

| Field | |
|---|---|
| `id`, `type`, `created` | The job, its type, and when it was created |
| `userId` | Who asked for it: the DID the gateway verified on `job:create`. It is the only identity a job carries |
| `retryCount`, `maxRetries` | The dispatcher sets `maxRetries` when it admits the job: 1 for the five annotation types, 0 for generation |
| `completedUnits` | The units whose annotations are all committed. A retry skips them |
| `unitCursors` | How far each unfinished unit got. A retry resumes each from there |

A worker never states who asked. The dispatcher records `userId` as the requester when it accepts a claim, and the knowledge base attributes a write that cites the job from that record.

Generation gets no retry because a second run is a different document, not a replay. An annotation pass reads the same content again, and resumes from its checkpoint.

## The six types

| `type` | Does | Params | Result | Units |
|---|---|---|---|---|
| `reference-annotation` | Finds mentions of entities | `DetectionParams` | `JobReferenceAnnotationResult` | One per entity type |
| `highlight-annotation` | Highlights key passages | `HighlightDetectionParams` | `JobHighlightAnnotationResult` | One |
| `comment-annotation` | Writes comments that explain | `CommentDetectionParams` | `JobCommentAnnotationResult` | One |
| `assessment-annotation` | Writes assessments that evaluate | `AssessmentDetectionParams` | `JobAssessmentAnnotationResult` | One |
| `tag-annotation` | Tags passages by their role in a schema | `TagDetectionParams` | `JobTagAnnotationResult` | One per category |
| `generation` | Writes a new resource | `GenerationJobParams & { resourceId }` | `JobGenerationResult` | None |

A unit is the grain a job checkpoints at. Its name is the key of `unitCursors`, and a finished one is listed in `completedUnits`.

Every result carries a `kind` equal to its job type. The annotation results count what was found and what was created; the two differ by what the deduper dropped. The reference result also counts errors, and the pieces whose extraction was accepted although it was flagged as under-reporting.

## Annotation params

Every annotation job names its `resourceId`. The rest:

| Param | On | |
|---|---|---|
| `entityTypes` | reference | The entity types to look for |
| `includeDescriptiveReferences` | reference | Also find mentions that are not names: "the senator", "she" |
| `instructions` | highlight, comment, assessment | What the person asked for, in their words |
| `density` | highlight, comment, assessment | A target count per 2000 words. With none, the instructions decide |
| `tone` | comment, assessment | The voice of the text written. Each of the two has its own set |
| `schema`, `categories` | tag | The whole tag schema, and the categories of it to tag |
| `language` | all but highlight | The language annotation text is written in. BCP-47 |
| `sourceLanguage` | all | The language of the resource being read. BCP-47 |

**Two languages.** A German reader annotating an English document sends `language: 'de'` and `sourceLanguage: 'en'`. The first is stamped on each `TextualBody`; the second goes in the prompt so that the model reads the source correctly.

**A tag job carries its schema.** A caller names a schema by id. The dispatcher resolves it against the knowledge base's tag schemas when it creates the job and puts the whole schema in the params, so a worker never reads the registry.

## Generation

`GenerationJobParams` is one type, shared with the SDK's `yield.fromContext(context, options)`: the params are the options plus the gathered context. `title`, `storageUri` and `context` are required.

| Param | |
|---|---|
| `title` | The new resource's title, and the topic the model is given |
| `storageUri` | Where the content is written. The worker writes exactly there |
| `context` | The gathered context the generation is grounded in. Its focus names the anchor |
| `task` | What to produce: `resource`, `answer` or `summary`. Any other text is used as the framing itself, and the worker warns |
| `prompt` | A refining instruction, given beside the task |
| `structure` | How the output is shaped: `prose`, `sections` or `chat`. Any other text becomes an "organize the output as" line, and the worker warns. With none, there is no directive at all |
| `outputMediaType` | `text/markdown` unless stated. A type the media-type registry does not mark `generatable` fails the job. There is no fallback |
| `cite` | The model marks each claim with the id of what supports it. The worker checks each id against the context, removes the marks, and makes a linking annotation on the new resource for each |
| `maxTokens` | Length only. It never implies structure |
| `entityTypes`, `language`, `sourceLanguage`, `temperature` | The new resource's entity types, the two languages, and the sampling temperature |

**Ids come from the focus.** Generation params carry no `referenceId`, and `job:create` carries no `resourceId`. The context already names its anchor, and a second copy could disagree with it. The dispatcher derives the job's `resourceId` from `context.focus` and refuses one a caller supplies. In the worker, `referenceIdOf(job)` is the one derivation:

| `context.focus.kind` | `referenceIdOf(job)` | What the worker does |
|---|---|---|
| `annotation` | `focus.annotation.id` | Uploads with `sourceAnnotationId`, and the Stower binds that reference to the new resource |
| `resource` | `undefined` | Makes a reference from the source to the new resource |

**The result is built after the upload.** `processGenerationJob` returns the content, its title and format, the citations and `truncated`. The worker uploads the content, which gives the resource its id, and only then states `JobGenerationResult` on `job:complete`.

**A cut-off result says so.** `truncated` is true when the model stopped at the `maxTokens` ceiling. It is required on the result and on the final progress report.

## Progress

A running job's `progress` is the last `JobProgress` its worker reported with `job:report-progress`, or `{}` before the first. `JobProgress` requires only `percentage`. Its `message` is a code with typed params (`loading`, `analyzing`, `detecting-entities`, `creating-annotations`, `complete-created` and the rest of the spec's `JobProgressMessage`), which each client renders in its own language.

The other fields are reported by the flows they apply to:

| Field | Reported by |
|---|---|
| `current`, `processed`, `total` | `reference-annotation` (entity types), `tag-annotation` (categories) |
| `completedItems` | `reference-annotation`, `tag-annotation` |
| `entitiesFound`, `entitiesEmitted`, `entitiesExpected` | `reference-annotation` |
| `requestParams` | `reference-annotation`, and the highlight, comment and assessment flows |
| `annotationId` | Any job attached to an annotation, such as a generation from a reference |

Generation reports three times: 5% `generating-resource`, 95% `creating-resource`, and 100% `complete-generated` with `truncated`.

Each report replaces the last, so anything that describes the run rather than the moment is sent every time.
