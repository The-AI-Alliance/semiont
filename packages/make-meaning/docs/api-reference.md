# API Reference

## Actors

Seven actors in two categories: five **access actors** (Stower, Browser, Gatherer, Matcher, CloneTokenManager) mediate reads and writes; two **projection pipelines** (Weaver, Smelter) follow the event log.

In the multi-service deployment the access actors are split across two services: the **Archivist** (`archivist-main`) runs Stower, Browser and CloneTokenManager — the actors that own the file-backed record — and the **Librarian** (`librarian-main`) runs Gatherer and Matcher — the LLM-bound actors. The Weaver and Smelter each run as their own process (`weaver-main` / `smelter-main`). Only the standalone composition root (`startMakeMeaning()`) runs the five access actors in-process; the gateway root (`startMakeMeaningGateway()`) starts no actors at all.

Each actor's constructor takes a **capability slice** — a Pick-derived interface naming exactly the store operations it uses — rather than the whole `KnowledgeBase`. A full `KnowledgeBase` satisfies every slice structurally, so in-process wiring passes `kb` directly; the standalone services assemble the slice from their own attachments.

### Stower

The single write gateway to the Knowledge Base. Subscribes to command events on the EventBus and translates them into domain events on the EventStore and content registrations in the WorkingTreeStore.

**Implementation**: [src/stower.ts](../src/stower.ts)

```typescript
import { Stower } from '@semiont/make-meaning';

const stower = new Stower(kb, eventBus, project, logger);
await stower.initialize();  // Subscribes to EventBus
await stower.stop();         // Unsubscribes
```

The first parameter is `StowerStores` — the write seam only: `content: ContentLifecycle` (`register`/`move`/`remove`/`resolveUri`, never bytes) and `eventStore: EventAppends` (`appendEvent` — Stower is the single caller anywhere). `project` is the `SemiontProject` used for resource resolution on moves.

No public business methods. All interaction is via EventBus commands. See [Architecture](./architecture.md) for the full subscription table.

### Browser

Read actor. Handles all deterministic KB read queries — resources, annotations, events, annotation history, referenced-by lookups, entity type and tag-schema listing — plus directory browse (filesystem listings merged with KB metadata).

**Implementation**: [src/browser.ts](../src/browser.ts)

```typescript
import { Browser } from '@semiont/make-meaning';

const browser = new Browser(kb, eventBus, project, config, limitsDiscovery, embeddingProvider, logger);
await browser.initialize();
await browser.stop();
```

The first parameter is `BrowserReads` — reads only: `views` (`get`/`getAll`/`exists`), `eventStore` (log storage + view materializer), `graph` (four queries), `vectors` (`searchResources`/`searchAnnotations`), `content.retrieve`, `anchoredText.read`, and `smeltProgress.whenSettled`. `limitsDiscovery` comes from `createLimitsDiscovery(config, logger)`; the `embeddingProvider` is mandatory — it powers the semantic search fallback for empty lexical searches.

Responds to:
- `browse:resource-requested` → emits `browse:resource-result` or `browse:resource-failed`
- `browse:anchored-text-requested` → emits `browse:anchored-text-result` or `browse:anchored-text-failed`
- `browse:resources-requested` → emits `browse:resources-result` or `browse:resources-failed`
- `browse:annotations-requested` → emits `browse:annotations-result` or `browse:annotations-failed`
- `browse:annotation-requested` → emits `browse:annotation-result` or `browse:annotation-failed`
- `browse:events-requested` → emits `browse:events-result` or `browse:events-failed`
- `browse:annotation-history-requested` → emits `browse:annotation-history-result` or `browse:annotation-history-failed`
- `browse:referenced-by-requested` → emits `browse:referenced-by-result` or `browse:referenced-by-failed`
- `browse:entity-types-requested` → emits `browse:entity-types-result` or `browse:entity-types-failed`
- `browse:tag-schemas-requested` → emits `browse:tag-schemas-result` or `browse:tag-schemas-failed`
- `browse:agents-requested` → emits `browse:agents-result` or `browse:agents-failed` (the collaborator directory: declared software agents with DIDs and served job types, derived from the workers/actors inference config)
- `browse:directory-requested` → emits `browse:directory-result` or `browse:directory-failed`

### Gatherer

Context assembly actor. Builds `GatheredContext` for annotations and resources — passage context, graph neighborhood, vector semantic search (`semanticContext`), and optionally an LLM relationship summary. Runs in the Librarian service.

**Implementation**: [src/gatherer.ts](../src/gatherer.ts)

