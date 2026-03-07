# API Reference

Complete API reference for `@semiont/make-meaning`.

## ResourceContext

Provides resource metadata and content assembly from event-sourced storage.

### getResourceMetadata()

Get resource metadata from view storage.

**Implementation**: [src/resource-context.ts:15-28](../src/resource-context.ts)

```typescript
static async getResourceMetadata(
  resourceId: ResourceId,
  config: EnvironmentConfig
): Promise<ResourceDescriptor | null>
```

**Returns**: Resource descriptor with metadata and representations, or `null` if not found.

### listResources()

List resources with optional filtering.

**Implementation**: [src/resource-context.ts:30-48](../src/resource-context.ts)

```typescript
static async listResources(
  filters: ListResourcesFilters | undefined,
  config: EnvironmentConfig
): Promise<ResourceDescriptor[]>
```

**Filters**:
```typescript
interface ListResourcesFilters {
  createdAfter?: string;
  createdBefore?: string;
  mimeType?: string;
  limit?: number;
}
```

### addContentPreviews()

Add content previews to resource descriptors.

**Implementation**: [src/resource-context.ts:50-77](../src/resource-context.ts)

```typescript
static async addContentPreviews(
  resources: ResourceDescriptor[],
  config: EnvironmentConfig
): Promise<Array<ResourceDescriptor & { content: string }>>
```

Loads content from RepresentationStore and adds it to each resource descriptor.

---

## AnnotationContext

Consolidated annotation operations including queries, context building, and AI summarization.

### buildLLMContext()

Build LLM context for an annotation (includes surrounding text).

**Implementation**: [src/annotation-context.ts:35-120](../src/annotation-context.ts)

```typescript
static async buildLLMContext(
  annotationUri: AnnotationUri,
  resourceId: ResourceId,
  config: EnvironmentConfig,
  options: BuildContextOptions
): Promise<AnnotationLLMContextResponse>
```

**Options**:
```typescript
interface BuildContextOptions {
  contextLines?: number;        // Lines of surrounding text (default: 5)
  includeMetadata?: boolean;    // Include resource metadata (default: true)
}
```

**Returns**: Full context for AI processing including annotation, surrounding text, and metadata.

### getResourceAnnotations()

Get all annotations for a resource, organized by motivation.

**Implementation**: [src/annotation-context.ts:122-172](../src/annotation-context.ts)

```typescript
static async getResourceAnnotations(
  resourceId: ResourceId,
  config: EnvironmentConfig
): Promise<ResourceAnnotations>
```

**Returns**: Annotations grouped by motivation (highlighting, commenting, etc.)

### getAllAnnotations()

Get all annotations for a resource (flat list).

**Implementation**: [src/annotation-context.ts:174-187](../src/annotation-context.ts)

```typescript
static async getAllAnnotations(
  resourceId: ResourceId,
  config: EnvironmentConfig
): Promise<Annotation[]>
```

### getAnnotation()

Get a specific annotation by ID.

**Implementation**: [src/annotation-context.ts:189-202](../src/annotation-context.ts)

```typescript
static async getAnnotation(
  annotationId: AnnotationId,
  resourceId: ResourceId,
  config: EnvironmentConfig
): Promise<Annotation | null>
```

### listAnnotations()

List annotations with optional filtering.

**Implementation**: [src/annotation-context.ts:204-225](../src/annotation-context.ts)

```typescript
static async listAnnotations(
  filters: { resourceId?: ResourceId; type?: AnnotationCategory } | undefined,
  config: EnvironmentConfig
): Promise<Annotation[]>
```

### resourceExists()

Check if a resource exists in view storage.

**Implementation**: [src/annotation-context.ts:227-236](../src/annotation-context.ts)

```typescript
static async resourceExists(
  resourceId: ResourceId,
  config: EnvironmentConfig
): Promise<boolean>
```

### getResourceStats()

Get resource statistics (version, last updated).

**Implementation**: [src/annotation-context.ts:238-254](../src/annotation-context.ts)

```typescript
static async getResourceStats(
  resourceId: ResourceId,
  config: EnvironmentConfig
): Promise<{
  resourceId: ResourceId;
  version: number;
  updatedAt: string;
}>
```

### getAnnotationContext()

Get annotation context (surrounding text).

**Implementation**: [src/annotation-context.ts:256-314](../src/annotation-context.ts)

```typescript
static async getAnnotationContext(
  annotationId: AnnotationId,
  resourceId: ResourceId,
  contextBefore: number,
  contextAfter: number,
  config: EnvironmentConfig
): Promise<AnnotationContextResponse>
```

### generateAnnotationSummary()

Generate AI summary of an annotation.

**Implementation**: [src/annotation-context.ts:316-381](../src/annotation-context.ts)

```typescript
static async generateAnnotationSummary(
  annotationId: AnnotationId,
  resourceId: ResourceId,
  config: EnvironmentConfig
): Promise<ContextualSummaryResponse>
```

Uses AI to generate a contextual summary of the annotation including surrounding text.

---

## GraphContext

Provides graph database operations for traversing resource relationships. All operations are delegated to @semiont/graph.

### getBacklinks()

Get all resources referencing this resource (backlinks).

**Implementation**: [src/graph-context.ts:26-30](../src/graph-context.ts)

