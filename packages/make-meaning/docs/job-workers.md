# Job Workers

This package exports job workers that process asynchronous AI tasks. Workers were moved from `apps/backend` to `@semiont/make-meaning` to separate detection logic from orchestration concerns.

## Overview

Workers extend the `JobWorker` base class from `@semiont/jobs` and implement domain-specific detection logic. Each worker:

- Accepts `JobQueue`, `EnvironmentConfig`, and `EventStore` as constructor parameters
- Processes jobs by calling `AnnotationDetection` methods
- Emits progress events to the Event Store
- Creates W3C-compliant annotations via events

## Available Workers

### ReferenceDetectionWorker

**Purpose**: Detects entity references in resources using AI inference.

**Job Type**: `'detection'`

**Implementation**: [src/jobs/reference-detection-worker.ts](../src/jobs/reference-detection-worker.ts)

**Key Features**:
- Processes multiple entity types per job
- Validates and corrects AI-generated offsets
- Emits `annotation.added` events for each detected entity
- Supports descriptive references (anaphoric/cataphoric)

**Usage**:
```typescript
import { ReferenceDetectionWorker } from '@semiont/make-meaning';
import { JobQueue } from '@semiont/jobs';
import { createEventStore } from '@semiont/event-sourcing';

const jobQueue = new JobQueue({ dataDir: '/path/to/jobs' });
const eventStore = await createEventStore(config);
const worker = new ReferenceDetectionWorker(jobQueue, config, eventStore);

await worker.start();
```

**Progress Events**:
- `job.started` - First progress update (0% processed)
- `job.progress` - Intermediate updates with entity counts
- `job.completed` - Final update with total entities found
- `job.failed` - If detection permanently fails

### GenerationWorker

**Purpose**: Generates new resources from annotation references using AI.

**Job Type**: `'generation'`

**Implementation**: [src/jobs/generation-worker.ts](../src/jobs/generation-worker.ts)

**Key Features**:
- Fetches annotation and source context
- Generates content using `generateResourceFromTopic()`
- Stores content in RepresentationStore
- Links generated resource to source annotation via `annotation.body.updated` event

**Progress Stages**:
- `fetching` (20%) - Loading source resource
- `generating` (40-70%) - AI content generation
- `creating` (85%) - Saving resource
- `linking` (95-100%) - Connecting annotation

**Result**:
```typescript
{
  resourceId: ResourceId;
  resourceName: string;
}
```

### HighlightDetectionWorker

**Purpose**: Detects passages that should be highlighted.

**Job Type**: `'highlight-detection'`

**Implementation**: [src/jobs/highlight-detection-worker.ts](../src/jobs/highlight-detection-worker.ts)

**Detection Logic**: Calls `AnnotationDetection.detectHighlights()`

**Annotation Structure**:
- Motivation: `'highlighting'`
- Target: TextPositionSelector + TextQuoteSelector
- Body: Empty (highlights have no body)

### CommentDetectionWorker

**Purpose**: Detects passages that merit commentary and generates comments.

**Job Type**: `'comment-detection'`

**Implementation**: [src/jobs/comment-detection-worker.ts](../src/jobs/comment-detection-worker.ts)

**Detection Logic**: Calls `AnnotationDetection.detectComments()`

**Annotation Structure**:
- Motivation: `'commenting'`
- Target: TextPositionSelector + TextQuoteSelector
- Body: TextualBody with AI-generated comment

### AssessmentDetectionWorker

**Purpose**: Detects passages that merit assessment/evaluation.

**Job Type**: `'assessment-detection'`

**Implementation**: [src/jobs/assessment-detection-worker.ts](../src/jobs/assessment-detection-worker.ts)

**Detection Logic**: Calls `AnnotationDetection.detectAssessments()`

**Annotation Structure**:
- Motivation: `'assessing'`
- Target: TextPositionSelector + TextQuoteSelector
- Body: TextualBody with AI-generated assessment

### TagDetectionWorker

**Purpose**: Detects and tags passages with structured semantic categories.

**Job Type**: `'tag-detection'`

**Implementation**: [src/jobs/tag-detection-worker.ts](../src/jobs/tag-detection-worker.ts)

**Detection Logic**: Calls `AnnotationDetection.detectTags()` for each category

