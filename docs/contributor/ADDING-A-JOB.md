# Adding a kind of job

A **job** is one of the protocol's [eight verbs](../protocol/README.md#the-eight-verbs) handed to an agent: asked for with parameters, and done by whoever claims it. A job description is its `jobType`, which is the verb, and the params that verb takes. Two verbs can be handed over today. A `mark` job annotates a resource for one motivation (`highlighting`, `commenting`, `assessing`, `linking` or `tagging`), and a `yield` job makes a resource.

So adding a kind of job adds something a verb can be asked to do. It adds no verb, no channel and no service. The `job:*` channels carry every job, the dispatcher queues every job, and a worker claims by a filter over the same description ([JOBS.md](../protocol/JOBS.md)). This page is the path of that change through the repository: each step, the file it is made in, and what fails when it is left out.

It is not how to write a worker. A worker of your own that serves a job the protocol already has changes nothing here. The [`semiont-worker` skill](../builder/skills/semiont-worker/SKILL.md) builds one in TypeScript, in Rust and in Python, and tests hold what it shows: its TypeScript is type-checked against the built packages, and its Rust and its Python are, word for word, programs that tests run.

The steps add a `mark` job of a new motivation, which is the usual case. Each was followed through the tree for one job that exists, **tagging**, the one that touches the most: params of its own, something the dispatcher adds to it, a unit for each category, progress codes of its own, and a member of the result. [A job of another verb](#a-job-of-another-verb) says what more a new `jobType` takes.

## The path

| | Step | Where | What fails when it is left out |
|---|---|---|---|
| 1 | [State the job](#1-state-the-job-in-the-spec) | `specs/src/components/schemas`, `specs/src/openapi.json`, `specs/src/service-telemetry/telemetry.json` | `npm run lint:spec-jobs`, `npm run lint:spec-archivist`; `tests/conformance/worker-service/telemetry.test.ts` |
| 2 | [Regenerate the types](#2-regenerate-the-types) | `packages/typescript/core`, `packages/go/sdk`, `packages/python/sdk` | CI's `generated-artifacts` job |
| 3 | [Admit it](#3-admit-it-the-dispatcher) | `images/dispatcher/handlers/src/admission.rs` | the dispatcher's build; `tests/conformance/dispatcher/create.test.ts` |
| 4 | [Do it](#4-do-it-the-worker) | `images/worker/src/semiont_worker` | `mypy`, `pyright` and `pytest` in `images/worker` |
| 5 | [State how its reply is read](#5-state-how-its-reply-is-read) | `specs/src/worker/parser-cases.json` | `images/worker/tests/test_parser_cases.py`; `npm run lint:spec-case-tables` |
| 6 | [Hold a Worker service to it](#6-hold-a-worker-service-to-it) | `tests/conformance/worker-service` | `npm run lint:conformance-readmes`, `npm run lint:transport-contract`; `images/worker/tests/test_prompts.py` |
| 7 | [Write the rule](#7-write-the-rule) | `docs/protocol/WORKER-SERVICE.md` | `npm run lint:transport-contract` |
| 8 | [Give it an engine](#8-give-it-an-engine) | a knowledge base's Inference document; nothing in the launcher | `TestEveryEngineJobHasAFilter`, in `packages/go/launcher` |
| 9 | [Word it in each client](#9-word-it-in-each-client) | `packages/go/launcher/verbs/mark.go`, `packages/typescript/react-ui/translations` | `TestEveryMotivationHasItsNoun`; `delegate-progress-copy.test.ts`; `npm run lint:translations` |

The numbers are the order the change reaches each part, and not the order to write it in. The repository works test first: step 5's cases and step 6's case are written before step 4's code, and each is seen to fail for the missing job.

## 1. State the job in the spec

A job description is the spec's, so the job starts there, in [`specs/src/components/schemas`](../../specs/src/components/schemas):

- [`Motivation.json`](../../specs/src/components/schemas/Motivation.json) lists the motivation.
- A schema states what the job takes, beside the other five, as [`TaggingJobParams.json`](../../specs/src/components/schemas/TaggingJobParams.json) does: closed, with `motivation` required and of its one value.
- [`MarkJobParams.json`](../../specs/src/components/schemas/MarkJobParams.json) gains it as a member and in its mapping, and [`specs/src/openapi.json`](../../specs/src/openapi.json) names it among its `components.schemas`.
- [`ArchivistEngines.json`](../../specs/src/components/schemas/ArchivistEngines.json) gains the motivation under `jobs.mark`, so that a knowledge base can say which engine software does the job with.

`npm run lint:spec-jobs` holds `MarkJobParams` to `Motivation`: its members are the schemas its mapping names, the mapping names one for each motivation and for nothing else, each member's `motivation` is the one value that selects it, and each member is closed. `npm run lint:spec-archivist` holds the engines' motivations to the same list. A step left out fails one of the two.

What the job needs no schema of its own for:

- **A result.** Every `mark` job completes with a [`MarkJobResult`](../../specs/src/components/schemas/MarkJobResult.json): its counts ([`MarkJobDone`](../../specs/src/components/schemas/MarkJobDone.json)) or a decline. A count only one job has is an optional member of the counts, as tagging's `byCategory` is.
- **Progress.** Every job reports one shape, [`JobProgress`](../../specs/src/components/schemas/JobProgress.json), whose `message` is a code with its values and never a sentence ([`JobProgressMessage`](../../specs/src/components/schemas/JobProgressMessage.json)). A job's last report, `complete-created`, states its motivation. A code of the job's own, as tagging's `analyzing-tags` and `creating-tag-annotations` are, is a member added to that union, and words for it in each client ([step 9](#9-word-it-in-each-client)).
- **A filter.** A claim names `mark` jobs by motivation ([`MarkJobFilter`](../../specs/src/components/schemas/MarkJobFilter.json)), and the motivation there is `Motivation`.

What the dispatcher adds to a job it hands over is stated in [`JobParams.json`](../../specs/src/components/schemas/JobParams.json): the job's `resourceId`, and for a tagging job `schema`, the tag schema its `schemaId` names. Something added for the new job is a property there.

The worker's telemetry is the spec's too. [`specs/src/service-telemetry/telemetry.json`](../../specs/src/service-telemetry/telemetry.json) lists the values of `job.motivation` on the worker's three rows of a job, and of `detection.label` on its rows of a detection, where the label is the worker's own word for the kind (`tag`). The Worker service's suite holds the first to `MarkJobParams` (`telemetry.test.ts`), and the worker's tests the second to the labels its code has (`images/worker/tests/test_chunk_plan.py`).

## 2. Regenerate the types

No language's types of the protocol are written by hand. The spec is bundled first, `npm run openapi:bundle`, and then:

| Language | How | What it writes |
|---|---|---|
| TypeScript | `npm run generate:openapi --workspace=@semiont/core`, then `npm run build --workspace=@semiont/core` | `@semiont/core`'s types, and with the build `MARK_MOTIVATIONS`, the list a client words its copy by |
| Go | `go generate ./...` in `packages/go/sdk` | [`api/client_gen.go`](../../packages/go/sdk/api/client_gen.go), which is committed |
| Python | `uv run --project packages/python/sdk --locked python packages/python/sdk/scripts/generate_models.py` | [`types.py`](../../packages/python/sdk/src/semiont/types.py), which is committed |
| Rust | nothing to run | `semiont::types`, made from `specs/src` by the SDK's build script when the crate is built |

CI's `generated-artifacts` job fails on a committed file that is not what the spec generates ([Testing](TESTING.md#continuous-integration)).

In the TypeScript, the Rust and the Python SDK, `mark.delegate` takes a `MarkJobParams`, so a caller can ask for the new job as soon as the types have it. No SDK method is written for a motivation.

## 3. Admit it: the dispatcher

`admit`, in [`images/dispatcher/handlers/src/admission.rs`](../../images/dispatcher/handlers/src/admission.rs), matches every member of `MarkJobParams`. A new member does not build until admission says what it checks for that job and what it adds. For a tagging job it reads the knowledge base's tag schemas, refuses a `schemaId` that names none of them, and adds the schema to the job it will hand over, so that a worker needs no registry. A job with nothing to check joins the members that add nothing.

The retry budget is set there too, by the verb: one retry for a `mark` job, which reads the same text again and takes up where its checkpoint left it, and none for a `yield` job, of which a second run would be another document.

[JOBS.md § `job:create`](../protocol/JOBS.md#jobcreate) states each check and its refusal, and the dispatcher's suite holds a dispatcher to them (`tests/conformance/dispatcher/create.test.ts`).

## 4. Do it: the worker

The Worker service is Python, in [`images/worker/src/semiont_worker`](../../images/worker/src/semiont_worker). Each module says at its head what it is. The ones a kind of job passes through:

| Module | What it is |
|---|---|
| `agent.py` | The service's one agent: it signs in once, and for each engine of its document claims the jobs that entry names and runs each job it is handed |
| `held_job.py` | One held job from its claim to its settle: it reads what the job needs, runs the job's processor, commits each piece and checkpoints it, and completes, cancels or fails the job |
| `held_params.py` | Which job was handed over: the params as the spec's shape for their motivation |
| `processors.py` | One processor for each kind of job, each doing one job from start to end |
| `detection/` | What a `mark` job does: the text it reads (`prepare_detection.py`), what it says to its model (`prompts.py`), what it reads of the reply (`parsers.py`), and the walk over the text's pieces (`annotation_detection.py`, `entity_extractor.py`, `chunk_plan.py`) |
| `generation/` | What a `yield` job does |
| `failure_class.py` | The class a failure is reported in |
| `telemetry.py` | The worker's rows of the telemetry table |

There is no class for a kind of job, and nothing to register. A new `mark` job is these, each as tagging has it:

- **Which job was handed over.** `HeldMark` in `held_params.py` gains the generated params type, and `held_mark` answers it. A job that cannot be run without what the dispatcher adds is a type of its own that carries both, as `HeldTagging` carries the schema. `images/worker/tests/test_held_params.py` fails until every motivation the spec has is answered.
- **The detection.** A prompt in `detection/prompts.py`, the element a reply is an array of and its reader in `detection/parsers.py`, and a function in `detection/annotation_detection.py` that asks about the text a piece at a time. The cutting of pieces, the budget, the halving of a piece whose answer cannot be used and the bound on a call are shared, and a new job writes none of them. `DetectionLabel` in `telemetry.py` gains the job's label.
- **The processor,** in `processors.py`, as `process_tag_job` is.
- **The branch.** `_detect` in `held_job.py` hands each kind to its processor. It ends in `assert_never`, so `mypy` and `pyright` fail a kind that has no branch.

A processor reads nothing and sends nothing itself. It is handed the text, a provider, the job's description, and what it needs of whoever holds the job, and every processor keeps to the same few things:

- **It commits a piece at a time, and never answers annotations for someone else to write.** Each piece's annotations go to `on_chunk_complete` with the cursor that piece leaves its unit at. That call is awaited, and nothing of the piece is counted until it returns, so a cursor never states more than the record holds and a later attempt takes the unit up where it stood.
- **It builds an annotation only with `build_annotation`.** The builder it is handed knows the resource, the agent, and how a span is anchored for the resource's media type, and refuses a span that is not the text's. The body is the processor's to give, one body or a list of them, as the spec states one ([`AnnotationBodies`](../../specs/src/components/schemas/AnnotationBodies.json)). An annotation's `id` is worked out from what it is, so the same span found twice is one annotation.
- **It names its units.** A unit is the grain a job checkpoints at: the job's motivation for a job of one unit, an entity type for linking, a category for tagging. Its counts begin at the cursor the job was claimed with, so a resumed job's result is the whole text's.
- **It stops for a cancellation after the piece it is on,** answers the units it had finished, and reports nothing more.
- **It reports with `on_progress`,** which is not awaited: a percentage and a code. What describes the whole job is said again in every report, because whoever follows a job holds only the last one.
- **It never states who asked.** An annotation says what made it. Who asked for the job is the record's to say, from the job a commit cites.
- **What stops it is raised.** Whatever a processor raises fails the job, and a `DeterministicJobError` fails it as a failure no second attempt can mend.

A processor is tested with no bus, no session and no queue: `images/worker/tests/test_processors.py` calls each one with the detection stood in for (`images/worker/tests/standing_in.py`) and holds what it hands over to be committed, what it reports and what it answers. `images/worker/tests/test_detection.py` holds a detection over a text, and `images/worker/tests/test_cancellation.py` where a job stops. [Testing § Python](TESTING.md#python) is how they are run.

## 5. State how its reply is read

What a worker does to a text and to a model's reply is stated in tables every worker runs, in whatever language it is written. A new `mark` job adds its cases to [`specs/src/worker/parser-cases.json`](../../specs/src/worker/parser-cases.json): for one reply to one piece, what is read of it, what is passed over, and what is refused. Its runner, `images/worker/tests/test_parser_cases.py`, reads a case by its `motivation` and fails on one it cannot read.

The tables beside it hold what every kind shares, and a new kind adds to one only where it changes the rule: where a text is cut ([`chunk-cases.json`](../../specs/src/text/chunk-cases.json)), how its pieces are planned ([`chunk-plan-cases.json`](../../specs/src/worker/chunk-plan-cases.json)), and how a failure is classed ([`failure-class-cases.json`](../../specs/src/worker/failure-class-cases.json)).

`npm run lint:spec-case-tables` fails on a table whose runner does not name it, and on a `*-cases.json` file added beside these that the gate does not list.

## 6. Hold a Worker service to it

The [worker-service suite](../../tests/conformance/worker-service/README.md) starts the service as a process and meets it only at its boundary, so its cases judge an implementation in any language. A kind of job has a file there, as [`tagging.test.ts`](../../tests/conformance/worker-service/tagging.test.ts) is: a job queued as the dispatcher would hand it over, the stand-in provider's answers scripted, and then every request to the provider, every batch committed, every checkpoint, every progress report and the completion, each held whole.

- Each prompt the case holds is a file of `prompts/`, the exact text sent. `images/worker/tests/test_prompts.py` fails until the worker's own tests build every such file word for word.
- The suite's README lists the file, with the rules it holds. `npm run lint:conformance-readmes` fails on a file the README does not name.
- The comment that heads the file names the sections of `WORKER-SERVICE.md` it is about. `npm run lint:transport-contract` fails on a file no rule of that document names.

What every kind does is held in files of its own, and a new kind joins those that apply to it: a job cancelled partway (`cancel.test.ts`), a job resumed from a checkpoint (`resume.test.ts`), a job that is declined or cannot be run (`declines.test.ts`).

## 7. Write the rule

[WORKER-SERVICE.md](../protocol/WORKER-SERVICE.md) is what a Worker service does, rule by rule, and a Worker service in another language is written from it. A new kind of `mark` job has there:

- its rule under [The five kinds of mark job](../protocol/WORKER-SERVICE.md#the-five-kinds-of-mark-job), whose heading counts them: what it asks its model for, what its prompt follows, and the body of what it makes;
- its units, in what [Detection](../protocol/WORKER-SERVICE.md#detection) opens with;
- its progress, as a rule of its own under [Progress](../protocol/WORKER-SERVICE.md#progress);
- and its part in whatever shared rule it changes: what its result adds, when it is declined, how it resumes.

Each rule ends with the cases that hold it. A new rule takes the next number of its letter, wherever it stands, and no rule's number changes. `npm run lint:transport-contract` fails on a rule that names a case the suite does not have.

Three other documents say something of each kind of job: [JOBS.md § `job:create`](../protocol/JOBS.md#jobcreate), what admission checks; [Mark § Delegation](../protocol/flows/MARK.md#delegation), the params a caller gives; and the operator's [Configuration § Inference](../operator/administration/CONFIGURATION.md#inference), each job's engine.

## 8. Give it an engine

A knowledge base's Inference document says which engine, a provider and a model, software does a job with, in its `engines`, keyed as a job is described ([Configuration § Inference](../operator/administration/CONFIGURATION.md#inference)): a `mark` job of a motivation is done with `jobs.mark.<motivation>`, and a `yield` job with `jobs.yield`. A job with no engine there is done by no software worker. Which principal does a job is not configured: whoever holds the worker role and claims it.

A Worker service reads no document of a knowledge base. The launcher writes the engines, as the Inference document states them, into two documents: the Archivist's, which answers the knowledge base's engines, and the worker's ([`WorkerConfig`](../../specs/src/components/schemas/WorkerConfig.json)), in which each engine's `jobs` are the filters of the jobs the worker does with it. The worker claims with those filters and no other.

Nothing in the launcher is written for a new motivation. The filters it writes are derived from the generated engines ([`archivistdoc.go`](../../packages/go/launcher/archivistdoc.go), [`workerdoc.go`](../../packages/go/launcher/workerdoc.go)), so they follow step 1's engines and step 2's `client_gen.go`. `TestEveryEngineJobHasAFilter` holds that every job the engines have is given a filter that names it.

A knowledge base's software does the new job once its Inference document gives the job an engine.

## 9. Word it in each client

The wire carries no sentence, so each client has its own words for a job:

- **The launcher** calls an annotation of each motivation by a noun, in `markNouns` ([`mark.go`](../../packages/go/launcher/verbs/mark.go)), and `TestEveryMotivationHasItsNoun` holds that table to `Motivation.json`. `semiont mark --delegate` takes the job's params as flags, and a param no flag gives is a flag added in the same file.
- **The Browser** words a progress report from [`packages/typescript/react-ui/translations`](../../packages/typescript/react-ui/translations). `delegate-progress-copy.test.ts` holds that there is one noun for every motivation the spec has, and `npm run lint:translations` that every locale has every key.

A new progress code is words in both: the launcher's `progressText` ([`job.go`](../../packages/go/launcher/verbs/job.go)), and a key in every locale. What a client shows a person to ask for the job with is that client's own.

## A job of another verb

A job of a verb that has none today is a new value of [`JobType.json`](../../specs/src/components/schemas/JobType.json), and more of the spec is told apart by that value. `npm run lint:spec-jobs` holds each of these to it:

- [`JobCreateCommand`](../../specs/src/components/schemas/JobCreateCommand.json), the description a job is asked for with;
- [`JobQueuedEvent`](../../specs/src/components/schemas/JobQueuedEvent.json), the announcement, which carries the description less the job's input;
- [`JobFilter`](../../specs/src/components/schemas/JobFilter.json), by which a claim names the verb's jobs;
- [`JobCompleteCommand`](../../specs/src/components/schemas/JobCompleteCommand.json), which carries the verb's result. The results every verb reports are together [`JobResult`](../../specs/src/components/schemas/JobResult.json), each closed, with no member that says which it is and no required member in common with another.

`npm run lint:spec-archivist` holds the engines' job types to `JobType`, so `ArchivistEngines` gains the verb under `jobs`. The dispatcher's admission says what resource the job is recorded under and what its retry budget is.

A verb's job is also written into each SDK, where a motivation's is not. The claiming of the TypeScript, the Rust and the Python SDK hands a worker a held job of its verb, which completes with that verb's result (`claims.ts`, `claims.rs`, `claims.py`), and the verb's namespace has the `delegate` that asks for the job and follows it. [`specs/src/client/surface.json`](../../specs/src/client/surface.json) states the method, and `npm run lint:client-surface` holds each SDK to it.

The rest is the path above: the worker's processor and its branch, the suite's file, the rules, the job's engine (`spec.engines.jobs.<jobType>` in an Inference document) and each client's words.

The verb is one of the eight. A job is how a verb is done on someone's behalf, and what the job makes is what the verb makes by hand: the same events, by another author.

## Related

- [JOBS.md](../protocol/JOBS.md): the job protocol, and the dispatcher's side of it
- [WORKER-CONTRACT.md](../protocol/WORKER-CONTRACT.md): what every worker promises, whoever wrote it
- [WORKER-SERVICE.md](../protocol/WORKER-SERVICE.md): what Semiont's Worker service does, rule by rule
- [`images/worker`](../../images/worker/README.md): the service's image, and how it is run
- [Testing](TESTING.md): the suites, and what CI gates
