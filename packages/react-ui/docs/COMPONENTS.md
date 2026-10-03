# Components

Component library reference for `@semiont/react-ui`.

## Overview

The library provides components organized by functionality:

- **Authentication Components** - Error displays (signing in happens at the issuer)
- **Resource Viewers** - Display and interact with resources
- **Layout Components** - Page structure and navigation
- **Annotation Components** - Semantic markup and collaboration
- **Modals & Overlays** - Dialogs and pop-ups
- **UI Elements** - Toolbars, toasts, and widgets
- **Accessibility** - Screen reader and keyboard navigation support

All components are framework-agnostic. Components that need routing accept a `Link` component as a prop, allowing you to use Next.js Link, React Router Link, or any other router.

## Resource Components

### ResourceViewer

Displays a resource with its annotation overlay (highlights, references, comments, tags) for
any media type. **Bring-your-own-session:** it takes your `SemiontSession` directly — no
`SemiontProvider` or cache/translation context required.

```tsx
import { ResourceViewer, useResourceLoader } from '@semiont/react-ui';

const { resource, annotations } = useResourceLoader(session.client, resourceId);

<ResourceViewer
  session={session}
  resource={{ ...resource, content }}    // `content` is the host's to fetch
  annotations={annotations}
  onOpenResource={(id) => navigate(id)}  // host-owned nav for a followed reference
/>
```

**Props:**
- `session` — the `SemiontSession` backing the resource (its client mutates/invalidates; its bus feeds annotation events); `null` while loading.
- `resource` — the `ResourceDescriptor` with `content` merged in (decoded text, or a media-token URL for binary media).
- `annotations` — grouped annotations (`useResourceLoader` returns them ready-shaped).
- `onOpenResource?` — a resolved reference was followed; called with that resource's `ResourceId` (host-owned navigation).
- `onOpenPanel?` — an annotation click requests a side panel (omit for a bare view).
- `sparkleAnnotationIds?`, `showLineNumbers?`, `hoverDelayMs?`, `hoveredAnnotationId?`, `generatingReferenceId?` — optional presentation / coordination hints.

**Ids are typed.** `useResourceLoader` takes a `ResourceId`, and `onOpenResource` hands one
back. A description's `@id` is one already. Text from outside the SDK — a route parameter, a
query string — becomes one through `@semiont/core`:

```tsx
import { isResourceId } from '@semiont/core';

if (!isResourceId(params.id)) return <NotFound />;   // narrows `params.id` to a ResourceId
const { resource, annotations } = useResourceLoader(session.client, params.id);
```

`isResourceId` asks without throwing. The constructor `resourceId(text)` throws a `TypeError`
for text the rule refuses: an id is 1 to 128 of `A–Z a–z 0–9 _ -`. `AnnotationId` and `JobId`
follow the same rule, with `isAnnotationId` / `annotationId` and `isJobId` / `jobId`.

**Features:**
- Browse / annotate modes (annotate mode persisted in `localStorage`), CodeMirror syntax highlighting, the annotation overlay, responsive layout.
- Speaks the SDK bus — an annotation edit made elsewhere updates the open document with no refetch.

> **Full end-to-end integration** — loading the resource, fetching text vs. binary content, and media tokens — is walked through in the SDK developer guide's *Render a resource in the browser — the embeddable viewer* recipe: [DEVELOPER-GUIDE.md](../../sdk/docs/DEVELOPER-GUIDE.md). For the batteries-included, provider-based page, see `ResourceViewerPage`.

### BrowseView

The read-only render layer that `ResourceViewer` composes in browse mode — markdown/media
rendering plus the annotation overlay applied over the DOM. It takes **decoded `content`** (not
a resource object) and a `SemiontSession` for its bus. Most hosts use `ResourceViewer` rather
than this directly.

```tsx
import { BrowseView } from '@semiont/react-ui';

<BrowseView
  content={text}
  mimeType="text/markdown"
  resourceUri={resource['@id']}
  annotations={annotations}
  annotateMode={false}
  session={session}
/>
```