**Annotation Structure**:
- Motivation: `'tagging'`
- Target: TextPositionSelector + TextQuoteSelector
- Body: Dual-body structure
  - TextualBody with category (purpose: `'tagging'`)
  - TextualBody with schema ID (purpose: `'classifying'`)

**Example Categories** (from IRAC schema):
- `'issue'` - Legal issues being addressed
- `'rule'` - Applicable legal rules
- `'application'` - Application of rules to facts
- `'conclusion'` - Legal conclusions

## Architecture

### Dependency Injection

All workers follow the explicit parameter passing pattern:

```typescript
constructor(
  jobQueue: JobQueue,        // Job queue instance
  private config: EnvironmentConfig,  // Environment configuration
  private eventStore: EventStore      // Event store instance
)
```

This eliminates singleton patterns and makes dependencies explicit.

### Event Emission

Workers emit domain events through the Event Store:

**Job Lifecycle Events**:
- `job.started` - Job processing begins
- `job.progress` - Progress updates during processing
- `job.completed` - Job successfully completes
- `job.failed` - Job permanently fails

**Annotation Events**:
- `annotation.added` - New annotation created
- `annotation.body.updated` - Annotation body modified

**Resource Events** (GenerationWorker only):
- `resource.created` - New resource generated

### Error Handling

Workers inherit retry logic from `JobWorker` base class:

1. **Transient failures**: Job moves back to `'pending'` for retry
2. **Permanent failures**: Job moves to `'failed'` after max retries
3. **Progress tracking**: Best-effort updates (failures are logged but don't crash worker)

Workers override `handleJobFailure()` to emit `job.failed` events.

## Integration with Backend

The backend creates workers and passes dependencies:

**File**: [apps/backend/src/index.ts](../../apps/backend/src/index.ts)

```typescript
// Create shared dependencies
const jobQueue = new JobQueue({ dataDir });
await jobQueue.initialize();
const eventStore = await createEventStore(config);

// Create workers with explicit dependencies
const referenceDetectionWorker = new ReferenceDetectionWorker(
  jobQueue,
  config,
  eventStore
);
const generationWorker = new GenerationWorker(
  jobQueue,
  config,
  eventStore
);
const highlightDetectionWorker = new HighlightDetectionWorker(
  jobQueue,
  config,
  eventStore
);
const assessmentDetectionWorker = new AssessmentDetectionWorker(
  jobQueue,
  config,
  eventStore
);
const commentDetectionWorker = new CommentDetectionWorker(
  jobQueue,
  config,
  eventStore
);
const tagDetectionWorker = new TagDetectionWorker(
  jobQueue,
  config,
  eventStore
);

// Start all workers
await Promise.all([
  referenceDetectionWorker.start(),
  generationWorker.start(),
  highlightDetectionWorker.start(),
  assessmentDetectionWorker.start(),
  commentDetectionWorker.start(),
  tagDetectionWorker.start(),
]);
```

## Testing

Workers can be tested by:

1. Creating a test JobQueue and EventStore
2. Enqueuing test jobs
3. Verifying emitted events
4. Checking annotation creation

**Example**:
```typescript
import { ReferenceDetectionWorker } from '@semiont/make-meaning';
import { JobQueue } from '@semiont/jobs';
import { createEventStore } from '@semiont/event-sourcing';

describe('ReferenceDetectionWorker', () => {
  it('detects entities and emits events', async () => {
    const jobQueue = new JobQueue({ dataDir: testDir });
    const eventStore = await createEventStore(testConfig);
    const worker = new ReferenceDetectionWorker(jobQueue, testConfig, eventStore);

    // Enqueue test job
    const job: DetectionJob = {
      id: jobId('test-job'),
      type: 'detection',
      resourceId: resourceId('test-resource'),
      userId: userId('test-user'),
      entityTypes: ['Person', 'Location'],
      status: 'pending',
      // ...
    };
    await jobQueue.enqueueJob(job);

    // Process job
    await worker.start();
    // ... verify events and annotations
  });
});
```

## See Also

- [AnnotationDetection API](./annotation-detection.md) - Detection methods called by workers
- [@semiont/jobs](../../jobs/README.md) - Job queue and worker base class
- [@semiont/event-sourcing](../../event-sourcing/README.md) - Event store
- [Architecture](./architecture.md) - Overall system design
