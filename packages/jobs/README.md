# @semiont/jobs

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+jobs%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=jobs)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=jobs)
[![npm version](https://img.shields.io/npm/v/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
[![License](https://img.shields.io/npm/l/@semiont/jobs.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Filesystem-based job queue, worker infrastructure, and annotation workers for [Semiont](https://github.com/The-AI-Alliance/semiont).

## Architecture Context

In production, the job queue and workers are created by `@semiont/make-meaning`'s `startMakeMeaning()` function. Workers emit commands on the **EventBus** — the **Stower** actor (in @semiont/make-meaning) handles all persistence to the Knowledge Base.

Workers are **not** actors. They use a polling loop, not RxJS subscriptions. But they emit the same EventBus commands as any other caller in the system.

## Installation

```bash
npm install @semiont/jobs
```

**Dependencies:**
- `@semiont/core` — Core types, EventBus
- `@semiont/api-client` — OpenAPI types
- `@semiont/inference` — InferenceClient for AI operations

## Quick Start

```typescript
import { JobQueue, type PendingJob, type GenerationParams } from '@semiont/jobs';
import { EventBus, userId, resourceId, annotationId } from '@semiont/core';
import { jobId } from '@semiont/api-client';

// Initialize
const eventBus = new EventBus();
const jobQueue = new JobQueue({ dataDir: './data' }, logger, eventBus);
await jobQueue.initialize();

// Create a job
const job: PendingJob<GenerationParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-abc123'),
    type: 'generation',
    userId: userId('user@example.com'),
    userName: 'Jane Doe',
    userEmail: 'jane@example.com',
    userDomain: 'example.com',
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
  },
  params: {
    referenceId: annotationId('ref-123'),
    sourceResourceId: resourceId('doc-456'),
    sourceResourceName: 'Source Document',
    annotation: { /* full W3C Annotation */ },
    title: 'Generated Article',
    prompt: 'Write about AI',
    language: 'en-US',
  },
};

await jobQueue.createJob(job);
```

## Job Types

```typescript
type JobType =
  | 'reference-annotation'     // Entity reference detection
  | 'generation'               // AI content generation
  | 'highlight-annotation'     // Key passage highlighting
  | 'assessment-annotation'    // Evaluative assessments
  | 'comment-annotation'       // Explanatory comments
  | 'tag-annotation'           // Structural role tagging
```

## Job Metadata

All jobs share common metadata:

```typescript
interface JobMetadata {
  id: JobId;
  type: JobType;
  userId: UserId;
  userName: string;       // For building W3C Agent creator
  userEmail: string;      // For building W3C Agent creator
  userDomain: string;     // For building W3C Agent creator
  created: string;
  retryCount: number;
  maxRetries: number;
}
```

The `userName`, `userEmail`, and `userDomain` fields are used by workers to build the W3C `Agent` for annotation `creator` attribution via `userToAgent()`.

## Annotation Workers

Six workers process different annotation types:

| Worker | Job Type | Constructor |
|--------|----------|------------|
| `ReferenceAnnotationWorker` | `reference-annotation` | `(jobQueue, config, inferenceClient, eventBus, contentFetcher, logger)` |
| `GenerationWorker` | `generation` | `(jobQueue, config, inferenceClient, eventBus, logger)` |
| `HighlightAnnotationWorker` | `highlight-annotation` | `(jobQueue, config, inferenceClient, eventBus, contentFetcher, logger)` |
| `AssessmentAnnotationWorker` | `assessment-annotation` | `(jobQueue, config, inferenceClient, eventBus, contentFetcher, logger)` |
| `CommentAnnotationWorker` | `comment-annotation` | `(jobQueue, config, inferenceClient, eventBus, contentFetcher, logger)` |
| `TagAnnotationWorker` | `tag-annotation` | `(jobQueue, config, inferenceClient, eventBus, contentFetcher, logger)` |

Workers emit EventBus commands (`mark:create`, `job:start`, `job:complete`, etc.) — the Stower actor in @semiont/make-meaning handles persistence.

## Custom Workers

```typescript
import { JobWorker, type AnyJob } from '@semiont/jobs';
import type { Logger } from '@semiont/core';

class MyWorker extends JobWorker {
  constructor(jobQueue: JobQueue, logger: Logger) {
    super(jobQueue, 1000, 5000, logger);
    //              ^^^^  ^^^^
    //              poll   error backoff
  }

  protected getWorkerName(): string {
    return 'MyWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'generation';
  }

  protected async executeJob(job: AnyJob): Promise<any> {
    // Your processing logic — return result object
  }
}
```

## Discriminated Unions

Jobs use TypeScript discriminated unions for type safety:

```typescript
function handleJob(job: AnyJob) {
  if (job.status === 'running') {
    console.log(job:progress);    // Available
    // console.log(job.result);   // Compile error
  }
  if (job.status === 'complete') {
    console.log(job.result);      // Available
    // console.log(job:progress); // Compile error
  }
}
```

## Storage Format

Jobs are stored as individual JSON files organized by status:

```
data/jobs/
  pending/job-abc123.json
  running/job-def456.json
  complete/job-ghi789.json
  failed/job-jkl012.json
  cancelled/job-mno345.json
```

## Documentation

- **[Job Queue Guide](./docs/JobQueue.md)** — JobQueue API and job management
- **[Workers Guide](./docs/Workers.md)** — Building custom workers
- **[Job Types Guide](./docs/JobTypes.md)** — All job type definitions
- **[Type System Guide](./docs/TYPES.md)** — Discriminated unions and type safety
- **[Configuration Guide](./docs/Configuration.md)** — Setup and options
- **[API Reference](./docs/API.md)** — Complete API reference

## License

Apache-2.0

## Related Packages

- [`@semiont/core`](../core/) — Domain types, EventBus
- [`@semiont/api-client`](../api-client/) — OpenAPI types
- [`@semiont/inference`](../inference/) — AI inference client
- [`@semiont/make-meaning`](../make-meaning/) — Actor model, Knowledge Base, service orchestration
