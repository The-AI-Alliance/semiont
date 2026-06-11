# API Reference

## Actors

### Stower

The single write gateway to the Knowledge Base. Subscribes to command events on the EventBus and translates them into domain events on the EventStore and content registrations in the WorkingTreeStore.

**Implementation**: [src/stower.ts](../src/stower.ts)

```typescript
import { Stower } from '@semiont/make-meaning';

const stower = new Stower(kb, eventBus, logger);
await stower.initialize();  // Subscribes to EventBus
await stower.stop();         // Unsubscribes
```

No public business methods. All interaction is via EventBus commands. See [Architecture](./architecture.md) for the full subscription table.

### Browser

Read actor. Handles all deterministic KB read queries — resources, annotations, events, annotation history, referenced-by lookups, entity type and tag-schema listing — plus directory browse (filesystem listings merged with KB metadata).

**Implementation**: [src/browser.ts](../src/browser.ts)

```typescript
import { Browser } from '@semiont/make-meaning';

const browser = new Browser(kb.views, kb, eventBus, project, logger);
await browser.initialize();
await browser.stop();
```

Responds to:
- `browse:resource-requested` → emits `browse:resource-result` or `browse:resource-failed`
- `browse:resources-requested` → emits `browse:resources-result` or `browse:resources-failed`
- `browse:annotations-requested` → emits `browse:annotations-result` or `browse:annotations-failed`
- `browse:annotation-requested` → emits `browse:annotation-result` or `browse:annotation-failed`
- `browse:events-requested` → emits `browse:events-result` or `browse:events-failed`
- `browse:annotation-history-requested` → emits `browse:annotation-history-result` or `browse:annotation-history-failed`
- `browse:referenced-by-requested` → emits `browse:referenced-by-result` or `browse:referenced-by-failed`
- `browse:entity-types-requested` → emits `browse:entity-types-result` or `browse:entity-types-failed`
- `browse:tag-schemas-requested` → emits `browse:tag-schemas-result` or `browse:tag-schemas-failed`
- `browse:directory-requested` → emits `browse:directory-result` or `browse:directory-failed`

### Gatherer

Context assembly actor. Builds `GatheredContext` for annotations and resources — passage context, graph neighborhood, vector semantic search (adds `semanticContext` when an `EmbeddingProvider` and VectorStore are available), and optionally an LLM relationship summary.

**Implementation**: [src/gatherer.ts](../src/gatherer.ts)

```typescript
import { Gatherer } from '@semiont/make-meaning';

const gatherer = new Gatherer(kb, eventBus, inferenceClient, logger, embeddingProvider);
await gatherer.initialize();
await gatherer.stop();
```

Responds to:
- `gather:requested` → emits `gather:complete` or `gather:failed`
- `gather:resource-requested` → emits `gather:resource-complete` or `gather:resource-failed`

### Matcher

Search/link actor. Searches KB stores for entity resolution, context-driven search with composite scoring, and graph queries. Retrieves candidates from four sources (name match, entity type filter, graph neighborhood, vector semantic search) with vector similarity weighted at 25. When an `InferenceClient` is provided, the Matcher also performs LLM-based semantic relevance scoring of search candidates (GraphRAG-style).

**Implementation**: [src/matcher.ts](../src/matcher.ts)

```typescript
import { Matcher } from '@semiont/make-meaning';

const matcher = new Matcher(kb, eventBus, logger, inferenceClient, embeddingProvider);
await matcher.initialize();
await matcher.stop();
```

Responds to:
- `match:search-requested` → context-driven search over the `context` field (a `GatheredContext`) → emits `match:search-results` or `match:search-failed`

Referenced-by lookups are handled by the Browser (`browse:referenced-by-requested`), not the Matcher.

### Smelter (standalone process)

Embedding pipeline actor. Runs in its own process via `@semiont/make-meaning/smelter-main` — it is **not** started by `startMakeMeaning()`. It chunks text, computes embeddings via `@semiont/vectors` (EmbeddingProvider: Voyage or Ollama), persists them to the EmbeddingStore (`.semiont/embeddings/`), and indexes vectors into the VectorStore (Qdrant or memory).