**Key props:** `content`, `mimeType`, `resourceUri` (a `ResourceId`), `annotations`, `annotateMode`, `session` (required); `hoveredAnnotationId?`, `selectedClick?`, `hoverDelayMs?`, `sparkleAnnotationIds?`, `renderers?` (override the read-only media renderers).

### AnnotateView

The annotate-mode layer that `ResourceViewer` composes for creating annotations (text selection
+ drawing). Like `BrowseView` it takes decoded `content` + a `SemiontSession`, plus annotation
UI state. Most hosts use `ResourceViewer`.

```tsx
import { AnnotateView } from '@semiont/react-ui';

<AnnotateView
  content={text}
  mimeType="text/markdown"
  resourceUri={resource['@id']}
  annotations={annotations}
  uiState={uiState}
  onUIStateChange={setUiState}
  annotateMode={true}
  session={session}
/>
```

**Key props:** `content`, `resourceUri` (a `ResourceId`), `annotations`, `uiState`, `annotateMode`, `session` (required); `mimeType?`, `onUIStateChange?`, `editable?`, `enableWidgets?`, `getTargetResourceName?`, `generatingReferenceId?`, `showLineNumbers?`, `hoverDelayMs?`, `sparkleAnnotationIds?`.

### AnnotationHistory

The resource's annotation-event history. Takes the events to show and the host's
framework-agnostic navigation primitives (`Link` + `routes`).

```tsx
import { AnnotationHistory } from '@semiont/react-ui';

<AnnotationHistory events={events} Link={Link} routes={routes} />
```

**Key props:** `events`, `Link`, `routes` (required); `eventsLoading?`, `eventsError?`, `onRetryEvents?`, `annotations?`, `hoveredAnnotationId?`, `onEventHover?`, `onEventClick?`. The two callbacks are called with the row's `AnnotationId`, or `null`.

---

## Authentication Components

Neither signing in nor signing up is a form here. A knowledge base trusts an issuer, and the
Browser sends the user there (`SemiontBrowser.beginSignIn` / `completeSignIn` in `@semiont/sdk`);
accounts are created at that issuer by an administrator. No component in this package collects a
credential, and the only one left is the error display below.

### AuthErrorDisplay

Display authentication error messages.

```tsx
import { AuthErrorDisplay } from '@semiont/react-ui';
import Link from 'next/link';

<AuthErrorDisplay
  errorType="AccessDenied" // or "Configuration", "Verification", etc.
  Link={Link}
  translations={{
    pageTitle: 'Authentication Error',
    tryAgain: 'Try signing in again',
    // ... error message translations
  }}
/>
```

**Props:**
- `errorType` - Type of authentication error
- `Link` - Link component from your router
- `translations` - Translation strings including error messages

**Supported Error Types:**
- `Configuration` - Server configuration issues
- `AccessDenied` - User not authorized
- `Verification` - Email verification failed
- Other types show generic error message

---

## Layout Components

These compose the app chrome and are **framework-agnostic**: instead of importing
`next/navigation` or a translation library, they take the host's primitives as props — `Link`
(your router's link component), `routes` (a `RouteBuilder`), and translation functions (`t`,
`tNav`, `tHome`). Wire them once from your shell. Each component's own `Props` interface is the
source of truth for the full (and evolving) list; the essentials are below.

### PageLayout

The standard page shell — composes `UnifiedHeader` around your content. (It does
*not* take `header` / `sidebar` slots.)

```tsx
import { PageLayout } from '@semiont/react-ui';

<PageLayout Link={Link} routes={routes} t={t} tNav={tNav} tHome={tHome}>
  {content}
</PageLayout>
```

Also optional: `className`, `showAuthLinks`, `onOpenKeyboardHelp`.

### UnifiedHeader

Application header (branding + nav + user menu). Presentation via `variant`
(`'standalone' | 'embedded' | 'floating'`) and `isAuthenticated`. No role flags — nothing in
the nav is gated on one. No `userName` prop either; the user menu resolves identity from the
session.

```tsx
<UnifiedHeader Link={Link} routes={routes} t={t} tHome={tHome} variant="standalone" isAuthenticated={isAuthenticated} />
```

### LeftSidebar

Collapsible sidebar; it manages its own collapse state (persisted to `localStorage`). `children`
may be a render function `(isCollapsed, toggleCollapsed, navigationMenu) => ReactNode`.

