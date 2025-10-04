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

The Semiont frontend is a Next.js 14 application using the App Router with React Server Components and Client Components. The architecture emphasizes:

- **Type Safety**: TypeScript throughout with strict mode enabled
- **Server State Management**: React Query for all API interactions
- **Authentication**: NextAuth.js for session management with custom JWT backend
- **No Global Mutable State**: All state is managed through React hooks and contexts
- **Fail-Fast Philosophy**: No default values - explicit configuration required

## Technology Stack

### Core Framework
- **Next.js 14** (App Router) - React framework with server/client components
- **React 18** - UI library with concurrent features
- **TypeScript 5** - Type safety and developer experience

### State Management
- **React Query (TanStack Query)** - Server state, caching, and data synchronization
- **React Context** - UI state and cross-cutting concerns (keyboard shortcuts, toast notifications)
- **NextAuth.js** - Authentication session management

### UI & Styling
- **Tailwind CSS** - Utility-first CSS framework
- **CodeMirror 6** - Code editor for document content
- **Headless UI** - Accessible UI components
- **Radix UI** - Low-level UI primitives

### API Communication
- **Fetch API** - HTTP client (wrapped with authentication)
- **Server-Sent Events (SSE)** - Real-time updates for long-running operations
- **WebSockets** - (Future) Real-time collaboration

## Authentication Architecture

See [AUTHENTICATION.md](./AUTHENTICATION.md) for detailed authentication flow.

### Key Components

**Session Management:**
```
NextAuth SessionProvider
    └── Custom SessionContext (isFullyAuthenticated helper)
        └── Application Components
```

**Authentication Flow:**
1. User authenticates via NextAuth (local or OAuth)
2. Backend returns JWT token stored in NextAuth session
3. `useSession()` hook provides token to components
4. `useAuthenticatedAPI()` hook wraps fetch with Bearer token
5. All API calls automatically include authentication

**Token Management:**
- Token stored in NextAuth session (`session.backendToken`)
- Read synchronously via `useSession()` hook (no async/await needed)
- Automatically included in all API requests via `useAuthenticatedAPI`
- No global mutable state - each request reads fresh token from session

### Authentication Hooks

```typescript
// Get session and authentication status
const { data: session, status } = useSession();
const isAuthenticated = status === 'authenticated' && !!session?.backendToken;

// Make authenticated API requests
const { fetchAPI, isAuthenticated } = useAuthenticatedAPI();
const data = await fetchAPI('/api/endpoint');

// Check full authentication (session + backend token)
const { isFullyAuthenticated } = useCustomSession();
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

### UI State (React Context)

UI-only state that doesn't come from the server:

**DocumentAnnotationsContext:**
- `newAnnotationIds` - Track recently created annotations for animations
- Mutation actions that return IDs for query invalidation
- NO data storage - data comes from React Query

**KeyboardShortcutsContext:**
- Keyboard shortcut registration and handling
- Global keyboard event coordination

**ToastProvider:**
- Toast notification queue
- Success/error/info messages

**LiveRegionProvider:**
- ARIA live region for screen reader announcements
- Accessibility notifications

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
    └── useDocumentEvents hook connects to SSE
        └── EventSource with Bearer token auth
            └── Backend sends events
                └── Event handler refetches queries
                    └── UI updates automatically
```

## Provider Hierarchy

The app is wrapped in multiple providers in this order (outer to inner):

```tsx
<SessionProvider>                    // NextAuth session
  <AuthErrorBoundary>               // Catch auth errors
    <CustomSessionProvider>         // isFullyAuthenticated helper
      <QueryClientProvider>         // React Query state
        <ToastProvider>             // Toast notifications
          <LiveRegionProvider>      // Screen reader announcements
            <KeyboardShortcutsProvider>  // Keyboard shortcuts
              {children}            // App content
            </KeyboardShortcutsProvider>
          </LiveRegionProvider>
        </ToastProvider>
      </QueryClientProvider>
    </CustomSessionProvider>
  </AuthErrorBoundary>
</SessionProvider>
```

