# Frontend Authentication Architecture

## Overview

Authentication in Semiont is owned entirely by the backend. The frontend has no auth server, no NextAuth, and no session encryption. The architecture emphasizes:

- **No global mutable state** - All authentication state managed through React hooks
- **Cookie-based auth** - Backend sets an httpOnly JWT cookie; browser sends it automatically
- **Fail-fast philosophy** - Missing authentication redirects to sign-in immediately
- **React Query integration** - All API calls use authenticated React Query hooks

## Core Components

### 1. AuthContext (`src/contexts/AuthContext.tsx`)

Fetches session state from `GET /api/auth/me` on mount and exposes it via context:

```typescript
interface AuthContextValue {
  isLoading: boolean;
  isAuthenticated: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  userDomain: string | null;
  isAdmin: boolean;
  isModerator: boolean;
  token: string | null;
  clearSession: () => void;
}
```

### 2. useAuth() Hook

Primary authentication hook — use this everywhere:

```typescript
const { isAuthenticated, isAdmin, token, displayName } = useAuth();
```

### 3. API Client

All API calls go through `@semiont/api-client`. The browser includes the httpOnly JWT cookie automatically on same-origin requests — no manual token header management needed.

```typescript
const apiClient = useApiClient();
const data = await apiClient.getDocument(id);
```

### 4. React Query Integration

All API calls use React Query hooks that internally use the api client:

```typescript
const { data, isLoading, error } = useDocuments();
```

## Authentication Flow

```
1. User submits credentials (email/password or OAuth)
   └── POST /api/auth/signin → backend validates
       └── Backend sets httpOnly JWT cookie
           └── Browser stores cookie automatically

2. Subsequent requests
   └── Browser sends cookie automatically (same-origin)
       └── Backend validates JWT on every request
           └── 401 response → frontend redirects to sign-in

3. Sign out
   └── POST /api/auth/signout → backend clears cookie
       └── AuthContext.clearSession() clears local state
           └── Router redirects to home
```

## Route Protection

Protected layouts check authentication and redirect if not authenticated:

```typescript
// In KnowledgeLayout, AdminLayout, ModerateLayout
const { token, isLoading } = useAuth();
const router = useRouter();

if (isLoading) return <LoadingSpinner />;
if (!token) {
  router.push(`/auth/signin?callbackUrl=${encodeURIComponent(window.location.pathname)}`);
  return null;
}
```

## OAuth Flow

OAuth is handled entirely by the backend:

1. Frontend links to `GET /api/auth/oauth/google` (backend redirects to Google)
2. Google redirects to `GET /api/auth/oauth/google/callback` (backend endpoint)
3. Backend validates, issues JWT, sets httpOnly cookie, redirects to frontend
4. Frontend's `AuthContext` picks up the new session on next render

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_BACKEND_URL` | Yes | Backend API URL |
| `NEXT_PUBLIC_SITE_NAME` | No | Site name (default: "Semiont") |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | No | Google OAuth client ID (for sign-in button display) |
| `NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS` | No | Comma-separated allowed email domains |
| `NEXT_PUBLIC_ENABLE_LOCAL_AUTH` | No | Enable email/password sign-in (default: false) |

## Related Documentation

- [AUTHORIZATION.md](./AUTHORIZATION.md) - Permission model
- [Backend Authentication](../../backend/README.md) - Backend JWT implementation
