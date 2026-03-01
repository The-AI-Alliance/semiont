# Resolve Flow

**Purpose**: Link reference annotations to existing resources or create new ones. When an annotation with motivation `linking` is created (by a human or AI agent), the Resolve flow lets a collaborator search for an existing resource to link it to, or navigate to the compose page to create a new one manually.

**Related Documentation**:
- [W3C Web Annotation Data Model](../../specs/docs/W3C-WEB-ANNOTATION.md) - Reference annotation and SpecificResource body structure
- [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md) - Event Store and annotation body updates
- [Annotate Flow](./ANNOTATE.md) - How reference annotations are created
- [Generate Flow](./GENERATE.md) - AI-powered resource generation (alternative to manual resolution)

## Overview

A reference annotation (motivation: `linking`) identifies an entity mention in a document — a person, place, concept, etc. Initially unresolved, it contains only entity type tags in its body. Resolution adds a `SpecificResource` body item that links the annotation to a concrete resource.

Resolution can happen in two ways:
1. **Link to existing resource** — Search for and select a resource already in the system
2. **Create new resource** — Navigate to the compose page with pre-filled parameters, or use the [Generate flow](./GENERATE.md) to have an AI agent create the resource

Both paths result in an `annotation.body.updated` event that adds the `SpecificResource` link.

## Using the API Client

Resolve a reference annotation by adding a `SpecificResource` link to its body:

```typescript
import { SemiontApiClient } from '@semiont/api-client';

const client = new SemiontApiClient({ baseUrl: 'http://localhost:4000' });

// Link a reference annotation to an existing resource
await client.updateAnnotationBody(annotationUri, {
  resourceId,
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
await client.updateAnnotationBody(annotationUri, {
  resourceId,
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
| `bind:link` | `{ annotationUri, searchTerm }` | User clicked "Link Document" on a reference |
| `bind:search-requested` | `{ referenceId, searchTerm }` | Open the resource search modal |
| `bind:update-body` | `{ annotationUri, resourceId, operations }` | Update annotation body (add/remove link) |
| `bind:body-updated` | `{ annotationUri }` | Annotation body successfully updated |
| `bind:body-update-failed` | `{ error }` | Annotation body update failed |
| `bind:create-manual` | `{ annotationUri, title, entityTypes }` | Navigate to compose page for manual resource creation |

## Resolution Workflow

### Link to Existing Resource

```
User clicks "Link Document" on unresolved reference
    |
bind:link → bind:search-requested
    |
Search modal opens with pre-filled search term
    |
User selects a resource from search results
    |
bind:update-body → API call (PATCH annotation body)
    |
bind:body-updated → UI updates: unresolved → linked
```

### Create New Resource (Manual)

```
User clicks "Create Document" on unresolved reference
    |
bind:create-manual
    |
Navigate to /know/compose?annotationUri=...&name=...&entityTypes=...
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

- **Hook**: [packages/react-ui/src/hooks/useBindFlow.ts](../../packages/react-ui/src/hooks/useBindFlow.ts)
- **Event definitions**: [packages/core/src/event-map.ts](../../packages/core/src/event-map.ts) — `RESOLUTION FLOW` section
- **API**: `updateAnnotationBody` in [@semiont/api-client](../../packages/api-client/README.md)