```typescript
import { Gatherer } from '@semiont/make-meaning';

const gatherer = new Gatherer(stores, eventBus, inferenceClient, settleTimeoutMs, logger, embeddingProvider);
await gatherer.initialize();
await gatherer.stop();
```

`stores` is `GathererStores` — derived as `AnnotationGatherReads & ResourceGatherReads`, the intersection of the two gather paths' reads. Its `content` capability is a ResourceId-keyed `ContentReads` (`getBinary`), not the working tree: in-process roots wrap `kb` via `workingTreeContentReads(kb.views, kb.content)`; the standalone Librarian passes `HttpContentTransport`. `settleTimeoutMs` bounds the vector-index settle barrier and comes from `MakeMeaningConfig.gather`.

Responds to:
- `gather:requested` → emits `gather:complete` or `gather:failed`
- `gather:resource-requested` → emits `gather:resource-complete` or `gather:resource-failed`

### Matcher

Search/link actor. Searches KB stores for entity resolution, context-driven search with composite scoring, and graph queries. Retrieves candidates from four sources (name match, entity type filter, graph neighborhood, vector semantic search) with vector similarity weighted at 25, then performs LLM-based semantic relevance scoring of the candidates (GraphRAG-style) unless the request sets `useSemanticScoring: false`. Runs in the Librarian service.

**Implementation**: [src/matcher.ts](../src/matcher.ts)

```typescript
import { Matcher } from '@semiont/make-meaning';

const matcher = new Matcher(stores, eventBus, logger, inferenceClient, embeddingProvider);
await matcher.initialize();
await matcher.stop();
```

`stores` is `MatcherStores` — `graph` (`listResources`/`getResource`), `views.get`, and `vectors.searchResources`. Both the `InferenceClient` and the `EmbeddingProvider` are required constructor arguments.

Responds to:
- `match:search-requested` → context-driven search over the `context` field (a `GatheredContext`) → emits `match:search-results` or `match:search-failed`

Referenced-by lookups are handled by the Browser (`browse:referenced-by-requested`), not the Matcher.

### Weaver (projection pipeline, standalone process)

Event-to-graph projection pipeline. Subscribes to graph-relevant domain events and applies them to the graph database with per-resource ordering and adaptive burst batching. Not exported from the package index and **not** started by `startMakeMeaning()` — it runs in its own process via `@semiont/make-meaning/weaver-main`. What the KB carries is `kb.weaveProgress`, the fold of the Weaver's `weave:applied` signals that backs the graph-projection read barrier. Full rebuilds are requested over the bus with `weave:rebuild`.

**Implementation**: [src/weaver.ts](../src/weaver.ts), entry point [src/weaver-main.ts](../src/weaver-main.ts)

### Smelter (projection pipeline, standalone process)

