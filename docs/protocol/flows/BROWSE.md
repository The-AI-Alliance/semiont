# Browse Flow

**Purpose**: Read the knowledge base, and route the acts of looking at it. Browse covers both halves: the request/reply operations that fetch resources, annotations, and history, and the intent signals that decide *what to look at next* — decoupling the components that choose a destination (toolbar buttons, annotation clicks, resolved-reference links, a tour guide at a terminal) from the components that perform the navigation (Next.js router, sidebar state, panel container). This separation lets react-ui remain framework-agnostic — the library emits intent; the host application fulfills it.

**Related Documentation**:
- [Beckon Flow](./BECKON.md) - Hover/focus/sparkle coordination (attention precedes navigation)
- [Bind Flow](./BIND.md) - Reference resolution triggers navigation to linked resources
- [Event-Bus Protocol](../EVENT-BUS.md) - Channel naming, bridging, SSE streaming
- [Frontend Annotations](../../../apps/frontend/docs/ANNOTATIONS.md) - Annotation click and panel interaction
- [React UI Events](../../../packages/react-ui/docs/EVENTS.md) - Event bus architecture
- [Launcher README](../../../apps/launcher/README.md) - `semiont browse`, including `--browser`

## Overview

The Browse flow provides structured navigation through the knowledge base. The application exposes paths through resources via click-through, drill-down, expand/collapse, filtering, and sorting. AI agents traverse these paths through agentic tool use and multi-hop reasoning; human collaborators review and examine content — scanning, comparing, and selectively reading in depth.

Four categories, distinguished by *who can hear them*:

1. **Read operations** — thirteen `browse:*-requested` request/reply pairs that fetch resources, annotations, history, and directory listings. Correlated; the replies are bridged by construction.
2. **Cross-participant navigation** — `browse:resource-open` (drive) and `browse:resource-viewed` (report). Bridged broadcasts: an agent or the launcher can move a participant's Browser, and the viewer announces where it landed.
3. **Local UI signals** — `browse:click`, `browse:entity-type-clicked`. Local-bus fan-out inside one browser session; never on the wire.
4. **Host routing** — the `nav:*` channels. Framework-shaped, host-local, and deliberately never bridged.

Browse is therefore **not** purely a frontend concern. Categories 1 and 2 cross the backend; only 3 and 4 stay in the page.

## The bridge boundary: `nav:*` is host-local, `browse:*` may cross

This is the rule that decides which prefix a new channel gets, and it is worth stating before the tables:

> **`browse:*` carries domain intent — *open resource R* — and may cross a transport. `nav:*` carries framework routing — *push path P* — and never does.**

`ResourceViewerPage` is where the two meet: it subscribes to `browse:resource-open`, calls `routes.resourceDetail(resourceId)`, and emits `nav:push` with the result. That translation is the whole point of the split.

Bridging `nav:push` instead would put Next.js paths and locale prefixes on the wire, and force every remote caller — the launcher, an agent — to know the frontend's route shapes. A future "just bridge `nav:push`, it's simpler" is a regression, not a shortcut.

Note that the payload distinction is real, not cosmetic: `browse:resource-open` carries `{resourceId}`, while `nav:push` carries `{path, reason?}`. Only one of those means anything to a caller outside the app.

## Read operations

Thirteen request/reply pairs, each `browse:X-requested` → `browse:X-result` / `browse:X-failed`:

| Operation | Requested channel | Returns |
|---|---|---|
| Resource | `browse:resource-requested` | One resource descriptor |
| Resource list | `browse:resources-requested` | The reply envelope — resources, `total`, `offset`, `limit`, `matchKind` |
| Anchored text | `browse:anchored-text-requested` | Extracted text for anchoring |
| Annotations | `browse:annotations-requested` | Every annotation on a resource |
| Annotation | `browse:annotation-requested` | One annotation |
| Annotation context | `browse:annotation-context-requested` | Surrounding text for an annotation |
| Annotation history | `browse:annotation-history-requested` | An annotation's event history |
| Events | `browse:events-requested` | A resource's event history |
| Referenced by | `browse:referenced-by-requested` | Inbound references to a resource |
| Entity types | `browse:entity-types-requested` | The KB's published entity-type vocabulary |
| Tag schemas | `browse:tag-schemas-requested` | Registered tag schemas |
| Agents | `browse:agents-requested` | Known agents |
| Directory | `browse:directory-requested` | A storage directory listing |

