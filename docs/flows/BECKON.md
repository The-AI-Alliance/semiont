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

Beckoning is ephemeral — it produces no persistent state and coordinates transient focus signals only. Within a browser session, it is purely a frontend concern operating on the local event bus. Cross-participant beckoning (via `semiont beckon` from the CLI or another agent) flows through the unified bus gateway (`POST /bus/emit` + `GET /bus/subscribe`), but remains stateless: signals are delivered if the participant is connected and silently dropped if not — same semantics as all other beckon events. The [Browse flow](./BROWSE.md) handles the routing of clicks and panel state changes.

## Using the API Client

Attention is primarily a frontend concern — in-browser hover/click
signals coordinate through the local event bus without touching the
backend. The annotations that attention targets are fetched via the
namespace API, and programmatic cross-participant beckoning goes
through the `beckon` namespace:

```typescript
import { firstValueFrom } from 'rxjs';

// Fetch annotations for a resource (the targets of attention)
const annotations = await firstValueFrom(
  client.browse.annotations(resourceId),
);

// Programmatically direct attention — broadcasts across participants
// via the bus gateway.
client.beckon.attention(annotations[0].id, resourceId);

// Or, for local-only scroll (no broadcast), emit directly on the
// workspace EventBus:
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

`semiont beckon <resourceId> --annotation <annotationId>` from the CLI
(or a programmatic call to `client.beckon.attention(...)`) delivers the
same `beckon:focus` signal to everyone watching the workspace, through
the unified bus gateway:

1. Originator calls `client.beckon.attention(annotationId, resourceId)`, which
   invokes `actor.emit('beckon:focus', ...)` → `POST /bus/emit`.
2. Backend emits the event on the in-process EventBus.
3. Every connected `SemiontApiClient` has `beckon:focus` and
   `beckon:sparkle` in its bus-subscription channel list; the backend
   broadcasts on these channels via `GET /bus/subscribe` (SSE).
4. The client bridges the event into the local workspace EventBus —
   same delivery path as an in-browser click relay.
5. BrowseView scrolls + pulses; ResourceViewerPage triggers the sparkle
   animation. The originator's own view responds too (their emit echoes
   through the bus, which is the intended behaviour).

If a participant is not connected, the signal is dropped. No queue, no
retry — same ephemeral semantics as all other beckon events.


## Implementation

- **ViewModel**: [packages/api-client/src/view-models/flows/beckon-vm.ts](../../packages/api-client/src/view-models/flows/beckon-vm.ts)
- **Namespace**: [packages/api-client/src/namespaces/beckon.ts](../../packages/api-client/src/namespaces/beckon.ts)
- **Event definitions**: [packages/core/src/bus-protocol.ts](../../packages/core/src/bus-protocol.ts) — `BECKON FLOW` section
- **Bus bridge (client)**: [packages/api-client/src/client.ts](../../packages/api-client/src/client.ts) — `ACTOR_TO_LOCAL_BRIDGES`
- **CLI command**: [apps/cli/src/core/commands/beckon.ts](../../apps/cli/src/core/commands/beckon.ts)
- **Bus gateway**: [apps/backend/src/routes/bus.ts](../../apps/backend/src/routes/bus.ts)
