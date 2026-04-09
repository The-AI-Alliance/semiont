# Frontend Architecture

This document describes the high-level architecture of the Semiont frontend application.

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

The Semiont frontend is a Vite + React Router v7 SPA. The architecture emphasizes:

- **Type Safety**: TypeScript throughout with strict mode enabled
- **Server State Management**: React Query for all API interactions
- **Authentication**: JWT cookie managed entirely by the backend — no frontend auth server
- **No Global Mutable State**: All state is managed through React hooks and contexts
- **Fail-Fast Philosophy**: No default values - explicit configuration required

## Technology Stack

### Core Framework
- **Vite** + **React Router v7** - SPA build tooling and client-side routing
- **React 18** - UI library with concurrent features
- **TypeScript 5** - Type safety and developer experience

### State Management
- **React Query (TanStack Query)** - Server state, caching, and data synchronization
- **React Context** - UI state and cross-cutting concerns (keyboard shortcuts, toast notifications)
- **i18next + react-i18next** - Internationalization

### UI & Styling

#### Hybrid CSS Architecture
The frontend uses a hybrid CSS approach that combines:
- **@semiont/react-ui** - Semantic CSS with BEM methodology for all UI components, organized into:
  - `core/` - Fundamental UI elements (buttons, toggles, sliders, badges, tags, indicators)
  - `components/` - Complex composed components (forms, modals, cards)
  - `panels/` - Panel layouts and containers (12 different panel styles)
  - `motivations/` - W3C Web Annotation standard styles (5 motivation types)
  - `features/` - Feature-specific styling
- **Tailwind CSS** - Utility-first CSS for app-specific layouts and custom components

This architecture ensures:
- Framework-agnostic component library (@semiont/react-ui uses semantic CSS)
- Modular organization with clear separation (core elements vs. components vs. panels)
- Centralized design tokens for consistency (panel tokens, color palettes)
- W3C Web Annotation compliance with dedicated motivation styles
- Flexibility for app-specific styling (frontend uses Tailwind)
- Clear separation of concerns (component styles vs. layout utilities)

#### UI Libraries
- **CodeMirror 6** - Code editor for document content
- **Headless UI** - Accessible UI components with Tailwind integration
- **Radix UI** - Low-level UI primitives

### Component Library Architecture

The frontend leverages **@semiont/react-ui**, a comprehensive framework-agnostic component library that provides:

#### Core Components
- **UI Components**: Button, Card, Toolbar, Toast, StatusDisplay
- **Resource Components**: ResourceViewer, AnnotateView, BrowseView
- **Annotation Components**: Complete annotation system with popups and overlays
- **Panel Components**: Comments, References, Tags, Statistics, JSON-LD panels
- **Navigation**: Footer, NavigationMenu, SkipLinks
- **Layout**: UnifiedHeader, LeftSidebar, PageLayout
- **Session**: SessionTimer, SessionExpiryBanner

#### Hooks & Utilities
- **API Hooks**: React Query wrappers for all Semiont API operations
- **UI Hooks**: useTheme, useKeyboardShortcuts, useToast, useDebounce
- **Resource Hooks**: useResourceEvents, useDetectionFlow, useGenerationFlow
- **Form Hooks**: useFormValidation with built-in validation rules

#### Provider Pattern
@semiont/react-ui uses a provider pattern for framework independence:

```typescript
// Frontend provides framework-specific implementations
<SessionProvider sessionManager={sessionManager}>
  <TranslationProvider translationManager={i18nextManager}>
    <ApiClientProvider apiClientManager={apiClientManager}>
      {/* App components can now use react-ui hooks */}
    </ApiClientProvider>
  </TranslationProvider>
</SessionProvider>
```

This architecture enables:
- **Framework Independence**: Components work with any React framework
- **Consistent Design**: Shared components across all Semiont applications
- **Type Safety**: Shared TypeScript types and interfaces
- **Comprehensive Testing**: 1250+ tests in the component library
- **Clear Boundaries**: Separation between framework code and UI components

See [Component Library Integration Guide](./COMPONENT-LIBRARY.md) for detailed usage.

### API Communication
- **Fetch API** - HTTP client (wrapped with authentication)
- **Server-Sent Events (SSE)** - Real-time updates for long-running operations
- **WebSockets** - (Future) Real-time collaboration

### Request Routing

