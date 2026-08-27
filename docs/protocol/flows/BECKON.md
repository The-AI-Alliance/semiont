# Beckon Flow

**Purpose**: Coordinate which resource or annotation has the user's attention. Hover, click, and navigation signals synchronize the document view, annotation panels, and visual effects so that humans and AI agents can direct focus to specific content.

**Related Documentation**:
- [Browser Annotations](../../../apps/browser/docs/ANNOTATIONS.md) - UI patterns and component architecture
- [CodeMirror Integration](../../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md) - Document view and overlay rendering
- [React UI Events](../../../packages/react-ui/docs/EVENTS.md) - Event bus architecture
- [Keyboard Navigation](../../browser/KEYBOARD-NAV.md) - Keyboard-driven attention

## Overview

The Beckon flow directs user focus to specific annotations or regions of interest. The application uses visual cues — toast notifications, sparkle animations, scroll-to positioning, highlight state — to signal where attention is needed next. AI agents surface suggested follow-ups, confidence flags, and items requiring human review; human collaborators respond to these cues by prioritizing what to examine next.

The Beckon flow is the coordination layer for user focus. When a human hovers over an annotation in the panel, the corresponding text lights up in the document — and vice versa. When an AI agent creates a new annotation, a sparkle animation draws the user's eye to it. All of this runs through a small set of events on the Browser event bus.

Beckoning is ephemeral — it produces no persistent state and coordinates transient focus signals only. Within a browser session, it is purely a Browser concern operating on the local event bus. Cross-participant beckoning (via `semiont beckon` from the launcher or another agent) flows through the unified bus gateway (`POST /bus/emit` + `GET /bus/subscribe`), but remains stateless: signals are delivered if the participant is connected and silently dropped if not — same semantics as all other beckon events. The [Browse flow](./BROWSE.md) handles the routing of clicks and panel state changes.

## Using the SDK

Attention is primarily a Browser concern — in-browser hover/click
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
// via the bus gateway. Each wire drive resolves with the subscriber
// count at dispatch (-1 = unknown).
await client.beckon.attention(resourceId, annotations[0].id);  // point at it
await client.beckon.click(annotations[0].id);                  // OPEN it

