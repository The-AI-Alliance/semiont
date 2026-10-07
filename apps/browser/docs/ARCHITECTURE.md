# Browser Architecture

This document describes how the Semiont Browser application is built. Where it sits in
Semiont as a whole is [Human UI](../../../docs/architecture/HUMAN-UI.md).

## Table of Contents

- [Overview](#overview)
- [Technology Stack](#technology-stack)
- [Authentication Architecture](#authentication-architecture)
- [State Management](#state-management)
- [API Integration](#api-integration)
- [Data Flow](#data-flow)
- [Provider Hierarchy](#provider-hierarchy)
- [Directory Structure](#directory-structure)
- [Key Design Patterns](#key-design-patterns)
- [Related Documentation](#related-documentation)

## Overview

The Semiont Browser is a Vite + React Router SPA. The architecture emphasizes:

- **Type Safety**: TypeScript throughout with strict mode enabled
- **Server State Management**: RxJS observable caches on the SDK's verb-namespace client, invalidated automatically by gateway domain events
- **Authentication**: bearer-only — the SDK session sends its access token as `Authorization: Bearer` and keeps the access and refresh pair in `localStorage`, per knowledge base; no cookie, no Browser-side auth server
- **Session state outside React**: one `SemiontBrowser` singleton from the SDK holds the knowledge bases and the active session; components read it through observables
- **Fail-Fast Philosophy**: No default values - explicit configuration required

## Technology Stack

### Core Framework
- **Vite** + **React Router** - SPA build tooling and client-side routing
- **React 19** - UI library with concurrent features
- **TypeScript 6** - Type safety and developer experience

### State Management
- **RxJS (BehaviorSubject)** - Server-state caching and live updates via the SDK's verb-namespace observables, subscribed through `useObservable`
- **React Context** - UI state and cross-cutting concerns (keyboard shortcuts, toast notifications)
- **i18next + react-i18next** - Internationalization

### UI & Styling

#### Hybrid CSS Architecture
The Browser uses a hybrid CSS approach that combines:
- **@semiont/react-ui** - Semantic CSS with BEM methodology for all UI components, organized into:
  - `core/` - Fundamental UI elements (buttons, toggles, sliders, badges, tags, indicators)
  - `patterns/` - Shared patterns (cards, panel base and helpers)
  - `panels/` - Panel-specific styles (history, user)
  - `motivations/` - W3C Web Annotation standard styles (5 motivation types)
  - `features/` - Feature-specific styling
- **Tailwind CSS** - Utility-first CSS for app-specific layouts and custom components

This architecture ensures:
- Framework-agnostic component library (@semiont/react-ui uses semantic CSS)
- Modular organization with clear separation (core elements vs. components vs. panels)
- Centralized design tokens for consistency (panel tokens, color palettes)
- W3C Web Annotation compliance with dedicated motivation styles
- Flexibility for app-specific styling (the Browser uses Tailwind)
- Clear separation of concerns (component styles vs. layout utilities)

#### UI Libraries
- **CodeMirror 6** - Code editor for document content
- **Headless UI** - Accessible UI components with Tailwind integration

### Component Library Architecture

The Browser leverages **@semiont/react-ui**, a comprehensive framework-agnostic component library that provides:

#### Core Components
- **UI Components**: Button, Toolbar, Toast, StatusDisplay
- **Resource Components**: ResourceViewer, AnnotateView, BrowseView
- **Annotation Components**: Complete annotation system with popups and overlays
- **Panel Components**: Comments, References, Tags, Statistics, JSON-LD panels
- **Navigation**: NavigationMenu, SkipLinks
- **Layout**: UnifiedHeader, LeftSidebar, PageLayout
- **Session**: SessionTimer, SessionExpiryBanner

#### Hooks & Utilities
- **Data Hooks**: `useObservable` / `useObservableBrowse` for subscribing to the SDK's verb-namespace observable caches
- **UI Hooks**: useTheme, useKeyboardShortcuts, useToast, useDebounce
- **Resource Hooks**: useResourceContent, useMediaToken

#### Provider Pattern
@semiont/react-ui uses a two-layer provider model — global (every page) and protected (only routes that require auth):

```tsx
import { useMergedTranslationManager } from '@/hooks/useMergedTranslationManager';

function AppTree() {
  const translationManager = useMergedTranslationManager(); // i18next-backed

  // Global layer — auth-independent (apps/browser/src/app/providers.tsx)
  return (
    <TranslationProvider translationManager={translationManager}>
      <SemiontProvider>            {/* the SemiontBrowser singleton: sessions, KBs, the client */}
        {/* Toast, LiveRegion, KeyboardShortcuts, Theme, LineNumbers, then the app */}

        {/* Protected layer — AuthShell, mounted only around the routes that require auth */}
        <ProtectedErrorBoundary>
          <SessionEndedModal />
          <PermissionDeniedModal />
          <KbIdentityConflictModal />
          {/* Auth-aware components live here */}
        </ProtectedErrorBoundary>
      </SemiontProvider>
    </TranslationProvider>
  );
}
```

This architecture enables:
- **Framework Independence**: Components work with any React framework
- **Consistent Design**: Shared components across all Semiont applications
- **Type Safety**: Shared TypeScript types and interfaces
- **Tested in the library**: the components' tests live with them in `@semiont/react-ui`
- **Clear Boundaries**: Separation between framework code and UI components

See [Component Library Integration Guide](./COMPONENT-LIBRARY.md) for detailed usage.

### API Communication
- **`@semiont/sdk`** over `@semiont/http-transport` - every call to a knowledge base. The app itself contains no `fetch` call
- **Server-Sent Events (SSE)** - the bus stream: one `POST /bus/subscribe` connection for the active knowledge base

### Two origins

The app is loaded from one origin and talks to others. Nothing proxies between them.

```
The person's web browser
  ├── loads the SPA from the Browser's origin (http://localhost:3000)
  │     server.js serves the built files, index.html for every route,
  │     and /discovery/* (the knowledge bases the launcher is running)
  │
  └── calls each knowledge base's gateway at its own origin (http://localhost:4000)
        /bus/emit, /bus/subscribe      the bus
        /api/users/me, /api/tokens/media, /api/resources/{id}
        with Authorization: Bearer <jwt> from that knowledge base's session
```

- **`server.js` is a static file server and nothing more.** It holds no session, proxies no API traffic, and knows no gateway. All routing under `/:locale/*` is client-side (React Router).
- **A gateway must be reachable from the person's web browser**, not from the Browser's container. Gateways answer any origin.
- The knowledge base's issuer signs the person in and issues the tokens; the app completes the exchange on its callback route and stores the session per knowledge base
- Each knowledge base has its own session (an access token and a refresh token) in `localStorage`, keyed by its id; the app sends the active one's access token on every call

## Authentication Architecture

See [AUTHENTICATION.md](./AUTHENTICATION.md) for the full authentication flow.

### Key Components

**Session Management:**
```
SemiontProvider (app root) → SemiontBrowser singleton (library-side, outside React)
    ├── owns: kbs$ (KB list), activeKbId$ (active KB) — persisted via the storage adapter
    ├── owns: activeSession$ — the active KB's SemiontSession (its SemiontClient + access/refresh tokens)
    ├── owns: activeSignals$ — session-expired / permission-denied modal signals
    ├── owns: openResources$, lastViewedResource$ (per-KB), identityToken$
    └── useSemiont() → SemiontBrowser   (components read observables via useObservable)
        └── Application Components
```

**Authentication Flow:**
1. User adds a KB → `SemiontBrowser.beginSignIn` discovers the KB's issuer from its gateway (RFC 9728) and redirects there → the callback page's `completeSignIn` exchanges the authorization code (PKCE) for access + refresh tokens
2. The browser activates the session (`activeSession$`), marks the KB active (`activeKbId$`), and persists the session via the storage adapter
3. On reload/switch the browser restores the stored session; the client uses its in-memory access token, re-minting from the refresh token as it nears expiry
4. A 401 that can't be refreshed → the session ends, and its signals raise `sessionEnded$` with why → `SessionEndedModal` surfaces

**Token Management:**
- Bearer-only: every request carries `Authorization: Bearer <jwt>` — there is no cookie and no ambient credential
- The per-KB session (short-lived access token + long-lived refresh token — TTLs in [Authentication](../../../docs/operator/administration/AUTHENTICATION.md)) is held in memory and persisted per-KB via the storage adapter (localStorage on web), so it survives reload
- The browser exposes mutations (`addKb`, `signIn`, `signOut`); `signOut(kbId)` forgets the stored session and revokes the refresh token at the issuer (RFC 7009), so it cannot be exchanged again. The gateway takes no part: it never issued the session. The access token already in hand stays valid until it expires, minutes later.

### Authentication Hooks

```typescript
import { useSemiont, useObservable } from '@semiont/react-ui';

// The browser singleton and its observable session state
const browser = useSemiont();
const session = useObservable(browser.activeSession$);   // null when signed out
const activeKbId = useObservable(browser.activeKbId$);

// The SemiontClient lives on the active session; namespace verbs hang off it.
// The session feeds the client its in-memory bearer token automatically.
// (One-shot read: .fresh() is the explicit fetch on a CacheObservable.)
const resource = await session?.client.browse.resource(resourceId).fresh();

// Mutations go through the browser:
await browser.signOut(activeKbId!);
```

## State Management

### Observable Stores (RxJS BehaviorSubject)

High-churn entity data and browser-persistent application state are managed as observable stores — `BehaviorSubject`-backed classes with no React dependency. Components subscribe via `useObservable(store.observable$)`.

**Verb namespace Observables** (live in `@semiont/sdk`, owned by `SemiontClient`):

| Namespace | Access | What it caches |
|---|---|---|
| Browse | `semiont.browse.resource(id)` | Resource descriptors, lazily fetched, invalidated by EventBus domain events |
| Browse | `semiont.browse.annotations(id)` | Annotation lists per resource, updated in-place by enriched SSE events |
| Browse | `semiont.browse.entityTypes()` | Entity types, updated via `frame:entity-type-added` bus channel |

These update automatically when gateway domain events arrive through the bus gateway (`mark:added`, `yield:updated`, etc.) — no manual cache-invalidation calls needed. Components subscribe via `useObservable(semiont.browse.annotations(resourceId))`. See [`@semiont/sdk` Usage.md](../../../docs/builder/Usage.md) for the full verb namespace API.

**Application state** lives on the `SemiontBrowser` singleton (`@semiont/sdk`) and in `@semiont/react-ui` hooks:

| Where | What it holds |
|---|---|
| `browser.openResources$` | Open document tabs, per KB; persisted through the `SessionStorage` adapter, which on the web is `WebBrowserStorage` (`localStorage`, synced across browser tabs by the `storage` event) |
| `useSessionExpiry()` | Time left on the active session's access token (`session.expiresAt`); drives the "expiring soon" warning |

The browser APIs (`localStorage`, `window`) stay in `WebBrowserStorage` (`@semiont/react-ui`); the SDK sees only the `SessionStorage` interface.

**React integration**: `SemiontProvider` exposes the `SemiontBrowser` singleton via `useSemiont()`. Each per-KB `SemiontSession` owns its `SemiontClient` and feeds it the in-memory bearer token as `token$`; the client reads the observable's current value on every request, so token refreshes propagate automatically without any React-specific wiring.

### Binary Content (Media Tokens)

Binary resources (images, PDFs) cannot carry `Authorization` headers through browser-native fetch paths (`<img src>`, PDF.js URL streaming). Buffering entire files into `ArrayBuffer` in the JS heap is unacceptable for large files.

The solution is **media tokens** — short-lived JWTs scoped to a single resource, passed as `?token=<media-token>` on the resource URL:

```
ResourceViewerPage
  → useMediaToken(client, resourceId)  # auth.mediaToken(id); refreshed every 4 min
      → POST /api/tokens/media
      → { token }
  → resourceUrl = `${baseUrl}/api/resources/${id}?token=${token}`
  → <img src={resourceUrl}> or pdfjsLib.getDocument({ url: resourceUrl })
      → browser/PDF.js fetches directly, streams
```

`ResourceViewerPage` loads what the view for the media type's render mode reads (`capabilitiesOf(mediaType)?.render`, from `@semiont/core`):
- `'image'` or `'pdf'` → `useMediaToken` → URL passed to the image/PDF viewer
- `'text'` → `useResourceContent` (fetch + decode to string) → text viewer
- `'none'`, or a type the registry does not know → nothing. The no-preview fallback reads no content, and its download link mints its own token

Callers of `ResourceViewerPage` do not manage media tokens; the component handles it internally. The `useMediaToken` hook is available from `@semiont/react-ui` for any component that needs a token-authenticated URL independently.

See [`@semiont/http-transport/docs/MEDIA-TOKENS.md`](../../../packages/http-transport/docs/MEDIA-TOKENS.md) for the full specification including the JWT format and `POST /api/tokens/media` endpoint.

### UI State (React Context)

UI-only state and framework-agnostic providers:

**Framework-Agnostic Providers** (from `@semiont/react-ui`):
- `SemiontProvider` - Puts the `SemiontBrowser` singleton (KB list, active KB, per-KB `SemiontSession` + its `SemiontClient`, open resources) into context; read via `useSemiont()`
- `TranslationProvider` - Injects `TranslationManager` for i18n
- `ToastProvider` - Toast notification queue
- `LiveRegionProvider` - ARIA live region for screen reader announcements

These providers are framework-independent and can work with Next.js, Vite, or any React framework. The app provides framework-specific manager implementations.

**App-Specific Contexts:**
- `KeyboardShortcutsProvider` - Keyboard shortcut registration and handling

See [`docs/builder/react-ui/SESSION.md`](../../../docs/builder/react-ui/SESSION.md) for complete Provider Pattern documentation.

## API Integration

### Verb-Namespace Client

Components never call REST routes or generated query hooks. Each per-KB `SemiontSession` owns a `SemiontClient` whose surface is a set of **verb namespaces** — methods grouped by intent rather than by resource:

```typescript
// In a component: const semiont = useObservable(useSemiont().activeSession$)?.client;

// browse — reads. Live queries return CacheObservable<T> (subscribe via useObservable);
//          one-shot reads return Promise<T>.
semiont.browse.resource(resourceId);         // CacheObservable<ResourceDescriptor>
semiont.browse.annotations(resourceId);      // CacheObservable<Annotation[]>
semiont.browse.entityTypes();                // CacheObservable<string[]>
semiont.browse.resourceContent(resourceId);  // Promise<string> (one-shot)

// mark / yield / frame / bind / gather / match — writes and long-running operations
semiont.mark.annotation({                    // Promise<{ annotationId }>
  motivation: 'highlighting',
  target: { source: resourceId, selector: { type: 'TextQuoteSelector', exact: 'quoted text' } },
});
semiont.mark.delete(rId, aId);               // Promise<void>
const context = await semiont.gather.resource(resourceId);                      // Promise<GatheredContext>
semiont.yield.delegate({ title: 'Summary', storageUri: 'file://summary.md', context });  // DelegationObservable<YieldJobCompletion>
semiont.frame.addEntityType('Person');       // Promise<void>
```

`StreamObservable<T>` extends RxJS `Observable<T>` and is also `PromiseLike<T>`, so both `.subscribe()` and `await` work without any wrapper. `DelegationObservable` is the same for a delegated job: `.subscribe()` gives the job's events, and `await` its completion. `CacheObservable<T>` extends `Observable<CacheState<T>>` — subscribe (or `useObservable`) for the live pending/ready/failed view, or call `.fresh()` for a one-shot `Promise<T>`. See [`@semiont/sdk` Usage.md](../../../docs/builder/Usage.md) for the full namespace API.

### Caching and Invalidation

There are no query keys to manage. Each live `browse.*` query is backed by an internal `Cache` primitive keyed by its resource id. Caches refresh themselves in response to gateway **domain events** delivered over the bus gateway — call sites never invalidate anything by hand. `mark:added`, for example, refetches the resource's annotation list and history, and `frame:entity-type-added` refetches the entity types.

The table of what each event does to which cache is `specs/src/client/refresh.json` (`scripts/spec/generate-cache-refresh.mjs` makes it a module of `@semiont/core` at build); [CACHE-SEMANTICS.md](../../../docs/protocol/CACHE-SEMANTICS.md) states the contract. A stream reopened after a drop, and a detected event gap (`bus:resume-gap`), have rows of their own, so no update is silently missed.

### Error Handling

**Auth failures (401 / 403):** The transport stamps every failure with a `TransportErrorCode` — `unauthorized` for 401, `forbidden` for 403 — and republishes them on `session.errors$`. `SemiontBrowser` subscribes to the active session's error stream and routes them to that session's `SessionSignals`:

```typescript
// SemiontBrowser, when a session activates (packages/sdk/src/session/semiont-browser.ts)
const signals = new SessionSignals(); // handed to the session factory, then published as activeSignals$
session.errors$.subscribe((err) => {
  if (err.code === 'unauthorized') void session.refresh();
  else if (err.code === 'forbidden') signals.notifyPermissionDenied(err.message);
});
```

A `401` is not the end of a session: `refresh()` renews the token, and only a
session that cannot be renewed, or whose renewed token the knowledge base also
refuses, ends. The session's own `onAuthFailed` then raises `notifySessionEnded`
with why: `expired` or `refused`. A `403` raises `notifyPermissionDenied` with
the refusal's message as its detail.

`SessionSignals` holds the modal state as `BehaviorSubject`s, one per signal (`sessionEnded$`, `permissionDenied$`, `kbIdentityConflict$`), each null until raised. A notice says what happened, never a sentence: `SessionEndedModal` and `PermissionDeniedModal` write what a person reads, in their language, and render by subscribing to the browser's `activeSignals$` via `useObservable`. When no session is active (e.g. on the landing page), `activeSignals$` is `null`, so auth errors have nowhere to surface and are no-ops.

**Component-level:** a live query carries its own loading/error state in the value it emits — `useObservable(semiont.browse.resource(id))` yields `CacheState` values (`pending` / `ready` / `failed`, plus `undefined` on the very first render). One-shot hooks such as `useResourceContent` return an explicit `{ content, loading, error }` shape, where `content` is `undefined` until the text has loaded and a zero-byte document loads as `''`:

```tsx
function ResourceText() {
  const semiont = useObservable(useSemiont().activeSession$)?.client;
  const { content, loading, error } = useResourceContent(semiont ?? null, resourceId, resource);

  if (error) {
    return <p role="alert">{error.message}</p>;
  }
  return loading ? <p>Loading…</p> : <pre>{content}</pre>;
}
```

## Data Flow

### Read Flow (Live Queries)

```
Component renders
    └── useObservable(semiont.browse.resource(id))
        └── browse Cache checks for the resource id
            ├── Cache HIT  → emit cached value, revalidate in background
            └── Cache MISS → transport fetches (Bearer token attached)
                                └── cache result → Observable emits → component re-renders
```

### Write Flow (Verb Methods)

```
User action (e.g., create annotation)
    └── await semiont.mark.annotation(input)   (Bearer token attached)
        └── the knowledge base records the change and announces it (mark:added)
            └── the event arrives on the bus stream → the browse cache invalidates the affected query
                └── live Observable re-emits → subscribed components re-render
```

No call site invalidates anything by hand — the domain event drives the cache update.

### Real-Time Updates (Bus Gateway)

```
SemiontClient creates one ActorStateUnit (single SSE to /bus/subscribe)
    └── ResourceViewerPage mounts and subscribes to browse.*(id) live queries
        └── observing them acquires the resource scope (adds scoped channels)
            └── the gateway delivers the resource's events to that scope
                └── ActorStateUnit bridges events into local EventBus
                    └── BrowseNamespace invalidates caches
                        └── Live query Observables re-emit
                            └── UI updates automatically
```

## Provider Hierarchy

The provider tree has two distinct layers:

1. **Root providers** mounted in `[locale]/layout.tsx` — auth-independent. Available on every page including the landing page, the OAuth flow, and static pages.
2. **Auth shell** mounted only around the protected routes (`know/`, `moderate/`). Bundles the protected error boundary and the auth-failure modals. Pre-app routes intentionally do not mount the auth shell — surfacing a "session expired" modal on the landing page would be confusing because the user has not yet entered the app.

### Root layer (always present)

```tsx
// apps/browser/src/app/providers.tsx
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { NavigationHandler } from '@/components/knowledge/NavigationHandler';
import { useMergedTranslationManager } from '@/hooks/useMergedTranslationManager';

export function Providers({ children }: { children: React.ReactNode }) {
  const translationManager = useMergedTranslationManager();

  return (
    <TranslationProvider translationManager={translationManager}>  {/* @semiont/react-ui — i18n */}
      <SemiontProvider>            {/* @semiont/react-ui — the SemiontBrowser singleton (sessions, KBs, the per-KB SemiontClient + app-scoped event bus) */}
        <ToastProvider>            {/* @semiont/react-ui — toast notifications */}
          <LiveRegionProvider>     {/* @semiont/react-ui — screen reader announcements */}
            <KeyboardShortcutsProvider>  {/* app-specific */}
              <ThemeProvider>      {/* @semiont/react-ui — theme */}
                <LineNumbersProvider>  {/* @semiont/react-ui — line-numbers display */}
                  <NavigationHandler />
                  {children}       {/* the landing page, /auth/connect, /auth/callback, /auth/error, or the AuthShell-wrapped routes below */}
                </LineNumbersProvider>
              </ThemeProvider>
            </KeyboardShortcutsProvider>
          </LiveRegionProvider>
        </ToastProvider>
      </SemiontProvider>
    </TranslationProvider>
  );
}
```

### Auth shell (mounted around protected routes only)

```tsx
// apps/browser/src/contexts/AuthShell.tsx — no provider; the SemiontBrowser
// singleton (mounted at the app root) already holds all session state.
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedErrorBoundary resetKeys={[pathname]}>  {/* catches render-time crashes inside the protected tree; navigating away resets it */}
      <SessionEndedModal />            {/* reads sessionEnded$ from the active session's signals */}
      <PermissionDeniedModal />        {/* reads permissionDenied$ from the active session's signals */}
      <KbIdentityConflictModal />      {/* reads kbIdentityConflict$ from the active session's signals */}
      {children}                       {/* protected layout body */}
    </ProtectedErrorBoundary>
  );
}
```

### Where the auth shell mounts

`AuthShell` mounts once, in `ProtectedLayout` in `apps/browser/src/App.tsx`: a pathless route
that wraps both protected sections, `/know/*` and `/moderate/*`. Navigating between the sections
keeps the shell mounted rather than tearing it down and rebuilding it.

### Why the split

- **Pre-app surfaces** (landing page, OAuth flow, static pages) do not need a validated session and should not surface auth-failure modals.
- **Protected routes** sit under `AuthShell`, which surfaces the auth-failure modals from the active session's signals (`activeSignals$`). A 401 that can't be refreshed ends the session and `SessionEndedModal` surfaces, saying why.
- **Switching KBs swaps `activeSession$`** to the new KB's session (with its own `SemiontClient` pointing at that KB's gateway) — the `SemiontBrowser` singleton handles it, with no per-layout provider or external bridge.

See [`docs/builder/react-ui/SESSION.md`](../../../docs/builder/react-ui/SESSION.md) for details on the Provider Pattern architecture.

## Directory Structure

```text
apps/browser/src/
├── App.tsx                # React Router route tree
├── main.tsx               # Entry point
├── app/[locale]/          # Locale-prefixed page components
│   ├── auth/             # Auth pages (connect, callback, error)
│   ├── know/             # Knowledge management pages
│   └── moderate/         # Moderation pages
├── components/            # App-specific UI components
│   ├── modals/            # Modal dialogs
│   └── ...                # Other app-specific components
├── contexts/              # App-specific React Context providers
│   ├── AuthShell.tsx      # Wraps protected routes with the error boundary and the auth-failure modals
│   ├── KeyboardShortcutsContext.tsx
│   └── ...
├── hooks/                 # App-specific custom hooks
│   └── ...
├── i18n/                  # i18next config and routing wrappers
│   ├── config.ts          # i18next initialisation
│   └── routing.tsx        # Link, useRouter, usePathname, redirect
├── lib/                   # App-specific utility libraries
│   ├── routing.tsx        # Link and routes for @semiont/react-ui
│   ├── tracing.ts         # OpenTelemetry tracer
│   └── browser-stubs/     # Browser API stubs
└── types/                 # TypeScript type definitions

packages/react-ui/src/      # Reusable React components library
├── features/              # Feature-based components
│   ├── auth/              # Authentication error surface
│   │   ├── components/
│   │   │   └── AuthErrorDisplay.tsx   # Error display
│   │   └── __tests__/     # Component tests
│   ├── resource-viewer/   # Resource viewing components
│   ├── resource-discovery/ # Discovery components
│   └── ...                # Other feature modules
├── components/            # Shared UI components
│   ├── resource/          # Resource viewer components
│   │   ├── AnnotateView.tsx      # Curation mode
│   │   ├── BrowseView.tsx        # Browse mode
│   │   └── ResourceViewer.tsx    # Main resource component
│   ├── CodeMirrorRenderer.tsx    # Editor-based renderer
│   ├── annotation-popups/ # Annotation interaction UI
│   └── ...                # Other reusable components
├── contexts/              # Provider Pattern contexts
│   ├── AnnotationContext.tsx
│   ├── ResourceAnnotationsContext.tsx
│   ├── RoutingContext.tsx
│   ├── ThemeContext.tsx
│   └── TranslationContext.tsx
├── hooks/                 # Reusable React hooks
│   ├── useObservable.ts
│   ├── useResourceGraph.ts
│   └── ...
├── lib/                   # Reusable utilities
│   ├── annotation-registry.ts  # Annotation type metadata
│   ├── validation.ts      # Form validation rules
│   └── ...
└── types/                 # Shared TypeScript interfaces
    ├── AnnotationManager.ts
    ├── TranslationManager.ts
    └── ...
```

**Key Separation:**
- `apps/browser/src` - Vite SPA pages and app-specific implementations
- `packages/react-ui/src` - Framework-agnostic components and interfaces

**Note**: `AuthErrorDisplay` is framework-agnostic and lives in `packages/react-ui/src/features/auth/`. Signing in is not a component: the Browser sends the user to the knowledge base's issuer and completes the exchange on its callback route. The Browser provides React Router-specific wrappers that handle routing, translations, and auth state.

See [`@semiont/react-ui/docs/`](../../../packages/react-ui/docs/) for documentation on the reusable component library.

## Key Design Patterns

### 1. Provider Pattern (Framework Independence)

**Philosophy:** Avoid framework lock-in by inverting dependencies.

The `@semiont/react-ui` library uses the **Provider Pattern** to remain framework-agnostic:

```tsx
// @semiont/react-ui defines the INTERFACE (TranslationManager); the Browser
// provides an IMPLEMENTATION backed by i18next
import { useMergedTranslationManager } from '@/hooks/useMergedTranslationManager';

function I18nRoot({ children }: { children: React.ReactNode }) {
  const translationManager: TranslationManager = useMergedTranslationManager();

  // Inject the implementation via the provider
  return (
    <TranslationProvider translationManager={translationManager}>
      {children}
    </TranslationProvider>
  );
}
```

**Benefits:**
- ✅ The UI library imports no i18n library; the host brings its own (the Browser's is i18next)
- ✅ Routing works the same way: components take the host's `Link` and `routes` as props
- ✅ Easy to test with mock implementations (`createMockTranslationManager` in `@semiont/react-ui/test-utils`)
- ✅ Clear separation of concerns

See [`docs/builder/react-ui/SESSION.md`](../../../docs/builder/react-ui/SESSION.md) for complete documentation.

### 2. No Default Values

**Philosophy:** Defaults hide configuration errors and create silent failures.

**Example:**
```typescript
// ❌ WRONG - hides missing configuration
function apiUrlOrDefault(apiUrl: string | undefined): string {
  return apiUrl || 'http://localhost:4000';
}

// ✅ RIGHT - fails loudly
function requiredApiUrl(apiUrl: string | undefined): string {
  if (!apiUrl) {
    throw new Error('API URL not configured!');
  }
  return apiUrl;
}
```

### 3. Fail-Fast Authentication

**Philosophy:** Better to fail immediately than work with wrong/missing auth.

```typescript
// Every call goes through the active session's client — with no session there
// is no anonymous fallback (as ResourceViewerPage does before a write)
async function archive(semiont: SemiontClient | undefined, id: ResourceId) {
  if (!semiont) {
    throw new Error('No active session');
  }
  await semiont.mark.archive(id);
}
```

### 4. Data Fetching in Components

**Philosophy:** Components fetch their own data, not through props drilling.

```typescript
// Each component subscribes to exactly the observables it needs
function ResourceView({ resourceId }: { resourceId: ResourceId }) {
  const semiont = useObservable(useSemiont().activeSession$)?.client;
  const resource = useObservable(semiont?.browse.resource(resourceId));     // CacheState<ResourceDescriptor>
  const annotations = useObservable(semiont?.browse.annotations(resourceId)); // CacheState<Annotation[]>
  // Each emits CacheState (pending → ready | failed) and re-emits on every
  // cache update; unwrap the value with readyValue(...) from @semiont/sdk
  // ...
}
```

### 5. Event-Driven Invalidation Over Manual Refetch

**Philosophy:** Let gateway domain events drive cache invalidation automatically.

```typescript
// A write is just a verb call — no onSuccess, no invalidate.
await semiont.mark.annotation({
  motivation: 'highlighting',
  target: { source: resourceId, selector: { type: 'TextQuoteSelector', exact: 'quoted text' } },
});
// The gateway broadcasts mark:added over the bus; the browse cache
// refetches the affected query and every subscriber re-renders.
```

### 6. Separation of Concerns

**Contexts handle UI state only:**
- Keyboard shortcuts
- Toast notifications
- Animation state (sparkles)

**SDK observable caches handle server state:**
- Resources
- Annotations
- Entity types

## UI Components and Terminology

### Document Page Layout

The resource page (`apps/browser/src/app/[locale]/know/resource/[id]/page.tsx`, which renders `ResourceViewerPage`) consists of:

**Main Content Area**:
- **AnnotateView**: Curation mode with text selection and annotation creation
- **BrowseView**: Read-only mode for document viewing

**Right Panel** (conditionally visible based on the shell state unit's `activePanel$`):
- **Annotations** (`UnifiedAnnotationsPanel`): the resource's annotations, grouped by motivation, with AI assist in Annotate mode
- **History** (`AnnotationHistory`): the resource's append-only event log
- **Info** (`ResourceInfoPanel`): metadata and provenance
- **Collaboration** (`CollaborationPanel`): bus connection state and the KB's collaborators
- **JSON-LD** (`JsonLdPanel`): the resource's JSON-LD graph

**Toolbar** (far right, vertical icon strip):
- Vertically aligned buttons for toggling right panel content
- Visual feedback: left border accent + background color when active
- Buttons: annotations, resource info, history, collaboration, JSON-LD, user account, settings

### Bi-directional Document ↔ History Focusing

The document and history panels synchronize via hover interactions:

**History → Document**:
- Hovering over an event in History scrolls to the related annotation in the document
- Annotation pulses to draw attention

**Document → History**:
- Hovering over an annotation in the document scrolls to its creation event in History
- Event background pulses to indicate the match

**Implementation**:
- Uses `hoveredAnnotationId` state managed by document page
- CodeMirrorRenderer handles mousemove events and scroll/pulse animations
- AnnotationHistory tracks event refs and scrolls on hover changes

### Bi-directional Annotation ↔ Panel Hover Sync

Annotation overlays and panel entries keep each other in step through one channel,
`beckon:hover`, for every media type (text/markdown, PDF, images):

- An overlay or a panel entry that is hovered calls `session.client.beckon.hover(annotationId)`,
  and `beckon.hover(null)` when the pointer leaves. Both say `beckon:hover` on the session's bus,
  with `{ annotationId: AnnotationId | null }`.
- The page holds the hovered id and passes it down as `hoveredAnnotationId`. The viewer scrolls
  the overlay into view and pulses it; the panel does the same for its entry.

Panels keep their entries' DOM nodes through React ref callbacks, not through an event.


## Related Documentation

### React UI Library
- [`docs/builder/react-ui/SESSION.md`](../../../docs/builder/react-ui/SESSION.md) - Provider Pattern architecture
- [`docs/builder/react-ui/ANNOTATIONS.md`](../../../docs/builder/react-ui/ANNOTATIONS.md) - Annotation system documentation
- [`@semiont/react-ui/docs/`](../../../packages/react-ui/docs/) - Complete library documentation

### Browser Documentation
- [AUTHENTICATION.md](./AUTHENTICATION.md) - Authentication and authorization
- [AUTHORIZATION.md](./AUTHORIZATION.md) - Permission model
- [RENDERING-ARCHITECTURE.md](../../../packages/react-ui/docs/RENDERING-ARCHITECTURE.md) - Rendering pipeline and component hierarchy
- [CODEMIRROR-INTEGRATION.md](../../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md) - AnnotateView rendering with CodeMirror
- [ANNOTATIONS.md](./ANNOTATIONS.md) - Annotation UI/UX and workflows
- [ANNOTATION-RENDERING-PRINCIPLES.md](../../../packages/react-ui/docs/ANNOTATION-RENDERING-PRINCIPLES.md) - Rendering axioms and correctness properties
- [KEYBOARD-NAV.md](./KEYBOARD-NAV.md) - Keyboard navigation implementation
