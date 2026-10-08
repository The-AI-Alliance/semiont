# API Integration Guide

How the Semiont Browser integrates with the gateway through the
framework-agnostic `@semiont/react-ui` library, the `@semiont/sdk` client
(`SemiontClient`, sessions, the namespace verb API), and the
`@semiont/http-transport` wire adapter — including the provider model, bus
gateway transport, and W3C annotation model.

## Overview

The Browser integrates with the gateway through a layered architecture
that maintains framework independence:

```text
┌─────────────────────────────────────┐
│         apps/browser                │
│         (Vite + React Router)       │
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
- **Bearer auth** — the per-KB `SemiontSession` feeds the client's `token$` and keeps the access and refresh pair in `localStorage`; no cookies, no ambient credentials
- **One bus connection** — `SemiontClient` maintains a single SSE subscription to `/bus/subscribe`
- **Structured errors** — consistent error shape from the gateway, surfaced through `APIError`

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
`apps/browser/src/app/providers.tsx`):

```tsx
import { useMergedTranslationManager } from '@/hooks/useMergedTranslationManager';

export function Providers({ children }: { children: React.ReactNode }) {
  const translationManager = useMergedTranslationManager();
  return (
    <TranslationProvider translationManager={translationManager}>
      <SemiontProvider>
        {/* Toast, LiveRegion, KeyboardShortcuts, Theme and LineNumbers providers wrap the app */}
        {children}
      </SemiontProvider>
    </TranslationProvider>
  );
}
```

Hooks that need a client — `useMediaToken`, `useResourceContent` — take it as
an argument rather than reading context, so a host can bring its own session.

**Reference**: see
[`docs/builder/react-ui/SESSION.md`](../../../docs/builder/react-ui/SESSION.md)
for the session/provider API and
[`docs/builder/Usage.md`](../../../docs/builder/Usage.md)
for the client and bus subscription.

## Authentication Flow

A user is always authenticated against a specific Knowledge Base; there is
**no global session**. The `SemiontBrowser` singleton holds:

- `kbs$` — the known Knowledge Bases
- `activeKbId$` — which one is active
- `activeSession$` — the active KB's `SemiontSession` (or `null` when signed out)
- `activeSignals$` — that session's session-expired / permission-denied signals

Switching KBs swaps `activeSession$` atomically. Each `SemiontSession` owns its
own `SemiontClient` and the per-KB **bearer token** — a short-lived access token
([lifetimes](../../../docs/operator/administration/AUTHENTICATION.md#token-lifecycle)),
renewed at the issuer from a refresh token, the pair kept in `localStorage`.
Bearer-only: no cookie, no ambient credential.

- **Sign in** — `browser.beginSignIn({ … })` discovers the KB's issuer from its
  gateway (RFC 9728) and sends the person there; the callback page's
  `browser.completeSignIn(url)` exchanges the authorization code (PKCE) for the
  access and refresh pair and activates the session.
- **Sign out** — `browser.signOut(kbId)` clears the stored session and
  `activeSession$`, and revokes the refresh token at the issuer (RFC 7009).

Protected layouts mount `AuthShell`, which mounts the protected error boundary
(reset on every route change) and the three signals modals — session ended,
permission denied, KB identity conflict; each reads the active session's
signals (`activeSignals$`):

```tsx
// apps/browser/src/contexts/AuthShell.tsx
import { useLocation } from 'react-router';
import {
  ProtectedErrorBoundary,
  SessionEndedModal,
  PermissionDeniedModal,
  KbIdentityConflictModal,
} from '@semiont/react-ui';

export function AuthShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <ProtectedErrorBoundary resetKeys={[location.pathname]}>
      <SessionEndedModal />
      <PermissionDeniedModal />
      <KbIdentityConflictModal />
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
- **No manual token management** — the `SemiontSession` renews the access token at the issuer and stores it; the client reads it observably.
- **Type-safe** — types flow from the OpenAPI spec through the transport to components.

## Bus Gateway Transport

Every domain operation (commands and queries) flows through a single
SSE connection to `/bus/subscribe` + HTTP POST to `/bus/emit`:

- **Request-response queries** — `busRequest` generates a correlationId, subscribes to the result channel, and emits the request. The client filters incoming events by correlationId.
- **Fire-and-forget commands** — `actor.emit(channel, payload)` POSTs to `/bus/emit`; results arrive as separate events.
- **Live domain events** — `mark:added`, `mark:body-updated`, etc. flow on resource-scoped channels. Subscribing to a resource's `browse.*(id)` live queries adds those channels to the bus actor's subscription — freshness follows observation, with the SDK driving the transport's internal `subscribeToResource` — and drops them when the last subscriber unsubscribes.
- **Resumption** — when the stream reopens after a drop, the gateway replays each resource scope's persisted events from the last one the client received, or emits `bus:resume-gap` when it cannot; `BrowseNamespace` refetches only what replay does not cover. See [`docs/protocol/CACHE-SEMANTICS.md`](../../../docs/protocol/CACHE-SEMANTICS.md) (B13).

See [`docs/protocol/EVENT-BUS.md`](../../../docs/protocol/EVENT-BUS.md) and
[`docs/protocol/CHANNELS.md`](../../../docs/protocol/CHANNELS.md) for
the bus protocol; see
[`docs/builder/Usage.md`](../../../docs/builder/Usage.md)
for the client side.

## W3C Web Annotation Model

Semiont implements the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
for interoperability with other annotation systems.

### Annotation Structure

The wire type is `Annotation`, generated from the OpenAPI spec and exported
by `@semiont/sdk`:

