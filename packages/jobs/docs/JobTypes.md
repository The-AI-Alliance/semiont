# Job Types

What a job is in the worker: what it is asked with, what a worker is handed, and what each job's params, result and progress mean.

The shapes are the spec's, generated into `@semiont/core`: a job's description, its result, a running job's record and its progress. [`src/types.ts`](../src/types.ts) holds only what a worker adds, the type of the params it is handed. This page says what the types cannot.

## A job description

A job is asked for with its `jobType` and the parameters that type takes. `jobType` is the verb that asks: `mark` annotates a resource, `yield` makes one.

| `jobType` | Motivation | Does | Units |
|---|---|---|---|
| `mark` | `highlighting` | Highlights key passages | One |
| `mark` | `commenting` | Writes comments that explain | One |
| `mark` | `assessing` | Writes assessments that evaluate | One |
| `mark` | `linking` | Finds mentions of entities | One per entity type |
| `mark` | `tagging` | Tags passages by their role in a schema | One per category |
| `yield` | | Writes a new resource | None |

A `mark` job's params state its motivation, and each motivation takes its own params and no others (`MarkJobParams`): the gateway refuses a `job:create` that gives a job a parameter it does not take. A `yield` job's are `GenerationJobParams`.

A unit is the grain a job checkpoints at. Its name is the key of `unitCursors`, and a finished one is listed in `completedUnits` and keeps its cursor.

## What a worker is handed

A worker only ever holds a job that is running: the spec's `JobRunning`, in the reply to its claim. Its `metadata`:

| Field | |
|---|---|
| `id`, `type`, `created` | The job, its `jobType`, and when it was created |
| `userId` | Who asked for it: the DID the gateway verified on `job:create`. It is the only identity a job carries |
| `retryCount`, `maxRetries` | The dispatcher sets `maxRetries` when it admits the job: 1 for a `mark` job, 0 for a `yield` job |
| `completedUnits` | The units whose annotations are all committed. A retry skips them, and counts each by its cursor |
| `unitCursors` | The furthest each unit begun got, with the unit's tallies. A retry resumes an unfinished unit from there; a finished unit's is where it ended |

A worker never states who asked. The dispatcher records `userId` as the requester when it accepts a claim, and the knowledge base attributes a write that cites the job from that record.

A `yield` job gets no retry because a second run is a different document, not a replay. A `mark` job reads the same content again, and resumes from its checkpoint.

Its `params` are the description's, and what the dispatcher adds:

- **`resourceId`**, the resource the job is about. A `mark` job's own; for a `yield` job, the one its context focuses on.
- **`schema`**, for a tagging job: the whole tag schema its `schemaId` names. A caller names a schema by id, and the dispatcher resolves it against the knowledge base's tag schemas when it creates the job, so a worker never reads the registry.

The spec names those two additions (`JobParams`) and leaves the rest of the held shape open, so a worker asks which job it holds. `isHeldMark(params, motivation)` answers, and narrows the params to `HeldMarkParams<motivation>`: that motivation's params from the spec, with `resourceId` and, for tagging, `schema`. It is no for a tagging job handed over without its schema, which a worker cannot run.

## Annotation params

| Param | On | |
|---|---|---|
| `entityTypes` | linking | The entity types to look for. At least one |
| `includeDescriptiveReferences` | linking | Also find mentions that are not names: "the senator", "she" |
| `instructions` | highlighting, commenting, assessing | What the person asked for, in their words |
| `density` | highlighting, commenting, assessing | A target count per 2000 words. With none, the instructions decide |
| `tone` | commenting, assessing | The voice of the text written. Each of the two has its own set |
| `schemaId`, `categories` | tagging | The tag schema, and the categories of it to tag. At least one category |
| `language` | all but highlighting | The language annotation text is written in. BCP-47 |
| `sourceLanguage` | all | The language of the resource being read. BCP-47 |

**Two languages.** A German reader annotating an English document sends `language: 'de'` and `sourceLanguage: 'en'`. The first is stamped on each `TextualBody`; the second goes in the prompt so that the model reads the source correctly.

## What a `mark` job reports

One result for every motivation, `JobDetectionResult`:

| Field | |
|---|---|
| `found` | What the model proposed, before anything was checked against the text |
| `persisted` | What the log holds: the annotations committed, after the ones that could not be anchored were dropped and repeats were collapsed |
| `errors` | How many of the proposed could not be anchored in the text. Absent means none |
| `byCategory` | The annotations persisted per category. A tagging job's |
| `underReportedPieces` | The pieces whose extraction was accepted although it was flagged as under-reporting. A linking job's, and absent when there were none |

A result has no field that says which job it answers. `job:complete` carries the `jobType` beside it, and that says which results it may carry: a `mark` job's is these counts or a decline (`MarkJobResult`), a `yield` job's the resource it made or a decline (`YieldJobResult`). The gateway refuses a completion that carries the other verb's. The three results share no member, so a decline is told from the other by `declined`.

The three tallies ride each unit's cursor, so a job that resumes reports the whole document's and not its last attempt's.

## A `yield` job

`GenerationJobParams` is one type, shared with the SDK's `yield.delegate(params)`: what is asked for (`GenerationJobRequest`), and the gathered context it is made from. `title`, `storageUri` and `context` are required.

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

**Ids come from the focus.** A `yield` job's params carry no `referenceId`, and its `job:create` carries no `resourceId`. The context already names its anchor, and a second copy could disagree with it. The dispatcher derives the job's `resourceId` from `context.focus`, and a `job:create` that supplies one is refused. In the worker, `referenceIdOf(job)` is the one derivation:

| `context.focus.kind` | The held job's `annotationId` | What the worker does |
|---|---|---|
| `annotation` | `focus.annotation.id` | Uploads with `sourceAnnotationId`, and the Stower binds that reference to the new resource |
| `resource` | `undefined` | Makes a reference from the source to the new resource |

**The result is built after the upload.** `processGenerationJob` returns the content, its title and format, the citations and `truncated`, or says a cancellation stopped it, and then nothing is uploaded. The worker uploads the content, which gives the resource its id, and only then states `JobGenerationResult` on `job:complete`.

**A cut-off result says so.** `truncated` is true when the model stopped at the `maxTokens` ceiling. It is required on the result and on the final progress report.

## Progress

A running job's `progress` is the last `JobProgress` its worker reported with `job:report-progress`, or `{}` before the first. `JobProgress` requires only `percentage`. Its `message` is a code with typed params (`loading`, `analyzing`, `detecting-entities`, `creating-annotations`, `complete-created` and the rest of the spec's `JobProgressMessage`), which each client renders in its own language.

The other fields are reported by the flows they apply to:

| Field | Reported by |
|---|---|
| `current`, `processed`, `total` | linking (entity types), tagging (categories) |
| `completedItems` | linking, tagging |
| `entitiesFound`, `entitiesEmitted`, `entitiesExpected` | linking |
| `requestParams` | linking, highlighting, commenting and assessing |
| `annotationId` | Any job attached to an annotation, such as a `yield` job from a reference |

A `yield` job reports three times: 5% `generating-resource`, 95% `creating-resource`, and 100% `complete-generated` with `truncated`.

Each report replaces the last, so anything that describes the run rather than the moment is sent every time.
