# API Integration Guide

How the Semiont frontend integrates with the backend through the
framework-agnostic `@semiont/react-ui` library and the `@semiont/api-client`
package — including the provider pattern, bus gateway transport, and
W3C annotation model.

## Overview

The frontend integrates with the backend through a layered architecture
that maintains framework independence:

```
┌─────────────────────────────────────┐
│         apps/frontend               │
│         (Vite + React Router v7)    │
│                                     │
│  • Auth + session wiring            │
│  • Page layouts and routing         │
│  • App-specific feature composition │
└─────────────┬───────────────────────┘
              │ mounts
              ▼
┌─────────────────────────────────────┐
│    packages/react-ui                │
│  (Framework-agnostic library)       │
│                                     │
│  • ApiClientProvider                │
│  • AuthTokenProvider                │
│  • Flow view models (RxJS)          │
│  • UI components & hooks            │
└─────────────┬───────────────────────┘
              │ uses
              ▼
┌─────────────────────────────────────┐
│    packages/api-client              │
│  (Type-safe API client)             │
│                                     │
│  • OpenAPI-generated types          │
│  • Namespace verb API               │
│  • Bus gateway (single SSE)         │
│  • HTTP for binary + auth           │
└─────────────────────────────────────┘
```

All API interactions feature:

- **Type-safety** — TypeScript types generated from the OpenAPI spec
- **Framework-agnostic react-ui** — plugs into any React framework via providers
- **Observable auth** — `token$: BehaviorSubject<AccessToken | null>` reactively drives bus auth
- **One bus connection** — `SemiontApiClient` maintains a single SSE subscription to `/bus/subscribe`
- **Structured errors** — consistent error shape from the backend, surfaced through `APIError`

## Provider Pattern Architecture

The Provider Pattern lets `@semiont/react-ui` run in any React framework
by abstracting framework-specific pieces (session, token source, routing)
behind a small set of context providers.

### How It Works

1. `@semiont/react-ui` exposes providers that take a minimal, framework-neutral shape (e.g. `AuthTokenProvider` takes `token: string | null`).
2. The frontend mounts those providers with values sourced from its own auth system.
3. Components inside read from the providers via hooks — they never touch the framework directly.

This boundary lets the same library power a Vite app, a Next.js app, or
a mobile shell without code changes to the components.

### Provider Stack

For an authenticated area of the app the provider stack looks like:

```
EventBusProvider
  └── AuthTokenProvider (token: string | null from your auth system)
       └── ApiClientProvider (baseUrl, tokenRefresher?)
            └── your components
```

`ApiClientProvider` reads the `BehaviorSubject` from `AuthTokenContext`
and passes it to `SemiontApiClient` as `token$`. The client uses
`token$.getValue()` on every request and subscribes to it to start its
bus actor the first time a real token arrives.

**Reference implementation**: see
[`packages/react-ui/docs/SESSION.md`](../../../packages/react-ui/docs/SESSION.md)
for the exact provider API. See
[`packages/sdk/docs/Usage.md`](../../../packages/sdk/docs/Usage.md)
for how the client consumes `token$`.

## Authentication Flow

A user is always authenticated against a specific Knowledge Base.
`KnowledgeBaseSessionProvider` (mounted via `AuthShell` in protected
layouts) owns the active KB, the per-KB JWT in localStorage, and the
validated session.

```tsx
// apps/frontend/src/contexts/AuthShell.tsx
import {
  KnowledgeBaseSessionProvider,
  ProtectedErrorBoundary,
  SessionExpiredModal,
  PermissionDeniedModal,
} from '@semiont/react-ui';

export function AuthShell({ children }) {
  return (
    <KnowledgeBaseSessionProvider>
      <ProtectedErrorBoundary>
        <SessionExpiredModal />
        <PermissionDeniedModal />
        {children}
      </ProtectedErrorBoundary>
    </KnowledgeBaseSessionProvider>
  );
}
```

Components inside the shell read session state with `useKnowledgeBaseSession()`:

```tsx
import { useKnowledgeBaseSession } from '@semiont/react-ui';

function UserBadge() {
  const { isAuthenticated, displayName, signOut, activeKnowledgeBase } =
    useKnowledgeBaseSession();
  if (!isAuthenticated || !activeKnowledgeBase) return null;
  return (
    <button onClick={() => signOut(activeKnowledgeBase.id)}>
      {displayName} (Sign out)
    </button>
  );
}
```

The hook throws if called outside the provider — there is no fallback.
Auth-aware components must always be inside the protected boundary.

**Key points:**

- **Per-KB sessions** — there is no global session; switching KBs switches sessions atomically.
- **No manual token management** — the session provider handles storage; the api-client reads the token observably.
- **Type-safe** — types flow from the OpenAPI spec through the api-client to components.

## Bus Gateway Transport

Every domain operation (commands and queries) flows through a single
SSE connection to `/bus/subscribe` + HTTP POST to `/bus/emit`:

