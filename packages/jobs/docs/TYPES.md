# Type System Architecture

The jobs package uses TypeScript's discriminated unions to create a type-safe state machine for asynchronous job processing. This architecture enforces valid state transitions at compile time and ensures fields are only accessible when they exist.

## Core Design Principles

### Three-Concept Separation

Jobs are modeled with three distinct concepts:

1. **Status** — The discriminator field that determines which other fields exist
2. **Progress** — Intermediate state tracking (only on `RunningJob`)
3. **Result** — Final outcome data (only on `CompleteJob`)

```typescript
// Anti-pattern: Result data in progress
interface Progress {
  percentage: number;
  resultId?: string;  // Don't do this!
}

// Correct: Result data in result
interface Progress {
  percentage: number;  // Only tracking data
}

interface Result {
  resultId: string;  // Final outcome data
}
```

### Discriminated Union Structure

```typescript
type JobStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';

interface PendingJob<P> {
  status: 'pending';
  metadata: JobMetadata;
  params: P;
}

interface RunningJob<P, PG> {
  status: 'running';
  metadata: JobMetadata;
  params: P;
  startedAt: string;
  progress: PG;          // Only RunningJob has progress
}

interface CompleteJob<P, R> {
  status: 'complete';
  metadata: JobMetadata;
  params: P;
  startedAt: string;
  completedAt: string;
  result: R;             // Only CompleteJob has result
}

interface FailedJob<P> {
  status: 'failed';
  metadata: JobMetadata;
  params: P;
  startedAt?: string;
  completedAt: string;
  error: string;         // Only FailedJob has error
}

interface CancelledJob<P> {
  status: 'cancelled';
  metadata: JobMetadata;
  params: P;
  startedAt?: string;
  completedAt: string;
}
```

## Type Parameters

Each job type is parameterized by three type variables:

```typescript
type Job<P, PG, R> =
  | PendingJob<P>
  | RunningJob<P, PG>
  | CompleteJob<P, R>
  | FailedJob<P>
  | CancelledJob<P>;

// Where:
// P  = Params (input configuration)
// PG = Progress (intermediate state)
// R  = Result (final outcome)
```

## Example: Tag Annotation Job

### Pending State

```typescript
const job: PendingJob<TagDetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job_123'),
    type: 'tag-annotation',
    userId: userId('user@example.com'),
    userName: 'Jane Doe',
    userEmail: 'jane@example.com',
    userDomain: 'example.com',
    created: '2026-01-31T10:00:00Z',
    retryCount: 0,
    maxRetries: 3,
  },
  params: {
    resourceId: resourceId('doc_456'),
    schemaId: 'irac',
    categories: ['issue', 'rule', 'application', 'conclusion'],
  },
};

// job.params exists
// job.progress does NOT exist (compile error)
// job.result does NOT exist (compile error)
```

### Running State

```typescript
const runningJob: RunningJob<TagDetectionParams, TagDetectionProgress> = {
  status: 'running',
  metadata: job.metadata,
  params: job.params,
  startedAt: '2026-01-31T10:00:05Z',
  progress: {
    stage: 'analyzing',
    percentage: 35,
    currentCategory: 'issue',
    processedCategories: 1,
    totalCategories: 4,
    message: 'Analyzing issue...',
  },
};

// runningJob.progress exists
// runningJob.result does NOT exist (compile error)
```

### Complete State

```typescript
const completeJob: CompleteJob<TagDetectionParams, TagDetectionResult> = {
  status: 'complete',
  metadata: runningJob.metadata,
  params: runningJob.params,
  startedAt: runningJob.startedAt,
  completedAt: '2026-01-31T10:01:30Z',
  result: {
    tagsFound: 15,
    tagsCreated: 15,
    byCategory: { issue: 4, rule: 3, application: 5, conclusion: 3 },
  },
};

// completeJob.result exists
// completeJob.progress does NOT exist (compile error)
```

## Type Narrowing

### Status-Based Narrowing

```typescript
function handleJob(job: AnyJob) {
  if (job.status === 'running') {
    console.log(job.progress.percentage);  // Available
    // console.log(job.result);            // Compile error
  }

  if (job.status === 'complete') {
    console.log(job.result);               // Available
    // console.log(job.progress);          // Compile error
  }
}
```

### Combined Type Guards

```typescript
function isRunningGenerationJob(
  job: AnyJob
): job is RunningJob<GenerationParams, YieldProgress> {
  return job.status === 'running' && job.metadata.type === 'generation';
}

if (isRunningGenerationJob(job)) {
  console.log(job.params.title);      // GenerationParams
  console.log(job.progress.stage);    // YieldProgress
}
```

### Built-in Type Guards

```typescript
import { isPendingJob, isRunningJob, isCompleteJob, isFailedJob, isCancelledJob } from '@semiont/jobs';

if (isRunningJob(job)) {
  console.log(job.progress);
}
```

## Worker Implementation Pattern

Workers use the template method pattern with result returns:

```typescript
class TagAnnotationWorker extends JobWorker {
  protected async executeJob(job: AnyJob): Promise<TagDetectionResult> {
    if (job.metadata.type !== 'tag-annotation') {
      throw new Error(`Invalid job type: ${job.metadata.type}`);
    }
    if (job.status !== 'running') {
      throw new Error(`Job must be running, got: ${job.status}`);
    }

    const tagJob = job as RunningJob<TagDetectionParams, TagDetectionProgress>;

    // Process and emit EventBus commands
    const allTags = await detectTags(tagJob.params);

    // Emit mark:create for each tag via EventBus
    for (const tag of allTags) {
      this.eventBus.get('mark:create').next({
        annotation: tag,
        userId: tagJob.metadata.userId,
      });
    }

    // Return result — base class handles transition to CompleteJob
    return {
      tagsFound: allTags.length,
      tagsCreated: allTags.length,
      byCategory: countByCategory(allTags),
    };
  }
}
```

Workers emit EventBus commands (`mark:create`, `job:start`, `job:complete`). The **Stower** actor in `@semiont/make-meaning` subscribes to these commands and handles all persistence to the Knowledge Base.

## Exhaustive Checking

```typescript
function getStatusMessage(job: AnyJob): string {
  switch (job.status) {
    case 'pending':
      return 'Waiting to start...';
    case 'running':
      return `${job.progress.percentage}% complete`;
    case 'complete':
      return 'Finished successfully';
    case 'failed':
      return `Error: ${job.error}`;
    case 'cancelled':
      return 'Cancelled';
    // TypeScript will error if a new status is added and not handled
  }
}
```

## Job Type Definitions

See [JobTypes.md](./JobTypes.md) for all parameter, progress, and result types:

- **Reference Annotation** (`reference-annotation`) — Entity detection
- **Generation** (`generation`) — AI content generation
- **Highlight Annotation** (`highlight-annotation`) — Key passage identification
- **Assessment Annotation** (`assessment-annotation`) — Evaluative assessments
- **Comment Annotation** (`comment-annotation`) — Explanatory comments
- **Tag Annotation** (`tag-annotation`) — Structural role tagging

## See Also

- [JobTypes.md](./JobTypes.md) — All job type definitions
- [Workers.md](./Workers.md) — Worker implementation guide
- [JobQueue.md](./JobQueue.md) — Job queue API