```tsx
<LeftSidebar Link={Link} routes={routes} t={t} tHome={tHome} collapsible isAuthenticated={isAuthenticated}>
  {(isCollapsed, toggle, navigationMenu) => navigationMenu(() => {})}
</LeftSidebar>
```

### NavigationMenu

The Know / Moderate / Administer nav. Every entry is shown to every authenticated user — no
role gates it, because no role exists to gate it with. `currentPath` highlights the active one.

```tsx
<NavigationMenu Link={Link} routes={routes} t={t} currentPath={currentPath} />
```


## Annotation Components

See [ANNOTATIONS.md](ANNOTATIONS.md) for detailed annotation documentation.

### AnnotateToolbar

The tool bar `ResourceViewer` composes in annotate mode. **Purely presentational**: each
control reports its chosen value via a callback and the owner (viewer instance or host)
applies it — the bar holds no pref state, emits no bus events, and touches no storage.
Composed for you by `ResourceViewer`; use it directly only for a custom annotate surface.

```tsx
import { AnnotateToolbar } from '@semiont/react-ui';

<AnnotateToolbar
  selectedMotivation={selectedMotivation}   // 'linking' | 'highlighting' | 'assessing' | 'commenting' | 'tagging' | null
  selectedClick={selectedClick}             // 'detail' | 'follow' | 'jsonld' | 'deleting'
  annotateMode
  annotators={annotators}
  onSelectionChange={setSelectedMotivation}
  onClickActionChange={setSelectedClick}
  onModeChange={setAnnotateMode}
/>
```

Optional: `parts` (which of the four control groups to render — `'clickAction' | 'mode' | 'selection' | 'shape'`), `compact` (icon-only inline form), `selectedShape` + `onShapeChange`, `mediaType` (gates the shape group), `showDeleteButton`. See the `AnnotateToolbarProps` interface for the rest.

### Annotation Panels

The side-panel renderers for each annotation motivation. **Bring-your-own-session**, like
`ResourceViewer`: every panel takes a `session: SemiontSession | null` prop directly — no
`SemiontProvider` required — plus the **grouped annotation arrays + UI state** (from
`useResourceLoader` / the page state unit). They render what you pass, send interactions
through the session's client, and follow `browse:click` on its bus for entry focus.
`session={null}` renders inert (display-only).

```tsx
import { HighlightPanel } from '@semiont/react-ui';

// One motivation — no providers, just the session:
<HighlightPanel
  session={session}
  resourceId={rId}
  annotations={highlights}
  pendingAnnotation={pending}
  annotateMode
/>
```

Also exported: `CommentsPanel`, `TaggingPanel`, `ReferencesPanel`, `AssessmentPanel`,
`ResourceInfoPanel`, and `UnifiedAnnotationsPanel` (all motivations in one tabbed panel —
additionally takes `annotators`, `Link` + `routes` for its reference-tab links, and
`onOpenResource?` for host-owned navigation when a resolved reference is followed).
Each panel's `Props` interface lists its state inputs. `resourceId` is a `ResourceId`, and
`onOpenResource` is called with one. `JsonLdPanel` is the one exception
that still reads `SemiontProvider`.

### Panel Entries

The per-annotation row each panel composes — exported for hosts that build their own list
chrome around the same interaction contract: `HighlightEntry`, `ReferenceEntry`,
`CommentEntry`, `AssessmentEntry`, `TagEntry`. Same bring-your-own-session shape.

```tsx
import { CommentEntry, ReferenceEntry } from '@semiont/react-ui';

<CommentEntry session={session} comment={annotation} isFocused={false} />

<ReferenceEntry
  session={session}
  reference={annotation}
  isFocused={false}
  onOpenResource={(id) => navigate(id)}  // 🔗 opens the resolved resource (host nav)
/>
```