**Implementation**: [src/smelter.ts](../src/smelter.ts), entry point [src/smelter-main.ts](../src/smelter-main.ts)

For custom wiring on top of an existing `WorkerBus`, the package exports both the pipeline and its domain-event fan-in:

```typescript
import { Smelter, createSmelterActorStateUnit } from '@semiont/make-meaning';
```

Consumes domain events:
- `yield:created` / `yield:updated` / `yield:representation-added` → chunks and embeds resource text, persists, indexes into VectorStore
- `mark:added` → chunks and embeds annotation text, persists, indexes
- `mark:removed` / `mark:archived` → removes vectors from index

### CloneTokenManager

Clone token lifecycle actor. Manages temporary tokens for resource cloning.

**Implementation**: [src/clone-token-manager.ts](../src/clone-token-manager.ts)

```typescript
import { CloneTokenManager } from '@semiont/make-meaning';

const ctm = new CloneTokenManager(kb, eventBus, logger);
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
): Promise<ResourceId>
```

Callers write content to the content store first; `CreateResourceInput` carries the resulting `storageUri`, `contentChecksum`, and `byteSize` (plus `name`, `format`, and optional `language`, `entityTypes`, generation provenance). Emits `yield:create` on EventBus, awaits `yield:create-ok` / `yield:create-failed` from Stower, and returns the new `ResourceId`.

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
): Promise<CreateAnnotationResult>
```

Assembles a full W3C Annotation locally (`assembleAnnotation` from `@semiont/core`, with `creator` and `created`), emits `mark:create` on EventBus (fire-and-forget — Stower persists), and returns the assembled annotation.

#### updateAnnotationBody()

```typescript
static async updateAnnotationBody(
  id: string,
  request: UpdateAnnotationBodyRequest,
  userId: UserId,
  eventBus: EventBus,
  kb: KnowledgeBase,
): Promise<UpdateAnnotationBodyResult>
```

Reads the current annotation from the KB, emits `mark:update-body` on EventBus, and returns the annotation with the body operations applied optimistically.

#### deleteAnnotation()

```typescript
static async deleteAnnotation(
  id: string,
  resourceId: string,
  userId: UserId,
  eventBus: EventBus,
  kb: KnowledgeBase,
  logger?: Logger,
): Promise<void>
```

Verifies the annotation exists in the resource's projection, then emits `mark:delete` on EventBus (fire-and-forget — Stower persists).

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
  options?: BuildContextOptions,
  inferenceClient?: InferenceClient,
  logger?: Logger,
  embeddingProvider?: EmbeddingProvider,
): Promise<AnnotationLLMContextResponse>
```

Builds rich context for AI processing including the annotation, surrounding text, resource metadata, and knowledge graph neighborhood (`graphContext`). When an `InferenceClient` is provided, also generates an `inferredRelationshipSummary` describing how the passage relates to its graph neighborhood; when an `EmbeddingProvider` is provided (and the KB has vectors), adds `semanticContext` from vector search.

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
  eventStore:     EventStore;
  views:          ViewStorage;
  content:        WorkingTreeStore;
  graph:          GraphDatabase;
  graphConsumer:  GraphDBConsumer;
  vectors?:       VectorStore;   // Optional — Qdrant or memory (from @semiont/vectors)
  projectionsDir: string;
}

export async function createKnowledgeBase(
  eventStore: EventStore,
  project: SemiontProject,
  graphDb: GraphDatabase,
  eventBus: EventBus,
  logger: Logger,
  options?: { vectorStore?: VectorStore; skipRebuild?: boolean },
): Promise<KnowledgeBase>
```

## See Also

- [Architecture](./architecture.md) — Actor model and data flow
- [Examples](./examples.md) — Common use cases
- [@semiont/jobs](../../jobs/README.md) — Job queue and annotation workers
