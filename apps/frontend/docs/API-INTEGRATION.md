# API Integration Guide

How the Semiont frontend integrates with the backend through the
framework-agnostic `@semiont/react-ui` library, the `@semiont/sdk` client
(`SemiontClient`, sessions, the namespace verb API), and the
`@semiont/http-transport` wire adapter — including the provider model, bus
gateway transport, and W3C annotation model.

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
│  • SemiontProvider — the single     │
│    React bridge to SemiontBrowser   │
│  • Flow state units (RxJS)          │
│  • UI components & hooks            │
└─────────────┬───────────────────────┘
              │ uses
              ▼
┌─────────────────────────────────────┐
│    packages/sdk                     │
│  (SemiontClient + sessions)         │
│                                     │
│  • SemiontBrowser / SemiontSession  │
│  • Namespace verb API               │
│    (browse, mark, yield, …)         │
│  • Bus gateway (single SSE)         │
└─────────────┬───────────────────────┘
              │ uses
              ▼
┌─────────────────────────────────────┐
│    packages/http-transport          │
│  (Wire adapter)                     │
│                                     │
│  • OpenAPI-generated types          │
│  • HttpTransport (HTTP + bus)       │
│  • Binary + media-token auth        │
│  • APIError                         │
└─────────────────────────────────────┘
```

All API interactions feature:

- **Type-safety** — TypeScript types generated from the OpenAPI spec
- **Framework-agnostic react-ui** — plugs into any React framework via providers
- **In-memory bearer auth** — the per-KB `SemiontSession` holds the access token in JS memory and feeds the client's `token$`; no cookies, no ambient credentials
- **One bus connection** — `SemiontClient` maintains a single SSE subscription to `/bus/subscribe`
- **Structured errors** — consistent error shape from the backend, surfaced through `APIError`

## Provider Model

`@semiont/react-ui` stays framework-neutral by keeping all session and client
logic in `@semiont/sdk` — pure RxJS classes with no React inside — and exposing
exactly **one** React bridge: `SemiontProvider`.

### How it works

`SemiontProvider` puts the module-scoped `SemiontBrowser` singleton into React
context; `useSemiont()` hands it back. The browser owns everything
session-related (the KB list, the active KB, and the per-KB `SemiontSession`),
lives outside React, and survives every re-render and route change. There is
**no** stack of token/client providers — a component reads the active client
through the browser's observables:

```tsx
import { useSemiont, useObservable } from '@semiont/react-ui';

function useClient() {
  // null until a session is active for the current KB
  return useObservable(useSemiont().activeSession$)?.client;
}
```

The app mounts the provider once at the root (see
`apps/frontend/src/app/providers.tsx`):

```tsx
<TranslationProvider …>
  <SemiontProvider>
    {/* Toast, LiveRegion, KeyboardShortcuts, Theme, then the app */}
  </SemiontProvider>
</TranslationProvider>
```

Most components never read the client directly — dedicated hooks
(`useMediaToken`, `useResourceContent`, the flow state units) encapsulate the
`activeSession$ → client` read.

**Reference**: see
[`packages/react-ui/docs/SESSION.md`](../../../packages/react-ui/docs/SESSION.md)
for the session/provider API and
[`packages/sdk/docs/Usage.md`](../../../packages/sdk/docs/Usage.md)
for the client and bus subscription.

## Authentication Flow

A user is always authenticated against a specific Knowledge Base; there is
**no global session**. The `SemiontBrowser` singleton holds:

- `kbs$` — the known Knowledge Bases
- `activeKbId$` — which one is active
- `activeSession$` — the active KB's `SemiontSession` (or `null` when signed out)
- `activeSignals$` — that session's session-expired / permission-denied signals

Switching KBs swaps `activeSession$` atomically. Each `SemiontSession` owns its
own `SemiontClient` and the per-KB **bearer token in JS memory** — a 10-minute
access token re-minted from a 30-day refresh token. Bearer-only: no cookie, no
ambient credential.

- **Sign in** — `SemiontSession.signInHttp({ … })` exchanges credentials for the
  JWT (returned in the response body) and activates the session.
- **Sign out** — `browser.signOut(kbId)` calls the backend logout, which bumps
  the user's `tokenVersion` — revoking the refresh token and every live access
  token **server-side, on all devices** — and clears `activeSession$`.

Protected layouts mount `AuthShell`, which mounts the protected error boundary
and the two auth-failure modals; the modals read the active session's signals
(`activeSignals$`):

```tsx
// apps/frontend/src/contexts/AuthShell.tsx
import {
  ProtectedErrorBoundary,
  SessionExpiredModal,
  PermissionDeniedModal,
} from '@semiont/react-ui';