Event-to-vector projection pipeline. Runs in its own process via `@semiont/make-meaning/smelter-main` — it is **not** started by `startMakeMeaning()`. It reads content bytes over `HttpContentTransport` (the gateway's byte path), chunks text, computes embeddings via `@semiont/vectors` (EmbeddingProvider: Voyage or Ollama), and indexes vectors into the VectorStore (Qdrant or memory). At startup, `reconcile()` diffs the index against the live catalog — re-embedding what's missing or stale (checksum-stamped upserts make changed content detectable), deleting orphans — so a wiped Qdrant volume recovers by restarting the smelter. Its `smelt:settled` signals feed the `kb.smeltProgress` fold, the vector-projection read barrier.

**Implementation**: [src/smelter.ts](../src/smelter.ts), entry point [src/smelter-main.ts](../src/smelter-main.ts)

For custom wiring on top of an existing `WorkerBus`, the package exports the pipeline and its domain-event fan-in:

```typescript
import { Smelter, createSmelterActorStateUnit } from '@semiont/make-meaning';
```

Consumes domain events:
- `yield:created` / `yield:updated` / `yield:representation-added` → chunks and embeds resource text, indexes into VectorStore
- `mark:added` → chunks and embeds annotation text, indexes
- `mark:removed` → removes the annotation's vectors from the index
- `mark:archived` / `mark:unarchived` → removes / re-indexes the resource's vectors
- `mark:entity-tag-added` / `mark:entity-tag-removed` → re-stamps the entity types on the resource's vectors

Plus the `smelt:rebuild-anchors` command, which rides its own stream rather than the per-resource event mailbox.

### CloneTokenManager

Clone token lifecycle actor. Manages temporary tokens for resource cloning. Runs in the Archivist service.

**Implementation**: [src/clone-token-manager.ts](../src/clone-token-manager.ts)

```typescript
import { CloneTokenManager } from '@semiont/make-meaning';

const ctm = new CloneTokenManager(kb, eventBus, logger);
await ctm.initialize();
await ctm.stop();
```

The first parameter is `CloneTokenStores` — `views.get` for resource metadata and `content.resolveUri` for existence checks; the actor holds no byte capability.

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

Callers write content to the content store first; `CreateResourceInput` carries the resulting `storageUri`, `contentChecksum`, and `byteSize` (plus `name`, `format`, and optional `language`, `entityTypes`, generation provenance). Emits `yield:create` over the correlated `busRequest` path, awaits the `yield:create-ok` / `yield:create-failed` reply from Stower, and returns the new `ResourceId`.

#### createFromCloneToken()

```typescript
static async createFromCloneToken(
  input: {
    token: string;
    name: string;
    storageUri: string;
    contentChecksum: string;
    byteSize: number;
    format: ContentFormat;
    archiveOriginal?: boolean;
  },
  userId: UserId,
  eventBus: EventBus,
): Promise<ResourceId>
```

The clone counterpart: the bytes are already stored by the upload path; this emits `yield:clone-create` (handled by the CloneTokenManager) with storage coordinates only.

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
  kb: { views: Pick<ViewStorage, 'get'> },
): Promise<CreateAnnotationResult>
```

Refuses targets whose media type cannot carry a coordinate (`assertAnnotatableTarget`), assembles a full W3C Annotation locally (`assembleAnnotation` from `@semiont/core`, with `creator` and `created`), emits `mark:create` on EventBus (fire-and-forget — Stower persists), and returns the assembled annotation.

#### updateAnnotationBody()

```typescript
static async updateAnnotationBody(
  id: string,
  request: UpdateAnnotationBodyRequest,
  userId: UserId,
  eventBus: EventBus,
  kb: { views: Pick<ViewStorage, 'get'> },
): Promise<UpdateAnnotationBodyResult>
```

Reads the current annotation from the views, emits `mark:update-body` on EventBus, and returns the annotation with the body operations applied optimistically.

#### deleteAnnotation()

```typescript
static async deleteAnnotation(
  id: string,
  resourceId: string,
  userId: UserId,
  eventBus: EventBus,
  kb: { views: Pick<ViewStorage, 'get'> },
  logger?: Logger,
): Promise<void>
```

Verifies the annotation exists in the resource's projection, then emits `mark:delete` on EventBus (fire-and-forget — Stower persists).

---

## Context Modules

Context modules read from the Knowledge Base. They are used internally by the actors and can be called directly for simple queries. Each takes the Pick-derived reads slice it actually uses; a full `KnowledgeBase` satisfies the view-only slices structurally.

### ResourceContext

Resource metadata and content assembly from ViewStorage.

**Implementation**: [src/resource-context.ts](../src/resource-context.ts)

#### getResourceMetadata()

```typescript
static async getResourceMetadata(
  resourceId: ResourceId,
  kb: { views: Pick<ViewStorage, 'get'> },
): Promise<ResourceDescriptor | null>
```

#### listResources()

```typescript
static async listResources(
  filters: ListResourcesFilters | undefined,
  kb: ListResourcesReads,
  semantic: SemanticFallbackDeps,
): Promise<ListResourcesResult>
```

`ListResourcesReads` is `views` (`get`/`getAll`), `graph` (`listResources`/`getResource`), and `vectors.searchResources`. A `search` goes to the graph's lexical index; an unsearched listing reads the materialized views. When a lexical search's first page is empty, the semantic fallback answers from the vector index using `SemanticFallbackDeps` (`embeddingProvider`, `semanticFloor`, `logger`). The result is `{ resources, total, matchKind }` — `total` is the size of the whole match set, and `matchKind` says whether the answer is `'lexical'` or `'semantic'` (semantic hits carry `content`, the passage that matched).

#### addContentPreviews()

```typescript
static async addContentPreviews(
  resources: ResourceDescriptor[],
  kb: { content: Pick<WorkingTreeStore, 'retrieve'> },
): Promise<Array<ResourceDescriptor & { content: string }>>
```

#### getResourceContent()

```typescript
static async getResourceContent(
  resource: ResourceDescriptor,
  kb: { content: ContentReads },
): Promise<string | undefined>
```

ResourceId-keyed: `ContentReads` is the transport contract's `getBinary`, so the standalone Librarian serves it over HTTP while in-process roots wrap the working tree behind the same shape.

### AnnotationContext

Annotation queries and LLM context building.

**Implementation**: [src/annotation-context.ts](../src/annotation-context.ts)

#### buildLLMContext()

```typescript
static async buildLLMContext(
  annotationId: AnnotationId,
  resourceId: ResourceId,
  kb: AnnotationGatherReads,
  embeddingProvider: EmbeddingProvider,
  options?: BuildContextOptions,
  inferenceClient?: InferenceClient,
  logger?: Logger,
): Promise<GatheredContext>
```

Builds rich context for AI processing: an annotation-focus `GatheredContext` carrying the annotation, surrounding text, resource metadata, `semanticContext` from vector search, and the shared knowledge-graph backbone (`graph` / `KnowledgeGraph`). When an `InferenceClient` is provided, also generates an `inferredRelationshipSummary` describing how the passage relates to its graph neighborhood. `AnnotationGatherReads` is `views.get`, `content` (`ContentReads`), the graph builder's slice plus `getEntityTypeStats`, `vectors.searchAnnotations`, and the weave-progress barrier.

#### getResourceAnnotations()

```typescript
static async getResourceAnnotations(
  resourceId: ResourceId,
  kb: { views: Pick<ViewStorage, 'get'> },
): Promise<ResourceAnnotations>
```

Returns the resource's annotation projection — `{ resourceId, annotations, version, updatedAt }`, a flat list with the projection's version stamp.

#### getAllAnnotations()

```typescript
static async getAllAnnotations(
  resourceId: ResourceId,
  kb: { views: Pick<ViewStorage, 'get'> },
): Promise<Annotation[]>
```

#### getAnnotation()

```typescript
static async getAnnotation(
  annotationId: AnnotationId,
  resourceId: ResourceId,
  kb: { views: Pick<ViewStorage, 'get'> },
): Promise<Annotation | null>
```

### GraphContext

The unified knowledge-graph builder.

**Implementation**: [src/graph-context.ts](../src/graph-context.ts)

#### buildKnowledgeGraph()

```typescript
static async buildKnowledgeGraph(
  resourceId: ResourceId,
  kb: KnowledgeGraphReads,
  logger?: Logger,
): Promise<KnowledgeGraph>
```

Builds the resource's full neighborhood — resources AND annotations as typed nodes, typed
directional edges, including inbound citations — with read-your-writes grace for graph
projection lag. `KnowledgeGraphReads` is the Pick-derived slice it needs: four graph reads,
`views.get`, and the weave-progress barrier.

For direct graph queries (backlinks, paths, connections), use the `GraphDatabase` interface
(`kb.graph.getResourceReferencedBy(...)`, `kb.graph.findPath(...)`,
`kb.graph.getResourceConnections(...)`). Bus clients get referenced-by lookups from the
Browser via `browse:referenced-by-requested`.

### LLMContext

Resource-level LLM context assembly.

**Implementation**: [src/llm-context.ts](../src/llm-context.ts)

#### getResourceContext()

```typescript
static async getResourceContext(
  resourceId: ResourceId,
  options: LLMContextOptions,
  kb: ResourceGatherReads,
  inferenceClient: InferenceClient,
  settleTimeoutMs: number,
  logger: Logger,
): Promise<GatheredContext>
```

`ResourceGatherReads` is `views.get`, `content` (`ContentReads`), the graph builder's slice, `vectors.searchByResource`, and the weave- and smelt-progress barriers. `settleTimeoutMs` bounds the `semanticContext` read-your-writes barrier against the vector index.

---

## Knowledge Base

**Implementation**: [src/knowledge-base.ts](../src/knowledge-base.ts)

```typescript
export interface KnowledgeBase {
  eventStore:    EventStore;
  views:         ViewStorage;
  content:       WorkingTreeStore;
  anchoredText:  AnchoredTextStore;  // Derived coordinate maps for recovered text
  graph:         GraphDatabase;
  weaveProgress: WeaveProgress;      // weave:applied fold — graph-projection barrier
  smeltProgress: SmeltProgress;      // smelt:settled fold — vector-projection barrier
  vectors:       VectorStore;        // Mandatory — Qdrant or memory (from @semiont/vectors)
  projectionsDir: string;
}

export async function createKnowledgeBase(
  eventStore: EventStore,
  project: SemiontProject,
  graphDb: GraphDatabase,
  eventBus: EventBus,
  logger: Logger,
  options: { vectorStore: VectorStore; skipRebuild?: boolean },
): Promise<KnowledgeBase>
```

`vectorStore` is required — a KB without vector search is not a supported configuration; `MemoryVectorStore` is the explicit named choice for stores that may rebuild on restart. The factory rebuilds the materialized views from the event log unless `skipRebuild`; the graph is never rebuilt here — the standalone Weaver catches up from its checkpoint.

## See Also

- [Architecture](./architecture.md) — Actor model and data flow
- [Examples](./examples.md) — Common use cases
- [@semiont/jobs](../../jobs/README.md) — Job queue and annotation workers
