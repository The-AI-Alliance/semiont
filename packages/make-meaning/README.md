# @semiont/make-meaning

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+make-meaning%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=make-meaning)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=make-meaning)
[![npm version](https://img.shields.io/npm/v/@semiont/make-meaning.svg)](https://www.npmjs.com/package/@semiont/make-meaning)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/make-meaning.svg)](https://www.npmjs.com/package/@semiont/make-meaning)
[![License](https://img.shields.io/npm/l/@semiont/make-meaning.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

**Making meaning from resources through actors, context assembly, and relationship reasoning.**

This package implements the actor model from [ACTOR-MODEL.md](../../docs/system/ACTOR-MODEL.md). It owns the **Knowledge Base** and the actors that interface with it:

- **Stower** (write) — the single write gateway to the Knowledge Base; handles all resource and annotation mutations and job lifecycle events
- **Browser** (read) — handles all KB read queries: resources, annotations, events, annotation history, referenced-by lookups, entity type listing, and directory browse (merging filesystem listings with KB metadata)
- **Gatherer** (context assembly) — assembles gathered context for annotations (`gather:requested`) and resources (`gather:resource-requested`); searches vectors for semantically similar passages (adds `semanticContext` to `GatheredContext`)
- **Matcher** (search/link) — context-driven candidate search with multi-source retrieval, composite structural scoring, and optional LLM semantic scoring
- **Smelter** (embed) — subscribes to resource/annotation events, chunks text, embeds via `@semiont/vectors`, emits `embedding:compute` commands (persisted by Stower as `embedding:computed` events), and indexes into vector store (Qdrant)
- **CloneTokenManager** (yield) — manages clone token lifecycle for resource cloning

All actors subscribe to the EventBus via RxJS pipelines. They expose only `initialize()` and `stop()` — no public business methods. Callers communicate with actors by putting events on the bus.

The EventBus is a **complete interface** for all knowledge-domain operations. HTTP routes in the backend are thin wrappers that delegate to EventBus actors. The `@semiont/api-client` exposes the same operations via verb-oriented namespaces (`semiont.browse`, `semiont.mark`, `semiont.gather`, etc.).

## Quick Start

```bash
npm install @semiont/make-meaning
```

### Start Make-Meaning Service

```typescript
import { startMakeMeaning } from '@semiont/make-meaning';
import { SemiontProject } from '@semiont/core/node';
import { EventBus } from '@semiont/core';
import type { Logger } from '@semiont/core';

// EventBus is created outside make-meaning — it is not encapsulated by this package
const eventBus = new EventBus();
const project = new SemiontProject('/path/to/project');

// Start all infrastructure
const makeMeaning = await startMakeMeaning(project, config, eventBus, logger);

// Access components
const { knowledgeSystem, jobQueue } = makeMeaning;
const { kb, stower, browser, gatherer, matcher, smelter, cloneTokenManager } = knowledgeSystem;

// Graceful shutdown
await makeMeaning.stop();
```

This single call initializes:
- **KnowledgeSystem** — groups the Knowledge Base and its actors
  - **KnowledgeBase** — groups EventStore, ViewStorage, WorkingTreeStore, GraphDatabase, GraphDBConsumer, and optionally VectorStore and Smelter
  - **Stower** — subscribes to write commands on EventBus
  - **Browser** — subscribes to all KB read queries and directory browse requests on EventBus
  - **Gatherer** — subscribes to annotation and resource gather requests on EventBus; searches vectors for semantically similar passages
  - **Matcher** — subscribes to candidate search requests on EventBus
  - **Smelter** — subscribes to resource/annotation events, chunks text, embeds, indexes into Qdrant
  - **CloneTokenManager** — subscribes to clone token operations on EventBus
- **JobQueue** — background job processing queue + job status subscription
- **6 annotation workers** — poll job queue for async AI tasks

### Gather Context (via EventBus)

```typescript
import { firstValueFrom, race, filter, timeout } from 'rxjs';

// Emit gather request for an annotation
eventBus.get('gather:requested').next({
  annotationUri,
  resourceId,
  options: { contextLines: 5 },
});

// Await result
const result = await firstValueFrom(
  race(
    eventBus.get('gather:complete').pipe(filter(e => e.annotationUri === annotationUri)),
    eventBus.get('gather:failed').pipe(filter(e => e.annotationUri === annotationUri)),
  ).pipe(timeout(30_000)),
);
```

## Architecture

### Actor Model

All meaningful actions flow through the EventBus. The KB actors are reactive — they subscribe via RxJS pipelines in `initialize()` and communicate results by emitting on the bus.

```mermaid
graph TB
    Routes["Backend Routes"] -->|commands| BUS["Event Bus"]
    Workers["Job Workers"] -->|commands| BUS
    EBC["SemiontApiClient"] -->|commands| BUS

    subgraph ks ["Knowledge System"]
        STOWER["Stower<br/>(write)"]
        BROWSER["Browser<br/>(read)"]
        GATHERER["Gatherer<br/>(context assembly)"]
        MATCHER["Matcher<br/>(search/link)"]
        SMELTER["Smelter<br/>(embed)"]
        CTM["CloneTokenManager<br/>(clone)"]
        KB["Knowledge Base"]
        VECTORS["Vector Store<br/>(Qdrant)"]
        STOWER -->|persist| KB
        BROWSER -->|query| KB
        GATHERER -->|query| KB
        GATHERER -->|search| VECTORS
        MATCHER -->|query| KB
        MATCHER -->|search| VECTORS
        SMELTER -->|embed & index| VECTORS
        SMELTER -->|read| KB
        CTM -->|query| KB
    end

    BUS -->|"yield:create, yield:update, yield:mv<br/>mark:create, mark:delete, mark:update-body<br/>mark:add-entity-type, mark:archive, mark:unarchive<br/>mark:update-entity-types, job:start, job:*"| STOWER
    BUS -->|"browse:resource-requested, browse:resources-requested<br/>browse:annotations-requested, browse:annotation-requested<br/>browse:events-requested, browse:annotation-history-requested<br/>browse:referenced-by-requested, browse:entity-types-requested<br/>browse:directory-requested"| BROWSER
    BUS -->|"gather:requested<br/>gather:resource-requested"| GATHERER
    BUS -->|"match:search-requested"| MATCHER
    BUS -->|"yield:created, mark:created,<br/>mark:body-updated"| SMELTER
    BUS -->|"yield:clone-token-requested<br/>yield:clone-resource-requested<br/>yield:clone-create"| CTM

    STOWER -->|"yield:created, yield:updated, yield:moved<br/>mark:created, mark:deleted, mark:body-updated<br/>mark:entity-type-added, ..."| BUS
    BROWSER -->|"browse:resource-result, browse:resources-result<br/>browse:annotations-result, browse:annotation-result<br/>browse:events-result, browse:annotation-history-result<br/>browse:referenced-by-result, browse:entity-types-result<br/>browse:directory-result"| BUS
    GATHERER -->|"gather:complete, gather:failed<br/>gather:resource-complete, gather:resource-failed"| BUS
    MATCHER -->|"match:search-results, match:search-failed"| BUS
    SMELTER -->|"embedding:compute,<br/>embedding:delete"| BUS
    CTM -->|"yield:clone-token-generated<br/>yield:clone-resource-result<br/>yield:clone-created"| BUS

    classDef bus fill:#e8a838,stroke:#b07818,stroke-width:3px,color:#000,font-weight:bold
    classDef actor fill:#5a9a6a,stroke:#3d6644,stroke-width:2px,color:#fff
    classDef kb fill:#8b6b9d,stroke:#6b4a7a,stroke-width:2px,color:#fff
    classDef caller fill:#4a90a4,stroke:#2c5f7a,stroke-width:2px,color:#fff

    class BUS bus
    classDef vectorstore fill:#6b8e9d,stroke:#4a6a7a,stroke-width:2px,color:#fff
    class STOWER,BROWSER,GATHERER,MATCHER,SMELTER,CTM actor
    class KB kb
    class VECTORS vectorstore
    class Routes,Workers,EBC caller
```

### Knowledge System and Knowledge Base

The **Knowledge System** binds the Knowledge Base to its actors. Nothing outside the Knowledge System reads or writes the Knowledge Base directly.

The **Knowledge Base** is an inert store — it has no intelligence, no goals, no decisions. It groups five core subsystems and two optional ones:

| Store | Implementation | Purpose |
|-------|---------------|---------|
| **Event Log** | `EventStore` | Immutable append-only log of all domain events |
| **Materialized Views** | `ViewStorage` | Denormalized projections for fast reads |
| **Content Store** | `WorkingTreeStore` | Working-tree files addressed by URI |
| **Graph** | `GraphDatabase` | Eventually consistent relationship projection |
| **Graph Consumer** | `GraphDBConsumer` | Event-to-graph synchronization pipeline |
| **Vectors** *(optional)* | `VectorStore` | Semantic vector index (Qdrant + memory) via `@semiont/vectors` |
| **Smelter** *(optional)* | `Smelter` | Embedding pipeline actor (chunk, embed, index) |

```typescript
import { createKnowledgeBase } from '@semiont/make-meaning';

const kb = await createKnowledgeBase(eventStore, project, graphDb, logger);
// kb.eventStore, kb.views, kb.content, kb.graph, kb.graphConsumer
// kb.vectors (optional), kb.smelter (optional)
```

### EventBus Ownership

The EventBus is created by the backend (or script) and passed into `startMakeMeaning()` as a dependency. Make-meaning does not own or encapsulate the EventBus — it is shared across the entire system.

## Documentation

- **[Architecture](./docs/architecture.md)** — Actor model, data flow, storage architecture
- **[API Reference](./docs/api-reference.md)** — Context modules and operations
- **[Examples](./docs/examples.md)** — Common use cases and patterns
- **[Job Workers](./docs/job-workers.md)** — Async annotation workers (in @semiont/jobs)
- **[Scripting](./docs/SCRIPTING.md)** — Direct scripting without HTTP backend

## Exports

### Service (Primary)

- `startMakeMeaning(project, config, eventBus, logger)` — Initialize all infrastructure
- `MakeMeaningService` — Type for service return value (`knowledgeSystem`, `jobQueue`, `workers`, `stop`)

### Knowledge System

- `KnowledgeSystem` — Interface grouping the Knowledge Base and its actors
- `stopKnowledgeSystem(ks)` — Ordered teardown of the Knowledge System

### Knowledge Base

- `createKnowledgeBase(eventStore, project, graphDb, logger)` — Async factory function
- `KnowledgeBase` — Interface grouping the five KB stores (including `graphConsumer`)

### Actors

- `Stower` — Write gateway actor
- `Browser` — Read actor (all KB queries, directory listings merged with KB metadata)
- `Gatherer` — Context assembly actor (annotation and resource gather flows; vector semantic search)
- `Matcher` — Search/link actor (context-driven candidate search with structural + semantic scoring)
- `Smelter` — Embedding pipeline actor (chunk, embed, persist, index into vector store)
- `CloneTokenManager` — Clone token lifecycle actor (yield domain)

### Operations

- `ResourceOperations` — Resource CRUD (emits commands to EventBus)
- `AnnotationOperations` — Annotation CRUD (emits commands to EventBus)

### Context Assembly

- `ResourceContext` — Resource metadata queries from ViewStorage
- `AnnotationContext` — Annotation queries and LLM context building
- `GraphContext` — Graph traversal and search
- `LLMContext` — Resource-level LLM context assembly

### Generation

- `generateResourceSummary` — Resource summarization
- `generateReferenceSuggestions` — Smart suggestion generation

## Dependencies

- **[@semiont/core](../core/)** — Core types, EventBus, utilities
- **[@semiont/api-client](../api-client/)** — OpenAPI-generated types
- **[@semiont/event-sourcing](../event-sourcing/)** — Event store and view storage
- **[@semiont/content](../content/)** — Content-addressed storage
- **[@semiont/graph](../graph/)** — Graph database abstraction
- **[@semiont/ontology](../ontology/)** — Schema definitions for tags
- **[@semiont/inference](../inference/)** — AI primitives (generateText)
- **[@semiont/vectors](../vectors/)** — Vector store abstraction (Qdrant + memory) and embedding providers (Voyage, Ollama)
- **[@semiont/jobs](../jobs/)** — Job queue and annotation workers

## Testing

```bash
npm test                # Run tests
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

## License

Apache-2.0
