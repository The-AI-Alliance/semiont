# Frontend Authentication Architecture

## Overview

A user is always authenticated **against a specific Knowledge Base (KB)** — never globally. Switching KBs means switching sessions atomically. The frontend stores one JWT per KB in `localStorage` and validates it on mount/switch via `GET /api/auth/me` against that KB's backend.

There is no NextAuth, no httpOnly cookie, no global session. State is owned by one merged provider that lives in `@semiont/react-ui` and is mounted only inside the protected layout boundary.

## Core Components

### 1. KnowledgeBaseSessionProvider (`@semiont/react-ui`)

The single source of truth for "which KB is active and what is the user's session against it." Owns:

- The list of configured KBs (persisted to `localStorage` under `semiont.knowledgeBases`)
- The active KB id (persisted to `localStorage` under `semiont.activeKnowledgeBaseId`)
- Per-KB JWTs (`localStorage` under `semiont.token.<kbId>`)
- The validated session (`{ token, user }`) for the active KB
- Modal-driving flags (`sessionExpiredAt`, `permissionDeniedAt`)
- JWT expiry derivations for the session-timer UI

Mount it inside `AuthShell`, never at the locale layout level. Mounting it on pre-app routes (landing, OAuth flow) triggers spurious JWT validation and modal flashes.

### 2. useKnowledgeBaseSession() Hook

The only hook anything needs to read or mutate session state:

```typescript
import { useKnowledgeBaseSession } from '@semiont/react-ui';

const {
  // KB list
  knowledgeBases,
  activeKnowledgeBase,
  // session state
  session,
  isLoading,
  // derived auth fields (memoized off session.user)
  user,
  token,
  isAuthenticated,
  isAdmin,
  isModerator,
  displayName,
  // mutations
  addKnowledgeBase,
  signIn,
  signOut,
  setActiveKnowledgeBase,
  // modal acks
  acknowledgeSessionExpired,
  acknowledgePermissionDenied,
} = useKnowledgeBaseSession();
```

The hook **throws** when called outside `KnowledgeBaseSessionProvider` (i.e. outside `AuthShell`). There is no fallback. Auth misuse must fail loudly.

### 3. AuthShell (`apps/frontend/src/contexts/AuthShell.tsx`)

A thin frontend composition that mounts the library provider, the protected error boundary, and the two auth-failure modals. Wrap any layout that hosts authenticated routes with `<AuthShell>`. Today that's `know/`, `admin/`, `moderate/`, and `auth/welcome/`.

```tsx
<KnowledgeBaseSessionProvider>
  <ProtectedErrorBoundary>
    <SessionExpiredModal />
    <PermissionDeniedModal />
    {children}
  </ProtectedErrorBoundary>
</KnowledgeBaseSessionProvider>
```

### 4. KnowledgeBasePanel (frontend)

User-facing UI for adding/switching/signing-out-of KBs. Calls `addKnowledgeBase(input, token)` (atomic — stores token + adds to list + sets active in one step) and `signIn(id, token)` for re-auth on existing KBs. Never writes to localStorage directly.

## Authentication Flow

```
1. User adds a KB via KnowledgeBasePanel
   └── Frontend POSTs credentials directly to that KB's backend
       └── Backend returns a JWT
           └── KnowledgeBasePanel calls addKnowledgeBase({...kb}, token)
               └── Provider stores token, adds KB to list, sets it active

2. Page mount / KB switch
   └── KnowledgeBaseSessionProvider's effect fires
       └── Reads stored token for the active KB
           └── If present and not expired by `exp`, calls getMe(token)
               ├── 200 → setSession({ token, user })
               └── 401 → clearKbToken + setSessionExpiredAt(Date.now())
                          └── SessionExpiredModal reads context, surfaces

3. Out-of-band 401/403 from any React Query call
   └── QueryCache.onError → notifySessionExpired() / notifyPermissionDenied()
       └── Module-scoped function calls into the active provider
           └── Provider sets the modal flag, modal surfaces

4. Sign out
   └── UserPanel calls apiClient.logout() then signOut(activeKb.id)
       └── Provider clears stored token + in-memory session
           └── Router redirects to home
```

## Route Protection

Protected layouts wrap their body in `<AuthShell>`, then check session state inside the body:

```typescript
function KnowledgeLayoutBody() {
  const { token, isLoading, activeKnowledgeBase } = useKnowledgeBaseSession();
  if (isLoading) return <LoadingSpinner />;
  if (!activeKnowledgeBase || !token) return <UnauthenticatedKnowledgeLayout />;
  return <AuthenticatedKnowledgeLayout />;
}

export default function KnowledgeLayout() {
  return <AuthShell><KnowledgeLayoutBody /></AuthShell>;
}
```

## OAuth Flow

OAuth providers can be configured per KB on the backend. The flow:

1. User picks a KB and chooses an OAuth provider in the connect form
2. Browser is redirected to the backend's OAuth endpoint for that KB
3. Backend handles the OAuth dance, issues a JWT, redirects back with the token
4. Frontend stores the token in `localStorage` keyed to the KB id and switches the active KB

## Cross-tree session signaling

Code outside the React tree (most importantly the React Query `QueryCache.onError` and `MutationCache.onError` handlers in `app/providers.tsx`) cannot call hooks. It signals the active provider via module-scoped notify functions exported from `@semiont/react-ui`:

```typescript
import { notifySessionExpired, notifyPermissionDenied } from '@semiont/react-ui';

new QueryCache({
  onError: (error) => {
    if (error instanceof APIError) {
      if (error.status === 401) notifySessionExpired('Your session has expired.');
      if (error.status === 403) notifyPermissionDenied('Access denied.');
    }
  },
});
```

When no `KnowledgeBaseSessionProvider` is mounted (e.g. on the landing page), these calls are no-ops.

## Related Documentation

- [AUTHORIZATION.md](./AUTHORIZATION.md) - Permission model
- [Backend Authentication](../../backend/README.md) - Backend JWT implementation