**Why This Order:**
1. SessionProvider must be outermost (provides auth to all)
2. AuthErrorBoundary catches auth failures
3. CustomSessionProvider depends on SessionProvider
4. QueryClientProvider needed for all data fetching
5. ToastProvider, LiveRegionProvider, KeyboardShortcuts are independent utilities

## Directory Structure

```
apps/frontend/src/
├── app/                    # Next.js App Router pages
│   ├── (auth)/            # Auth-related pages (login, signup)
│   ├── know/              # Main knowledge management UI
│   │   ├── discover/      # Document discovery
│   │   ├── document/[id]/ # Document viewer/editor with Toolbar
│   │   └── compose/       # Document composition
│   ├── api/               # API route handlers (NextAuth, etc.)
│   ├── layout.tsx         # Root layout
│   └── providers.tsx      # Provider setup
├── components/            # Reusable UI components
│   ├── document/          # Document-specific components
│   │   ├── AnnotateView.tsx      # Curation mode (uses CodeMirrorRenderer)
│   │   ├── BrowseView.tsx        # Browse mode (uses ReactMarkdown)
│   │   ├── DocumentViewer.tsx    # Main document component
│   │   └── AnnotationHistory.tsx # Event log panel
│   ├── CodeMirrorRenderer.tsx    # Editor-based renderer (for AnnotateView)
│   ├── modals/            # Modal dialogs
│   ├── annotation-popups/ # Annotation interaction UI
│   └── ...                # Other shared components
├── contexts/              # React Context providers
│   ├── SessionContext.tsx
│   ├── DocumentAnnotationsContext.tsx
│   └── KeyboardShortcutsContext.tsx
├── hooks/                 # Custom React hooks
│   ├── useAuthenticatedAPI.ts
│   ├── useDocumentEvents.ts
│   └── ...
├── lib/                   # Utility libraries
│   ├── api-client.ts      # API client with React Query
│   ├── query-helpers.ts   # React Query utilities
│   ├── auth-events.ts     # Auth error event bus
└── types/                 # TypeScript type definitions
```

## Key Design Patterns

### 1. No Default Values

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

## Related Documentation

- [AUTHENTICATION.md](./AUTHENTICATION.md) - Authentication and authorization
- [AUTHORIZATION.md](./AUTHORIZATION.md) - Permission model
- [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md) - Rendering pipeline and component hierarchy
- [REACT-MARKDOWN.md](./REACT-MARKDOWN.md) - BrowseView rendering with ReactMarkdown
- [CODEMIRROR-INTEGRATION.md](./CODEMIRROR-INTEGRATION.md) - AnnotateView rendering with CodeMirror
- [ANNOTATIONS.md](./ANNOTATIONS.md) - Annotation UI/UX and workflows
- [SELECTIONS.md](./SELECTIONS.md) - Annotation data model and API (backend)
- [KEYBOARD-NAV.md](./KEYBOARD-NAV.md) - Keyboard shortcuts
- [PERFORMANCE.md](./PERFORMANCE.md) - Performance optimization

## Migration Notes

This architecture represents a major refactoring completed in phases 0-8 (see `/CLEAN-FRONTEND.md` in project root):

**Before:** Global mutable state, race conditions, `apiClient.setAuthToken()`
**After:** React Query, no global state, `useAuthenticatedAPI` hook

**Key Changes:**
- Removed all `apiClient.setAuthToken()` / `clearAuthToken()` / `getAuthToken()` methods
- All API calls now use React Query hooks
- Authentication handled per-request via `useAuthenticatedAPI`
- No more `apiService.*` direct calls in components
- SSE hooks use `useSession()` for auth instead of `getAuthToken()`

All 802 tests passing with 100% coverage of authentication code.
