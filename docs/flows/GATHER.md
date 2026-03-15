# Gather Flow

**Purpose**: Extract semantic context from an annotation — its surrounding passage, metadata, and knowledge graph neighborhood — for downstream use. The Gatherer assembles a `GatheredContext` that serves as grounding material for the [Yield flow](./YIELD.md), the [Bind flow](./BIND.md), or any other consumer that needs rich context from an annotation.

**Related Documentation**:
- [Yield Flow](./YIELD.md) - Consumer: generation prompt enrichment
- [Bind Flow](./BIND.md) - Consumer: context-driven search scoring
- [Mark Flow](./MARK.md) - How annotations (the correlation sources) are created
- [@semiont/make-meaning Architecture](../../packages/make-meaning/docs/architecture.md) - Context assembly layer
- [Make-Meaning API Reference](../../packages/make-meaning/docs/api-reference.md) - `buildLLMContext` method

## Overview

The Gather flow assembles related context around a focal annotation. The application surfaces surrounding passage text, annotation metadata, and knowledge graph neighborhood to construct a coherent input for downstream processing. AI agents perform RAG retrieval, context window assembly, and knowledge graph traversal; human collaborators pull prior materials and cross-references. The output is a `GatheredContext` object that provides grounding material for resource generation, context-driven search, or other context-dependent operations.

Gathering is triggered automatically when the generation modal opens (Yield flow) or when the user clicks "Link Document" (Bind flow). It runs in parallel with the modal rendering, so context is typically ready by the time the user interacts.

## Using the API Client

Fetch the assembled context for an annotation:

```typescript
import { SemiontApiClient } from '@semiont/api-client';

const client = new SemiontApiClient({ baseUrl: 'http://localhost:4000' });

// Get LLM-ready context for an annotation
const { context } = await client.getAnnotationLLMContext(
  resourceId,
  annotationId,
  { contextWindow: 2000 }
);

// Source context (passage text)
console.log(context.sourceContext.selected);  // The exact text the annotation targets
console.log(context.sourceContext.before);    // Surrounding passage before the selection
console.log(context.sourceContext.after);     // Surrounding passage after the selection

// Graph context (knowledge graph neighborhood)
console.log(context.graphContext.connections);       // Connected resources with scores
console.log(context.graphContext.citedBy);           // Resources citing the source
console.log(context.graphContext.citedByCount);      // Total citation count
console.log(context.graphContext.siblingEntityTypes); // Entity types in neighborhood
console.log(context.graphContext.entityTypeFrequencies); // IDF-weighted type frequencies

// Inference enrichment (when InferenceClient is available)
console.log(context.graphContext.inferredRelationshipSummary); // LLM-generated summary

// Metadata
console.log(context.metadata.entityTypes);   // Entity type tags on the annotation
console.log(context.metadata.resourceName);  // Source resource name
```

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `gather:requested` | `{ annotationId, resourceId }` | Fetch context for this annotation |
| `gather:complete` | `{ annotationId, context: GatheredContext }` | Context successfully assembled |
| `gather:failed` | `{ annotationId, error }` | Context fetch failed |

## Context Assembly

The Gatherer actor assembles a `GatheredContext` by:

1. Loading the annotation from Materialized Views
2. Extracting the target text via the annotation's selector
3. Extracting surrounding text (configurable context window, default ~2000 characters)
4. Including annotation metadata (entity types, motivation)
5. Traversing the knowledge graph for connections, citations, and sibling entity types
6. Computing entity type frequencies (IDF-weighted) across the neighborhood
7. Optionally generating an `inferredRelationshipSummary` via the InferenceClient

The result is a `GatheredContext` containing:
- **sourceContext** — `{ selected, before, after }` — the passage text
- **metadata** — Entity types, annotation motivation, resource info
- **graphContext** — Knowledge graph neighborhood:
  - `connections` — Resources linked from/to the source resource, with `mutual` flag for bidirectional links
  - `citedBy` / `citedByCount` — Resources that cite the source
  - `siblingEntityTypes` — Entity types present in the graph neighborhood
  - `entityTypeFrequencies` — IDF-weighted frequency map for entity types
  - `inferredRelationshipSummary` — (optional) LLM-generated 1-2 sentence summary of how the passage relates to its graph neighborhood

## Workflow

### Yield Flow (Generation)

```
User clicks "Generate" on a reference annotation
    |
yield:modal-open fires
    |
useYieldFlow emits gather:requested on EventBus (parallel with modal render)
    |
Gatherer assembles GatheredContext (passage + graph + optional inference summary)
    |
gather:complete → Context available in generation modal
    |
GenerationConfigModal displays entity types, graph context, passage preview
```

### Bind Flow (Search)

```
User clicks "Link Document" on unresolved reference
    |
bind:link fires
    |
useBindFlow emits gather:requested on EventBus
    |
Gatherer assembles GatheredContext (passage + graph + optional inference summary)
    |
gather:complete → Context modal opens for review
    |
User clicks "Find" → bind:search-requested fires with context
    |
Binder uses context for multi-signal search scoring
```

## Relationship to Downstream Flows

Gathering is separate from both generation and search because it is independently useful. Any consumer that needs rich annotation context — the Yield flow, the Bind flow, a search index, an export pipeline, an agent reasoning step — can subscribe to `gather:complete` without triggering other flows.

Current consumers:
- **Yield flow** — uses gathered context to enrich the generation prompt with graph neighborhood
- **Bind flow** — passes gathered context to the Binder for context-driven search scoring

## Implementation

- **Hook**: [packages/react-ui/src/hooks/useContextGatherFlow.ts](../../packages/react-ui/src/hooks/useContextGatherFlow.ts)
- **Event definitions**: [packages/core/src/event-map.ts](../../packages/core/src/event-map.ts) — `CONTEXT CORRELATION FLOW` section
- **API**: `getAnnotationLLMContext` in [@semiont/api-client](../../packages/api-client/README.md)
- **Backend**: Context assembly in [@semiont/make-meaning](../../packages/make-meaning/docs/api-reference.md)
