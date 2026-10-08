# @semiont/jobs

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+jobs%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=jobs)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=jobs)
[![npm version](https://img.shields.io/npm/v/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
[![License](https://img.shields.io/npm/l/@semiont/jobs.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The worker: the process that claims jobs and does them. A `mark` job is an annotation pass over a resource for one motivation (highlighting, commenting, assessing, linking, tagging); a `yield` job makes a new resource. Both are done with a model through [`@semiont/inference`](../inference/README.md).

The queue is not here. It is the [dispatcher](../../apps/dispatcher/README.md)'s, and the protocol between the two is [Jobs](../../docs/protocol/JOBS.md).

## Who uses it

- **The Worker service** is this package's `worker-main`, run as the `semiont-worker` image ([apps/worker](../../apps/worker/README.md)).

**Building an application?** You do not need this package. An application starts a job through [`@semiont/sdk`](../sdk/README.md) (`mark.delegate` for an annotation pass, `yield.delegate` for a new resource) and follows it with the `job` namespace.

## What is in it

| | |
|---|---|
| `@semiont/jobs/worker-main` | The Worker's entry point. It signs in as an agent, opens a client for each model it is configured with, and claims jobs until it is stopped |
| `processHighlightJob`, `processCommentJob`, `processAssessmentJob`, `processReferenceJob`, `processTagJob`, `processGenerationJob` | One function for each motivation of a `mark` job, and one for a `yield` job. There are no worker classes |
| `AnnotationDetection`, `generateResourceFromTopic` | What the processors call: the detection passes, and generation |
| `HeldMarkParams`, `isHeldMark` | A `mark` job's params as a worker is handed them, typed from the spec, and the guard that says which motivation's they are |

## Example

A job's description is the spec's. What a worker is handed is that description and what the dispatcher adds to it, and `isHeldMark` says which of the five `mark` jobs it is.

```typescript
import { isHeldMark } from '@semiont/jobs';
import type { components } from '@semiont/core';

function describe(job: components['schemas']['JobRunning']): string {
  if (job.metadata.type === 'yield') return 'makes a resource';
  if (isHeldMark(job.params, 'linking')) return `links ${job.params.entityTypes.join(', ')}`;
  if (isHeldMark(job.params, 'tagging')) return `tags by ${job.params.schema.name}`;   // the schema the dispatcher resolved
  return 'annotates';
}
```

## What a change must keep

- **A worker holds nothing of the knowledge base.** It has no mount and no broker credential. It reaches the gateway with a URL and a token, reads a resource's bytes from the Archivist, and writes annotations by the awaited `mark:commit`, a batch per unit of work.
- **A worker sees a job only as it is handed over.** It never reads the queue's storage. What it knows of a job is what `job:claimed` carried.
- **A worker never says who asked.** A job's requester is the identity the gateway verified on `job:create`, recorded by the dispatcher. What the worker contributes is itself, as the software agent that generated the result.
- **A processor is plain work.** It is given content, an inference client, the job's params and callbacks for progress and for committing a chunk. It fetches nothing and knows no transport.
- **One progress shape, and one result.** Every job reports the spec's `JobProgress`, and every `mark` job the spec's `MarkJobResult`, whatever its motivation: its counts (`JobDetectionResult`), or a decline.
- **Failure is bounded, classified and resumable.** Every inference call has a deadline and is truly cancelled. A failure caused by size subdivides the work in place. A retry resumes from the last checkpoint and skips what was committed. [Failure discipline](docs/FailureDiscipline.md) has the rules.

Adding a job starts in the spec, not here: [Workers](docs/Workers.md#adding-a-job) lists the steps.

## Documentation

- [Workers](docs/Workers.md): how a worker runs, where content comes from, how it emits, a worker written outside this package, adding a job.
- [Job types](docs/JobTypes.md): what a job is asked with, what a worker is handed, and what each job's params, result and progress mean.
- [Failure discipline](docs/FailureDiscipline.md): deadlines, budgets, subdivision, verification, classification, resumption.
- [The worker service](../../apps/worker/README.md): running it.

## License

Apache-2.0