**The shared contract:**
- `session`, the annotation (prop named by motivation: `highlight` / `reference` / `comment` / `assessment` / `tag`), and `isFocused` are required; `isHovered?` pulses the row, `ref?` reaches the row element.
- Click emits `browse:click` via `session.client.browse.click(id)` — the same event the stock Browser routes to panel focus, so a host-composed list and any Semiont surface on the same session stay in sync for free.
- Hover (debounced) emits the beckon hover signal that highlights the annotation in an open viewer on the same session.
- `ReferenceEntry` extras: `onOpenResource?` (host navigation when the resolved reference is followed; called with its `ResourceId`), `annotateMode?` (resolve / unlink affordances), `isGenerating?`.

---

## Modals & Overlays

### SessionEndedModal

Displays when the active knowledge base's session ends: its token could not be
renewed (`expired`), or the knowledge base refused the sign-in (`refused`).
Reads `sessionEnded$` from the active session's `SessionSignals`.

```tsx
import { SessionEndedModal } from '@semiont/react-ui';

<SessionEndedModal />
```

**Features:**
- Says why the session ended, in the person's language (namespace `SessionEndedModal`)
- Offers signing in again, or going home; either acknowledges the signal

### PermissionDeniedModal

Displays when a request is refused for lack of permission. Reads
`permissionDenied$` from the active session's `SessionSignals`.

```tsx
import { PermissionDeniedModal } from '@semiont/react-ui';

<PermissionDeniedModal />
```

**Features:**
- Its own copy in the person's language (namespace `PermissionDeniedModal`)
- Beneath it, the refusal's own message, unaltered and marked as the knowledge base's
- Offers going back, going home, or switching account

### KeyboardShortcutsHelpModal

Displays keyboard shortcuts help.

```tsx
import { KeyboardShortcutsHelpModal } from '@semiont/react-ui';

<KeyboardShortcutsHelpModal
  isOpen={showHelp}
  onClose={() => setShowHelp(false)}
/>
```

---

## UI Elements

### Toolbar

The panel-switcher rail — toggles the resource side panels (annotations, info, history,
json-ld, collaboration, knowledge-base, user, settings). Not a generic container.

```tsx
import { Toolbar } from '@semiont/react-ui';

<Toolbar
  context="document"        // 'document' | 'simple'
  activePanel={activePanel} // the open panel key, or null
  isArchived={false}
/>
```

### Toast

Toast notification system.

```tsx
import { ToastProvider, useToast } from '@semiont/react-ui';

// In providers
<ToastProvider>{children}</ToastProvider>

// In components
function MyComponent() {
  const toast = useToast();

  const handleSave = () => {
    toast.success('Saved successfully');
    // or
    toast.error('Save failed');
    // or
    toast.info('Processing...');
  };
}
```

### LiveRegion

Accessibility live region for announcements.

```tsx
import { LiveRegionProvider, useLiveRegion } from '@semiont/react-ui';

// In providers
<LiveRegionProvider>{children}</LiveRegionProvider>

// In components
function MyComponent() {
  const { announce } = useLiveRegion();

  const handleAction = () => {
    announce('Action completed');
  };
}
```

---

## Session Components

### SessionTimer

Displays time until session expires.

```tsx
import { SessionTimer } from '@semiont/react-ui';

<SessionTimer />
```

### SessionExpiryBanner

Warning banner before session expires.

```tsx
import { SessionExpiryBanner } from '@semiont/react-ui';

<SessionExpiryBanner />
```

**Features:**
- Shows 5 minutes before expiration
- Auto-dismisses when session is refreshed
- Accessible announcements

### UserMenuSkeleton

Loading skeleton for user menu.

```tsx
import { UserMenuSkeleton } from '@semiont/react-ui';

<UserMenuSkeleton />
```

---

## Accessibility Components

### SkipLinks

Skip-navigation links for keyboard users. Takes no props — it renders the standard skip targets
(main content, navigation).

```tsx
import { SkipLinks } from '@semiont/react-ui';

<SkipLinks />
```

---

## Branding Components

### SemiontBranding

Semiont logo + tagline. Takes a translation function `t` for the tagline text.

```tsx
import { SemiontBranding } from '@semiont/react-ui';

<SemiontBranding t={t} size="lg" showTagline />
```

`size` is `'sm' | 'md' | 'lg' | 'xl'`; also optional: `showTagline`, `animated`, `compactTagline`, `className`.

---

## Utility Components

### ErrorBoundary

React error boundary for graceful error handling.

