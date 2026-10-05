# @semiont/jobs

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+jobs%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=jobs)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=jobs)
[![npm version](https://img.shields.io/npm/v/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
[![License](https://img.shields.io/npm/l/@semiont/jobs.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The worker: the process that claims jobs and does them. A job is an annotation pass over a resource (references, highlights, comments, assessments, tags) or the generation of a new resource, done with a model through [`@semiont/inference`](../inference/README.md).

The queue is not here. It is the [dispatcher](../../apps/dispatcher/README.md)'s, and the protocol between the two is [Jobs](../../docs/protocol/JOBS.md).

## Who uses it

- **The Worker service** is this package's `worker-main`, run as the `semiont-worker` image ([apps/worker](../../apps/worker/README.md)).
- **[`@semiont/make-meaning`](../make-meaning/README.md)** takes one constant from it: the stall threshold that its own gather deadlines are checked against.

**Building an application?** You do not need this package. An application starts a job through [`@semiont/sdk`](../sdk/README.md) (`mark.assist` for an annotation pass, `yield.fromContext` for a generation) and follows it with the `job` namespace.

## What is in it

| | |
|---|---|
| `@semiont/jobs/worker-main` | The Worker's entry point. It signs in as an agent, opens a client for each model it is configured with, and claims jobs until it is stopped |
| `createJobClaimAdapter` | Claiming over the bus: `job:claim` whenever the worker is idle, woken by `job:queued` |
| `processReferenceJob`, `processHighlightJob`, `processCommentJob`, `processAssessmentJob`, `processTagJob`, `processGenerationJob` | One function per job type. There are no worker classes |
| `AnnotationDetection`, `generateResourceFromTopic` | What the processors call: the detection passes, and generation |
| `JobType`, `AnyJob`, and each job's params | The job types. `JobType` and `JobStatus` are generated from the spec |
| `isPendingJob`, `isRunningJob`, `isCompleteJob`, `isFailedJob`, `isCancelledJob` | Guards that narrow a job to its state |

## Example

A job is a union discriminated by its `status`, so what a job carries follows from the state it is in.

```typescript
import { isCompleteJob, isRunningJob, type AnyJob } from '@semiont/jobs';

function describe(job: AnyJob): string {
  if (isRunningJob(job)) return `${job.metadata.type}: running`;      // job.progress is here, job.result is not
  if (isCompleteJob(job)) return `${job.metadata.type}: done`;        // job.result is here
  return `${job.metadata.type}: ${job.status}`;
}
```

## What a change must keep

- **A worker holds nothing of the knowledge base.** It has no mount and no broker credential. It reaches the gateway with a URL and a token, reads a resource's bytes from the Archivist, and writes annotations by the awaited `mark:commit`, a batch per unit of work.
- **A worker sees a job only as it is handed over.** It never reads the queue's storage. What it knows of a job is what `job:claimed` carried.
- **A worker never says who asked.** A job's requester is the identity the gateway verified on `job:create`, recorded by the dispatcher. What the worker contributes is itself, as the software agent that generated the result.
- **A processor is plain work.** It is given content, an inference client, the job's params and callbacks for progress and for committing a chunk. It fetches nothing and knows no transport.
- **One progress shape.** Every job type reports the spec's `JobProgress`. There are no per-type progress types.
- **Failure is bounded, classified and resumable.** Every inference call has a deadline and is truly cancelled. A failure caused by size subdivides the work in place. A retry resumes from the last checkpoint and skips what was committed. [Failure discipline](docs/FailureDiscipline.md) has the rules.

Adding a job type starts in the spec, not here: [Workers](docs/Workers.md#adding-a-custom-job-type) lists the steps.

## Documentation

- [Workers](docs/Workers.md): how a worker runs, where content comes from, how it emits, adding a job type.
- [Job types](docs/JobTypes.md): each type's params, result and progress.
- [Failure discipline](docs/FailureDiscipline.md): deadlines, budgets, subdivision, verification, classification, resumption.
- [Types](docs/TYPES.md): the discriminated unions.
- [Configuration](docs/Configuration.md) and [API](docs/API.md).

## License

Apache-2.0
