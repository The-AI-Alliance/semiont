# Navigate Flow

**Purpose**: Route user actions to the correct view, panel, or resource. Navigation events decouple the components that *decide* where to go (toolbar buttons, annotation clicks, resolved-reference links) from the components that *perform* the navigation (Next.js router, sidebar state, panel container). This separation lets react-ui remain framework-agnostic — the library emits intent; the host application fulfills it.

**Related Documentation**:
- [Beckon Flow](./BECKON.md) - Hover/focus/sparkle coordination (attention precedes navigation)
- [Resolve Flow](./RESOLVE.md) - Reference resolution triggers navigation to linked resources
- [Frontend Annotations](../../apps/frontend/docs/ANNOTATIONS.md) - Annotation click and panel interaction
- [React UI Events](../../packages/react-ui/docs/EVENTS.md) - Event bus architecture

## Overview

The Navigate flow handles three categories of routing:

1. **Panel navigation** — Opening, closing, and toggling the right-side toolbar panels (annotations, info, history, settings, etc.)
2. **Annotation click routing** — When a user clicks an annotation in any view (document, PDF, image, panel entry), the event is broadcast so that panels can highlight the clicked entry and the Attend flow can scroll to it.
3. **Application routing** — Sidebar state, resource tab management, and in-app or external URL navigation.

Navigation is purely a frontend concern. It produces no backend events and no persistent state (except `localStorage` for panel and sidebar preferences).

## Events

### Annotation Click

| Event | Payload | Description |
|-------|---------|-------------|
| `browse:click` | `{ annotationId: string; motivation: Motivation }` | User clicked an annotation element |

Emitted from every clickable annotation surface: CodeMirror document view, BrowseView, PDF canvas, image overlay, and all panel entries (HighlightEntry, CommentEntry, AssessmentEntry, TagEntry, ReferenceEntry).

Subscribers:
- **useBeckonFlow** — relays as `beckon:focus` to scroll the document view to the annotation
- **ResourceViewer** — opens the annotations panel with scroll-to-annotation coordination
- **Panel components** (HighlightPanel, CommentsPanel, AssessmentPanel, TaggingPanel, ReferencesPanel) — update focused/selected state to highlight the clicked entry

### Panel Navigation

| Event | Payload | Description |
|-------|---------|-------------|
| `browse:panel-toggle` | `{ panel: string }` | Toggle a panel open/closed |
| `browse:panel-open` | `{ panel: string; scrollToAnnotationId?: string; motivation?: string }` | Open a specific panel, optionally scrolling to an annotation |
| `browse:panel-close` | `void` | Close the active panel |

**`browse:panel-toggle`** is emitted by the Toolbar when a user clicks a panel button. If the panel is already open, it closes; otherwise it opens.

**`browse:panel-open`** is emitted when the system needs to open a specific panel programmatically — for example, when an annotation is clicked in the document view (ResourceViewer opens the annotations panel with a scroll target) or when an annotation is requested (useAnnotationFlow opens the relevant motivation tab).

**`browse:panel-close`** closes whichever panel is currently active.

All three are consumed by **usePanelNavigation**, which manages `activePanel` state and persists it to `localStorage`.

### Sidebar Navigation

| Event | Payload | Description |
|-------|---------|-------------|
| `browse:sidebar-toggle` | `void` | Toggle the left sidebar collapsed/expanded |
| `browse:resource-close` | `{ resourceId: string }` | Close a resource tab in the sidebar |
| `browse:resource-reorder` | `{ oldIndex: number; newIndex: number }` | Reorder resource tabs (keyboard or drag-and-drop) |

Emitted by **CollapsibleResourceNavigation** (and **SimpleNavigation** for the toggle). Consumed by the host application's navigation components (KnowledgeNavigation, AdminNavigation, ModerationNavigation), which manage the open-resource list and sidebar collapsed state.

### Application Routing

