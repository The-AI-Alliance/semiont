# Job Types Guide

Semiont supports multiple job types for different async tasks. All jobs share a common base structure and use discriminated union types for type safety.

## Table of Contents

- [Base Job Structure](#base-job-structure)
- [Job Type: Detection](#job-type-detection)
- [Job Type: Generation](#job-type-generation)
- [Job Type: Highlight Detection](#job-type-highlight-detection)
- [Job Type: Assessment Detection](#job-type-assessment-detection)
- [Job Type: Comment Detection](#job-type-comment-detection)
- [Job Type: Tag Detection](#job-type-tag-detection)
- [Type Safety](#type-safety)
- [Progress Tracking](#progress-tracking)
- [Result Types](#result-types)

## Base Job Structure

All jobs extend the `BaseJob` interface:

```typescript
interface BaseJob {
  // Identity
  id: JobId;              // Unique job identifier
  type: JobType;          // Job type discriminator
  userId: UserId;         // User who created job

  // Status
  status: JobStatus;      // Current status

  // Timestamps
  created: string;        // ISO 8601 creation time
  startedAt?: string;     // ISO 8601 start time (set by worker)
  completedAt?: string;   // ISO 8601 completion time (set by worker)

  // Error handling
  error?: string;         // Error message if failed
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

```typescript
interface DetectionJob extends BaseJob {
  type: 'detection';

  // Target resource
  resourceId: ResourceId;

  // What to detect
  entityTypes: EntityType[];  // e.g., ['Person', 'Organization']

  // Options
  includeDescriptiveReferences?: boolean;  // Include "the CEO", "the company"

  // Progress tracking
  progress?: {
    totalEntityTypes: number;
    processedEntityTypes: number;
    currentEntityType?: string;
    entitiesFound: number;
    entitiesEmitted: number;
  };

  // Result
  result?: {
    totalFound: number;
    totalEmitted: number;
    errors: number;
  };
}
```

**Example:**

```typescript
import { jobId, entityType } from '@semiont/api-client';
import { userId, resourceId } from '@semiont/core';
import type { DetectionJob } from '@semiont/jobs';

const job: DetectionJob = {
  id: jobId('job-123'),
  type: 'detection',
  status: 'pending',
  userId: userId('user@example.com'),
  resourceId: resourceId('doc-456'),
  entityTypes: [
    entityType('Person'),
    entityType('Organization'),
    entityType('Location'),
  ],
  includeDescriptiveReferences: true,
  created: new Date().toISOString(),
  retryCount: 0,
  maxRetries: 3,
};
```

**Use cases:**
- Extract entities from documents for knowledge graphs
- Index content by people, organizations, locations
- Enable entity-based search and filtering

## Job Type: Generation

Generation creates new content using AI based on source material and prompts.

```typescript
interface GenerationJob extends BaseJob {
  type: 'generation';

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

  // Progress tracking
  progress?: {
    stage: 'fetching' | 'generating' | 'creating' | 'linking';
    percentage: number;
    message?: string;
  };

  // Result
  result?: {
    resourceId: ResourceId;
    resourceName: string;
  };
}
```

**Example:**

```typescript
import type { GenerationJob, GenerationContext } from '@semiont/jobs';

const job: GenerationJob = {
  id: jobId('job-789'),
  type: 'generation',
  status: 'pending',
  userId: userId('user@example.com'),
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
  created: new Date().toISOString(),
  retryCount: 0,
  maxRetries: 3,
};
```

**Use cases:**
- Generate articles from annotations
- Create summaries of source material
- Expand notes into full documents

## Job Type: Highlight Detection

Highlight detection identifies key passages that should be highlighted for emphasis.

```typescript
interface HighlightDetectionJob extends BaseJob {
  type: 'highlight-detection';

  // Target resource
  resourceId: ResourceId;

  // Options
  instructions?: string;  // User guidance for AI
  density?: number;       // 1-15 highlights per 2000 words

  // Progress tracking
  progress?: {
    stage: 'analyzing' | 'creating';
    percentage: number;
    message?: string;
  };

  // Result
  result?: {
    highlightsFound: number;
    highlightsCreated: number;
  };
}
```

**Example:**

```typescript
import type { HighlightDetectionJob } from '@semiont/jobs';

const job: HighlightDetectionJob = {
  id: jobId('job-111'),
  type: 'highlight-detection',
  status: 'pending',
  userId: userId('user@example.com'),
  resourceId: resourceId('doc-222'),
  instructions: 'Highlight key findings and conclusions',
  density: 5, // 5 highlights per 2000 words
  created: new Date().toISOString(),
  retryCount: 0,
  maxRetries: 1,
};
```

**Use cases:**
- Automatic highlighting of key passages
- Study guide generation
- Content curation for readers

## Job Type: Assessment Detection

Assessment detection generates evaluative comments on content quality, accuracy, or style.

```typescript
interface AssessmentDetectionJob extends BaseJob {
  type: 'assessment-detection';

  // Target resource
  resourceId: ResourceId;

  // Options
  instructions?: string;  // User guidance for AI
  tone?: 'analytical' | 'critical' | 'balanced' | 'constructive';
  density?: number;       // 1-10 assessments per 2000 words

  // Progress tracking
  progress?: {
    stage: 'analyzing' | 'creating';
    percentage: number;
    message?: string;
  };

  // Result
  result?: {
    assessmentsFound: number;
    assessmentsCreated: number;
  };
}
```

**Example:**

```typescript
import type { AssessmentDetectionJob } from '@semiont/jobs';

const job: AssessmentDetectionJob = {
  id: jobId('job-333'),
  type: 'assessment-detection',
  status: 'pending',
  userId: userId('user@example.com'),
  resourceId: resourceId('doc-444'),
  instructions: 'Evaluate argument strength and evidence quality',
  tone: 'analytical',
  density: 3,
  created: new Date().toISOString(),
  retryCount: 0,
  maxRetries: 1,
};
```

**Use cases:**
- Automated content review
- Quality assessment for writing
- Editorial feedback generation

## Job Type: Comment Detection

Comment detection generates explanatory comments to help readers understand content.

```typescript
interface CommentDetectionJob extends BaseJob {
  type: 'comment-detection';

  // Target resource
  resourceId: ResourceId;

  // Options
  instructions?: string;  // User guidance for AI
  tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical';
  density?: number;       // 2-12 comments per 2000 words

  // Progress tracking
  progress?: {
    stage: 'analyzing' | 'creating';
    percentage: number;
    message?: string;
  };

  // Result
  result?: {
    commentsFound: number;
    commentsCreated: number;
  };
}
```

**Example:**

```typescript
import type { CommentDetectionJob } from '@semiont/jobs';

const job: CommentDetectionJob = {
  id: jobId('job-555'),
  type: 'comment-detection',
  status: 'pending',
  userId: userId('user@example.com'),
  resourceId: resourceId('doc-666'),
  instructions: 'Explain technical concepts for general audience',
  tone: 'explanatory',
  density: 6,
  created: new Date().toISOString(),
  retryCount: 0,
  maxRetries: 1,
};
```

**Use cases:**
- Educational annotations
- Technical documentation enhancement
- Onboarding content for complex topics

## Job Type: Tag Detection

Tag detection identifies passages that serve structural roles (introduction, conclusion, methodology, etc.).

```typescript
interface TagDetectionJob extends BaseJob {
  type: 'tag-detection';

  // Target resource
  resourceId: ResourceId;

  // Schema
  schemaId: string;       // e.g., 'legal-irac', 'scientific-imrad'
  categories: string[];   // e.g., ['Issue', 'Rule', 'Application']

  // Progress tracking
  progress?: {
    stage: 'analyzing' | 'creating';
    percentage: number;
    currentCategory?: string;
    processedCategories: number;
    totalCategories: number;
    message?: string;
  };

  // Result
  result?: {
    tagsFound: number;
    tagsCreated: number;
    byCategory: Record<string, number>;  // { "Issue": 1, "Rule": 2 }
  };
}
```

**Example:**

```typescript
import type { TagDetectionJob } from '@semiont/jobs';

// Legal document (IRAC schema)
const legalJob: TagDetectionJob = {
  id: jobId('job-777'),
  type: 'tag-detection',
  status: 'pending',
  userId: userId('user@example.com'),
  resourceId: resourceId('doc-888'),
  schemaId: 'legal-irac',
  categories: ['Issue', 'Rule', 'Application', 'Conclusion'],
  created: new Date().toISOString(),
  retryCount: 0,
  maxRetries: 1,
};

// Scientific paper (IMRaD schema)
const scientificJob: TagDetectionJob = {
  id: jobId('job-999'),
  type: 'tag-detection',
  status: 'pending',
  userId: userId('user@example.com'),
  resourceId: resourceId('doc-111'),
  schemaId: 'scientific-imrad',
  categories: ['Introduction', 'Methods', 'Results', 'Discussion'],
  created: new Date().toISOString(),
  retryCount: 0,
  maxRetries: 1,
};
```

**Use cases:**
- Structural analysis of legal documents
- Scientific paper organization
- Content outline generation

## Type Safety

Jobs use a discriminated union for type safety:

```typescript
type Job =
  | DetectionJob
  | GenerationJob
  | HighlightDetectionJob
  | AssessmentDetectionJob
  | CommentDetectionJob
  | TagDetectionJob;
```

### Type Narrowing

```typescript
function processJob(job: Job) {
  // Type narrowing with if
  if (job.type === 'generation') {
    console.log(job.title);      // ✅ GenerationJob has title
    console.log(job.entityTypes); // ❌ Error: not all jobs have this
  }

  // Type narrowing with switch
  switch (job.type) {
    case 'detection':
      console.log(job.resourceId);    // ✅ DetectionJob
      console.log(job.entityTypes);   // ✅ DetectionJob
      break;

    case 'generation':
      console.log(job.referenceId);   // ✅ GenerationJob
      console.log(job.prompt);        // ✅ GenerationJob
      break;

    // ... other cases
  }
}
```

### Type Guards

```typescript
function isGenerationJob(job: Job): job is GenerationJob {
  return job.type === 'generation';
}

function isDetectionJob(job: Job): job is DetectionJob {
  return job.type === 'detection';
}

// Usage
if (isGenerationJob(job)) {
  console.log(job.title); // ✅ TypeScript knows it's GenerationJob
}
```

## Progress Tracking

Different job types have different progress structures:

### Single-Stage Jobs

```typescript
// Detection jobs
job.progress = {
  totalEntityTypes: 5,
  processedEntityTypes: 3,
  currentEntityType: 'Organization',
  entitiesFound: 42,
  entitiesEmitted: 38,
};

// Tag detection jobs
job.progress = {
  stage: 'analyzing',
  percentage: 60,
  currentCategory: 'Methods',
  processedCategories: 2,
  totalCategories: 4,
  message: 'Processing Methods section...',
};
```

### Multi-Stage Jobs

```typescript
// Generation jobs progress through stages
job.progress = {
  stage: 'fetching',
  percentage: 25,
  message: 'Fetching source content...',
};

job.progress = {
  stage: 'generating',
  percentage: 50,
  message: 'Generating content with AI...',
};

job.progress = {
  stage: 'creating',
  percentage: 75,
  message: 'Creating resource...',
};

job.progress = {
  stage: 'linking',
  percentage: 90,
  message: 'Linking to source...',
};
```

## Result Types

Each job type has a specific result structure:

```typescript
// Detection results
detectionJob.result = {
  totalFound: 50,
  totalEmitted: 45,
  errors: 5,
};

// Generation results
generationJob.result = {
  resourceId: resourceId('doc-new'),
  resourceName: 'Generated Article',
};

// Highlight detection results
highlightJob.result = {
  highlightsFound: 12,
  highlightsCreated: 12,
};

// Assessment detection results
assessmentJob.result = {
  assessmentsFound: 8,
  assessmentsCreated: 8,
};

// Comment detection results
commentJob.result = {
  commentsFound: 15,
  commentsCreated: 15,
};

// Tag detection results
tagJob.result = {
  tagsFound: 4,
  tagsCreated: 4,
  byCategory: {
    'Issue': 1,
    'Rule': 1,
    'Application': 1,
    'Conclusion': 1,
  },
};
```

## Best Practices

### Job Creation

```typescript
// ✅ Generate unique IDs
import { nanoid } from 'nanoid';
const job = {
  id: jobId(`job-${nanoid()}`),
  // ...
};

// ✅ Set creation timestamp
const job = {
  created: new Date().toISOString(),
  // ...
};

// ✅ Configure retries appropriately
const job = {
  retryCount: 0,
  maxRetries: 3, // AI tasks: 3 retries
  // maxRetries: 1, // Detection tasks: 1 retry
  // ...
};
```

### Progress Updates

```typescript
// ✅ Update progress during processing
job.progress = {
  stage: 'generating',
  percentage: Math.round((current / total) * 100),
  message: `Processing ${current}/${total}`,
};
await queue.updateJob(job);

// ❌ Don't update too frequently
// Throttle to ~1 update per second max
```

### Results

```typescript
// ✅ Set complete result before job finishes
job.result = {
  resourceId,
  resourceName,
};
// Worker will move to 'complete' status

// ❌ Don't forget to set results
// Job will complete but have no output
```