The SPA serves static files. All routing is client-side (React Router v7):

```
Browser → http://localhost/
  ↓
Static file server (Envoy/nginx serves index.html for all non-asset paths)
  ↓
React Router v7 handles /:locale/* routes client-side
  ↓
API calls go directly to backend (/api/*)
```

**Path-Based Routing:**

- **`/api/*`** → Backend API (called directly from browser)
  - All REST API endpoints
  - WebSocket connections
  - SSE streams
  - Browser includes JWT from httpOnly cookie

- **`/*`** → Static frontend SPA (served by Envoy/nginx)
  - Vite-built static files
  - index.html for all non-asset paths (SPA routing)

**Key Architecture Points:**
- No frontend Node.js server process at runtime
- Backend handles all OAuth callbacks and token issuance
- JWT stored in httpOnly cookie set by backend, included automatically in browser API requests

## Authentication Architecture

See [AUTHENTICATION.md](./AUTHENTICATION.md) for detailed authentication flow.

### Key Components

**Session Management:**
```
AuthContext (reads JWT from httpOnly cookie via /api/auth/me)
    └── useAuth() hook
        └── Application Components
```

**Authentication Flow:**
1. User submits credentials → backend validates and sets httpOnly JWT cookie
2. `useAuth()` hook reads session state from AuthContext
3. API requests automatically include the cookie (same-origin)
4. 401 responses trigger redirect to sign-in

**Token Management:**
- JWT stored in httpOnly cookie set by backend (browser sends automatically)
- `useAuth()` provides `isAuthenticated`, `isAdmin`, `token`, etc.
- No global mutable state - each component reads from context

### Authentication Hooks

```typescript
// Get authentication state
const { isAuthenticated, isAdmin, isModerator, displayName, token } = useAuth();

// API calls use @semiont/api-client (cookie sent automatically)
const apiClient = useApiClient();
const data = await apiClient.getDocument(id);
```

## State Management

### Server State (React Query)

All server data is managed through React Query hooks generated from the API client.

**Queries (Read Operations):**
```typescript
// Fetch data with automatic caching and refetching
const { data, isLoading, error } = api.documents.get.useQuery(documentId);
```

**Mutations (Write Operations):**
```typescript
// Create/update/delete with automatic cache invalidation
const updateMutation = api.documents.update.useMutation();
await updateMutation.mutateAsync({ id, title, content });
```

**Benefits:**
- Automatic caching (5 minute stale time)
- Background refetching
- Request deduplication
- Optimistic updates
- Error handling with retry logic
- No manual state management needed

### Observable Stores (RxJS BehaviorSubject)

High-churn entity data and browser-persistent application state are managed as observable stores — `BehaviorSubject`-backed classes with no React dependency. Components subscribe via `useObservable(store.observable$)`.

**Entity stores** (live in `@semiont/api-client`, owned by `SemiontApiClient`):

| Store | Access | What it holds |
|---|---|---|
| `ResourceStore` | `client.stores.resources` | Resource descriptors, lazily fetched, invalidated by EventBus domain events |
| `AnnotationStore` | `client.stores.annotations` | Annotation lists + details per resource, invalidated by SSE events |

These update automatically when backend SSE events arrive (`mark:added`, `yield:updated`, etc.) — no manual `invalidateQueries` calls needed for annotation or resource list consumers. See [`@semiont/api-client/docs/STORES.md`](../../../packages/api-client/docs/STORES.md) for full documentation.

**Application state stores** (live in `apps/frontend/src/stores/`, browser-coupled):

| Store | What it holds |
|---|---|
| `OpenResourcesStore` | Open document tabs; persisted to `localStorage`, synced across browser tabs via `StorageEvent` |
| `SessionStore` | Session expiry state derived from the JWT; drives the "expiring soon" warning |

These stores depend on browser APIs (`localStorage`, `window`) and so cannot live in the framework-agnostic `api-client` package.

**React integration**: `useStoreTokenSync()` (called once at the workspace root) keeps the entity stores' token getters current as the auth token changes.

### Binary Content (Media Tokens)

Binary resources (images, PDFs) cannot carry `Authorization` headers through browser-native fetch paths (`<img src>`, PDF.js URL streaming). Buffering entire files into `ArrayBuffer` in the JS heap is unacceptable for large files.

The solution is **media tokens** — short-lived JWTs scoped to a single resource, passed as `?token=<media-token>` on the resource URL:

