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

Both paths result in an `annotation.body.updated` event that adds the `SpecificResource` link.

## Using the API Client

Resolve a reference annotation by adding a `SpecificResource` link to its body:

```typescript
import { SemiontApiClient } from '@semiont/api-client';

const client = new SemiontApiClient({ baseUrl: 'http://localhost:4000' });

// Link a reference annotation to an existing resource
await client.updateAnnotationBody(resourceId, annotationId, {
  operations: [{
    op: 'add',
    item: {
      type: 'SpecificResource',
      source: 'resource://target-doc-789',
      purpose: 'linking',
    },
  }],
});

// Unlink — remove the SpecificResource body item
await client.updateAnnotationBody(resourceId, annotationId, {
  operations: [{
    op: 'remove',
    oldItem: {
      type: 'SpecificResource',
      source: 'resource://target-doc-789',
      purpose: 'linking',
    },
  }],
});
```

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `bind:link` | `{ annotationId, resourceId, searchTerm }` | User clicked "Link Document" on a reference |
| `bind:search-requested` | `{ referenceId, searchTerm, context? }` | Open the resource search modal (context enables scoring) |
| `bind:search-results` | `{ referenceId, searchTerm, results, correlationId? }` | Scored search results from Binder |
| `bind:search-failed` | `{ referenceId, error, correlationId? }` | Search failed |
| `bind:referenced-by-requested` | `{ correlationId, resourceId, motivation? }` | Query which annotations reference a resource |
| `bind:referenced-by-result` | `{ correlationId, response }` | Referenced-by results from Binder via Graph |
| `bind:update-body` | `{ annotationId, resourceId, operations }` | Update annotation body (add/remove link) |
| `bind:body-updated` | `{ annotationId }` | Annotation body successfully updated |
| `bind:body-update-failed` | `{ error }` | Annotation body update failed |
| `bind:create-manual` | `{ annotationId, title, entityTypes }` | Navigate to compose page for manual resource creation |

## Resolution Workflow

### Link to Existing Resource (Two-Step Modal)

The Bind flow uses a two-step modal: first a context modal shows gathered context (passage, graph neighborhood), then the search modal shows context-scored results.

```
User clicks "Link Document" on unresolved reference
    |
bind:link fires with { annotationId, resourceId, searchTerm }
    |
useBindFlow emits gather:requested on EventBus (fetches annotation context)
    |
Gatherer assembles GatheredContext (passage + graph neighborhood)
    |
gather:complete → Context modal opens (shows passage, connections, entity types)
    |
User clicks "Find" in context modal
    |
bind:search-requested fires with { searchTerm, context: GatheredContext }
    |
Binder runs context-driven search (structural scoring + optional inference scoring)
    |
bind:search-results → Search results modal opens with scored candidates
    |
User selects a resource from search results
    |
bind:update-body → API call (PATCH annotation body)
    |
bind:body-updated → UI updates: unresolved → linked
```

### Context-Driven Search

When `bind:search-requested` includes a `context` field (a `GatheredContext`), the Binder uses multi-source candidate retrieval and composite scoring:

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

### Create New Resource (Manual)

```
User clicks "Create Document" on unresolved reference
    |
bind:create-manual
    |
Navigate to /know/compose?annotationId=...&name=...&entityTypes=...
    |
User composes and saves the new resource
    |
annotation.body.updated event links the reference
```

### Unlinking

Resolution is reversible. A user can remove a link via `bind:update-body` with an `op: 'remove'` operation, returning the reference to its unresolved state.

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

- **Hook**: [packages/react-ui/src/hooks/useBindFlow.ts](../../packages/react-ui/src/hooks/useBindFlow.ts) — two-step modal state, gather trigger, search dispatch
- **Binder actor**: [packages/make-meaning/src/binder.ts](../../packages/make-meaning/src/binder.ts) — context-driven search + inference scoring
- **Event definitions**: [packages/core/src/event-map.ts](../../packages/core/src/event-map.ts) — `RESOLUTION FLOW` section
- **API**: `updateAnnotationBody` in [@semiont/api-client](../../packages/api-client/README.md)
