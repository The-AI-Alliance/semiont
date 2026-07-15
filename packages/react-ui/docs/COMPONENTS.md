# Components

Component library reference for `@semiont/react-ui`.

## Overview

The library provides components organized by functionality:

- **Authentication Components** - Sign-in, sign-up, and error displays
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
- `onOpenResource?` — a resolved reference was followed (host-owned navigation).
- `onOpenPanel?` — an annotation click requests a side panel (omit for a bare view).
- `newAnnotationIds?`, `showLineNumbers?`, `hoverDelayMs?`, `hoveredAnnotationId?`, `generatingReferenceId?` — optional presentation / coordination hints.

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

**Key props:** `content`, `annotations`, `annotateMode`, `session` (required); `mimeType?`, `resourceUri?`, `hoveredAnnotationId?`, `selectedClick?`, `hoverDelayMs?`, `newAnnotationIds?`, `renderers?` (override the read-only media renderers).

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

**Key props:** `content`, `annotations`, `uiState`, `annotateMode`, `session` (required); `onUIStateChange?`, `editable?`, `enableWidgets?`, `getTargetResourceName?`, `generatingReferenceId?`, `showLineNumbers?`, `hoverDelayMs?`, `newAnnotationIds?`.

### AnnotationHistory

The resource's annotation-event history. Takes the resource id (`rUri`) and the host's
framework-agnostic navigation primitives (`Link` + `routes`).

```tsx
import { AnnotationHistory } from '@semiont/react-ui';

<AnnotationHistory rUri={rId} Link={Link} routes={routes} />
```

**Key props:** `rUri`, `Link`, `routes` (required); `hoveredAnnotationId?`, `onEventHover?`, `onEventClick?`.

---

## Authentication Components

### SignInForm

Sign-in form with Google OAuth and optional credentials-based auth. The sign-in callbacks
receive the target `backendUrl` (the form can prompt for it, or you can pre-fill + lock it via
the `backendUrl` prop).

```tsx
import { SignInForm } from '@semiont/react-ui';
import Link from 'next/link'; // or your router's Link

<SignInForm
  onGoogleSignIn={async (backendUrl) => signIn('google', { backendUrl })}
  onCredentialsSignIn={async (backendUrl, email, password) => signIn('credentials', { backendUrl, email, password })}
  backendUrl={lockedBackendUrl}   // optional: pre-fill + lock the backend-URL field
  showCredentialsAuth
  isLoading={submitting}
  error={errorMessage}
  Link={Link}
  translations={strings}
/>
```

**Required:** `onGoogleSignIn(backendUrl)`, `Link`, `translations`. **Optional:** `onCredentialsSignIn(backendUrl, email, password)`, `backendUrl`, `showCredentialsAuth`, `isLoading`, `error`. The full `translations` shape (21 keys) is the exported `SignInFormProps` type.

### SignUpForm

Google OAuth sign-up form.

```tsx
import { SignUpForm } from '@semiont/react-ui';
import Link from 'next/link';

<SignUpForm
  onSignUp={async () => signIn('google', { callbackUrl: '/welcome' })}
  Link={Link}
  translations={{
    pageTitle: 'Join Semiont',
    signUpPrompt: 'Create your account',
    // ... other translation keys
  }}
/>
```

**Props:**
- `onSignUp` - Callback when user initiates sign-up
- `Link` - Link component from your router
- `translations` - Translation strings

**Features:**
- Loading state during OAuth flow
- Error handling with user feedback
- Accessible form controls

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

### WelcomePage

Terms-acceptance / welcome screen for new users. Driven by an explicit `status` and
accept/decline callbacks; the host injects its own `PageLayout`.

```tsx
import { WelcomePage } from '@semiont/react-ui';
import Link from 'next/link';

<WelcomePage
  status="form"            // 'loading' | 'accepted' | 'form'
  isProcessing={processing}
  onAccept={acceptTerms}
  onDecline={declineTerms}
  userName={user.name}
  PageLayout={PageLayout}
  Link={Link}
  translations={strings}
/>
```

**Required:** `status`, `isProcessing`, `onAccept`, `onDecline`, `PageLayout`, `Link`, `translations`. **Optional:** `userName`, `termsAcceptedAt`, `isNewUser`. Full shape: the exported `WelcomePageProps` type.

---

## Layout Components