```
ResourceViewerPage
  → useMediaToken(resourceId)       # React Query, staleTime: 4 min
      → POST /api/tokens/media
      → { token }
  → resourceUrl = `${baseUrl}/api/resources/${id}?token=${token}`
  → <img src={resourceUrl}> or pdfjsLib.getDocument({ url: resourceUrl })
      → browser/PDF.js fetches directly, streams
```

`ResourceViewerPage` branches on `getMimeCategory(resource)`:
- `'text'` → `useResourceContent` (fetch + decode to string) → text viewer
- `'image'` (includes `application/pdf`) → `useMediaToken` → URL passed to image/PDF viewer

Callers of `ResourceViewerPage` do not manage media tokens; the component handles it internally. The `useMediaToken` hook is available from `@semiont/react-ui` for any component that needs a token-authenticated URL independently.

See [`@semiont/api-client/docs/MEDIA-TOKENS.md`](../../../packages/api-client/docs/MEDIA-TOKENS.md) for the full specification including the JWT format and `POST /api/tokens/media` endpoint.

### UI State (React Context)

UI-only state and framework-agnostic providers:

**Framework-Agnostic Providers** (from `@semiont/react-ui`):
- `AnnotationProvider` - Injects `AnnotationManager` for annotation mutations
- `CacheProvider` - Injects `CacheManager` for cache invalidation
- `AnnotationUIProvider` - UI-only state for sparkle animations (`newAnnotationIds`)
- `TranslationProvider` - Injects `TranslationManager` for i18n
- `ApiClientProvider` - Injects `ApiClientManager` for API access
- `SessionProvider` - Injects `SessionManager` for session state
- `OpenResourcesProvider` - Injects `OpenResourcesManager` for routing

These providers are framework-independent and can work with Next.js, Vite, or any React framework. The app provides framework-specific manager implementations.

**App-Specific Contexts:**
- `KeyboardShortcutsProvider` - Keyboard shortcut registration and handling
- `ToastProvider` - Toast notification queue
- `LiveRegionProvider` - ARIA live region for screen reader announcements

See [`@semiont/react-ui/docs/PROVIDERS.md`](../../../packages/react-ui/docs/PROVIDERS.md) for complete Provider Pattern documentation.

## API Integration

### API Client Structure

```typescript
// Type-safe API client with React Query hooks
export const api = {
  documents: {
    get: {
      useQuery: (id: string) => useAuthenticatedQuery(['/api/documents', id], ...)
    },
    list: {
      useQuery: () => useAuthenticatedQuery(['/api/documents'], ...)
    },
    create: {
      useMutation: () => useAuthenticatedMutation(...)
    },
    update: {
      useMutation: () => useAuthenticatedMutation(...)
    },
    delete: {
      useMutation: () => useAuthenticatedMutation(...)
    }
  },
  annotations: { ... },  // Note: API still uses 'selections' endpoint, to be renamed later
  entityTypes: { ... },
  // ... other resources
};
```

### Query Keys

React Query uses query keys to identify and cache queries. We follow **TanStack Query best practices** by centralizing query keys in a single source of truth.

**Location:** `/src/lib/api-client.ts`

**Structure:**
```typescript
export const QUERY_KEYS = {
  auth: {
    me: () => ['/api/auth/me'],
  },
  documents: {
    all: (limit?: number, archived?: boolean) => ['/api/documents', limit, archived],
    detail: (id: string) => ['/api/documents', id],
    search: (query: string, limit: number) => ['/api/documents/search', query, limit],
    events: (id: string) => ['/api/documents', id, 'events'],
    highlights: (documentId: string) => ['/api/documents/:id/highlights', documentId],
    references: (documentId: string) => ['/api/documents/:id/references', documentId],
  },
  entityTypes: {
    all: () => ['/api/entity-types'],
  },
  // ... other resources
};
```

**Usage in Hooks:**
```typescript
// Query hook uses QUERY_KEYS
getReferences: {
  useQuery: (documentId: string) => {
    return useAuthenticatedQuery(
      QUERY_KEYS.documents.references(documentId),  // Single source of truth
      `/api/documents/${documentId}/references`
    );
  }
}
```

**Usage in Invalidation:**
```typescript
// Invalidation uses same key - guaranteed to match
queryClient.invalidateQueries({
  queryKey: QUERY_KEYS.documents.references(documentId)
});
```

