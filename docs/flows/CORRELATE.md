# Correlate Flow

**Purpose**: Extract semantic context from an annotation and its surrounding document text for downstream use. Correlation assembles a `GenerationContext` — the selected text, surrounding passage, and metadata — that serves as grounding material for the [Generate flow](./GENERATE.md) or any other consumer that needs rich context from an annotation.

**Related Documentation**:
- [Generate Flow](./GENERATE.md) - Primary consumer of correlated context
- [Annotate Flow](./ANNOTATE.md) - How annotations (the correlation sources) are created
- [@semiont/make-meaning Architecture](../../packages/make-meaning/docs/architecture.md) - Context assembly layer
- [Make-Meaning API Reference](../../packages/make-meaning/docs/api-reference.md) - `getAnnotationLLMContext` endpoint

## Overview

When a user or agent wants to generate a new resource from a reference annotation, the system first needs to understand the context around that reference — what the surrounding text says, what the annotation targets, and what entity types are involved. The Correlate flow fetches this context from the backend and makes it available to downstream flows.

Correlation is triggered automatically when the generation modal opens. It runs in parallel with the modal rendering, so context is typically ready by the time the user submits.

## Using the API Client

Fetch the assembled context for an annotation:

```typescript
import { SemiontApiClient } from '@semiont/api-client';

const client = new SemiontApiClient({ baseUrl: 'http://localhost:4000' });

// Get LLM-ready context for an annotation
const { context } = await client.getAnnotationLLMContext(
  resourceUri,
  annotationId,
  { contextWindow: 2000 }
);

// context contains: selectedText, beforeText, afterText, metadata
console.log(context.selectedText);  // The exact text the annotation targets
console.log(context.beforeText);    // Surrounding passage before the selection
console.log(context.afterText);     // Surrounding passage after the selection
```

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `correlate:requested` | `{ annotationUri, resourceUri }` | Fetch context for this annotation |
| `correlate:complete` | `{ annotationUri, context: GenerationContext }` | Context successfully assembled |
| `correlate:failed` | `{ annotationUri, error }` | Context fetch failed |

## Context Assembly

The backend assembles a `GenerationContext` by:

1. Loading the annotation from View Storage
2. Extracting the target text via the annotation's selector
3. Extracting surrounding text (configurable context window, default ~2000 characters)
4. Including annotation metadata (entity types, motivation)

The result is a `GenerationContext` containing:
- **selectedText** — The exact text the annotation targets
- **beforeText** — Text preceding the selection
- **afterText** — Text following the selection
- **metadata** — Entity types, annotation motivation, resource info

## Workflow

```
User clicks "Generate" on a reference annotation
    |
generate:modal-open fires
    |
useGenerationFlow emits correlate:requested (parallel with modal render)
    |
useContextCorrelationFlow calls getAnnotationLLMContext API
    |
Backend assembles GenerationContext from View Storage + RepresentationStore
    |
correlate:complete fires with assembled context
    |
Context available in generation modal for user review and submission
```

## Relationship to Generate

Correlation and generation are separate flows because correlation is independently useful. Any consumer that needs rich annotation context — a search index, an export pipeline, an agent reasoning step — can subscribe to `correlate:complete` without triggering generation.

In the current UI, the primary consumer is the Generate flow. When `generate:modal-open` fires, `useGenerationFlow` emits `correlate:requested` in parallel. The correlated context is then passed as input when the user submits the generation form.

## Implementation

- **Hook**: [packages/react-ui/src/hooks/useContextCorrelationFlow.ts](../../packages/react-ui/src/hooks/useContextCorrelationFlow.ts)
- **Event definitions**: [packages/core/src/event-map.ts](../../packages/core/src/event-map.ts) — `CONTEXT CORRELATION FLOW` section
- **API**: `getAnnotationLLMContext` in [@semiont/api-client](../../packages/api-client/README.md)
- **Backend**: Context assembly in [@semiont/make-meaning](../../packages/make-meaning/docs/api-reference.md)
