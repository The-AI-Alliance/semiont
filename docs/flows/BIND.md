# Bind Flow

**Purpose**: Link reference annotations to existing resources or create new ones. When an annotation with motivation `linking` is created (by a human or AI agent), the Bind flow lets a collaborator review gathered context, then search for an existing resource to link it to, or navigate to the compose page to create a new one manually.

**Related Documentation**:
- [W3C Web Annotation Data Model](../../specs/docs/W3C-WEB-ANNOTATION.md) - Reference annotation and SpecificResource body structure
- [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md) - Event Store and annotation body updates
- [Mark Flow](./MARK.md) - How reference annotations are created
- [Gather Flow](./GATHER.md) - Context assembly (used by Bind before search)
- [Yield Flow](./YIELD.md) - AI-powered resource generation (alternative to manual resolution)

## Overview

The Bind flow resolves ambiguous references to specific resources. A detected entity mention such as "John Smith" is linked to the correct resource in the knowledge base, converting an unresolved annotation into a concrete cross-document link. AI agents perform entity linking, coreference resolution, and grounding (hallucination — binding to a nonexistent referent — is the primary failure mode). Human collaborators verify and confirm matches by cross-checking records and disambiguating between candidate entities.

A reference annotation (motivation: `linking`) identifies an entity mention in a document — a person, place, concept, etc. Initially unresolved, it contains only entity type tags in its body. Binding adds a `SpecificResource` body item that links the annotation to a concrete resource.

Resolution can happen in two ways:
1. **Link to existing resource** — Search for and select a resource already in the system
2. **Create new resource** — Navigate to the compose page with pre-filled parameters, or use the [Yield flow](./YIELD.md) to have an AI agent create the resource

Both paths result in an `mark:body-updated` event that adds the `SpecificResource` link.

## Using the API Client

Resolve a reference annotation by adding a `SpecificResource` link to
its body. The `bind` namespace emits `bind:initiate` on the bus gateway
— the backend Stower handler persists the body change and broadcasts
the enriched `mark:body-updated` event to everyone viewing the resource.

```typescript
// Link a reference annotation to an existing resource
await client.bind.body(resourceId, annotationId, [{
  op: 'add',
  item: {
    type: 'SpecificResource',
    source: 'resource://target-doc-789',
    purpose: 'linking',
  },
}]);

// Unlink — remove the SpecificResource body item
await client.bind.body(resourceId, annotationId, [{
  op: 'remove',
  item: {
    type: 'SpecificResource',
    source: 'resource://target-doc-789',
    purpose: 'linking',
  },
}]);
```

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `bind:initiate` | `{ correlationId, annotationId, resourceId, operations }` | Frontend emits; Stower handles via bus gateway. Wizard-style UI also uses this channel to signal the wizard should open. |
| `match:search-requested` | `{ correlationId, referenceId, context, limit?, useSemanticScoring? }` | Search for binding candidates using gathered context |
| `match:search-results` | `{ correlationId, referenceId, response }` | Scored search results from Matcher |
| `match:search-failed` | `{ correlationId, referenceId, error }` | Search failed |
| `browse:referenced-by-requested` | `{ correlationId, resourceId, motivation? }` | Query which annotations reference a resource |
| `browse:referenced-by-result` | `{ correlationId, response }` | Referenced-by results |
| `bind:body-updated` | `{ annotationId }` | Annotation body successfully updated |
| `bind:body-update-failed` | `{ error }` | Annotation body update failed |

## Resolution Workflow

### Link to Existing Resource (Wizard)

The Bind path runs through a multi-step wizard (`ReferenceWizardModal`). A single 🕸️🧙 button on any unresolved reference opens it. The wizard first displays the gathered context (passage, entity types, graph neighborhood), then offers three resolution strategies: **Bind** (search for an existing resource via the Matcher), **Generate** (AI-create a new resource via the Yield flow), or **Compose** (navigate to the compose page with context pre-loaded). Choosing Bind advances to a search configuration step — max results (1/5/10/20) and a semantic scoring toggle — before running the Matcher search.