**Benefits:**
- ✅ **Type-safe**: TypeScript autocomplete for all query keys
- ✅ **Single source of truth**: Change key structure in one place
- ✅ **No mismatches**: Impossible for hook and invalidation to use different keys
- ✅ **Refactoring safety**: Rename/restructure without breaking cache invalidation
- ✅ **Hierarchical invalidation**: Can invalidate all document queries or specific subsets

**Anti-Pattern (Before):**
```typescript
// ❌ WRONG - Keys hardcoded in multiple places
useAuthenticatedQuery(['/api/documents/:id/references', documentId], ...);
queryClient.invalidateQueries({ queryKey: ['/api/selections', documentId, 'references'] });
// These don't match! Cache invalidation silently fails.
```

**Best Practice (After):**
```typescript
// ✅ RIGHT - Keys from QUERY_KEYS constant
useAuthenticatedQuery(QUERY_KEYS.documents.references(documentId), ...);
queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.references(documentId) });
// Guaranteed to match!
```

**Why No `as const`:**
```typescript
// We don't use 'as const' because it creates readonly tuple types
// which can cause React Query type mismatches
() => ['/api/documents', id] as const  // ❌ Readonly tuple - avoid
() => ['/api/documents', id]           // ✅ Mutable array - use this
```

### Error Handling

**Global Error Handlers:**
```typescript
// In QueryClient configuration
queryCache: new QueryCache({
  onError: (error) => {
    if (error instanceof APIError) {
      if (error.status === 401) {
        dispatch401Error('Session expired');
      } else if (error.status === 403) {
        dispatch403Error('Permission denied');
      }
    }
  }
})
```

**Component-Level:**
```typescript
const { data, error } = api.documents.get.useQuery(id);

if (error) {
  return <ErrorDisplay error={error} />;
}
```

## Data Flow

### Read Flow (Queries)

```
Component renders
    └── useQuery hook checks cache
        ├── Cache HIT → Return cached data + background refetch
        └── Cache MISS → Fetch from API
            └── useAuthenticatedAPI adds Bearer token
                └── Fetch from backend
                    └── Cache result + return data
```

### Write Flow (Mutations)

```
User action (e.g., click save)
    └── Component calls mutation.mutateAsync()
        └── useAuthenticatedAPI adds Bearer token
            └── POST/PATCH/DELETE to backend
                └── On success:
                    ├── Invalidate related queries
                    ├── Trigger automatic refetch
                    └── UI updates with fresh data
```

### Real-Time Updates (SSE)

```
Component mounts
    └── useResourceEvents hook connects to SSE
        └── EventSource with Bearer token auth
            └── Backend sends events
                └── Event handler refetches queries
                    └── UI updates automatically
```

## Provider Hierarchy

The provider tree has two distinct layers:

1. **Root providers** mounted in `[locale]/layout.tsx` — auth-independent. Available on every page including the landing page, the OAuth flow, and static pages.
2. **Auth shell** mounted only in protected layouts (`know/`, `admin/`, `moderate/`) and around `<WelcomePage />` in the route tree. Bundles authentication, the active KB, and the auth-failure modals. Pre-app routes intentionally do not mount the auth shell — surfacing a "session expired" modal on the landing page would be confusing because the user has not yet entered the app.

### Root layer (always present)

```tsx
// apps/frontend/src/app/providers.tsx
<TranslationProvider>          // @semiont/react-ui — i18n
  <QueryClientProvider>        // React Query (with auth-event dispatching in onError)
    <ToastProvider>            // @semiont/react-ui — toast notifications
      <LiveRegionProvider>     // @semiont/react-ui — screen reader announcements
        <KeyboardShortcutsProvider>  // app-specific
          <ThemeProvider>      // @semiont/react-ui — theme
            <EventBusProvider> // @semiont/react-ui — RxJS event bus
              <NavigationHandler />
              {children}        // landing, about, privacy, terms, /auth/connect, /auth/error, /auth/signup, or any of the AuthShell-wrapped subtrees below
```

### Auth shell (mounted in protected layouts only)

