# Type System Architecture

The jobs package uses TypeScript's discriminated unions to create a type-safe state machine for asynchronous job processing. This architecture enforces valid state transitions at compile time and ensures fields are only accessible when they exist.

## Core Design Principles

### Three-Concept Separation

Jobs are modeled with three distinct concepts:

1. **Status** - The discriminator field that determines which other fields exist
2. **Progress** - Intermediate state tracking (only on `RunningJob`)
3. **Result** - Final outcome data (only on `CompleteJob`)

This separation ensures result data cannot be "smuggled" through progress objects—a common anti-pattern.

```typescript
// ❌ Anti-pattern: Result data in progress
interface Progress {
  percentage: number;
  resultId?: string;  // Don't do this!
}

// ✅ Correct: Result data in result
interface Progress {
  percentage: number;  // Only tracking data
}

interface Result {
  resultId: string;  // Final outcome data
}
```

### Discriminated Union Structure

Jobs use `status` as the discriminator, with each status having specific fields:

```typescript
type JobStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';

// Pending - just created
interface PendingJob<P> {
  status: 'pending';
  metadata: JobMetadata;
  params: P;
}

// Running - being processed
interface RunningJob<P, PG> {
  status: 'running';
  metadata: JobMetadata;
  params: P;
  startedAt: string;
  progress: PG;  // ← Only RunningJob has progress
}

// Complete - successfully finished
interface CompleteJob<P, R> {
  status: 'complete';
  metadata: JobMetadata;
  params: P;
  startedAt: string;
  completedAt: string;
  result: R;  // ← Only CompleteJob has result
}

// Failed - encountered error
interface FailedJob<P> {
  status: 'failed';
  metadata: JobMetadata;
  params: P;
  startedAt?: string;
  completedAt: string;
  error: string;  // ← Only FailedJob has error
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

## Example: Tag Detection Job

### Pending State

```typescript
const job: PendingJob<TagDetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job_123'),
    type: 'tag-detection',
    userId: userId('user@example.com'),
    created: '2026-01-31T10:00:00Z',
    retryCount: 0,
    maxRetries: 3
  },
  params: {
    resourceId: resourceId('doc_456'),
    schemaId: 'irac',
    categories: ['issue', 'rule', 'application', 'conclusion']
  }
};

// ✅ job.params exists
// ❌ job.progress does NOT exist (compile error)
// ❌ job.result does NOT exist (compile error)
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
    message: 'Analyzing issue...'
  }
};

// ✅ runningJob.progress exists
// ❌ runningJob.result does NOT exist (compile error)
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
    byCategory: {
      'issue': 4,
      'rule': 3,
      'application': 5,
      'conclusion': 3
    }
  }
};

// ✅ completeJob.result exists
// ❌ completeJob.progress does NOT exist (compile error)
```

## Type Narrowing

### Status-Based Narrowing

TypeScript automatically narrows types based on status checks:

```typescript
function handleJob(job: AnyJob) {
  if (job.status === 'running') {
    // TypeScript knows: job is RunningJob<any, any>
    console.log(job.progress.percentage);  // ✅ Available
    // console.log(job.result);  // ❌ Compile error
  }

  if (job.status === 'complete') {
    // TypeScript knows: job is CompleteJob<any, any>
    console.log(job.result);  // ✅ Available
    // console.log(job.progress);  // ❌ Compile error
  }
}
```

### Combined Type Guards

```typescript
function isRunningGenerationJob(
  job: AnyJob
): job is RunningJob<GenerationParams, GenerationProgress> {
  return job.status === 'running' && job.metadata.type === 'generation';
}

if (isRunningGenerationJob(job)) {
  // TypeScript knows all these exist:
  console.log(job.params.title);      // ✅ GenerationParams
  console.log(job.progress.stage);    // ✅ GenerationProgress
}
```

## Job Type Definitions

See [JobTypes.md](./JobTypes.md) for complete parameter, progress, and result types for all job types:

- **DetectionJob** - Entity detection
- **GenerationJob** - AI content generation
- **HighlightDetectionJob** - Key passage identification
- **AssessmentDetectionJob** - Evaluative comments
- **CommentDetectionJob** - Explanatory comments
- **TagDetectionJob** - Structural role tagging

## Worker Implementation Pattern

Workers use the template method pattern with result returns:

```typescript
class TagDetectionWorker extends JobWorker {
  // 1. Type guard and execute
  protected async executeJob(job: AnyJob): Promise<TagDetectionResult> {
    if (job.metadata.type !== 'tag-detection') {
      throw new Error(`Invalid job type: ${job.metadata.type}`);
    }

    if (job.status !== 'running') {
      throw new Error(`Job must be in running state, got: ${job.status}`);
    }

    return await this.processTagDetectionJob(
      job as RunningJob<TagDetectionParams, TagDetectionProgress>
    );
  }

  // 2. Process and return result
  private async processTagDetectionJob(
    job: RunningJob<TagDetectionParams, TagDetectionProgress>
  ): Promise<TagDetectionResult> {
    // Do work, track progress
    const allTags = await detectTags(job.params);

    // Return result - base class handles transition to CompleteJob
    return {
      tagsFound: allTags.length,
      tagsCreated: created,
      byCategory
    };
  }

  // 3. Optional: Emit completion event with result data
  protected override async emitCompletionEvent(
    job: RunningJob<TagDetectionParams, TagDetectionProgress>,
    result: TagDetectionResult
  ): Promise<void> {
    await this.eventStore.appendEvent({
      type: 'job.completed',
      resourceId: job.params.resourceId,
      userId: job.metadata.userId,
      version: 1,
      payload: {
        jobId: job.metadata.id,
        jobType: 'tag-detection',
        // Can include result data here if needed
      },
    });
  }
}
```

## Type Safety Benefits

### Compile-Time Guarantees

```typescript
// ❌ Error: Property 'progress' does not exist on type 'AnyJob'
console.log(job.progress);

// ✅ Correct: Type guard first
if (job.status === 'running') {
  console.log(job.progress.percentage);
}
```

### Exhaustive Checking

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
      return 'Cancelled by user';
    // If we add a new status, TypeScript will error here
  }
}
```

## Best Practices

### Creating Jobs

```typescript
// ✅ Use discriminated union structure
const job: PendingJob<GenerationParams> = {
  status: 'pending',
  metadata: { /* ... */ },
  params: { /* ... */ }
};

// ❌ Don't use flat structure
// const job = { id, type, status, title, prompt, ... }
```

### Updating Progress

```typescript
// ✅ Immutable update pattern
if (job.status === 'running') {
  const updatedJob: RunningJob<Params, Progress> = {
    ...job,
    progress: { percentage: 50, stage: 'processing' }
  };
  await queue.updateJob(updatedJob);
}

// ❌ Don't mutate
// job.progress = { ... }
```

### Returning Results

```typescript
// ✅ Return result from executeJob
protected async executeJob(job: AnyJob): Promise<GenerationResult> {
  const resourceId = await createResource(content);

  return {
    resourceId,
    resourceName: job.params.title
  };
}

// ❌ Don't try to set result field
// job.result = { ... }  // Field doesn't exist on RunningJob
```

## See Also

- [JobTypes.md](./JobTypes.md) - All job type definitions
- [Workers.md](./Workers.md) - Worker implementation guide
- [JobQueue.md](./JobQueue.md) - Job queue API