// Or, for local-only scroll (no broadcast), emit directly on the
// workspace EventBus:
eventBus.get('beckon:focus').next({ annotationId: annotations[0].id });
```

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `beckon:hover` | `{ annotationId: string \| null }` | Mouse entered/left an annotation element |
| `browse:click` | `{ annotationId: string }` (+ local-only `anchorRect?`) | An annotation was clicked — **open** it (see Browse flow) |
| `beckon:focus` | `{ annotationId?: string \| null; resourceId? }` | Scroll-to-annotation signal (relayed from click) |
| `beckon:sparkle` | `{ annotationId: string }` | Trigger sparkle animation on an annotation |

**`beckon:focus.resourceId` is a guard, not navigation.** It names the resource
the focus applies to; a viewer currently showing a different resource
*deliberately ignores* the event rather than silently no-oping. Moving the
viewer is [`browse:resource-open`](./BROWSE.md#cross-participant-navigation)'s
job. The field is optional, and **absence still scrolls** — the in-app emitters
(history panel, annotation list) omit it because they are already scoped to the
open resource, so treating absent as "not mine" would silence all of them.

**Focus points; a click opens.** `beckon:focus` scrolls the viewer to an
annotation and stops. `browse:click` opens it — the annotations panel comes up
with that entry selected, and this flow's relay then produces the scroll. Both
are drivable from outside the page, so a guide chooses between "notice this"
and "read this"; see
[Cross-participant navigation](./BROWSE.md#cross-participant-navigation).

Note the asymmetry with the guard above: a click carries no `resourceId`
because its `annotationId` is **required** and already names one annotation on
one resource. Focus's `annotationId` is optional — it can name a resource
alone — which is what leaves `resourceId` something to guard.

Panel state is not an event flow — see
[Panel and sidebar state](./BROWSE.md#panel-and-sidebar-state) in the Browse
flow.

## Hover Coordination

Hover events synchronize the annotation panel and the document view:

1. Mouse enters annotation element (panel entry or document overlay)
2. After a **150ms dwell** (debounced to suppress transient mouse movements), `beckon:hover` fires
3. `createBeckonStateUnit` sets `hoveredAnnotationId` → both panel and document highlight the annotation
4. `beckon:sparkle` fires → document overlay shows a brief sparkle animation
5. On mouse leave, `beckon:hover` fires with `null` → highlights clear immediately (no delay)

The dwell delay prevents visual noise when the mouse passes through annotations on its way to a button or scrollbar.

Two forms are provided for emitting hover events:
- **`useHoverEmitter(annotationId)`** — React hook returning `{ onMouseEnter, onMouseLeave }` props for panel entries
- **`createHoverHandlers(emit, delayMs)`** — Plain factory for imperative contexts (CodeMirror, PDF canvas, annotation overlay)

## Click → Focus Relay

Click events relay through `beckon:focus` to scroll the document view:

1. User clicks an annotation entry in the panel
2. `browse:click` fires with `annotationId` (the motivation is derived from the annotation it names, not carried)
3. `createBeckonStateUnit` relays as `beckon:focus`
4. BrowseView subscribes to `beckon:focus` and scrolls the document to the annotation's position

## Cross-Participant Beckoning

`semiont beckon <resourceId> --annotation <annotationId>` from the launcher
(or a programmatic call to `client.beckon.attention(...)`) delivers the
same `beckon:focus` signal to everyone watching the workspace, through
the unified bus gateway:

1. Originator calls `client.beckon.attention(resourceId, annotationId)`, which
   invokes `actor.emit('beckon:focus', ...)` → `POST /bus/emit`.
2. Backend emits the event on the in-process EventBus.
3. Every connected `SemiontClient` has `beckon:focus` and
   `beckon:sparkle` in its bus-subscription channel list; the backend
   broadcasts on these channels via `GET /bus/subscribe` (SSE).
4. The client bridges the event into the local workspace EventBus —
   same delivery path as an in-browser click relay.
5. BrowseView scrolls + pulses; ResourceViewerPage triggers the sparkle
   animation. The originator's own view responds too (their emit echoes
   through the bus, which is the intended behaviour).

If a participant is not connected, the signal is dropped. No queue, no
retry — same ephemeral semantics as all other beckon events.

## Presence Aggregation Is Consumer Territory

The Beckon flow is a *substrate*, not a presence system. It delivers
ephemeral signals — hover, focus, sparkle, click, panel-open — and
that is the entire contract. There is no aggregation layer ("who is
currently hovering this annotation"), no debounce beyond the 150ms
dwell, no synthesis of cursor positions or per-user state, and no
last-seen retention.

A consumer that wants Liveblocks-style live-cursor-with-username, a
"3 collaborators here" indicator, or any presence-as-a-feature view
builds it on top of the beckon signals plus its own state aggregator —
typically a small reducer that listens to `beckon:hover` events
(carrying `_userId` from the gateway) and maintains a map of
`userId → { annotationId, lastSeenAt }`. The protocol delivers the raw
signals; the consumer decides the aggregation policy, retention
window, and rendering.

This split is deliberate. Presence semantics are domain-specific —
"who is hovering" matters in a code review tool, "who has read this"
matters in a knowledge base, "where is the cursor" matters in a live
editor — and a one-size-fits-all aggregation layer in the protocol
would push policy decisions onto every consumer regardless of fit. The
ephemeral, fan-out-only contract is the substrate every presence
system can be built on.

## Implementation

- **StateUnit**: [packages/sdk/src/state/flows/beckon-state-unit.ts](../../../packages/sdk/src/state/flows/beckon-state-unit.ts)
- **Namespace**: [packages/sdk/src/namespaces/beckon.ts](../../../packages/sdk/src/namespaces/beckon.ts)
- **Event definitions** (authority; generated into `bus-protocol.ts`): [specs/src/bus/registry.json](../../../specs/src/bus/registry.json) — `BECKON FLOW` section
- **Bus bridge (client)**: [packages/sdk/src/client.ts](../../../packages/sdk/src/client.ts) — `ACTOR_TO_LOCAL_BRIDGES`
- **Launcher command**: [apps/launcher/internal/launcher/beckon.go](../../../apps/launcher/internal/launcher/beckon.go) — `semiont beckon`
- **Bus gateway**: [apps/backend/src/routes/bus.ts](../../../apps/backend/src/routes/bus.ts)
