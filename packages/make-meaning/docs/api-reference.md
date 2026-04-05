# API Reference

## Actors

### Stower

The single write gateway to the Knowledge Base. Subscribes to command events on the EventBus and translates them into domain events on the EventStore and content writes to the RepresentationStore.

**Implementation**: [src/stower.ts](../src/stower.ts)

```typescript
import { Stower } from '@semiont/make-meaning';

const stower = new Stower(kb, publicURL, eventBus, logger);
await stower.initialize();  // Subscribes to EventBus
await stower.stop();         // Unsubscribes
```

No public business methods. All interaction is via EventBus commands. See [Architecture](./architecture.md) for the full subscription table.

### Gatherer

Read actor. Handles all browse reads, context assembly, entity type listing, and vector semantic search (adds `semanticContext` to `GatheredContext` when a VectorStore is available).

**Implementation**: [src/gatherer.ts](../src/gatherer.ts)

```typescript
import { Gatherer } from '@semiont/make-meaning';

const gatherer = new Gatherer(publicURL, kb, eventBus, inferenceClient, logger, config);
await gatherer.initialize();
await gatherer.stop();
```

Responds to:
- `browse:resource-requested` → emits `browse:resource-result` or `browse:resource-failed`
- `browse:resources-requested` → emits `browse:resources-result` or `browse:resources-failed`
- `browse:annotations-requested` → emits `browse:annotations-result` or `browse:annotations-failed`
- `browse:annotation-requested` → emits `browse:annotation-result` or `browse:annotation-failed`
- `browse:events-requested` → emits `browse:events-result` or `browse:events-failed`
- `browse:annotation-history-requested` → emits `browse:annotation-history-result` or `browse:annotation-history-failed`
- `mark:entity-types-requested` → emits `mark:entity-types-result` or `mark:entity-types-failed`
- `gather:requested` → emits `gather:complete` or `gather:failed`
- `gather:resource-requested` → emits `gather:resource-complete` or `gather:resource-failed`

### Matcher

Search/link actor. Searches KB stores for entity resolution, context-driven search with composite scoring, and graph queries. Retrieves candidates from four sources (name match, entity type filter, graph neighborhood, vector semantic search) with vector similarity weighted at 25. When an `InferenceClient` is provided, the Matcher also performs LLM-based semantic relevance scoring of search candidates (GraphRAG-style).

**Implementation**: [src/matcher.ts](../src/matcher.ts)

```typescript
import { Matcher } from '@semiont/make-meaning';

const matcher = new Matcher(kb, eventBus, logger, inferenceClient);
await matcher.initialize();
await matcher.stop();
```

Responds to:
- `bind:search-requested` → context-driven search when `context` field is present, plain search otherwise → emits `bind:search-results` or `bind:search-failed`
- `bind:referenced-by-requested` → emits `bind:referenced-by-result` or `bind:referenced-by-failed`

### Smelter

Embedding pipeline actor. Subscribes to resource and annotation events, chunks text, computes embeddings via `@semiont/vectors` (EmbeddingProvider: Voyage or Ollama), persists `embedding:computed` events, and indexes vectors into the VectorStore (Qdrant or memory).

**Implementation**: [src/smelter.ts](../src/smelter.ts)

```typescript
import { Smelter } from '@semiont/make-meaning';

const smelter = new Smelter(kb, eventBus, vectorStore, embeddingProvider, logger, chunkingConfig);
await smelter.initialize();
await smelter.stop();
```

Responds to:
- `yield:created` → chunks and embeds resource text, indexes into VectorStore → emits `embedding:computed`
- `mark:created` → chunks and embeds annotation text → emits `embedding:computed`
- `mark:body-updated` → re-chunks and re-embeds annotation text → emits `embedding:computed`
- `yield:moved` / resource deleted → removes vectors from index → emits `embedding:deleted`

### CloneTokenManager

Clone token lifecycle actor. Manages temporary tokens for resource cloning.

**Implementation**: [src/clone-token-manager.ts](../src/clone-token-manager.ts)

```typescript
import { CloneTokenManager } from '@semiont/make-meaning';

const ctm = new CloneTokenManager(eventBus, kb, publicURL, logger);
await ctm.initialize();
await ctm.stop();
```

Responds to:
- `yield:clone-token-requested` → emits `yield:clone-token-generated` or `yield:clone-token-failed`
- `yield:clone-resource-requested` → emits `yield:clone-resource-result` or `yield:clone-resource-failed`
- `yield:clone-create` → emits `yield:clone-created` or `yield:clone-create-failed`

---

## Operations

### ResourceOperations

Business logic for resource CRUD. Emits commands on the EventBus — does not access KB stores directly.

**Implementation**: [src/resource-operations.ts](../src/resource-operations.ts)

#### createResource()

```typescript
static async createResource(
  input: CreateResourceInput,
  userId: UserId,
  eventBus: EventBus,
  publicURL: string,
): Promise<CreateResourceResult>
```

Emits `yield:create` on EventBus, awaits `yield:created` from Stower.

#### updateResource()

```typescript
static async updateResource(
  resourceId: ResourceId,
  input: UpdateResourceInput,
  userId: UserId,
  eventBus: EventBus,
): Promise<void>
```

Emits `mark:update-entity-types`, `mark:archive`, or `mark:unarchive` on EventBus depending on input.

### AnnotationOperations

