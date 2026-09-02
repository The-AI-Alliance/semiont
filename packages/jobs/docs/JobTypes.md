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
  userName: string;       // Audit-only snapshot of the requesting user
  userEmail: string;      // Audit-only snapshot of the requesting user
  userDomain: string;     // Audit-only snapshot of the requesting user
  created: string;        // ISO 8601
  retryCount: number;
  maxRetries: number;
  completedUnits?: string[];  // Checkpoint: units a failed attempt persisted
                              // (entity types, for reference-annotation);
                              // written only by failJob, the retry skips them
}
```

The `userName`, `userEmail`, and `userDomain` fields are an audit-only snapshot of the requesting user, persisted in the on-disk job file. Workers derive annotation `creator` attribution from `userId` via `didToAgent()`.

## Reference Annotation (`reference-annotation`)

Entity reference detection — finds named entities (people, organizations, locations) in a resource using AI inference.

**Parameters:**

```typescript
interface DetectionParams {
  resourceId: ResourceId;
  entityTypes: EntityType[];
  includeDescriptiveReferences?: boolean;
  language?: string;        // Annotation body locale (BCP-47)
  sourceLanguage?: string;  // Source resource locale (BCP-47)
}
```

**Progress:**

```typescript
interface DetectionProgress {
  totalEntityTypes: number;
  processedEntityTypes: number;
  entitiesFound: number;
  entitiesEmitted: number;
}
```

**Result:**

```typescript
interface DetectionResult {
  kind: 'reference-annotation';   // discriminant — every JobResult member carries one
  totalFound: number;
  totalEmitted: number;
  errors: number;
}
```

**Example:**

```typescript
import type { PendingJob, DetectionParams } from '@semiont/jobs';
import { jobId, userId, resourceId } from '@semiont/core';

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
    maxRetries: 1,   // detection re-scans the same content — one self-heal retry
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

**Parameters:** `GenerationJobParams`, generated from the OpenAPI spec into
`@semiont/core` — one type shared by the SDK's `yield.fromContext(context,
options)` surface and this worker, so the params bag is exactly *options + the
gathered context*.

```typescript
interface GenerationJobParams {
  title: string;                    // Required — title of the generated resource;
                                    // also the LLM topic
  storageUri: string;               // Required
  context: GatheredContext;         // Required — grounds the prompt, and NAMES THE
                                    // ANCHOR (see "Ids come from the focus" below)
  prompt?: string;                  // Freeform refinement — rendered as an authoritative
                                    // "Instruction:" line under the task framing
  entityTypes?: EntityType[];
  language?: string;                // Generated-content locale, e.g., 'en-US'
  sourceLanguage?: string;          // Source resource locale (BCP-47)
  temperature?: number;
  maxTokens?: number;               // Length only — never implies structure
  outputMediaType?: SupportedMediaType; // Default text/markdown; only text/markdown |
                                    // text/plain are produced — anything else fails the job
  task?: 'resource' | 'answer' | 'summary' | (string & {});
                                    // Framing (what to produce). Unknown strings are used
                                    // verbatim as the framing + a worker warn (loud degrade)
  structure?: 'prose' | 'sections' | 'chat' | (string & {});
                                    // Shape, subordinate to outputMediaType. Unknown strings
                                    // become "Organize the output as: …" + warn. UNSET ⇒ no
                                    // structure directive at all
  cite?: boolean;                   // Inline citations: model emits [[<id>]] tokens; the worker
                                    // strips them pre-upload and mints W3C linking annotations
                                    // on the derived resource (hallucination-guarded against the
                                    // embedded context ids). Off ⇒ resolver never runs
}
```

**Ids come from the focus.** Generation params carry no `referenceId`, and the
`job:create` envelope carries no `resourceId` — the context already names its
anchor, so sending the ids beside it would encode the same fact twice and let
the two disagree. The dispatcher derives the job's `resourceId` from
`context.focus` (resource focus → `focus.resource`; annotation focus →
`focus.sourceResource`) and rejects a caller-supplied id outright. In the
worker, `referenceIdOf(job)` is the one derivation:

| `context.focus.kind` | `referenceIdOf(job)` | what the worker does |
|---|---|---|
| `annotation` | `focus.annotation.id` | uploads with `sourceAnnotationId` — the Stower auto-binds the triggering reference |
| `resource` | `undefined` | mints a source→derived provenance reference instead |

The same helper serves every other jobType by passing their own
`params.referenceId` through — detection echoes still carry one.

**Progress:**

```typescript
interface YieldProgress {
  /** The two real generation transitions — LLM call running, then persisting. */
  stage: 'generating' | 'creating';
  percentage: number;
  message?: string;
}
```

Note: The progress type is `YieldProgress`, not `GenerationProgress`. On the wire,
progress is the coded `JobProgressMessage` — for generation exactly three frames:
5% `generating-resource`, 95% `creating-resource`, and the terminal 100%
`complete-generated` carrying required `truncated`.

**Result:**

```typescript
interface GenerationResult {
  kind: 'generation';
  resourceId: ResourceId;
  resourceName: string;
  truncated: boolean;   // true ⇒ the model stopped at the maxTokens ceiling —
                        // the artifact is cut off, not complete. Never silent.
}
```

**Example:**

```typescript
import type { PendingJob } from '@semiont/jobs';
import type { GenerationJobParams } from '@semiont/core';