Their reply channels are bridged **by derivation, not by hand** — `BRIDGED_CHANNELS` composes every operation's `result`/`failure` out of the operations registry, so no reply can be forgotten. Only the broadcast minority below is hand-listed.

These are what `client.browse.*` calls in the SDK, and what `semiont browse` uses from the launcher.

## Cross-participant navigation

Within one browser session, clicking a resolved reference is a local affair. But `browse:resource-open` and `browse:resource-viewed` are **bridged broadcasts**, which makes the same acts available to anything holding a session — the launcher, an agent, a script running a guided tour. Signals are delivered to whoever is subscribed and silently dropped if nobody is, the same stateless semantics as Beckon.

| Event | Payload | Direction |
|---|---|---|
| `browse:resource-open` | `{ resourceId }` | **Drive** — put this resource on the participant's screen |
| `browse:resource-viewed` | `{ resourceId }` | **Report** — the viewer arrived at this resource |

**These two must never be collapsed into one bidirectional channel.** A driver signal and a user report sharing a channel is a feedback loop: a launcher listening for arrivals would hear its own commands, and one viewer's click would drive another viewer's page.

**`browse:resource-open`** is emitted by `browse.openResource(resourceId)` — from `ResourceInfoPanel`, from the CodeMirror reference-widget handlers, and from `semiont browse <resourceId> --browser`. `ResourceViewerPage` subscribes and translates to `nav:push`, so a remote caller never learns a URL.

**`browse:resource-viewed`** is emitted on the viewer's load-complete transition (`useResourceViewedReport`), gated on the same condition as the accessibility load announcement — so "viewed" means content actually reached the screen. It fires however the participant arrived: followed cue, in-app link, back button, or typed URL. That last part is why it exists rather than the driver simply assuming its own cue landed.

Because these are broadcasts on a KB-wide channel, the model is **one participant, one session**: a launcher authenticated as a given user reaches that user's open Browser. There is no addressing. Every emit through the bus gateway reports the subscriber count at dispatch, so a caller that expected one viewer can see that there were two — but the count is *not* delivery confirmation, since a subscriber is a connection rather than a pair of eyes, and these channels carry no reply.

## Local UI signals

Local-bus fan-out within a single page. Not bridged, and `browse:click`'s payload has no wire schema at all.

| Event | Payload | Description |
|-------|---------|-------------|
| `browse:click` | `{ annotationId, motivation, anchorRect? }` | User clicked an annotation element |
| `browse:entity-type-clicked` | `{ entityType }` | Filter resources by an entity type |

**`browse:click`** is emitted through `browse.click(...)` from every clickable annotation surface: CodeMirror document view, BrowseView, PDF canvas, image overlay, and the panel entries (HighlightEntry, CommentEntry, AssessmentEntry, TagEntry, ReferenceEntry). The optional `anchorRect` carries the clicked element's bounding rect for positioning.

Subscribers:
- **createBeckonStateUnit** — relays as `beckon:focus` to scroll the document view to the annotation
- **ResourceViewer** — opens the annotations panel with scroll-to-annotation coordination
- **Panel components** (HighlightPanel, CommentsPanel, AssessmentPanel, TaggingPanel, ReferencesPanel) — update focused/selected state to highlight the clicked entry

**`browse:entity-type-clicked`** is consumed by `ResourceViewerPage`, which applies the filter by emitting `nav:push`. The channel is wired on the subscribe side only — no in-repo emitter currently sends it.

## Host routing (`nav:*`)

Framework-shaped and host-local by rule. react-ui emits; the frontend's `NavigationHandler` performs.

| Event | Payload | Description |
|-------|---------|-------------|
| `nav:push` | `{ path: string; reason?: string }` | Navigate to an in-app route |
| `nav:external` | `{ url, resourceId?, cancelFallback }` | Navigate to an external URL |
| `nav:link-clicked` | `{ href, label? }` | A tracked link was clicked (observability) |

**`nav:push`** is emitted by `useObservableRouter` (a wrapper around Next.js `router.push` / `router.replace`), by `ResourceViewerPage` for clone-resource, reference-link and entity-type-filter navigation, and by `KnowledgeBasePanel` on KB switch. The `reason` field labels the cause — `'clone'`, `'reference-link'`, `'entity-type-filter'`, `'kb-switch'`.