export function AuthShell({ children }) {
  return (
    <ProtectedErrorBoundary>
      <SessionExpiredModal />
      <PermissionDeniedModal />
      {children}
    </ProtectedErrorBoundary>
  );
}
```

Components read auth state by subscribing to the browser's observables — a
`null` `activeSession$` means the user isn't signed into the active KB:

```tsx
import { useSemiont, useObservable } from '@semiont/react-ui';

function UserBadge() {
  const browser = useSemiont();
  const session = useObservable(browser.activeSession$);
  const activeKbId = useObservable(browser.activeKbId$);
  if (!session || !activeKbId) return null;
  return <button onClick={() => browser.signOut(activeKbId)}>Sign out</button>;
}
```

**Key points:**

- **Per-KB sessions** — there is no global session; switching KBs switches sessions atomically.
- **No manual token management** — the `SemiontSession` mints and refreshes the bearer token in memory; the client reads it observably.
- **Type-safe** — types flow from the OpenAPI spec through the transport to components.

## Bus Gateway Transport

Every domain operation (commands and queries) flows through a single
SSE connection to `/bus/subscribe` + HTTP POST to `/bus/emit`:

- **Request-response queries** — `busRequest` generates a correlationId, subscribes to the result channel, and emits the request. The client filters incoming events by correlationId.
- **Fire-and-forget commands** — `actor.emit(channel, payload)` POSTs to `/bus/emit`; results arrive as separate events.
- **Live domain events** — `mark:added`, `yield:create-ok`, etc. flow on resource-scoped channels. Subscribing to a resource's `browse.*(id)` live queries adds those channels to the bus actor's subscription — freshness follows observation, with the SDK driving the transport's internal `subscribeToResource` (#847) — and drops them when the last subscriber unsubscribes.
- **Gap detection** — on reconnect after a disconnect, `BrowseNamespace` invalidates all active caches and refetches. No server-side replay.

See [`docs/protocol/EVENT-BUS.md`](../../../docs/protocol/EVENT-BUS.md) and
[`docs/protocol/CHANNELS.md`](../../../docs/protocol/CHANNELS.md) for
the bus protocol; see
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

HTTP errors from the http-transport surface as `APIError`:

```typescript
import { APIError } from '@semiont/http-transport';

try {
  await semiont.mark.annotation(input);
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

- **401 errors** — the `SemiontSession` re-mints a fresh access token from the refresh token and retries once before propagating the error.
- **Session expired** — when the refresh token is gone or revoked, the active session's signals surface `SessionExpiredModal`.
- **Permission denied** — surfaced via `PermissionDeniedModal`.

## Related Documentation

### React UI library

- [`@semiont/react-ui/docs/SESSION.md`](../../../packages/react-ui/docs/SESSION.md) — provider reference
- [`@semiont/react-ui/docs/ARCHITECTURE.md`](../../../packages/react-ui/docs/ARCHITECTURE.md) — architectural overview
- [`@semiont/react-ui/docs/ANNOTATIONS.md`](../../../packages/react-ui/docs/ANNOTATIONS.md) — annotation UI components

### API client

- [`@semiont/http-transport/README.md`](../../../packages/http-transport/README.md) — API overview
- [`@semiont/sdk/docs/Usage.md`](../../../packages/sdk/docs/Usage.md) — setup, bus subscription, namespace reference
- [`@semiont/http-transport/docs/API-Reference.md`](../../../packages/http-transport/docs/API-Reference.md) — HTTP transport reference (`HttpTransport`, `TokenRefresher`, `APIError`)

### Backend

- [Backend README](../../backend/README.md)

### Protocol

- [`docs/protocol/EVENT-BUS.md`](../../../docs/protocol/EVENT-BUS.md) — bus protocol semantics
- [`docs/protocol/CHANNELS.md`](../../../docs/protocol/CHANNELS.md) — channel inventory

### External

- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
