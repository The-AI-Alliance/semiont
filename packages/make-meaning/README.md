# @semiont/make-meaning

[![npm version](https://img.shields.io/npm/v/@semiont/make-meaning)](https://www.npmjs.com/package/@semiont/make-meaning)
[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+make-meaning%22)

**Making meaning from resources through context assembly, pattern detection, and relationship reasoning.**

This package transforms raw resources into meaningful, interconnected knowledge. It provides the core capabilities for:

- **Context Assembly**: Gathering resource metadata, content, and annotations from distributed storage
- **Pattern Detection**: AI-powered discovery of semantic patterns (comments, highlights, assessments, tags)
- **Graph Reasoning**: Navigating relationships and connections between resources

## Philosophy

Resources don't exist in isolation. A document becomes meaningful when we understand its annotations, its relationships to other resources, and the patterns within its content. `@semiont/make-meaning` provides the infrastructure to assemble this context from event-sourced storage, detect semantic patterns using AI, and reason about resource relationships through graph traversal.

This is the "applied meaning-making" layer - it sits between low-level AI primitives ([@semiont/inference](../inference/)) and high-level application orchestration ([apps/backend](../../apps/backend/)).

## Installation

```bash
npm install @semiont/make-meaning
```

## Quick Start

### Assemble Resource Context

```typescript
import { ResourceContext } from '@semiont/make-meaning';
import type { EnvironmentConfig } from '@semiont/core';

// Get resource metadata from event-sourced view storage
const resource = await ResourceContext.getResourceMetadata(resourceId, config);

// List all resources with optional filtering
const resources = await ResourceContext.listResources(
  { createdAfter: '2024-01-01' },
  config
);

// Add content previews to resource descriptors
const withContent = await ResourceContext.addContentPreviews(resources, config);
```

### Work with Annotations

```typescript
import { AnnotationContext } from '@semiont/make-meaning';

// Get all annotations for a resource
const annotations = await AnnotationContext.getResourceAnnotations(resourceId, config);

// Build LLM context for an annotation (includes surrounding text)
const context = await AnnotationContext.buildLLMContext(
  annotationUri,
  resourceId,
  config,
  { contextLines: 5 }
);

// Generate AI summary of an annotation
const summary = await AnnotationContext.generateAnnotationSummary(
  annotationId,
  resourceId,
  config
);
```

### Detect Semantic Patterns

```typescript
import { AnnotationDetection } from '@semiont/make-meaning';

// AI-powered detection of passages that merit commentary
const comments = await AnnotationDetection.detectComments(
  resourceId,
  config,
  'Focus on technical explanations',
  'educational',
  0.7
);

// Detect passages that should be highlighted
const highlights = await AnnotationDetection.detectHighlights(
  resourceId,
  config,
  'Find key definitions and important concepts',
  0.5
);

// Detect passages that merit assessment/evaluation
const assessments = await AnnotationDetection.detectAssessments(
  resourceId,
  config,
  'Evaluate clarity and technical accuracy',
  'constructive',
  0.6
);

// Detect and extract structured tags from text using ontology schemas
const tags = await AnnotationDetection.detectTags(
  resourceId,
  config,
  'irac',  // Schema ID from @semiont/ontology
  'issue'  // Category within the schema
);
```

### Structured Tagging with Ontology Schemas

A powerful use case is **structured tagging** using tag schemas defined in [@semiont/ontology](../ontology/). For example, legal writing can be analyzed using the IRAC framework (Issue, Rule, Application, Conclusion):

```typescript
import { AnnotationDetection } from '@semiont/make-meaning';

// Analyze a legal brief using IRAC schema
const categories = ['issue', 'rule', 'application', 'conclusion'];

for (const category of categories) {
  const tags = await AnnotationDetection.detectTags(
    resourceId,
    config,
    'irac',      // Tag schema from @semiont/ontology
    category     // Which category to detect
  );

  console.log(`Found ${tags.length} ${category} passages`);
}
```

**Why this matters:**

When you tag multiple documents with the same schema (e.g., IRAC for legal briefs, IMRAD for scientific papers), you create a **structured semantic layer** across your corpus:

- **Rich traversal**: Find all "issue" statements across 100 legal briefs
- **Cross-document analysis**: Compare how different authors structure their "application" sections
- **Context retrieval**: When reading one brief, see related "rule" passages from other cases
- **Graph-based reasoning**: Trace argument patterns across your entire document collection

This transforms a collection of unstructured documents into a queryable knowledge base organized by domain-specific rhetorical structures.

See [@semiont/ontology](../ontology/) for available tag schemas and how to define custom schemas.

### Navigate Resource Relationships

```typescript
import { GraphContext } from '@semiont/make-meaning';

// Find resources that link to this resource (backlinks)
const backlinks = await GraphContext.getBacklinks(resourceId, config);

// Find shortest path between two resources
const paths = await GraphContext.findPath(fromResourceId, toResourceId, config, 3);

// Get all connections for a resource
const connections = await GraphContext.getResourceConnections(resourceId, config);

// Full-text search across all resources
const results = await GraphContext.searchResources('neural networks', config, 10);
```

## Architecture

`@semiont/make-meaning` implements a **three-layer architecture**:

```
┌─────────────────────────────────────────────┐
│  apps/backend                               │
│  Job orchestration, progress tracking,      │
│  HTTP APIs, event emission                  │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│  @semiont/make-meaning                      │
│  Context assembly, pattern detection,       │
│  relationship reasoning                     │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│  @semiont/inference                         │
│  AI primitives: prompts, parsers,           │
│  generateText abstraction                   │
└─────────────────────────────────────────────┘
```

**Key principles:**

- **Event-sourced context**: Resources and annotations are assembled from event streams via view storage
- **Content-addressed storage**: Content retrieved using checksums, enabling deduplication and caching
- **Graph-backed relationships**: @semiont/graph provides graph traversal for backlinks, paths, and connections
- **Separation of concerns**: Detection logic (make-meaning) is separate from job orchestration (backend)

See [MAKE-MEANING-PACKAGE.md](../../MAKE-MEANING-PACKAGE.md) for complete architecture documentation.

## API Reference

### ResourceContext

Provides resource metadata and content assembly from event-sourced storage.

```typescript
class ResourceContext {
  /**
   * Get resource metadata from view storage
   * Implementation: packages/make-meaning/src/resource-context.ts:15-28
   */
  static async getResourceMetadata(
    resourceId: ResourceId,
    config: EnvironmentConfig
  ): Promise<ResourceDescriptor | null>

  /**
   * List resources with optional filtering
   * Implementation: packages/make-meaning/src/resource-context.ts:30-48
   */
  static async listResources(
    filters: ListResourcesFilters | undefined,
    config: EnvironmentConfig
  ): Promise<ResourceDescriptor[]>

  /**
   * Add content previews to resource descriptors
   * Implementation: packages/make-meaning/src/resource-context.ts:50-77
   */
  static async addContentPreviews(
    resources: ResourceDescriptor[],
    config: EnvironmentConfig
  ): Promise<Array<ResourceDescriptor & { content: string }>>
}
```

**Filters:**
```typescript
interface ListResourcesFilters {
  createdAfter?: string;
  createdBefore?: string;
  mimeType?: string;
  limit?: number;
}
```

### AnnotationContext

Consolidated annotation operations including queries, context building, and AI summarization.

```typescript
class AnnotationContext {
  /**
   * Build LLM context for an annotation (includes surrounding text)
   * Implementation: packages/make-meaning/src/annotation-context.ts:35-120
   */
  static async buildLLMContext(
    annotationUri: AnnotationUri,
    resourceId: ResourceId,
    config: EnvironmentConfig,
    options: BuildContextOptions
  ): Promise<AnnotationLLMContextResponse>

  /**
   * Get all annotations for a resource, organized by motivation
   * Implementation: packages/make-meaning/src/annotation-context.ts:122-172
   */
  static async getResourceAnnotations(
    resourceId: ResourceId,
    config: EnvironmentConfig
  ): Promise<ResourceAnnotations>

  /**
   * Get all annotations for a resource (flat list)
   * Implementation: packages/make-meaning/src/annotation-context.ts:174-187
   */
  static async getAllAnnotations(
    resourceId: ResourceId,
    config: EnvironmentConfig
  ): Promise<Annotation[]>

  /**
   * Get a specific annotation by ID
   * Implementation: packages/make-meaning/src/annotation-context.ts:189-202
   */
  static async getAnnotation(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    config: EnvironmentConfig
  ): Promise<Annotation | null>

  /**
   * List annotations with optional filtering
   * Implementation: packages/make-meaning/src/annotation-context.ts:204-225
   */
  static async listAnnotations(
    filters: { resourceId?: ResourceId; type?: AnnotationCategory } | undefined,
    config: EnvironmentConfig
  ): Promise<Annotation[]>

  /**
   * Check if a resource exists in view storage
   * Implementation: packages/make-meaning/src/annotation-context.ts:227-236
   */
  static async resourceExists(
    resourceId: ResourceId,
    config: EnvironmentConfig
  ): Promise<boolean>

  /**
   * Get resource statistics (version, last updated)
   * Implementation: packages/make-meaning/src/annotation-context.ts:238-254
   */
  static async getResourceStats(
    resourceId: ResourceId,
    config: EnvironmentConfig
  ): Promise<{
    resourceId: ResourceId;
    version: number;
    updatedAt: string;
  }>

  /**
   * Get annotation context (surrounding text)
   * Implementation: packages/make-meaning/src/annotation-context.ts:256-314
   */
  static async getAnnotationContext(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    contextBefore: number,
    contextAfter: number,
    config: EnvironmentConfig
  ): Promise<AnnotationContextResponse>

  /**
   * Generate AI summary of an annotation
   * Implementation: packages/make-meaning/src/annotation-context.ts:316-381
   */
  static async generateAnnotationSummary(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    config: EnvironmentConfig
  ): Promise<ContextualSummaryResponse>
}
```

**Options:**
```typescript
interface BuildContextOptions {
  contextLines?: number;        // Lines of surrounding text (default: 5)
  includeMetadata?: boolean;    // Include resource metadata (default: true)
}
```

### GraphContext

Provides graph database operations for traversing resource relationships. All operations are delegated to @semiont/graph (which may use Neo4j or other graph database implementations).

```typescript
class GraphContext {
  /**
   * Get all resources referencing this resource (backlinks)
   * Requires graph traversal - uses @semiont/graph
   * Implementation: packages/make-meaning/src/graph-context.ts:26-30
   */
  static async getBacklinks(
    resourceId: ResourceId,
    config: EnvironmentConfig
  ): Promise<Annotation[]>

  /**
   * Find shortest path between two resources
   * Requires graph traversal - uses @semiont/graph
   * Implementation: packages/make-meaning/src/graph-context.ts:36-44
   */
  static async findPath(
    fromResourceId: ResourceId,
    toResourceId: ResourceId,
    config: EnvironmentConfig,
    maxDepth?: number
  ): Promise<GraphPath[]>

  /**
   * Get resource connections (graph edges)
   * Requires graph traversal - uses @semiont/graph
   * Implementation: packages/make-meaning/src/graph-context.ts:50-53
   */
  static async getResourceConnections(
    resourceId: ResourceId,
    config: EnvironmentConfig
  ): Promise<GraphConnection[]>

  /**
   * Search resources by name (cross-resource query)
   * Requires full-text search - uses @semiont/graph
   * Implementation: packages/make-meaning/src/graph-context.ts:59-62
   */
  static async searchResources(
    query: string,
    config: EnvironmentConfig,
    limit?: number
  ): Promise<ResourceDescriptor[]>
}
```

### AnnotationDetection

AI-powered semantic pattern detection. Orchestrates the full pipeline: resource content → AI prompts → response parsing → validated matches.

```typescript
class AnnotationDetection {
  /**
   * Detect passages that merit commentary
   * Implementation: packages/make-meaning/src/annotation-detection.ts:27-65
   * Uses: MotivationPrompts.buildCommentPrompt, MotivationParsers.parseComments
   */
  static async detectComments(
    resourceId: ResourceId,
    config: EnvironmentConfig,
    instructions?: string,
    tone?: string,
    density?: number
  ): Promise<CommentMatch[]>

  /**
   * Detect passages that should be highlighted
   * Implementation: packages/make-meaning/src/annotation-detection.ts:67-101
   * Uses: MotivationPrompts.buildHighlightPrompt, MotivationParsers.parseHighlights
   */
  static async detectHighlights(
    resourceId: ResourceId,
    config: EnvironmentConfig,
    instructions?: string,
    density?: number
  ): Promise<HighlightMatch[]>

  /**
   * Detect passages that merit assessment/evaluation
   * Implementation: packages/make-meaning/src/annotation-detection.ts:103-141
   * Uses: MotivationPrompts.buildAssessmentPrompt, MotivationParsers.parseAssessments
   */
  static async detectAssessments(
    resourceId: ResourceId,
    config: EnvironmentConfig,
    instructions?: string,
    tone?: string,
    density?: number
  ): Promise<AssessmentMatch[]>

  /**
   * Detect and extract structured tags from text
   * Implementation: packages/make-meaning/src/annotation-detection.ts:143-197
   * Uses: MotivationPrompts.buildTagPrompt, MotivationParsers.parseTags
   */
  static async detectTags(
    resourceId: ResourceId,
    config: EnvironmentConfig,
    schemaId: string,
    category: string
  ): Promise<TagMatch[]>
}
```

**Match types:**
```typescript
// Re-exported from @semiont/inference for convenience
interface CommentMatch {
  exact: string;      // The exact text passage
  start: number;      // Character offset start
  end: number;        // Character offset end
  prefix?: string;    // Context before (for fuzzy anchoring)
  suffix?: string;    // Context after (for fuzzy anchoring)
  comment: string;    // The AI-generated comment
}

interface HighlightMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
}

interface AssessmentMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  assessment: string;  // The AI-generated assessment
}

interface TagMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  category: string;    // The tag category
}
```

**Detection parameters:**

- `instructions`: Custom guidance for the AI (e.g., "Focus on technical concepts")
- `tone`: Tone for comments/assessments (e.g., "educational", "constructive", "analytical")
- `density`: Target density 0.0-1.0 (0.5 = ~50% of passages should be detected)

## Examples

### Building Annotation Context for AI

```typescript
import { AnnotationContext, ResourceContext } from '@semiont/make-meaning';

// Get the full context needed for AI to process an annotation
const context = await AnnotationContext.buildLLMContext(
  annotationUri,
  resourceId,
  config,
  { contextLines: 10 }
);

// context includes:
// - The annotation itself
// - Surrounding text (10 lines before/after)
// - Resource metadata
// - Related annotations in the vicinity
```

### Detecting Patterns and Creating Annotations

```typescript
import { AnnotationDetection } from '@semiont/make-meaning';
import { createEventStore } from '@semiont/event-sourcing';

// Detect highlights using AI
const highlights = await AnnotationDetection.detectHighlights(
  resourceId,
  config,
  'Find key definitions and important claims',
  0.6  // Medium density
);

// Create annotations for each detected highlight
const eventStore = await createEventStore(config);
for (const highlight of highlights) {
  const annotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: generateAnnotationId(),
    motivation: 'highlighting',
    target: {
      type: 'SpecificResource',
      source: resourceUri,
      selector: [
        {
          type: 'TextPositionSelector',
          start: highlight.start,
          end: highlight.end,
        },
        {
          type: 'TextQuoteSelector',
          exact: highlight.exact,
          prefix: highlight.prefix,
          suffix: highlight.suffix,
        },
      ],
    },
    body: [],
  };

  await eventStore.appendEvent({
    type: 'annotation.added',
    resourceId,
    userId,
    version: 1,
    payload: { annotation },
  });
}
```

### Navigating Resource Relationships

```typescript
import { GraphContext, ResourceContext } from '@semiont/make-meaning';

// Find all resources that link to this one
const backlinks = await GraphContext.getBacklinks(resourceId, config);
console.log(`Found ${backlinks.length} resources linking here`);

// Find connection path between two resources
const paths = await GraphContext.findPath(sourceId, targetId, config, 3);
if (paths.length > 0) {
  console.log(`Shortest path has ${paths[0].nodes.length} nodes`);
}

// Get all connections for a resource
const connections = await GraphContext.getResourceConnections(resourceId, config);
// connections = [{ from: ResourceId, to: ResourceId, via: AnnotationId }, ...]
```

## Configuration

All methods require an `EnvironmentConfig` object with:

```typescript
interface EnvironmentConfig {
  services: {
    backend: {
      publicURL: string;           // Base URL for resource URIs
    };
    openai?: {
      apiKey: string;              // Required for detection methods
      model?: string;              // Default: 'gpt-4o-mini'
      temperature?: number;        // Default: 0.7
    };
  };
  storage: {
    base: string;                  // Base path for filesystem storage
  };
}
```

Example:
```typescript
const config: EnvironmentConfig = {
  services: {
    backend: {
      publicURL: 'http://localhost:3000',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
      temperature: 0.7,
    },
  },
  storage: {
    base: '/path/to/storage',
  },
};
```

## Dependencies

`@semiont/make-meaning` builds on several core packages:

- **[@semiont/core](../core/)**: Core types and utilities
- **[@semiont/api-client](../api-client/)**: OpenAPI-generated types
- **[@semiont/event-sourcing](../event-sourcing/)**: Event store and view storage
- **[@semiont/content](../content/)**: Content-addressed storage
- **[@semiont/graph](../graph/)**: Neo4j graph database client
- **[@semiont/ontology](../ontology/)**: Schema definitions for tags
- **[@semiont/inference](../inference/)**: AI primitives (prompts, parsers, generateText)

## How Detection Works

See [packages/inference/README.md](../inference/README.md) for details on the AI pipeline.

**High-level flow:**

1. **Context Assembly**: `ResourceContext.getResourceMetadata()` retrieves resource content
2. **Prompt Building**: `MotivationPrompts.buildXPrompt()` creates AI prompt with domain knowledge
3. **AI Inference**: `generateText()` calls OpenAI API with prompt
4. **Response Parsing**: `MotivationParsers.parseX()` extracts structured matches from response
5. **Offset Validation**: Parser validates that `start`/`end` offsets match `exact` text in content

**Example for highlights:**

```typescript
// 1. Get content
const resource = await ResourceContext.getResourceMetadata(resourceId, config);
const content = await representationStore.retrieve(resource.contentId);

// 2. Build prompt
const prompt = MotivationPrompts.buildHighlightPrompt(
  content,
  'Find key definitions',
  0.6
);

// 3. Generate AI response
const response = await generateText(prompt, config);

// 4. Parse and validate
const highlights = MotivationParsers.parseHighlights(response, content);
// Returns: HighlightMatch[] with validated offsets
```

## Worker Integration

Detection jobs are orchestrated by workers in [apps/backend/src/jobs/workers/](../../apps/backend/src/jobs/workers/):

- [highlight-detection-worker.ts](../../apps/backend/src/jobs/workers/highlight-detection-worker.ts) - Delegated detection to `AnnotationDetection.detectHighlights()`
- [comment-detection-worker.ts](../../apps/backend/src/jobs/workers/comment-detection-worker.ts) - Delegated detection to `AnnotationDetection.detectComments()`
- [assessment-detection-worker.ts](../../apps/backend/src/jobs/workers/assessment-detection-worker.ts) - Delegated detection to `AnnotationDetection.detectAssessments()`
- [tag-detection-worker.ts](../../apps/backend/src/jobs/workers/tag-detection-worker.ts) - Delegated detection to `AnnotationDetection.detectTags()`

Workers handle:
- Job lifecycle (pending → running → completed/failed)
- Progress tracking and event emission
- Annotation creation via event store
- Error handling and retries

All detection logic lives in `@semiont/make-meaning`, keeping workers focused on orchestration.

## Future Direction

### Deterministic Reasoning

Future versions will add deterministic reasoning capabilities alongside AI-powered detection:

- **Rule-based pattern matching**: Detect annotations using regex, string matching, or custom predicates
- **Ontology-driven inference**: Apply OWL/RDFS reasoning over resource relationships
- **Compositional reasoning**: Combine multiple reasoning strategies (AI + rules + ontology)

Example (aspirational):

```typescript
// AI-powered detection
const aiHighlights = await AnnotationDetection.detectHighlights(resourceId, config);

// Rule-based detection
const ruleHighlights = await ResourceReasoning.findMatches(resourceId, {
  pattern: /\btheorem\b.*\bproof\b/gi,
  motivation: 'highlighting',
});

// Ontology-based reasoning
const inferences = await ResourceReasoning.inferRelationships(resourceId, {
  ontology: 'http://example.org/math-ontology',
  rules: ['transitive-proof-chain'],
});
```

This will enable hybrid approaches where AI handles semantic understanding and deterministic rules handle structural patterns.

### Enhanced Context Assembly

- **Multi-resource context**: Build context spanning multiple related resources
- **Temporal context**: Access historical versions of resources and annotations
- **Provenance tracking**: Track reasoning chains and decision paths

## License

MIT