**`nav:external`** is emitted by `useObservableExternalNavigation` when a link points outside the app. The payload includes a `cancelFallback` callback — if the subscriber handles the navigation itself, it calls `cancelFallback()` to prevent the default `window.location` redirect. That callback is a live function reference, which is a second reason this channel cannot cross a transport.

**`nav:link-clicked`** is emitted by `ObservableLink` for analytics and observability. No active subscribers — the channel exists for future logging or telemetry consumers.

## Why Events Instead of Direct Router Calls?

react-ui is a framework-agnostic component library. It cannot import `next/navigation` or call `router.push()` directly. Instead:

1. react-ui components emit navigation intent via the event bus
2. The host application (Next.js frontend) subscribes and translates to framework-specific routing
3. This decoupling lets the same components work in different host environments

The bridge boundary above is the same idea carried one step further: a *domain* intent is portable enough to cross a network, while a *framework* intent is not portable past the host that owns the routes.

## Panel and sidebar state

Panel state is **not** an event flow — it is held by `ShellStateUnit` and consumed through `useShellStateUnit`:

- `activePanel$` tracks which panel is open (or `null` for closed)
- `useShellStateUnit` persists it to `localStorage` under key `activeToolbarPanel` and restores it as the unit's `initialPanel` on load
- Simple-context pages (compose, discover, admin) only honor common panels; resource-specific panels are ignored there

Panel types:
- `COMMON_PANELS` — `['knowledge-base', 'user', 'settings']` — available on all pages
- `RESOURCE_PANELS` — `['history', 'info', 'annotations', 'collaboration', 'jsonld']` — resource viewer pages only

## Implementation

- **Panel state**: [packages/react-ui/src/state/shell-state-unit.ts](../../../packages/react-ui/src/state/shell-state-unit.ts) — `ShellStateUnit`, consumed via [useShellStateUnit](../../../packages/react-ui/src/hooks/useShellStateUnit.ts) (which owns the `localStorage` round-trip)
- **Read operations + UI signals (SDK)**: [packages/sdk/src/namespaces/browse.ts](../../../packages/sdk/src/namespaces/browse.ts) — the thirteen request/reply methods, plus `click()`, `openResource()`, `resourceViewed()`
- **Arrival report**: [packages/react-ui/src/features/resource-viewer/hooks/useResourceViewedReport.ts](../../../packages/react-ui/src/features/resource-viewer/hooks/useResourceViewedReport.ts)
- **`browse:resource-open` → `nav:push` translation**: [packages/react-ui/src/features/resource-viewer/components/ResourceViewerPage.tsx](../../../packages/react-ui/src/features/resource-viewer/components/ResourceViewerPage.tsx)
- **Toolbar (emitter)**: [packages/react-ui/src/components/Toolbar.tsx](../../../packages/react-ui/src/components/Toolbar.tsx)
- **Panel container**: [apps/frontend/src/components/toolbar/ToolbarPanels.tsx](../../../apps/frontend/src/components/toolbar/ToolbarPanels.tsx)
- **Sidebar navigation**: [packages/react-ui/src/components/navigation/CollapsibleResourceNavigation.tsx](../../../packages/react-ui/src/components/navigation/CollapsibleResourceNavigation.tsx)
- **Observable router / external navigation**: [packages/react-ui/src/hooks/useObservableBrowse.tsx](../../../packages/react-ui/src/hooks/useObservableBrowse.tsx)
- **Navigation handler (subscriber)**: [apps/frontend/src/components/knowledge/NavigationHandler.tsx](../../../apps/frontend/src/components/knowledge/NavigationHandler.tsx)
- **Launcher verb**: [apps/launcher/internal/launcher/browse.go](../../../apps/launcher/internal/launcher/browse.go) — `semiont browse`, including `--browser`
- **Bridged set**: [packages/core/src/bridged-channels.ts](../../../packages/core/src/bridged-channels.ts) — `BRIDGED_BROADCASTS` (hand-listed) plus the derived operation replies
- **Event definitions** (authority; generated into `bus-protocol.ts`): [specs/src/bus/registry.json](../../../specs/src/bus/registry.json) — `BROWSE FLOW` section