```tsx
// apps/frontend/src/contexts/AuthShell.tsx
<KnowledgeBaseProvider>           // which KB is active (from localStorage)
  <KnowledgeBaseAuthBridge>       // re-keys AuthProvider on activeKnowledgeBase.id
    <AuthProvider>                // validates JWT against the active KB on mount
      <AuthErrorBoundary>         // catches errors thrown by the auth chain
        <SessionProvider>         // @semiont/react-ui — fed by useSessionManager → useAuth
          <SessionExpiredModal /> // @semiont/react-ui — surfaces 401s
          <PermissionDeniedModal /> // @semiont/react-ui — surfaces 403s
          {children}              // protected layout body
```

### Where the auth shell mounts

| Route            | Mounted in                                          |
|------------------|-----------------------------------------------------|
| `/know/*`        | `apps/frontend/src/app/[locale]/know/layout.tsx`    |
| `/admin/*`       | `apps/frontend/src/app/[locale]/admin/layout.tsx`   |
| `/moderate/*`    | `apps/frontend/src/app/[locale]/moderate/layout.tsx`|
| `/auth/welcome`  | `apps/frontend/src/App.tsx` (route element)         |

### Why the split

- **Pre-app surfaces** (landing page, OAuth flow, static pages) do not need to validate JWTs and should not surface auth-failure modals.
- **Protected layouts** validate the active KB's JWT on mount via `getMe`. A 401 from that call dispatches `auth:unauthorized`, which `SessionExpiredModal` (mounted in the same shell) catches and surfaces.
- **`AuthProvider` re-keys on `activeKnowledgeBase.id`** so switching KBs forces a fresh validation against the new backend.
- **Protected layouts mount their own `ApiClientProvider`** pointing at the active KB's backend URL — they need the auth context to resolve that URL.

See [`@semiont/react-ui/docs/PROVIDERS.md`](../../../packages/react-ui/docs/PROVIDERS.md) for details on the Provider Pattern architecture.

## Directory Structure

```
apps/frontend/src/
├── App.tsx                # React Router v7 route tree
├── main.tsx               # Entry point
├── app/[locale]/          # Locale-prefixed page components
│   ├── auth/             # Auth pages (signin, signup, etc.)
│   ├── know/             # Knowledge management pages
│   ├── moderate/         # Moderation pages
│   └── admin/            # Admin pages
├── components/            # App-specific UI components
│   ├── modals/            # Modal dialogs
│   └── ...                # Other app-specific components
├── contexts/              # App-specific React Context providers
│   ├── AuthContext.tsx
│   ├── KeyboardShortcutsContext.tsx
│   └── ...
├── hooks/                 # App-specific custom hooks
│   ├── useAuth.ts
│   ├── useResourceEvents.ts
│   └── ...
├── i18n/                  # i18next config and routing wrappers
│   ├── config.ts          # i18next initialisation
│   └── routing.tsx        # Link, useRouter, usePathname, useLocale
├── lib/                   # App-specific utility libraries
│   ├── api-client.ts      # API client setup with React Query
│   ├── query-helpers.ts   # React Query utilities
│   ├── auth-events.ts     # Auth error event bus
│   └── cacheManager.ts    # CacheManager implementation for @semiont/react-ui
└── types/                 # TypeScript type definitions

packages/react-ui/src/      # Reusable React components library
├── features/              # Feature-based components
│   ├── auth/              # Authentication components
│   │   ├── components/
│   │   │   ├── SignInForm.tsx         # Framework-agnostic sign-in
│   │   │   ├── SignUpForm.tsx         # Framework-agnostic sign-up
│   │   │   ├── AuthErrorDisplay.tsx   # Error display
│   │   │   └── WelcomePage.tsx        # Welcome page
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
│   ├── CacheContext.tsx
│   ├── ApiClientContext.tsx
│   ├── TranslationContext.tsx
│   └── SessionContext.tsx
├── hooks/                 # Reusable React hooks
│   ├── useResourceAnnotations.ts
│   └── ...
├── lib/                   # Reusable utilities
│   ├── annotation-registry.ts  # Annotation type metadata
│   ├── api-hooks.ts       # API client utilities
│   └── ...
└── types/                 # Shared TypeScript interfaces
    ├── AnnotationManager.ts
    ├── CacheManager.ts
    └── ...
```

**Key Separation:**
- `apps/frontend/src` - Vite SPA pages and app-specific implementations
- `packages/react-ui/src` - Framework-agnostic components and interfaces