```typescript
static async getBacklinks(
  resourceId: ResourceId,
  config: EnvironmentConfig
): Promise<Annotation[]>
```

Requires graph traversal - uses @semiont/graph.

### findPath()

Find shortest path between two resources.

**Implementation**: [src/graph-context.ts:36-44](../src/graph-context.ts)

```typescript
static async findPath(
  fromResourceId: ResourceId,
  toResourceId: ResourceId,
  config: EnvironmentConfig,
  maxDepth?: number
): Promise<GraphPath[]>
```

Requires graph traversal - uses @semiont/graph.

### getResourceConnections()

Get resource connections (graph edges).

**Implementation**: [src/graph-context.ts:50-53](../src/graph-context.ts)

```typescript
static async getResourceConnections(
  resourceId: ResourceId,
  config: EnvironmentConfig
): Promise<GraphConnection[]>
```

Requires graph traversal - uses @semiont/graph.

### searchResources()

Search resources by name (cross-resource query).

**Implementation**: [src/graph-context.ts:59-62](../src/graph-context.ts)

```typescript
static async searchResources(
  query: string,
  config: EnvironmentConfig,
  limit?: number
): Promise<ResourceDescriptor[]>
```

Requires full-text search - uses @semiont/graph.

---

## AnnotationDetection

AI-powered semantic pattern detection. Orchestrates the full pipeline: resource content → AI prompts → response parsing → validated matches.

### detectComments()

Detect passages that merit commentary.

**Implementation**: [src/annotation-detection.ts:27-65](../src/annotation-detection.ts)

```typescript
static async detectComments(
  resourceId: ResourceId,
  config: EnvironmentConfig,
  instructions?: string,
  tone?: string,
  density?: number
): Promise<CommentMatch[]>
```

**Uses**: `MotivationPrompts.buildCommentPrompt`, `MotivationParsers.parseComments`

**Parameters**:
- `instructions`: Custom guidance for AI (e.g., "Focus on technical concepts")
- `tone`: Tone for comments (e.g., "educational", "analytical")
- `density`: Target density 0.0-1.0 (0.5 = ~50% of passages)

**Returns**:
```typescript
interface CommentMatch {
  exact: string;      // The exact text passage
  start: number;      // Character offset start
  end: number;        // Character offset end
  prefix?: string;    // Context before (for fuzzy anchoring)
  suffix?: string;    // Context after (for fuzzy anchoring)
  comment: string;    // The AI-generated comment
}
```

### detectHighlights()

Detect passages that should be highlighted.

**Implementation**: [src/annotation-detection.ts:67-101](../src/annotation-detection.ts)

```typescript
static async detectHighlights(
  resourceId: ResourceId,
  config: EnvironmentConfig,
  instructions?: string,
  density?: number
): Promise<HighlightMatch[]>
```

**Uses**: `MotivationPrompts.buildHighlightPrompt`, `MotivationParsers.parseHighlights`

**Returns**:
```typescript
interface HighlightMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
}
```

### detectAssessments()

Detect passages that merit assessment/evaluation.

**Implementation**: [src/annotation-detection.ts:103-141](../src/annotation-detection.ts)

```typescript
static async detectAssessments(
  resourceId: ResourceId,
  config: EnvironmentConfig,
  instructions?: string,
  tone?: string,
  density?: number
): Promise<AssessmentMatch[]>
```

**Uses**: `MotivationPrompts.buildAssessmentPrompt`, `MotivationParsers.parseAssessments`

**Returns**:
```typescript
interface AssessmentMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  assessment: string;  // The AI-generated assessment
}
```

### detectTags()

Detect and extract structured tags from text.

**Implementation**: [src/annotation-detection.ts:143-197](../src/annotation-detection.ts)

```typescript
static async detectTags(
  resourceId: ResourceId,
  config: EnvironmentConfig,
  schemaId: string,
  category: string
): Promise<TagMatch[]>
```

**Uses**: `MotivationPrompts.buildTagPrompt`, `MotivationParsers.parseTags`

**Parameters**:
- `schemaId`: Tag schema ID from @semiont/ontology (e.g., 'irac', 'imrad')
- `category`: Category within the schema (e.g., 'issue', 'rule')

**Returns**:
```typescript
interface TagMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  category: string;    // The tag category
}
```

**Example**:
```typescript
// Detect "issue" statements in a legal brief using IRAC schema
const tags = await AnnotationDetection.detectTags(
  resourceId,
  config,
  'irac',   // Schema from @semiont/ontology
  'issue'   // Category
);
```

See [@semiont/ontology](../../ontology/README.md) for available schemas.

---

## Type Exports

Re-exported from [@semiont/inference](../../inference/README.md) for convenience:

```typescript
export type {
  CommentMatch,
  HighlightMatch,
  AssessmentMatch,
  TagMatch,
} from '@semiont/inference';
```

Re-exported job workers:

```typescript
export { CommentDetectionWorker } from './jobs/comment-detection-worker';
export { HighlightDetectionWorker } from './jobs/highlight-detection-worker';
export { AssessmentDetectionWorker } from './jobs/assessment-detection-worker';
export { TagDetectionWorker } from './jobs/tag-detection-worker';
export { ReferenceDetectionWorker } from './jobs/reference-detection-worker';
export { GenerationWorker } from './jobs/generation-worker';
```

See [Job Workers](./job-workers.md) for worker documentation.
