# Gather Flow

**Purpose**: Extract semantic context from an annotation — its surrounding passage, metadata, and knowledge graph neighborhood — for downstream use. The Gatherer assembles a `GatheredContext` that serves as grounding material for the [Yield flow](./YIELD.md), the [Bind flow](./BIND.md), or any other consumer that needs rich context from an annotation.

**Related Documentation**:
- [Yield Flow](./YIELD.md) - Consumer: generation prompt enrichment
- [Bind Flow](./BIND.md) - Consumer: context-driven search scoring
- [Mark Flow](./MARK.md) - How annotations (the correlation sources) are created
- [@semiont/make-meaning Architecture](../../../packages/make-meaning/docs/architecture.md) - Context assembly layer
- [Make-Meaning API Reference](../../../packages/make-meaning/docs/api-reference.md) - `buildLLMContext` method

## Overview

The Gather flow assembles related context around a focal annotation. The application surfaces surrounding passage text, annotation metadata, and knowledge graph neighborhood to construct a coherent input for downstream processing. AI agents perform RAG retrieval, context window assembly, and knowledge graph traversal; human collaborators pull prior materials and cross-references. The output is a `GatheredContext` object that provides grounding material for resource generation, context-driven search, or other context-dependent operations.

Gathering is triggered automatically when the Reference Resolution Wizard opens (`bind:initiate`). It runs in parallel with the wizard rendering, so context is typically ready by the time the user interacts with the wizard's first step.

## Using the API Client

Gathering is a long-running operation (LLM calls + graph traversal).
`client.gather.annotation()` returns an Observable that emits progress
events while the Gatherer assembles context, then emits the final
`GatheredContext` on completion.

```typescript
import { firstValueFrom, lastValueFrom } from 'rxjs';

// Subscribe for progress + result
client.gather.annotation(annotationId, resourceId, { contextWindow: 2000 })
  .subscribe({
    next: (event) => console.log('progress:', event),
    complete: () => console.log('done'),
    error: (err) => console.error(err),
  });

// Or await the final context (one-shot)
const final = await lastValueFrom(
  client.gather.annotation(annotationId, resourceId, { contextWindow: 2000 }),
);
const context = (final as { context?: GatheredContext }).context;

// gather.annotation returns an annotation-focus GatheredContext — narrow on focus.kind
if (context.focus.kind === 'annotation') {
  const focus = context.focus;
  console.log(focus.selected?.text);      // The exact text the annotation targets
  console.log(focus.selected?.before);    // Surrounding passage before the selection
  console.log(focus.selected?.after);     // Surrounding passage after the selection
  console.log(focus.sourceResource.name); // Source resource name

  // The flattened neighborhood views derive from the shared graph backbone
  // (deriveViews is exported from @semiont/core)
  const views = deriveViews(context.graph, String(focus.sourceResource.id), focus.annotation.id);
  console.log(views.connections);        // Connected resources with scores
  console.log(views.citedBy);            // Resources citing the source
  console.log(views.citedByCount);       // Total citation count
  console.log(views.siblingEntityTypes); // Entity types in the neighborhood
}

// Shared base (present on every GatheredContext, both focus kinds)
console.log(context.graph.nodes);                    // KnowledgeGraph: resource + annotation nodes
console.log(context.metadata.entityTypes);           // Entity type tags
console.log(context.metadata.entityTypeFrequencies); // IDF-weighted type frequencies
console.log(context.inferredRelationshipSummary);    // (optional) LLM-generated summary
console.log(context.semanticContext?.similar);       // (optional) vector-similar passages
```

Under the hood: the namespace emits `gather:annotation-request` via
`/bus/emit` with a correlationId, then filters `gather:complete` and
`gather:annotation-progress` events coming back through the bus for
that correlationId. The Gatherer actor on the backend handles the
command. See [`EVENT-BUS.md`](../EVENT-BUS.md).

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
- **focus** (`kind: 'annotation'`) — `{ annotation, sourceResource, selected: { text, before, after }, userHint? }` — the annotation, its resource, and the passage text it targets
- **graph** — a `KnowledgeGraph` (the shared backbone): resource **and** annotation nodes plus typed, directional edges (with a `bidirectional?` flag). The flattened neighborhood views — `connections`, `citedBy` / `citedByCount`, `siblingEntityTypes` — are **derived from `graph`** via `deriveViews` (`@semiont/core`), not stored
- **metadata** — `{ entityTypes?, entityTypeFrequencies?, language?, resourceType? }` (the IDF-weighted frequency map is a global statistic kept here, not graph-derived)
- **inferredRelationshipSummary** — (optional) LLM-generated 1-2 sentence summary of how the passage relates to its graph neighborhood
- **semanticContext** — (optional) `{ similar }` — vector-similar passages, when embeddings are available

## Workflow

### Reference Resolution Wizard

```
User clicks 🕸️🧙 wizard button on unresolved reference
    |
bind:initiate fires
    |
ResourceViewerPage emits gather:requested on EventBus (parallel with wizard render)
    |
Gatherer assembles GatheredContext (passage + graph + optional inference summary)
    |
gather:complete → Wizard Step 1 displays entity types, graph context, passage preview
    |
User chooses: Bind (search) / Generate (AI) / Compose (manual)
```

Both the Bind path (context-driven search) and Generate path (SSE generation) use the same `GatheredContext` gathered in Step 1.

## Relationship to Downstream Flows

Gathering is separate from both generation and search because it is independently useful. Any consumer that needs rich annotation context — the Yield flow, the Bind flow, a search index, an export pipeline, an agent reasoning step — can subscribe to `gather:complete` without triggering other flows.

Current consumers:
- **Yield flow** — uses gathered context to enrich the generation prompt with graph neighborhood
- **Bind flow** — passes gathered context to the Matcher for context-driven search scoring

## Implementation

- **StateUnit**: [packages/sdk/src/state/flows/gather-state-unit.ts](../../../packages/sdk/src/state/flows/gather-state-unit.ts)
- **Event definitions**: [packages/core/src/bus-protocol.ts](../../../packages/core/src/bus-protocol.ts) — `GATHER FLOW` section
- **API**: `getAnnotationLLMContext` in [@semiont/sdk](../../../packages/sdk/README.md)
- **Backend**: Context assembly in [@semiont/make-meaning](../../../packages/make-meaning/docs/api-reference.md)