**Note**: Authentication components (SignInForm, SignUpForm, AuthErrorDisplay, WelcomePage) are framework-agnostic and live in `packages/react-ui/src/features/auth/`. The frontend provides React Router-specific wrappers that handle routing, translations, and auth state.

See [`@semiont/react-ui/docs/`](../../../packages/react-ui/docs/) for documentation on the reusable component library.

## Key Design Patterns

### 1. Provider Pattern (Framework Independence)

**Philosophy:** Avoid framework lock-in by inverting dependencies.

The `@semiont/react-ui` library uses the **Provider Pattern** to remain framework-agnostic:

```typescript
// @semiont/react-ui defines INTERFACES
interface AnnotationManager {
  createAnnotation: (params: CreateAnnotationParams) => Promise<Annotation | undefined>;
  deleteAnnotation: (params: DeleteAnnotationParams) => Promise<void>;
}

interface CacheManager {
  invalidateAnnotations: (rId: ResourceId) => void | Promise<void>;
  invalidateEvents: (rId: ResourceId) => void | Promise<void>;
}

// Apps provide IMPLEMENTATIONS
const annotationManager: AnnotationManager = {
  createAnnotation: async (params) => {
    const annotation = await client.createAnnotation(params);
    queryClient.invalidateQueries(['annotations', params.rId]);
    return annotation;
  },
  deleteAnnotation: async (params) => {
    await client.deleteAnnotation(params);
    queryClient.invalidateQueries(['annotations', params.rId]);
  }
};

const cacheManager: CacheManager = {
  invalidateAnnotations: (rId) => {
    queryClient.invalidateQueries({ queryKey: ['annotations', rId] });
  },
  invalidateEvents: (rId) => {
    queryClient.invalidateQueries({ queryKey: ['resources', 'events', rId] });
  }
};

// Inject implementations via providers
<AnnotationProvider annotationManager={annotationManager}>
  <CacheProvider cacheManager={cacheManager}>
    <App />
  </CacheProvider>
</AnnotationProvider>
```

**Benefits:**
- ✅ React UI library has **zero React Query dependency**
- ✅ Apps can use React Query, SWR, Apollo, or any data fetching library
- ✅ Easy to test with mock implementations
- ✅ Clear separation of concerns

See [`@semiont/react-ui/docs/PROVIDERS.md`](../../../packages/react-ui/docs/PROVIDERS.md) for complete documentation.

### 2. No Default Values

**Philosophy:** Defaults hide configuration errors and create silent failures.

**Example:**
```typescript
// ❌ WRONG - hides missing configuration
const apiUrl = config?.apiUrl || 'http://localhost:4000';

// ✅ RIGHT - fails loudly
if (!config?.apiUrl) {
  throw new Error('API URL not configured!');
}
```

### 2. Fail-Fast Authentication

**Philosophy:** Better to fail immediately than work with wrong/missing auth.

```typescript
// All API calls require authentication - no fallback
if (!session?.backendToken) {
  throw new Error('Authentication required');
}
```

### 3. Data Fetching in Components

**Philosophy:** Components fetch their own data, not through props drilling.

```typescript
// Each component fetches what it needs
function DocumentView({ documentId }: { documentId: string }) {
  const { data: doc } = api.documents.get.useQuery(documentId);
  const { data: highlights } = api.annotations.getHighlights.useQuery(documentId);
  // Note: API client uses 'annotations', but backend endpoint is still '/api/selections'
  // ...
}
```

### 4. Query Invalidation Over Manual Refetch

**Philosophy:** Let React Query handle refetching automatically.

```typescript
// After mutation, invalidate queries
const updateMutation = api.documents.update.useMutation({
  onSuccess: () => {
    queryClient.invalidateQueries(['/api/documents']);
  }
});
```

### 5. Separation of Concerns

**Contexts handle UI state only:**
- Keyboard shortcuts
- Toast notifications
- Animation state (sparkles)

**React Query handles server state:**
- Documents
- Annotations
- Entity types

## UI Components and Terminology

### Document Page Layout

The document page (`/know/document/[id]/page.tsx`) consists of:

**Main Content Area**:
- **AnnotateView**: Curation mode with text selection and annotation creation
- **BrowseView**: Read-only mode for document viewing

**Right Panel** (conditionally visible based on activeToolbarPanel state):
- **History Panel**: Append-only event log showing document changes (📒 icon)
- **Stats Panel**: Document metadata and "Referenced By" section (ℹ️ icon)
- **Detect Panel**: Reference detection UI (🔵 icon, only in curation mode)