```tsx
import { ErrorBoundary } from '@semiont/react-ui';

<ErrorBoundary fallback={(error, reset) => <button onClick={reset}>{error.message}. Try again</button>}>
  {children}
</ErrorBoundary>
```

`fallback?` is a function of the error and a `reset`; without it the boundary renders its own
notice.

### CodeMirrorRenderer

CodeMirror-based renderer for text/markdown content with the annotation overlay (used internally
by `BrowseView` / `AnnotateView`). Editability is controlled by `editable` (not `readOnly`), and
it always renders markdown — there is no `language` prop.

```tsx
import { CodeMirrorRenderer } from '@semiont/react-ui';

<CodeMirrorRenderer content={text} editable={false} showLineNumbers hoverDelayMs={200} />
```

`content` and `hoverDelayMs` are required; also optional: `segments`, `onTextSelect`, `onChange`, `session`, `sparkleAnnotationIds`, `hoveredAnnotationId`, `scrollToAnnotationId`, `sourceView`, `enableWidgets`, `getTargetResourceName`, `generatingReferenceId`.

### StatusDisplay

Renders the gateway-connection / auth health indicator. Takes the current auth flags (not a
free-form status/message).

```tsx
import { StatusDisplay } from '@semiont/react-ui';

<StatusDisplay isAuthenticated={isAuthenticated} isFullyAuthenticated={isFullyAuthed} hasValidGatewayToken={tokenValid} />
```

### ResourceTagsInline

Renders a resource's tags inline (read-only display).

```tsx
import { ResourceTagsInline } from '@semiont/react-ui';

<ResourceTagsInline resourceId={rId} tags={['important', 'review']} isEditing={false} onUpdate={async () => {}} />
```

---

## Component Patterns

### With Translations

All components use the translation system:

```tsx
import { useTranslations } from '@semiont/react-ui';

function MyComponent() {
  const t = useTranslations('MyComponent');

  return <button>{t('save')}</button>;
}
```

### With Routing

Components that render a link take the host's `Link` and `routes` as props (see
[ROUTING.md](ROUTING.md)):

```tsx
import type { ResourceId } from '@semiont/core';
import type { LinkComponentProps, RouteBuilder } from '@semiont/react-ui';

function MyComponent({ Link, routes, resourceId }: { Link: React.ComponentType<LinkComponentProps>; routes: RouteBuilder; resourceId: ResourceId }) {
  return <Link href={routes.resourceDetail(resourceId)}>Open</Link>;
}
```

### With API Data

Components fetch data by observing the SDK's live queries:

```tsx
import { useSemiont, useObservable } from '@semiont/react-ui';

function MyComponent() {
  const client = useObservable(useSemiont().activeSession$)?.client;
  // Emissions are CacheState<ResourceList>: pending → ready | failed.
  const state = useObservable(client?.browse.resources());

  if (!state || state.status === 'pending') return <p>Loading…</p>;
  if (state.status === 'failed') return <p role="alert">{state.error.message}</p>;

  return <ul>{state.value.resources.map((r) => <li key={r['@id']}>{r.name}</li>)}</ul>;
}
```

## Styling

Components use Tailwind CSS utility classes. To customize:

```tsx
// Pass className prop
<NavigationMenu className="custom-nav" />

// Or use Tailwind config
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: '#your-color'
      }
    }
  }
}
```

## Accessibility

All components follow WCAG 2.1 AA guidelines:

- ✅ Keyboard navigation
- ✅ Screen reader support
- ✅ Focus management
- ✅ ARIA labels and roles
- ✅ Color contrast compliance

Test with:

```tsx
import { axe } from 'jest-axe';

it('should have no accessibility violations', async () => {
  const { container } = render(<MyComponent />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

## See Also

- [SESSION.md](SESSION.md) - Context providers for components
- [API-INTEGRATION.md](API-INTEGRATION.md) - API hooks used by components
- [INTERNATIONALIZATION.md](INTERNATIONALIZATION.md) - Translation usage
- [ROUTING.md](ROUTING.md) - Navigation in components
- [ANNOTATIONS.md](ANNOTATIONS.md) - Annotation components
- [TESTING.md](TESTING.md) - Testing components
