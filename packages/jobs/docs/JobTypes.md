# Job Types Guide

All job types, their parameters, progress, and result types. Jobs use discriminated unions based on status for type safety.

**See also**: [Type System Guide](./TYPES.md) for discriminated union architecture and type narrowing patterns.

## Job Type Enum

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
  created: string;        // ISO 8601
  retryCount: number;
  maxRetries: number;
}
```

The `userName`, `userEmail`, and `userDomain` fields are used by workers to build the W3C `Agent` for annotation `creator` attribution via `userToAgent()`.

## Reference Annotation (`reference-annotation`)

Entity reference detection — finds named entities (people, organizations, locations) in a resource using AI inference.

**Parameters:**

```typescript
interface DetectionParams {
  resourceId: ResourceId;
  entityTypes: EntityType[];
  includeDescriptiveReferences?: boolean;
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
import type { PendingJob, DetectionParams } from '@semiont/jobs';
import { jobId } from '@semiont/api-client';
import { userId, resourceId } from '@semiont/core';

const job: PendingJob<DetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-123'),
    type: 'reference-annotation',
    userId: userId('user@example.com'),
    userName: 'Jane Doe',
    userEmail: 'jane@example.com',
    userDomain: 'example.com',
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
  },
  params: {
    resourceId: resourceId('doc-456'),
    entityTypes: ['Person', 'Organization', 'Location'],
    includeDescriptiveReferences: true,
  },
};
```

## Generation (`generation`)

AI content generation — creates new resources from source material and prompts.

**Parameters:**

```typescript
interface GenerationParams {
  referenceId: AnnotationId;
  sourceResourceId: ResourceId;
  sourceResourceName: string;
  annotation: Annotation;           // Full W3C Annotation
  prompt?: string;
  title?: string;
  entityTypes?: EntityType[];
  language?: string;                // e.g., 'en-US'
  context?: GatheredContext;
  temperature?: number;
  maxTokens?: number;
}
```

**Progress:**

```typescript
interface YieldProgress {
  stage: 'fetching' | 'generating' | 'creating' | 'linking';
  percentage: number;
  message?: string;
}
```

Note: The progress type is `YieldProgress`, not `GenerationProgress`.

**Result:**

```typescript
interface GenerationResult {
  resourceId: ResourceId;
  resourceName: string;
}
```

**Example:**

```typescript
import type { PendingJob, GenerationParams } from '@semiont/jobs';

const job: PendingJob<GenerationParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-789'),
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
    annotation: { /* W3C Annotation */ },
    title: 'Article about Quantum Computing',
    prompt: 'Write a comprehensive overview',
    language: 'en-US',
  },
};
```

## Highlight Annotation (`highlight-annotation`)

Key passage highlighting — identifies passages that should be highlighted for emphasis.

**Parameters:**

```typescript
interface HighlightDetectionParams {
  resourceId: ResourceId;
  instructions?: string;
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
const job: PendingJob<HighlightDetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-111'),
    type: 'highlight-annotation',
    userId: userId('user@example.com'),
    userName: 'Jane Doe',
    userEmail: 'jane@example.com',
    userDomain: 'example.com',
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 1,
  },
  params: {
    resourceId: resourceId('doc-222'),
    instructions: 'Highlight key findings and conclusions',
    density: 5,
  },
};
```

## Assessment Annotation (`assessment-annotation`)

Evaluative assessments — generates evaluative comments on content quality, accuracy, or style.

**Parameters:**

```typescript
interface AssessmentDetectionParams {
  resourceId: ResourceId;
  instructions?: string;
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

## Comment Annotation (`comment-annotation`)

Explanatory comments — generates comments to help readers understand content.

**Parameters:**

```typescript
interface CommentDetectionParams {
  resourceId: ResourceId;
  instructions?: string;
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

## Tag Annotation (`tag-annotation`)

Structural role tagging — identifies passages that serve structural roles (introduction, conclusion, methodology).

**Parameters:**

```typescript
interface TagDetectionParams {
  resourceId: ResourceId;
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
  byCategory: Record<string, number>;
}
```

**Example:**

```typescript
const job: PendingJob<TagDetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId('job-777'),
    type: 'tag-annotation',
    userId: userId('user@example.com'),
    userName: 'Jane Doe',
    userEmail: 'jane@example.com',
    userDomain: 'example.com',
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
```

## Concrete Job Type Aliases

```typescript
type DetectionJob = Job<DetectionParams, DetectionProgress, DetectionResult>;
type GenerationJob = Job<GenerationParams, YieldProgress, GenerationResult>;
type HighlightDetectionJob = Job<HighlightDetectionParams, HighlightDetectionProgress, HighlightDetectionResult>;
type AssessmentDetectionJob = Job<AssessmentDetectionParams, AssessmentDetectionProgress, AssessmentDetectionResult>;
type CommentDetectionJob = Job<CommentDetectionParams, CommentDetectionProgress, CommentDetectionResult>;
type TagDetectionJob = Job<TagDetectionParams, TagDetectionProgress, TagDetectionResult>;

type AnyJob = DetectionJob | GenerationJob | HighlightDetectionJob | AssessmentDetectionJob | CommentDetectionJob | TagDetectionJob;
```

## Type Safety

### Status-Based Narrowing

```typescript
function processJob(job: AnyJob) {
  if (job.status === 'running') {
    console.log(job:progress);      // Available
    // console.log(job.result);     // Compile error
  }
  if (job.status === 'complete') {
    console.log(job.result);        // Available
    // console.log(job:progress);   // Compile error
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
  console.log(job.params.title);     // GenerationParams
  console.log(job:progress.stage);   // YieldProgress
}
```