| Event | Payload | Description |
|-------|---------|-------------|
| `browse:router-push` | `{ path: string; reason?: string }` | Navigate to an in-app route |
| `browse:external-navigate` | `{ url: string; resourceId?: string; cancelFallback: () => void }` | Navigate to an external URL |
| `browse:reference-navigate` | `{ documentId: string }` | Navigate to a resolved reference's target resource |
| `browse:link-clicked` | `{ href: string; label?: string }` | A tracked link was clicked (observability) |
| `browse:entity-type-clicked` | `{ entityType: string }` | User clicked an entity type to filter by it |

**`browse:router-push`** is emitted by **useObservableRouter** (a wrapper around Next.js `router.push` / `router.replace`) and by ResourceViewerPage for actions like clone-resource and entity-type filtering. Consumed by **NavigationHandler** in the frontend, which performs the actual `router.push()`.

**`browse:external-navigate`** is emitted by **useObservableNavigation** when a link points outside the app. The payload includes a `cancelFallback` callback — if the subscriber handles the navigation (e.g., via `router.push` to an internal equivalent), it calls `cancelFallback()` to prevent the default `window.location` redirect. Consumed by **NavigationHandler**.

**`browse:reference-navigate`** is emitted by **CodeMirrorRenderer** when a user clicks a resolved reference widget in the document. Consumed by **ResourceViewerPage**, which navigates to the target document.

**`browse:link-clicked`** is emitted by **ObservableLink** for analytics and observability. No active subscribers — the event exists for future logging or telemetry consumers.

**`browse:entity-type-clicked`** is emitted when a user clicks an entity type tag to filter resources by that type. Consumed by **ResourceViewerPage**, which applies the entity type filter.

## Why Events Instead of Direct Router Calls?

react-ui is a framework-agnostic component library. It cannot import `next/navigation` or call `router.push()` directly. Instead:

1. react-ui components emit navigation intent via the event bus
2. The host application (Next.js frontend) subscribes and translates to framework-specific routing
3. This decoupling lets the same components work in different host environments

The same pattern applies to sidebar and panel state — react-ui emits the intent, the host manages the actual state and persistence.

## Panel State Management

Panel state is managed by **usePanelNavigation** in react-ui:

- `activePanel` tracks which panel is open (or `null` for closed)
- State persists to `localStorage` under key `activeToolbarPanel`
- On page load, the last-open panel is restored
- Simple-context pages (compose, discover, admin) only honor common panels (`user`, `settings`); resource-specific panels (`annotations`, `history`, `info`, `collaboration`, `jsonld`) are ignored on those pages

Panel types are defined as constants:
- `COMMON_PANELS` — `['user', 'settings']` — available on all pages
- `RESOURCE_PANELS` — `['history', 'info', 'annotations', 'collaboration', 'jsonld']` — available only on resource viewer pages

## Implementation

- **Panel hook**: [packages/react-ui/src/hooks/usePanelNavigation.ts](../../packages/react-ui/src/hooks/usePanelNavigation.ts)
- **Toolbar (emitter)**: [packages/react-ui/src/components/Toolbar.tsx](../../packages/react-ui/src/components/Toolbar.tsx)
- **Panel container**: [apps/frontend/src/components/toolbar/ToolbarPanels.tsx](../../apps/frontend/src/components/toolbar/ToolbarPanels.tsx)
- **Sidebar navigation**: [packages/react-ui/src/components/navigation/CollapsibleResourceNavigation.tsx](../../packages/react-ui/src/components/navigation/CollapsibleResourceNavigation.tsx)
- **Observable router**: [packages/react-ui/src/hooks/useObservableRouter.tsx](../../packages/react-ui/src/hooks/useObservableRouter.tsx)
- **Observable navigation**: [packages/react-ui/src/hooks/useObservableNavigation.tsx](../../packages/react-ui/src/hooks/useObservableNavigation.tsx)
- **Navigation handler (subscriber)**: [apps/frontend/src/components/knowledge/NavigationHandler.tsx](../../apps/frontend/src/components/knowledge/NavigationHandler.tsx)
- **Event definitions**: [packages/core/src/event-map.ts](../../packages/core/src/event-map.ts) — `Navigation` section
