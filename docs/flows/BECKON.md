# Beckon Flow

**Purpose**: Coordinate which resource or annotation has the user's attention. Hover, click, and navigation signals synchronize the document view, annotation panels, and visual effects so that humans and AI agents can direct focus to specific content.

**Related Documentation**:
- [Frontend Annotations](../../apps/frontend/docs/ANNOTATIONS.md) - UI patterns and component architecture
- [CodeMirror Integration](../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md) - Document view and overlay rendering
- [React UI Events](../../packages/react-ui/docs/EVENTS.md) - Event bus architecture
- [Keyboard Navigation](../../apps/frontend/docs/KEYBOARD-NAV.md) - Keyboard-driven attention

## Overview

The Beckon flow directs user focus to specific annotations or regions of interest. The application uses visual cues — toast notifications, sparkle animations, scroll-to positioning, highlight state — to signal where attention is needed next. AI agents surface suggested follow-ups, confidence flags, and items requiring human review; human collaborators respond to these cues by prioritizing what to examine next.

The Beckon flow is the coordination layer for user focus. When a human hovers over an annotation in the panel, the corresponding text lights up in the document — and vice versa. When an AI agent creates a new annotation, a sparkle animation draws the user's eye to it. All of this runs through a small set of events on the frontend event bus.

Beckoning is ephemeral — it produces no persistent state and coordinates transient focus signals only. Within a browser session, it is purely a frontend concern operating on the local event bus. Cross-participant beckoning (via `semiont beckon` from the CLI or another agent) goes through a lightweight backend endpoint and a participant-scoped SSE stream, but remains stateless: signals are delivered if the participant is connected and silently dropped if not — same semantics as all other beckon events. The [Browse flow](./BROWSE.md) handles the routing of clicks and panel state changes.

## Using the API Client

Attention is a frontend concern — it coordinates focus through the event bus, not through backend API calls. However, the annotations that attention targets are fetched via `@semiont/api-client`:

```typescript
import { SemiontApiClient } from '@semiont/api-client';

const client = new SemiontApiClient({ baseUrl: 'http://localhost:4000' });

// Fetch annotations for a resource (the targets of attention)
const { annotations } = await client.listAnnotations(resourceId);

// Programmatically direct attention via the event bus
eventBus.get('beckon:focus').next({ annotationId: annotations[0].id });
```

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `beckon:hover` | `{ annotationId: string \| null }` | Mouse entered/left an annotation element |
| `browse:click` | `{ annotationId: string; motivation: Motivation }` | User clicked an annotation |
| `beckon:focus` | `{ annotationId: string \| null }` | Scroll-to-annotation signal (relayed from click) |
| `beckon:sparkle` | `{ annotationId: string }` | Trigger sparkle animation on an annotation |
| `browse:panel-toggle` | `{ panel: string }` | Toggle a panel open/closed |
| `browse:panel-open` | `{ panel: string; scrollToAnnotationId?: string }` | Open a specific panel (optionally scroll to annotation) |
| `browse:panel-close` | `void` | Close the active panel |

## Hover Coordination

Hover events synchronize the annotation panel and the document view:

1. Mouse enters annotation element (panel entry or document overlay)
2. After a **150ms dwell** (debounced to suppress transient mouse movements), `beckon:hover` fires
3. `createBeckonVM` sets `hoveredAnnotationId` → both panel and document highlight the annotation
4. `beckon:sparkle` fires → document overlay shows a brief sparkle animation
5. On mouse leave, `beckon:hover` fires with `null` → highlights clear immediately (no delay)

The dwell delay prevents visual noise when the mouse passes through annotations on its way to a button or scrollbar.

Two forms are provided for emitting hover events:
- **`useHoverEmitter(annotationId)`** — React hook returning `{ onMouseEnter, onMouseLeave }` props for panel entries
- **`createHoverHandlers(emit, delayMs)`** — Plain factory for imperative contexts (CodeMirror, PDF canvas, annotation overlay)

## Click → Focus Relay

Click events relay through `beckon:focus` to scroll the document view:

1. User clicks an annotation entry in the panel
2. `browse:click` fires with `annotationId` and `motivation`
3. `createBeckonVM` relays as `beckon:focus`
4. BrowseView subscribes to `beckon:focus` and scrolls the document to the annotation's position

## Cross-Participant Beckoning

`semiont beckon <participantId> --resource <resourceId>` from the CLI (or from another
agent) delivers the same `beckon:focus` signal to a named participant via a backend
endpoint and a participant-scoped SSE stream:

1. CLI emits `beckon:focus` via `POST /bus/emit`
2. Backend broadcasts it on the EventBus; any participant subscribed to the
   `beckon:focus` channel via `/bus/subscribe` receives it
3. Frontend's `SemiontApiClient` has `beckon:focus` in its channel list and
   bridges the event into the local EventBus — same path as an in-browser
   click relay
4. The existing scroll-and-highlight behaviour fires, exactly as if the
   participant had hovered themselves

If the participant is not connected, the signal is dropped. No queue, no retry — same
ephemeral semantics as all other beckon events.


## Implementation

- **ViewModel**: [packages/api-client/src/view-models/flows/beckon-vm.ts](../../packages/api-client/src/view-models/flows/beckon-vm.ts)
- **Event definitions**: [packages/core/src/bus-protocol.ts](../../packages/core/src/bus-protocol.ts) — `BECKON FLOW` section
- **CLI command**: [apps/cli/src/core/commands/beckon.ts](../../apps/cli/src/core/commands/beckon.ts)
- **Backend route**: [apps/backend/src/routes/participants/](../../apps/backend/src/routes/participants/)
