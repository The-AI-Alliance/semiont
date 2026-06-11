# @semiont/jobs

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+jobs%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=jobs)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=jobs)
[![npm version](https://img.shields.io/npm/v/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/jobs.svg)](https://www.npmjs.com/package/@semiont/jobs)
[![License](https://img.shields.io/npm/l/@semiont/jobs.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Job queue, worker infrastructure, and annotation workers for [Semiont](https://github.com/The-AI-Alliance/semiont).

## Architecture Context

Workers run in a separate process and connect to the Knowledge System (KS) over HTTP/SSE using a `SemiontSession` (from `@semiont/sdk`) driven by a `JobClaimAdapter`. Workers receive job assignments via an SSE `job:queued` subscription, claim jobs atomically, and emit domain events back to the KS via `session.client.transport.emit(...)`. The KS ingests these events onto its EventBus for SSE delivery to the frontend.

## Installation

```bash
npm install @semiont/jobs
```

**Dependencies:**
- `@semiont/core` — Core types, `SemiontProject`, EventBus
- `@semiont/sdk` — `SemiontSession`, `JobClaimAdapter` (worker process)
- `@semiont/http-transport` — HTTP transport, OpenAPI types
- `@semiont/inference` — InferenceClient for AI operations
- `@semiont/content` — Content storage URI derivation
- `@semiont/observability` — Spans and job-outcome metrics

## Quick Start

```typescript
import { FsJobQueue, type PendingJob, type GenerationParams } from '@semiont/jobs';
import { EventBus, userId, resourceId, annotationId, jobId } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';

// Initialize — jobs are stored under project.jobsDir
const eventBus = new EventBus();
const project = new SemiontProject('/path/to/project');
const jobQueue = new FsJobQueue(project, logger, eventBus);
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

The worker process (`worker-main.ts` → `startWorkerProcess` in `worker-process.ts`) claims jobs over the bus via a `JobClaimAdapter` and dispatches by `jobType` to a processor function. There are no per-type worker classes; each job type maps to one `process*Job` function:

| Job Type | Processor |
|----------|-----------|
| `reference-annotation` | `processReferenceJob` |
| `generation` | `processGenerationJob` |
| `highlight-annotation` | `processHighlightJob` |
| `assessment-annotation` | `processAssessmentJob` |
| `comment-annotation` | `processCommentJob` |
| `tag-annotation` | `processTagJob` |

Detection logic lives in the `AnnotationDetection` class (`src/workers/annotation-detection.ts`); generation synthesis in `generateResourceFromTopic()` (`src/workers/generation/resource-generation.ts`). Each processor fetches content via `session.client.browse.resourceContent(resourceId)`.

Workers emit bus events via `session.client.transport.emit('mark:create' | 'job:start' | 'job:report-progress' | 'job:complete' | 'job:fail', payload)` — the Stower actor in @semiont/make-meaning handles persistence.

## Adding a Job Type

Workers are not subclassed. To add a job type:

1. Add the new `JobType` and its params/result/progress types in `src/types.ts`.
2. Add a `process*Job` function in `src/processors.ts` that runs the inference and returns the annotations/result.
3. Dispatch the new `jobType` to that processor in `handleJobInner()` in `src/worker-process.ts`.

Processors are transport-agnostic: they take content, an `InferenceClient`, the job params, the user id, the `generator` (W3C SoftwareAgent), and an `onProgress` callback, and return annotations plus a result. The worker process handles claiming, content fetching, and lifecycle event emission.

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

- [`@semiont/core`](../core/) — Domain types, `SemiontProject`, EventBus
- [`@semiont/sdk`](../sdk/) — `SemiontSession`, `JobClaimAdapter`
- [`@semiont/http-transport`](../http-transport/) — HTTP transport, OpenAPI types
- [`@semiont/inference`](../inference/) — AI inference client
- [`@semiont/make-meaning`](../make-meaning/) — Actor model, Knowledge Base, service orchestration