- **Request-response queries** — `busRequest` generates a correlationId, subscribes to the result channel, and emits the request. The client filters incoming events by correlationId.
- **Fire-and-forget commands** — `actor.emit(channel, payload)` POSTs to `/bus/emit`; results arrive as separate events.
- **Live domain events** — `mark:added`, `yield:create-ok`, etc. flow on resource-scoped channels. `SemiontApiClient.subscribeToResource(id)` adds those channels to the bus actor's subscription when a resource page mounts.
- **Gap detection** — on reconnect after a disconnect, `BrowseNamespace` invalidates all active caches and refetches. No server-side replay.

See [`apps/backend/docs/STREAMS.md`](../../backend/docs/STREAMS.md) and
[`apps/backend/docs/REAL-TIME.md`](../../backend/docs/REAL-TIME.md) for
the backend side; see
[`packages/sdk/docs/Usage.md`](../../../packages/sdk/docs/Usage.md)
for the client side.

## W3C Web Annotation Model

Semiont implements the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
for interoperability with other annotation systems.

### Annotation Structure

```typescript
interface Annotation {
  "@context": "http://www.w3.org/ns/anno.jsonld";
  type: "Annotation";
  id: string;
  created: string;                 // ISO 8601
  creator: { id: string; type: "Person" };
  target: {
    source: string;                // resource id
    selector: Selector[];          // position + quote
  };
  body: AnnotationBody[];          // multi-body: tags + links
}
```

### Multi-Body Annotations

Annotations combine entity-type tags and resource links:

**Entity tag** (`TextualBody`):
```typescript
{ type: "TextualBody", purpose: "tagging", value: "Person" }
```

**Resource link** (`SpecificResource`):
```typescript
{
  type: "SpecificResource",
  purpose: "linking",
  source: "doc-einstein-bio",
  relationship: "definition",
}
```

### Selectors

Two complementary selector types anchor annotations to text:

**TextPositionSelector** — character offsets (fast, precise):
```typescript
{ type: "TextPositionSelector", start: 100, end: 115 }
```

**TextQuoteSelector** — text with context (resilient to edits):
```typescript
{
  type: "TextQuoteSelector",
  exact: "knowledge graph",
  prefix: "building a ",
  suffix: " using annotations",
}
```

Together they survive both precise edits (offsets shift) and large
rewrites (text moves) — the position is tried first, then quote
matching locates the text if offsets are stale.

### JSON-LD Export

Annotations are serialized as standard JSON-LD on the wire and in
exports — any W3C-compliant consumer can ingest them.

## Synchronous vs Asynchronous Operations

Two conceptual patterns:

**Synchronous (request-response)** — commands that complete quickly on
the backend handler: create annotation, delete annotation, browse
queries. The frontend awaits a result event matched by correlationId.

**Asynchronous (job-based)** — operations that run minutes to hours:
entity detection, resource generation. The frontend emits `job:create`,
gets back `job:created` with a `jobId`, then listens for `job:progress`
/ `job:completed` / `mark:progress` events scoped to the resource.

Both flow through the same bus gateway. The difference is whether the
final result event arrives in the same HTTP turnaround as the command
(sync) or later, driven by worker processes (async).

## Error Handling

### Error Shape

Backend errors follow a consistent shape:

```typescript
{
  error: string;       // human-readable
  code: string;        // machine-readable
  details?: unknown;   // context
}
```

### In the Client

HTTP errors from the api-client surface as `APIError`:

```typescript
import { APIError } from '@semiont/api-client';

try {
  await semiont.mark.annotation(resourceId, input);
} catch (err) {
  if (err instanceof APIError) {
    if (err.status === 401) { /* session expired */ }
    if (err.status === 403) { /* permission denied */ }
  }
}
```

Bus command errors surface as `BusRequestError` (from failure channels
like `browse:resources-failed`), raised from the promise returned by
`busRequest`.

### Automatic Recovery

- **401 errors** — if `ApiClientProvider` is given a `tokenRefresher`, the client retries once with a fresh token before propagating the error.
- **Session expired** — `KnowledgeBaseSessionProvider` detects expiry and surfaces `SessionExpiredModal`.
- **Permission denied** — surfaced via `PermissionDeniedModal`.

## Related Documentation

### React UI library

- [`@semiont/react-ui/docs/SESSION.md`](../../../packages/react-ui/docs/SESSION.md) — provider reference
- [`@semiont/react-ui/docs/ARCHITECTURE.md`](../../../packages/react-ui/docs/ARCHITECTURE.md) — architectural overview
- [`@semiont/react-ui/docs/ANNOTATIONS.md`](../../../packages/react-ui/docs/ANNOTATIONS.md) — annotation UI components

### API client

- [`@semiont/api-client/README.md`](../../../packages/api-client/README.md) — API overview
- [`@semiont/sdk/docs/Usage.md`](../../../packages/sdk/docs/Usage.md) — setup + bus subscription
- [`@semiont/api-client/docs/API-Reference.md`](../../../packages/api-client/docs/API-Reference.md) — namespace reference

### Backend

- [Backend README](../../backend/README.md)
- [`apps/backend/docs/STREAMS.md`](../../backend/docs/STREAMS.md) — bus gateway
- [`apps/backend/docs/REAL-TIME.md`](../../backend/docs/REAL-TIME.md) — real-time delivery

### External

- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