These compose the app chrome and are **framework-agnostic**: instead of importing
`next/navigation` or a translation library, they take the host's primitives as props — `Link`
(your router's link component), `routes` (a `RouteBuilder`), and translation functions (`t`,
`tNav`, `tHome`). Wire them once from your shell. Each component's own `Props` interface is the
source of truth for the full (and evolving) list; the essentials are below.

### PageLayout

The standard page shell — composes `UnifiedHeader` + `Footer` around your content. (It does
*not* take `header` / `sidebar` slots.)

```tsx
import { PageLayout } from '@semiont/react-ui';

<PageLayout Link={Link} routes={routes} t={t} tNav={tNav} tHome={tHome}>
  {content}
</PageLayout>
```

Also optional: `className`, `showAuthLinks`, `CookiePreferences`, `onOpenKeyboardHelp`.

### UnifiedHeader

Application header (branding + nav + user menu). Presentation via `variant`
(`'standalone' | 'embedded' | 'floating'`) and the `isAuthenticated` / `isAdmin` /
`isModerator` flags. No `userName` prop — the user menu resolves identity from the session.

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

The Know / Moderate / Administer nav. `isAdmin` / `isModerator` gate the privileged entries;
`currentPath` highlights the active one.

```tsx
<NavigationMenu Link={Link} routes={routes} t={t} isAdmin={isAdmin} currentPath={currentPath} />
```

### Footer

Application footer; rendered for you inside `PageLayout`. Optional: `showPolicyLinks`,
`sourceCodeUrl`, `CookiePreferences`, `onOpenKeyboardHelp`.

```tsx
<Footer Link={Link} routes={routes} t={t} showPolicyLinks />
```

---

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
Each panel's `Props` interface lists its state inputs. `JsonLdPanel` is the one exception
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
- Click emits `browse:click` via `session.client.browse.click(id, motivation)` — the same event the stock Browser routes to panel focus, so a host-composed list and any Semiont surface on the same session stay in sync for free.
- Hover (debounced) emits the beckon hover signal that highlights the annotation in an open viewer on the same session.
- `ReferenceEntry` extras: `onOpenResource?` (host navigation when the resolved reference is followed), `annotateMode?` (resolve / unlink affordances), `isGenerating?`.

---

## Modals & Overlays

### SessionExpiredModal

Displays when user session expires.

```tsx
import { SessionExpiredModal } from '@semiont/react-ui';

<SessionExpiredModal />
```

**Features:**
- Auto-detects session expiration
- Prompts user to re-authenticate
- Redirects after sign-in

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

<ErrorBoundary fallback={<ErrorPage />}>
  {children}
</ErrorBoundary>
```

### CodeMirrorRenderer

CodeMirror-based renderer for text/markdown content with the annotation overlay (used internally
by `BrowseView` / `AnnotateView`). Editability is controlled by `editable` (not `readOnly`), and
it always renders markdown — there is no `language` prop.

```tsx
import { CodeMirrorRenderer } from '@semiont/react-ui';

<CodeMirrorRenderer content={text} editable={false} showLineNumbers hoverDelayMs={200} />
```

`content` and `hoverDelayMs` are required; also optional: `segments`, `onTextSelect`, `onChange`, `session`, `newAnnotationIds`, `hoveredAnnotationId`, `scrollToAnnotationId`, `sourceView`, `enableWidgets`, `getTargetResourceName`, `generatingReferenceId`.

### StatusDisplay

Renders the backend-connection / auth health indicator. Takes the current auth flags (not a
free-form status/message).

```tsx
import { StatusDisplay } from '@semiont/react-ui';

<StatusDisplay isAuthenticated={isAuthenticated} isFullyAuthenticated={isFullyAuthed} hasValidBackendToken={tokenValid} />
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

Components that need navigation use routing context:

```tsx
import { useRouting } from '@semiont/react-ui';

function MyComponent() {
  const { Link, routes } = useRouting();

  return <Link href={routes.home}>Home</Link>;
}
```

### With API Data

Components fetch data by observing the SDK's live queries:

```tsx
import { useSemiont, useObservable } from '@semiont/react-ui';

function MyComponent() {
  const semiont = useSemiont();
  const data = useObservable(semiont.browse.resources());

  if (data === undefined) return <Spinner />;

  return <ResourceList items={data} />;
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