```typescript
const linked: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId,
  motivation: 'linking',
  created: '2026-01-15T09:30:00Z',         // ISO 8601
  target: {
    source: resourceId,                     // the annotated resource
    selector: [                             // position + quote
      { type: 'TextPositionSelector', start: 100, end: 115 },
      { type: 'TextQuoteSelector', exact: 'knowledge graph' },
    ],
  },
  body: [                                   // multi-body: tags + links
    { type: 'TextualBody', purpose: 'tagging', value: 'Person' },
    { type: 'SpecificResource', purpose: 'linking', source: resourceId },
  ],
};
```

`creator` and `wasAttributedTo` are derived by the knowledge base at write
time and never accepted from an emitter.

### Multi-Body Annotations

Annotations combine entity-type tags and resource links. Each body is a
`BodyItem`, told apart by `type`:

**Entity tag** (`TextualBody`):
```typescript
const tag: BodyItem = { type: 'TextualBody', purpose: 'tagging', value: 'Person' };
```

**Resource link** (`SpecificResource`) — `source` is the id of the resource
the body leads to:
```typescript
const link: BodyItem = { type: 'SpecificResource', purpose: 'linking', source: resourceId };
```

### Selectors

Two complementary selector types anchor annotations to text:

**TextPositionSelector** — character offsets (fast, precise):
```typescript
import type { TextPositionSelector } from '@semiont/core';

const position: TextPositionSelector = { type: 'TextPositionSelector', start: 100, end: 115 };
```

**TextQuoteSelector** — text with context (resilient to edits):
```typescript
import type { TextQuoteSelector } from '@semiont/core';

const quote: TextQuoteSelector = {
  type: 'TextQuoteSelector',
  exact: 'knowledge graph',
  prefix: 'building a ',
  suffix: ' using annotations',
};
```

Together they survive both precise edits (offsets shift) and large
rewrites (text moves) — the position is tried first, then quote
matching locates the text if offsets are stale.

### JSON-LD Export

Annotations are serialized as standard JSON-LD on the wire and in
exports — any W3C-compliant consumer can ingest them.

## Request/Reply Operations and Jobs

The gateway hosts no handlers. Every bus operation is a `POST /bus/emit`
that the gateway answers `202` once it has accepted the frame; what the
operation produces arrives afterwards on the SSE stream. Two patterns
follow:

**Request/reply** — creating or deleting an annotation, a browse query.
The request carries a `correlationId`; the service that answers the
operation (the Archivist, for these) emits its reply with the same id, and
the gateway delivers it to the client that asked. The request settles when
that reply arrives on the stream: with the reply's response, or as a
`BusRequestError` on a failure reply or when none arrives by the request's
deadline.

**Jobs** — long-running work a worker performs: delegated annotation
(`mark.delegate`) and generation (`yield.delegate`). The verb emits
`job:create`, itself a request/reply: the dispatcher admits the job and
answers `job:created` with its `jobId`. The worker then reports on
`job:report-progress`, `job:complete` and `job:fail`, which reach every
client; the SDK keeps the frames that carry its job's `jobId` and delivers
them as the verb's delegation: the job's events, then its completion.

[`docs/protocol/EVENT-BUS.md`](../../../docs/protocol/EVENT-BUS.md) and
[`docs/protocol/TRANSPORT-HTTP.md`](../../../docs/protocol/TRANSPORT-HTTP.md)
specify the emit and the correlated reply;
[`docs/protocol/JOBS.md`](../../../docs/protocol/JOBS.md) specifies jobs.

## Error Handling

### Error Shape

Every gateway error answers with the spec's `ErrorResponse` body, whatever
the status and route:

```typescript
import type { components } from '@semiont/core';

type ErrorResponse = components['schemas']['ErrorResponse'];
// error: what went wrong, in a sentence; code?: a machine-readable class;
// hint?: what the caller can do about it; details?: context
```

### In the Client

HTTP errors from the http-transport surface as `APIError`:

```typescript
import { APIError } from '@semiont/http-transport';

declare const input: CreateAnnotationInput;

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
- **Session ended** — when the session's token cannot be renewed, or the knowledge base refuses the renewed one, the active session's signals surface `SessionEndedModal`, which says which.
- **Permission denied** — surfaced via `PermissionDeniedModal`.

## Related Documentation

### React UI library

- [`docs/builder/react-ui/SESSION.md`](../../../docs/builder/react-ui/SESSION.md) — provider reference
- [`@semiont/react-ui/docs/ARCHITECTURE.md`](../../../packages/react-ui/docs/ARCHITECTURE.md) — architectural overview
- [`docs/builder/react-ui/ANNOTATIONS.md`](../../../docs/builder/react-ui/ANNOTATIONS.md) — annotation UI components

### API client

- [`@semiont/http-transport/README.md`](../../../packages/http-transport/README.md) — API overview
- [`docs/builder/Usage.md`](../../../docs/builder/Usage.md) — setup, bus subscription, namespace reference
- [`@semiont/http-transport/docs/API-Reference.md`](../../../packages/http-transport/docs/API-Reference.md) — HTTP transport reference (`HttpTransport`, `TokenRefresher`, `APIError`)

### Gateway

- [Gateway README](../../gateway/README.md)

### Protocol

- [`docs/protocol/EVENT-BUS.md`](../../../docs/protocol/EVENT-BUS.md) — bus protocol semantics
- [`docs/protocol/CHANNELS.md`](../../../docs/protocol/CHANNELS.md) — channel inventory

### External

- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
