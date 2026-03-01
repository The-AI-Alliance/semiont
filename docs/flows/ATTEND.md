# Attend Flow

**Purpose**: Coordinate which resource or annotation has the user's attention. Hover, click, and navigation signals synchronize the document view, annotation panels, and visual effects so that humans and AI agents can direct focus to specific content.

**Related Documentation**:
- [Frontend Annotations](../../apps/frontend/docs/ANNOTATIONS.md) - UI patterns and component architecture
- [CodeMirror Integration](../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md) - Document view and overlay rendering
- [React UI Events](../../packages/react-ui/docs/EVENTS.md) - Event bus architecture
- [Keyboard Navigation](../../apps/frontend/docs/KEYBOARD-NAV.md) - Keyboard-driven attention

## Overview

The Attend flow is the coordination layer for user focus. When a human hovers over an annotation in the panel, the corresponding text lights up in the document — and vice versa. When an AI agent creates a new annotation, a sparkle animation draws the user's eye to it. All of this runs through a small set of events on the frontend event bus.

Attention is purely a frontend concern. It produces no backend events and no persistent state. It is the entry point of the five-flow pipeline: you attend to something before you annotate, resolve, correlate, or generate from it.

## Using the API Client

Attention is a frontend concern — it coordinates focus through the event bus, not through backend API calls. However, the annotations that attention targets are fetched via `@semiont/api-client`:

```typescript
import { SemiontApiClient } from '@semiont/api-client';

const client = new SemiontApiClient({ baseUrl: 'http://localhost:4000' });

// Fetch annotations for a resource (the targets of attention)
const { annotations } = await client.listAnnotations(resourceUri);

// Programmatically direct attention via the event bus
eventBus.get('attend:focus').next({ annotationId: annotations[0].id });
```

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `attend:hover` | `{ annotationId: string \| null }` | Mouse entered/left an annotation element |
| `navigation:click` | `{ annotationId: string; motivation: Motivation }` | User clicked an annotation |
| `attend:focus` | `{ annotationId: string \| null }` | Scroll-to-annotation signal (relayed from click) |
| `attend:sparkle` | `{ annotationId: string }` | Trigger sparkle animation on an annotation |
| `navigation:panel-toggle` | `{ panel: string }` | Toggle a panel open/closed |
| `navigation:panel-open` | `{ panel: string; scrollToAnnotationId?: string }` | Open a specific panel (optionally scroll to annotation) |
| `navigation:panel-close` | `void` | Close the active panel |

## Hover Coordination

Hover events synchronize the annotation panel and the document view:

1. Mouse enters annotation element (panel entry or document overlay)
2. After a **150ms dwell** (debounced to suppress transient mouse movements), `attend:hover` fires
3. `useAttentionFlow` sets `hoveredAnnotationId` → both panel and document highlight the annotation
4. `attend:sparkle` fires → document overlay shows a brief sparkle animation
5. On mouse leave, `attend:hover` fires with `null` → highlights clear immediately (no delay)

The dwell delay prevents visual noise when the mouse passes through annotations on its way to a button or scrollbar.

Two forms are provided for emitting hover events:
- **`useHoverEmitter(annotationId)`** — React hook returning `{ onMouseEnter, onMouseLeave }` props for panel entries
- **`createHoverHandlers(emit, delayMs)`** — Plain factory for imperative contexts (CodeMirror, PDF canvas, annotation overlay)

## Click → Focus Relay

Click events relay through `attend:focus` to scroll the document view:

1. User clicks an annotation entry in the panel
2. `navigation:click` fires with `annotationId` and `motivation`
3. `useAttentionFlow` relays as `attend:focus`
4. BrowseView subscribes to `attend:focus` and scrolls the document to the annotation's position

## Implementation

- **Hook**: [packages/react-ui/src/hooks/useAttentionFlow.ts](../../packages/react-ui/src/hooks/useAttentionFlow.ts)
- **Event definitions**: [packages/core/src/event-map.ts](../../packages/core/src/event-map.ts) — `ATTENTION FLOW` section