Business logic for annotation CRUD. Emits commands on the EventBus.

**Implementation**: [src/annotation-operations.ts](../src/annotation-operations.ts)

#### createAnnotation()

```typescript
static async createAnnotation(
  request: CreateAnnotationRequest,
  userId: UserId,
  creator: Agent,
  eventBus: EventBus,
  publicURL: string,
): Promise<CreateAnnotationResult>
```

Builds a full W3C Annotation (with `creator` and `created`), emits `mark:create` on EventBus, awaits `mark:created` from Stower.

#### updateAnnotationBody()

```typescript
static async updateAnnotationBody(
  annotationId: AnnotationId,
  resourceId: ResourceId,
  operations: AnnotationBodyOperation[],
  userId: UserId,
  eventBus: EventBus,
): Promise<UpdateAnnotationBodyResult>
```

Emits `mark:update-body` on EventBus.

#### deleteAnnotation()

```typescript
static async deleteAnnotation(
  annotationId: AnnotationId,
  resourceId: ResourceId,
  userId: UserId,
  eventBus: EventBus,
): Promise<void>
```

Emits `mark:delete` on EventBus, awaits `mark:deleted` from Stower.

---

## Context Modules

Context modules read from the Knowledge Base. They are used internally by the Gatherer actor and can be called directly for simple queries.

### ResourceContext

Resource metadata and content assembly from ViewStorage.

**Implementation**: [src/resource-context.ts](../src/resource-context.ts)

#### getResourceMetadata()

```typescript
static async getResourceMetadata(
  resourceId: ResourceId,
  kb: KnowledgeBase,
): Promise<ResourceDescriptor | null>
```

#### listResources()

```typescript
static async listResources(
  filters: ListResourcesFilters | undefined,
  kb: KnowledgeBase,
): Promise<ResourceDescriptor[]>
```

#### addContentPreviews()

```typescript
static async addContentPreviews(
  resources: ResourceDescriptor[],
  kb: KnowledgeBase,
): Promise<Array<ResourceDescriptor & { content: string }>>
```

### AnnotationContext

Annotation queries and LLM context building.

**Implementation**: [src/annotation-context.ts](../src/annotation-context.ts)

#### buildLLMContext()

```typescript
static async buildLLMContext(
  annotationId: AnnotationId,
  resourceId: ResourceId,
  kb: KnowledgeBase,
  options: BuildContextOptions,
  inferenceClient?: InferenceClient,
  logger?: Logger,
): Promise<AnnotationLLMContextResponse>
```

Builds rich context for AI processing including the annotation, surrounding text, resource metadata, and knowledge graph neighborhood (`graphContext`). When an `InferenceClient` is provided, also generates an `inferredRelationshipSummary` describing how the passage relates to its graph neighborhood.

#### getResourceAnnotations()

```typescript
static async getResourceAnnotations(
  resourceId: ResourceId,
  kb: KnowledgeBase,
): Promise<ResourceAnnotations>
```

Returns annotations grouped by motivation.

#### getAllAnnotations()

```typescript
static async getAllAnnotations(
  resourceId: ResourceId,
  kb: KnowledgeBase,
): Promise<Annotation[]>
```

#### getAnnotation()

```typescript
static async getAnnotation(
  annotationId: AnnotationId,
  resourceId: ResourceId,
  kb: KnowledgeBase,
): Promise<Annotation | null>
```

### GraphContext

Graph database operations for traversing resource relationships.

**Implementation**: [src/graph-context.ts](../src/graph-context.ts)

#### getBacklinks()

```typescript
static async getBacklinks(
  resourceId: ResourceId,
  kb: KnowledgeBase,
): Promise<Annotation[]>
```

#### searchResources()

```typescript
static async searchResources(
  query: string,
  kb: KnowledgeBase,
  limit?: number,
): Promise<ResourceDescriptor[]>
```

#### findPath()

```typescript
static async findPath(
  fromResourceId: ResourceId,
  toResourceId: ResourceId,
  kb: KnowledgeBase,
  maxDepth?: number,
): Promise<GraphPath[]>
```

### LLMContext

Resource-level LLM context assembly.

**Implementation**: [src/llm-context.ts](../src/llm-context.ts)

#### getResourceContext()

```typescript
static async getResourceContext(
  resourceId: ResourceId,
  options: LLMContextOptions,
  kb: KnowledgeBase,
  inferenceClient: InferenceClient,
): Promise<ResourceLLMContextResponse>
```

---

## Knowledge Base

**Implementation**: [src/knowledge-base.ts](../src/knowledge-base.ts)

```typescript
export interface KnowledgeBase {
  eventStore: EventStore;
  views: ViewStorage;
  content: RepresentationStore;
  graph: GraphDatabase;
  vectors?: VectorStore;   // Optional — Qdrant or memory (from @semiont/vectors)
  smelter?: Smelter;       // Optional — embedding pipeline actor
}

export function createKnowledgeBase(
  eventStore: EventStore,
  basePath: string,
  projectRoot: string | undefined,
  graphDb: GraphDatabase,
  logger: Logger,
  vectorStore?: VectorStore,
  smelter?: Smelter,
): KnowledgeBase
```

## See Also

- [Architecture](./architecture.md) — Actor model and data flow
- [Examples](./examples.md) — Common use cases
- [@semiont/jobs](../../jobs/README.md) — Job queue and annotation workers
