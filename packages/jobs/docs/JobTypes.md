# Job Types Guide

Semiont supports multiple job types for different async tasks. All jobs use discriminated unions based on status for type safety and to prevent accessing fields that don't exist in the current state.

## Table of Contents

- [Discriminated Union Structure](#discriminated-union-structure)
- [Job Metadata](#job-metadata)
- [Job Type: Detection](#job-type-detection)
- [Job Type: Generation](#job-type-generation)
- [Job Type: Highlight Detection](#job-type-highlight-detection)
- [Job Type: Assessment Detection](#job-type-assessment-detection)
- [Job Type: Comment Detection](#job-type-comment-detection)
- [Job Type: Tag Detection](#job-type-tag-detection)
- [Type Safety](#type-safety)
- [Progress Tracking](#progress-tracking)
- [Result Types](#result-types)

## Discriminated Union Structure

Jobs are discriminated unions based on their `status` field. Each status has different fields available:

```typescript
// Pending job - waiting to be processed
interface PendingJob<TParams> {
  status: 'pending';
  metadata: JobMetadata;
  params: TParams;
}

// Running job - currently being processed
interface RunningJob<TParams, TProgress = any> {
  status: 'running';
  metadata: JobMetadata;
  params: TParams;
  startedAt: string;
  progress: TProgress;
}

// Complete job - successfully finished
interface CompleteJob<TParams, TResult = any> {
  status: 'complete';
  metadata: JobMetadata;
  params: TParams;
  startedAt: string;
  completedAt: string;
  result: TResult;
}

// Failed job - failed with error
interface FailedJob<TParams> {
  status: 'failed';
  metadata: JobMetadata;
  params: TParams;
  startedAt: string;
  completedAt: string;
  error: string;
}

// Union of all job states
type AnyJob = PendingJob<any> | RunningJob<any> | CompleteJob<any> | FailedJob<any> | CancelledJob<any>;
```

**Key benefits:**
- TypeScript prevents accessing `progress` on pending jobs (compile error)
- TypeScript prevents accessing `result` on running jobs (compile error)
- No more optional fields that may or may not exist
- Clear separation between metadata (who/what/when) and params (job-specific data)

## Job Metadata

All jobs share common metadata regardless of status:

```typescript
interface JobMetadata {
  // Identity
  id: JobId;              // Unique job identifier
  type: JobType;          // Job type discriminator ('generation', 'detection', etc.)
  userId: UserId;         // User who created job

  // Timestamps
  created: string;        // ISO 8601 creation time

  // Error handling
  retryCount: number;     // Number of retry attempts
  maxRetries: number;     // Maximum retry attempts allowed
}
```

**Job Types:**

```typescript
type JobType =
  | 'detection'             // Entity detection
  | 'generation'            // AI content generation
  | 'highlight-detection'   // Key passage identification
  | 'assessment-detection'  // Evaluative comments
  | 'comment-detection'     // Explanatory comments
  | 'tag-detection'         // Structural role tagging
```

**Job Status:**

```typescript
type JobStatus =
  | 'pending'    // Waiting to be processed
  | 'running'    // Currently being processed
  | 'complete'   // Successfully finished
  | 'failed'     // Failed with error
  | 'cancelled'  // Cancelled by user
```

## Job Type: Detection

Entity detection finds named entities (people, organizations, locations, etc.) in a resource using AI inference.

**Parameters:**

```typescript
interface DetectionParams {
  // Target resource
  resourceId: ResourceId;

  // What to detect
  entityTypes: EntityType[];  // e.g., ['Person', 'Organization']

  // Options
  includeDescriptiveReferences?: boolean;  // Include "the CEO", "the company"
}
```

**Progress:**

```typescript
interface DetectionProgress {
  totalEntityTypes: number;
  processedEntityTypes: number;
  currentEntityType?: string;
  entitiesFound: number;
  entitiesEmitted: number;
}
```

**Result:**

```typescript
interface DetectionResult {
  totalFound: number;
  totalEmitted: number;
  errors: number;
}
```

**Example:**

```typescript
import { jobId, entityType } from '@semiont/api-client';
import { userId, resourceId } from '@semiont/core';
import type { PendingJob, DetectionParams } from '@semiont/jobs';

const job: PendingJob<DetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-123'),
    type: 'detection',
    userId: userId('user@example.com'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
  },
  params: {
    resourceId: resourceId('doc-456'),
    entityTypes: [
      entityType('Person'),
      entityType('Organization'),
      entityType('Location'),
    ],
    includeDescriptiveReferences: true,
  },
};
```

**Use cases:**
- Extract entities from documents for knowledge graphs
- Index content by people, organizations, locations
- Enable entity-based search and filtering

## Job Type: Generation

Generation creates new content using AI based on source material and prompts.

**Parameters:**

```typescript
interface GenerationParams {
  // Source
  referenceId: AnnotationId;      // Annotation that triggered generation
  sourceResourceId: ResourceId;   // Source document

  // Generation parameters
  prompt?: string;                // User-provided prompt
  title?: string;                 // Title for generated resource
  entityTypes?: EntityType[];     // Entity types to include
  language?: string;              // Locale (e.g., 'en-US', 'es-ES')

  // AI parameters
  context?: GenerationContext;    // Context from source (required)
  temperature?: number;           // 0.0-1.0 (creativity)
  maxTokens?: number;             // Token limit
}
```

**Progress:**

```typescript
interface GenerationProgress {
  stage: 'fetching' | 'generating' | 'creating' | 'linking';
  percentage: number;
  message?: string;
}
```

**Result:**

```typescript
interface GenerationResult {
  resourceId: ResourceId;
  resourceName: string;
}
```

**Example:**

```typescript
import type { PendingJob, GenerationParams, GenerationContext } from '@semiont/jobs';

const job: PendingJob<GenerationParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-789'),
    type: 'generation',
    userId: userId('user@example.com'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
  },
  params: {
    referenceId: annotationId('ref-123'),
    sourceResourceId: resourceId('doc-456'),
    title: 'Article about Quantum Computing',
    prompt: 'Write a comprehensive overview of quantum computing applications',
    language: 'en-US',
    context: {
      sourceContext: {
        before: 'Text before selection...',
        selected: 'Quantum Computing',
        after: 'Text after selection...',
      },
      references: [],
    },
    temperature: 0.7,
    maxTokens: 2000,
  },
};
```

**Use cases:**
- Generate articles from annotations
- Create summaries of source material
- Expand notes into full documents

## Job Type: Highlight Detection

Highlight detection identifies key passages that should be highlighted for emphasis.

**Parameters:**

```typescript
interface HighlightDetectionParams {
  // Target resource
  resourceId: ResourceId;

  // Options
  instructions?: string;  // User guidance for AI
  density?: number;       // 1-15 highlights per 2000 words
}
```

**Progress:**

```typescript
interface HighlightDetectionProgress {
  stage: 'analyzing' | 'creating';
  percentage: number;
  message?: string;
}
```

**Result:**

```typescript
interface HighlightDetectionResult {
  highlightsFound: number;
  highlightsCreated: number;
}
```

**Example:**

```typescript
import type { PendingJob, HighlightDetectionParams } from '@semiont/jobs';

const job: PendingJob<HighlightDetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-111'),
    type: 'highlight-detection',
    userId: userId('user@example.com'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 1,
  },
  params: {
    resourceId: resourceId('doc-222'),
    instructions: 'Highlight key findings and conclusions',
    density: 5, // 5 highlights per 2000 words
  },
};
```

**Use cases:**
- Automatic highlighting of key passages
- Study guide generation
- Content curation for readers

## Job Type: Assessment Detection

Assessment detection generates evaluative comments on content quality, accuracy, or style.

**Parameters:**

```typescript
interface AssessmentDetectionParams {
  // Target resource
  resourceId: ResourceId;

  // Options
  instructions?: string;  // User guidance for AI
  tone?: 'analytical' | 'critical' | 'balanced' | 'constructive';
  density?: number;       // 1-10 assessments per 2000 words
}
```

**Progress:**

```typescript
interface AssessmentDetectionProgress {
  stage: 'analyzing' | 'creating';
  percentage: number;
  message?: string;
}
```

**Result:**

```typescript
interface AssessmentDetectionResult {
  assessmentsFound: number;
  assessmentsCreated: number;
}
```

**Example:**

```typescript
import type { PendingJob, AssessmentDetectionParams } from '@semiont/jobs';

const job: PendingJob<AssessmentDetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-333'),
    type: 'assessment-detection',
    userId: userId('user@example.com'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 1,
  },
  params: {
    resourceId: resourceId('doc-444'),
    instructions: 'Evaluate argument strength and evidence quality',
    tone: 'analytical',
    density: 3,
  },
};
```

**Use cases:**
- Automated content review
- Quality assessment for writing
- Editorial feedback generation

## Job Type: Comment Detection

Comment detection generates explanatory comments to help readers understand content.

**Parameters:**

```typescript
interface CommentDetectionParams {
  // Target resource
  resourceId: ResourceId;

  // Options
  instructions?: string;  // User guidance for AI
  tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical';
  density?: number;       // 2-12 comments per 2000 words
}
```

**Progress:**

```typescript
interface CommentDetectionProgress {
  stage: 'analyzing' | 'creating';
  percentage: number;
  message?: string;
}
```

**Result:**

```typescript
interface CommentDetectionResult {
  commentsFound: number;
  commentsCreated: number;
}
```

**Example:**

```typescript
import type { PendingJob, CommentDetectionParams } from '@semiont/jobs';

const job: PendingJob<CommentDetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-555'),
    type: 'comment-detection',
    userId: userId('user@example.com'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 1,
  },
  params: {
    resourceId: resourceId('doc-666'),
    instructions: 'Explain technical concepts for general audience',
    tone: 'explanatory',
    density: 6,
  },
};
```

**Use cases:**
- Educational annotations
- Technical documentation enhancement
- Onboarding content for complex topics

## Job Type: Tag Detection

Tag detection identifies passages that serve structural roles (introduction, conclusion, methodology, etc.).

**Parameters:**

```typescript
interface TagDetectionParams {
  // Target resource
  resourceId: ResourceId;

  // Schema
  schemaId: string;       // e.g., 'legal-irac', 'scientific-imrad'
  categories: string[];   // e.g., ['Issue', 'Rule', 'Application']
}
```

**Progress:**

```typescript
interface TagDetectionProgress {
  stage: 'analyzing' | 'creating';
  percentage: number;
  currentCategory?: string;
  processedCategories: number;
  totalCategories: number;
  message?: string;
}
```

**Result:**

```typescript
interface TagDetectionResult {
  tagsFound: number;
  tagsCreated: number;
  byCategory: Record<string, number>;  // { "Issue": 1, "Rule": 2 }
}
```

**Example:**

```typescript
import type { PendingJob, TagDetectionParams } from '@semiont/jobs';

// Legal document (IRAC schema)
const legalJob: PendingJob<TagDetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-777'),
    type: 'tag-detection',
    userId: userId('user@example.com'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 1,
  },
  params: {
    resourceId: resourceId('doc-888'),
    schemaId: 'legal-irac',
    categories: ['Issue', 'Rule', 'Application', 'Conclusion'],
  },
};

// Scientific paper (IMRaD schema)
const scientificJob: PendingJob<TagDetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-999'),
    type: 'tag-detection',
    userId: userId('user@example.com'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 1,
  },
  params: {
    resourceId: resourceId('doc-111'),
    schemaId: 'scientific-imrad',
    categories: ['Introduction', 'Methods', 'Results', 'Discussion'],
  },
};
```

**Use cases:**
- Structural analysis of legal documents
- Scientific paper organization
- Content outline generation

## Type Safety

Jobs use **two levels of discriminated unions** for maximum type safety:

1. **Status-based discrimination** - prevents accessing fields that don't exist in the current state
2. **Type-based discrimination** - differentiates between job types (generation, detection, etc.)

```typescript
type AnyJob =
  | PendingJob<any>
  | RunningJob<any>
  | CompleteJob<any>
  | FailedJob<any>
  | CancelledJob<any>;
```

### Status-Based Type Narrowing

```typescript
function processJob(job: AnyJob) {
  // Status narrowing - TypeScript knows what fields are available
  if (job.status === 'running') {
    console.log(job.progress);      // ✅ Available on running jobs
    console.log(job.startedAt);     // ✅ Available on running jobs
    // console.log(job.result);     // ❌ Compile error - not available on running
  }

  if (job.status === 'complete') {
    console.log(job.result);        // ✅ Available on complete jobs
    console.log(job.completedAt);   // ✅ Available on complete jobs
    // console.log(job.progress);   // ❌ Compile error - not available on complete
  }

  if (job.status === 'failed') {
    console.log(job.error);         // ✅ Available on failed jobs
    // console.log(job.result);     // ❌ Compile error - not available on failed
  }
}
```

### Type-Based Type Narrowing

```typescript
function processJob(job: AnyJob) {
  // Type narrowing by job type
  if (job.metadata.type === 'generation') {
    // TypeScript knows job.params is GenerationParams
    console.log(job.params.title);      // ✅ GenerationParams has title
    console.log(job.params.prompt);     // ✅ GenerationParams has prompt
  }

  if (job.metadata.type === 'detection') {
    // TypeScript knows job.params is DetectionParams
    console.log(job.params.resourceId);   // ✅ DetectionParams has resourceId
    console.log(job.params.entityTypes);  // ✅ DetectionParams has entityTypes
  }

  // Type narrowing with switch
  switch (job.metadata.type) {
    case 'detection':
      const detectionJob = job as RunningJob<DetectionParams, DetectionProgress>;
      console.log(detectionJob.params.resourceId);
      break;

    case 'generation':
      const generationJob = job as RunningJob<GenerationParams, GenerationProgress>;
      console.log(generationJob.params.title);
      break;

    // ... other cases
  }
}
```

### Combined Type Guards

```typescript
// Type guard combining status and type
function isRunningGenerationJob(
  job: AnyJob
): job is RunningJob<GenerationParams, GenerationProgress> {
  return job.status === 'running' && job.metadata.type === 'generation';
}

function isCompleteDetectionJob(
  job: AnyJob
): job is CompleteJob<DetectionParams, DetectionResult> {
  return job.status === 'complete' && job.metadata.type === 'detection';
}

// Usage
if (isRunningGenerationJob(job)) {
  // TypeScript knows:
  // - job.status is 'running'
  // - job.params is GenerationParams
  // - job.progress is GenerationProgress
  console.log(job.params.title);
  console.log(job.progress.stage);
}
```

## Progress Tracking

Different job types have different progress structures:

### Single-Stage Jobs

```typescript
// Detection jobs - progress only available on running jobs
if (job.status === 'running' && job.metadata.type === 'detection') {
  const detectionJob = job as RunningJob<DetectionParams, DetectionProgress>;

  // Immutable update pattern
  const updatedJob: RunningJob<DetectionParams, DetectionProgress> = {
    ...detectionJob,
    progress: {
      totalEntityTypes: 5,
      processedEntityTypes: 3,
      currentEntityType: 'Organization',
      entitiesFound: 42,
      entitiesEmitted: 38,
    },
  };
  await queue.updateJob(updatedJob);
}

// Tag detection jobs
if (job.status === 'running' && job.metadata.type === 'tag-detection') {
  const tagJob = job as RunningJob<TagDetectionParams, TagDetectionProgress>;

  const updatedJob: RunningJob<TagDetectionParams, TagDetectionProgress> = {
    ...tagJob,
    progress: {
      stage: 'analyzing',
      percentage: 60,
      currentCategory: 'Methods',
      processedCategories: 2,
      totalCategories: 4,
      message: 'Processing Methods section...',
    },
  };
  await queue.updateJob(updatedJob);
}
```

### Multi-Stage Jobs

```typescript
// Generation jobs progress through stages - immutable pattern
if (job.status === 'running' && job.metadata.type === 'generation') {
  const genJob = job as RunningJob<GenerationParams, GenerationProgress>;

  // Stage 1: Fetching
  let currentJob: RunningJob<GenerationParams, GenerationProgress> = {
    ...genJob,
    progress: {
      stage: 'fetching',
      percentage: 25,
      message: 'Fetching source content...',
    },
  };
  await queue.updateJob(currentJob);

  // Stage 2: Generating
  currentJob = {
    ...currentJob,
    progress: {
      stage: 'generating',
      percentage: 50,
      message: 'Generating content with AI...',
    },
  };
  await queue.updateJob(currentJob);

  // Stage 3: Creating
  currentJob = {
    ...currentJob,
    progress: {
      stage: 'creating',
      percentage: 75,
      message: 'Creating resource...',
    },
  };
  await queue.updateJob(currentJob);

  // Stage 4: Linking
  currentJob = {
    ...currentJob,
    progress: {
      stage: 'linking',
      percentage: 90,
      message: 'Linking to source...',
    },
  };
  await queue.updateJob(currentJob);
}
```

## Result Types

Each job type has a specific result structure (only available on complete jobs):

```typescript
// Detection results - type-safe access
if (job.status === 'complete' && job.metadata.type === 'detection') {
  const detectionJob = job as CompleteJob<DetectionParams, DetectionResult>;
  console.log(detectionJob.result.totalFound);      // ✅ Available
  console.log(detectionJob.result.totalEmitted);    // ✅ Available
  console.log(detectionJob.result.errors);          // ✅ Available
}

// Generation results
if (job.status === 'complete' && job.metadata.type === 'generation') {
  const generationJob = job as CompleteJob<GenerationParams, GenerationResult>;
  console.log(generationJob.result.resourceId);     // ✅ Available
  console.log(generationJob.result.resourceName);   // ✅ Available
}

// Highlight detection results
if (job.status === 'complete' && job.metadata.type === 'highlight-detection') {
  const highlightJob = job as CompleteJob<HighlightDetectionParams, HighlightDetectionResult>;
  console.log(highlightJob.result.highlightsFound);    // ✅ Available
  console.log(highlightJob.result.highlightsCreated);  // ✅ Available
}

// Assessment detection results
if (job.status === 'complete' && job.metadata.type === 'assessment-detection') {
  const assessmentJob = job as CompleteJob<AssessmentDetectionParams, AssessmentDetectionResult>;
  console.log(assessmentJob.result.assessmentsFound);    // ✅ Available
  console.log(assessmentJob.result.assessmentsCreated);  // ✅ Available
}

// Comment detection results
if (job.status === 'complete' && job.metadata.type === 'comment-detection') {
  const commentJob = job as CompleteJob<CommentDetectionParams, CommentDetectionResult>;
  console.log(commentJob.result.commentsFound);    // ✅ Available
  console.log(commentJob.result.commentsCreated);  // ✅ Available
}

// Tag detection results
if (job.status === 'complete' && job.metadata.type === 'tag-detection') {
  const tagJob = job as CompleteJob<TagDetectionParams, TagDetectionResult>;
  console.log(tagJob.result.tagsFound);       // ✅ Available
  console.log(tagJob.result.tagsCreated);     // ✅ Available
  console.log(tagJob.result.byCategory);      // ✅ Available
}
```

## Best Practices

### Job Creation

```typescript
// ✅ Generate unique IDs and use discriminated union structure
import { nanoid } from 'nanoid';

const job: PendingJob<GenerationParams> = {
  status: 'pending',
  metadata: {
    id: jobId(`job-${nanoid()}`),
    type: 'generation',
    userId: userId('user@example.com'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3, // AI tasks: 3 retries (1 for detection tasks)
  },
  params: {
    referenceId: annotationId('ref-1'),
    sourceResourceId: resourceId('doc-1'),
    title: 'Generated Article',
    prompt: 'Write about AI',
    language: 'en-US',
  },
};

// ❌ Don't use flat structure anymore
// const oldJob = { id, type, status, title, prompt, ... }
```

### Progress Updates

```typescript
// ✅ Update progress during processing (immutable pattern)
if (job.status === 'running') {
  const updatedJob: RunningJob<GenerationParams, GenerationProgress> = {
    ...job,
    progress: {
      stage: 'generating',
      percentage: Math.round((current / total) * 100),
      message: `Processing ${current}/${total}`,
    },
  };
  await queue.updateJob(updatedJob);
}

// ❌ Don't mutate job objects directly
// job.progress = { ... }  // BAD - mutation

// ❌ Don't update too frequently
// Throttle to ~1 update per second max
```

### Results

```typescript
// ✅ Return result from executeJob (worker handles completion)
protected async executeJob(job: AnyJob): Promise<GenerationResult> {
  if (job.status !== 'running') {
    throw new Error('Job must be running');
  }

  const genJob = job as RunningJob<GenerationParams, GenerationProgress>;

  // Do work...
  const resourceId = await createResource(content);

  // Return result - base class creates CompleteJob
  return {
    resourceId,
    resourceName: genJob.params.title,
  };
}

// ❌ Don't mutate job.result
// genJob.result = { ... }  // BAD - field doesn't exist on RunningJob
```