**Toolbar** (far right, vertical icon strip):
- Vertically aligned buttons for toggling right panel content
- Visual feedback: left border accent + background color when active
- Icons: 🔵 Detect References, 📒 History, ℹ️ Statistics

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

Annotation overlays and panel entries synchronize via hover events for all media types (text/markdown, PDF, images):

**Overlay → Panel**:
- Hovering over an annotation in the content emits `annotation:hover` event
- Panel entry scrolls into view and pulses

**Panel → Overlay**:
- Hovering over a panel entry emits `annotation-entry:hover` event
- BrowseView scrolls overlay into view and pulses

**Implementation (Consistent Across Media Types)**:
- **Text annotations** (CodeMirrorRenderer): Emit `annotation:hover` on mouseover/mouseout
- **PDF annotations** (PdfAnnotationCanvas): Emit `annotation:hover` on mouseenter/mouseleave
- **Image annotations** (AnnotationOverlay): Emit `annotation:hover` on mouseenter/mouseleave
- **Panel entries**: Emit `annotation-entry:hover` on mouseenter/mouseleave
- **useAnnotationPanel hook**: Subscribes to `annotation:hover` and `annotation-entry:hover`, triggers scroll-to-view and pulse effects for panel entries
- **BrowseView**: Subscribes to `annotation:hover` and `annotation-entry:hover`, handles scrolling and pulse for overlays in browse mode
- **AnnotateView**: Subscribes to `annotation-entry:hover`, updates `hoveredAnnotationId` prop to trigger CodeMirrorRenderer scrolling and pulse

**Events**:
- `annotation:hover` - Emitted by all overlay types with `{ annotationId: string | null }`
- `annotation-entry:hover` - Emitted by panel entries with `{ annotationId: string | null }`
- `annotation:ref-update` - Emitted to register DOM refs for scroll targeting

## Related Documentation

### React UI Library
- [`@semiont/react-ui/docs/PROVIDERS.md`](../../../packages/react-ui/docs/PROVIDERS.md) - Provider Pattern architecture
- [`@semiont/react-ui/docs/ANNOTATIONS.md`](../../../packages/react-ui/docs/ANNOTATIONS.md) - Annotation system documentation
- [`@semiont/react-ui/docs/`](../../../packages/react-ui/docs/) - Complete library documentation

### Frontend Documentation
- [AUTHENTICATION.md](./AUTHENTICATION.md) - Authentication and authorization
- [AUTHORIZATION.md](./AUTHORIZATION.md) - Permission model
- [RENDERING-ARCHITECTURE.md](../../../packages/react-ui/docs/RENDERING-ARCHITECTURE.md) - Rendering pipeline and component hierarchy
- [ANNOTATION-OVERLAY.md](../../../ANNOTATION-OVERLAY.md) - BrowseView rendering with ReactMarkdown
- [CODEMIRROR-INTEGRATION.md](../../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md) - AnnotateView rendering with CodeMirror
- [ANNOTATIONS.md](./ANNOTATIONS.md) - Annotation UI/UX and workflows
- [ANNOTATION-RENDERING-PRINCIPLES.md](../../../packages/react-ui/docs/ANNOTATION-RENDERING-PRINCIPLES.md) - Rendering axioms and correctness properties
- [KEYBOARD-NAV.md](./KEYBOARD-NAV.md) - Keyboard shortcuts
- [PERFORMANCE.md](./PERFORMANCE.md) - Performance optimization

## Migration Notes

Two major refactors are complete:

**PURE-JWT-TOKEN**: Removed NextAuth, backend owns all auth via JWT httpOnly cookies.
- Removed `apiClient.setAuthToken()` / `clearAuthToken()` / `getAuthToken()`
- All API calls use `@semiont/api-client` (cookie sent automatically)
- Auth state via `useAuth()` / `AuthContext` instead of `useSession()`

**NO-NEXTJS** (see `/NO-NEXTJS.md`): Replaced Next.js with Vite + React Router v7 + i18next.
- `next build` → `vite build` (output: static files)
- `next dev` → `vite --host`
- `next-intl` → `i18next` + `react-i18next`
- `[locale]/layout.tsx` → React Router layout routes with `<Outlet />`
- No Node.js server process at runtime