const job: PendingJob<GenerationJobParams> = {
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
    // Generation is non-idempotent — a retry re-rolls the LLM and produces
    // different content, not a replay — so the dispatcher sets 0 here.
    // Detection jobs re-scan the same content and keep one self-heal retry.
    maxRetries: 0,
  },
  params: {
    title: 'Article about Quantum Computing',
    storageUri: 'file://generated/quantum-computing.md',
    // The context carries the anchor. This one is annotation-focus, so the
    // worker auto-binds the new resource to focus.annotation — no referenceId
    // field, and no resourceId on the envelope that created this job.
    context: {
      focus: {
        kind: 'annotation',
        annotation: { /* W3C Annotation — its `id` is the auto-bind target */ },
        sourceResource: { '@id': 'doc-456' /* … */ },
      },
      graph: { /* … */ },
      metadata: { /* … */ },
    },
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
  density?: number;         // 1-15 highlights per 2000 words
  sourceLanguage?: string;  // Source resource locale (BCP-47)
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
  kind: 'highlight-annotation';
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
  density?: number;         // 1-10 assessments per 2000 words
  language?: string;        // Annotation body locale (BCP-47)
  sourceLanguage?: string;  // Source resource locale (BCP-47)
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
  kind: 'assessment-annotation';
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
  density?: number;         // 2-12 comments per 2000 words
  language?: string;        // Annotation body locale (BCP-47)
  sourceLanguage?: string;  // Source resource locale (BCP-47)
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
  kind: 'comment-annotation';
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
  schema: TagSchema;        // Full schema object (e.g., legal-irac, scientific-imrad)
  categories: string[];     // e.g., ['Issue', 'Rule', 'Application']
  language?: string;        // Annotation body locale (BCP-47)
  sourceLanguage?: string;  // Source resource locale (BCP-47)
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
  kind: 'tag-annotation';
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
    schema: {
      id: 'legal-irac',
      name: 'IRAC',
      description: 'Legal analysis structure',
      domain: 'legal',
      tags: [
        { name: 'Issue', description: 'The legal question presented', examples: [] },
        { name: 'Rule', description: 'The governing legal rule', examples: [] },
        { name: 'Application', description: 'Application of rule to facts', examples: [] },
        { name: 'Conclusion', description: 'The resulting conclusion', examples: [] },
      ],
    },
    categories: ['Issue', 'Rule', 'Application', 'Conclusion'],
  },
};
```

## Concrete Job Type Aliases

```typescript
type DetectionJob = Job<DetectionParams, DetectionProgress, DetectionResult>;
type GenerationJob = Job<GenerationJobParams, YieldProgress, GenerationResult>;
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
    console.log(job.progress);      // Available
    // console.log(job.result);     // Compile error
  }
  if (job.status === 'complete') {
    console.log(job.result);        // Available
    // console.log(job.progress);   // Compile error
  }
}
```

### Combined Type Guards

```typescript
function isRunningGenerationJob(
  job: AnyJob
): job is RunningJob<GenerationJobParams, YieldProgress> {
  return job.status === 'running' && job.metadata.type === 'generation';
}

if (isRunningGenerationJob(job)) {
  console.log(job.params.title);     // GenerationJobParams
  console.log(job.progress.stage);   // YieldProgress
}
```