```
User clicks 🕸️🧙 wizard button on unresolved reference
    |
bind:initiate fires with { annotationId, resourceId, defaultTitle, entityTypes }
    |
ResourceViewerPage emits gather:requested on EventBus
    |
Gatherer assembles GatheredContext (passage + graph neighborhood)
    |
gather:complete → Wizard shows gathered context (Step 1)
    |
User clicks "Bind" → Configure Search (Step 2A)
    |
User submits search → match:search-requested emitted via /bus/emit with { correlationId, context, limit, useSemanticScoring }
    |
Matcher runs context-driven search (structural scoring + optional inference scoring)
    |
match:search-results → Wizard shows scored candidates (Step 3A)
    |
User clicks "Link" on a result
    |
client.bind.body(...) → bind:initiate emitted via /bus/emit → 202
    |
backend Stower persists mark:body-updated event, materializes view
    |
EventStore enrichment attaches post-materialization annotation,
publishes on scoped EventBus → /bus/subscribe → frontend ActorVM
    |
BrowseNamespace.updateAnnotationInPlace writes the annotation into the cached Observable
    |
useObservable re-renders → ReferenceEntry recomputes isBodyResolved → 🔗
```

### How the link icon flip works

The `mark:body-updated` event delivered through the bus gateway carries the post-materialization annotation (attached by the event store enrichment callback). The `BrowseNamespace`'s EventBus subscriber writes it directly into the cached Observable via `updateAnnotationInPlace` — no HTTP refetch needed. This is the single delivery path for all annotation mutations: locally-initiated binds and remote mutations from other participants all arrive the same way. See `apps/backend/docs/STREAMS.md` for the bus-gateway architecture.

### Context-Driven Search

When `match:search-requested` includes a `context` field (a `GatheredContext`), the Matcher uses multi-source candidate retrieval and composite scoring:

**Candidate Sources**:
1. Name match — direct text search against resource names
2. Entity type filtered — resources sharing entity types with the annotation
3. Graph neighborhood — resources connected to the source resource

**Structural Scoring Signals**:
- Entity type overlap (Jaccard similarity + IDF weighting)
- Bidirectional links (mutual connections score higher)
- Citation weight (how many annotations reference the candidate)
- Name match quality
- Recency
- Multi-source bonus (candidates found via multiple retrieval paths)

**Inference Scoring** (when `InferenceClient` is available):
- Top 20 candidates are batch-scored by LLM for semantic relevance
- The LLM receives the passage text, entity types, and candidate names
- Returns 0–1 relevance scores that blend with structural scores
- Graceful degradation — if inference fails, structural scores are used alone

### Create New Resource (Compose via Wizard)

```
User clicks 🕸️🧙 wizard button → Step 1 shows context → User clicks "Compose"
    |
GatheredContext stored in sessionStorage
    |
Navigate to /know/compose?annotationUri=...&name=...&entityTypes=...
    |
User composes and saves the new resource
    |
mark:body-updated event links the reference
```

### Unlinking

Resolution is reversible. A user can remove a link via `client.bind.body()` with an `op: 'remove'` operation, returning the reference to its unresolved state.

## Annotation Body Structure

**Unresolved** (entity type tags only):
```json
{
  "body": [
    { "type": "TextualBody", "value": "Person", "purpose": "tagging" }
  ]
}
```

**Resolved** (with SpecificResource link):
```json
{
  "body": [
    { "type": "TextualBody", "value": "Person", "purpose": "tagging" },
    { "type": "SpecificResource", "source": "resource://doc-789", "purpose": "linking" }
  ]
}
```

## Implementation

- **ViewModel**: [packages/api-client/src/view-models/flows/bind-vm.ts](../../packages/api-client/src/view-models/flows/bind-vm.ts) — write side (annotation body updates)
- **Wizard**: [packages/react-ui/src/components/modals/ReferenceWizardModal.tsx](../../packages/react-ui/src/components/modals/ReferenceWizardModal.tsx) — multi-step wizard for Bind/Generate/Compose
- **Matcher actor**: [packages/make-meaning/src/matcher.ts](../../packages/make-meaning/src/matcher.ts) — context-driven search + inference scoring
- **Event definitions**: [packages/core/src/bus-protocol.ts](../../packages/core/src/bus-protocol.ts) — `BIND FLOW` section
- **API**: `updateAnnotationBody` in [@semiont/sdk](../../packages/sdk/README.md)
