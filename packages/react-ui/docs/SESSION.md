# Session Architecture

The session layer is the per-KB authentication, token-refresh, event-bus,
and HTTP client glue that sits between the React tree and the backend.
This document describes the current shape after the UNREACT and
VMs-from-Session refactors.

## Package layout

```
@semiont/api-client
├── client.ts                 ← SemiontApiClient (HTTP + private EventBus)
├── session/                  ← per-KB session, app-level browser, storage
│   ├── session-storage.ts    ← SessionStorage interface + InMemorySessionStorage
│   ├── semiont-session.ts    ← SemiontSession (per-KB)
│   ├── semiont-browser.ts    ← SemiontBrowser (app singleton)
│   ├── registry.ts           ← getBrowser({ storage }) singleton
│   ├── storage.ts            ← pure helpers + adapter-fed loaders
│   ├── refresh.ts            ← token refresh with in-flight dedup
│   ├── notify.ts             ← out-of-React notify handlers
│   ├── errors.ts             ← SemiontError + codes
│   ├── knowledge-base.ts     ← KnowledgeBase, KbSessionStatus types
│   └── open-resource.ts      ← OpenResource type
└── view-models/              ← MVVM factories; take `client`, not a bus
    ├── flows/                ← beckon, browse, gather, mark, match, yield
    ├── domain/                ← actor, job-queue, welcome, admin-*, …
    └── pages/                 ← compose-page, resource-viewer-page

@semiont/react-ui
└── session/
    ├── SemiontProvider.tsx   ← React context provider + useSemiont hook
    └── web-browser-storage.ts ← WebBrowserStorage (localStorage + storage event)
```

No session logic lives in `@semiont/react-ui` anymore. The React surface is
exactly two exports: `SemiontProvider` / `useSemiont` (context) and
`WebBrowserStorage` (the browser-backed `SessionStorage` implementation).

## Core classes

### `SemiontApiClient`

Owns HTTP (via `ky`), an actor-shaped SSE connection, and a private
`EventBus`. Workspace-scoped: one client per connected KB.

Bus surface (the only public path to the bus):

```ts
client.emit<K>(channel: K, payload: EventMap[K]): void
client.on<K>(channel: K, handler: (p: EventMap[K]) => void): () => void
client.stream<K>(channel: K): Observable<EventMap[K]>
```

`client.eventBus` is **private** — no public accessor. ViewModel factories
take `client` and route through `client.stream(...)` / `client.emit(...)`.

### `SemiontSession`

Per-KB lifetime object. Owns:

- `client: SemiontApiClient` — public `readonly`; components reach the bus
  via `session.client.emit(...)` / `session.client.on(...)` /
  `session.client.stream(...)`.
- `token$`, `user$` — observable auth state.
- Modal state: `sessionExpiredAt$`, `permissionDeniedAt$` with messages.
- `refresh()` — token refresh entrypoint.

The session is **not** a bus wrapper. It does not forward `emit`/`on` —
that surface is on the client directly. Components hold the session, read
`.client`, and call through.

### `SemiontBrowser`

App-level singleton. Owns:

- `kbs$` — configured KB list
- `activeKbId$`, `activeSession$` — active selection + session
- `openResources$` — open-resource list (tab bar)
- `identityToken$` — app-level identity bridge (e.g. NextAuth)
- `error$` — session-level error stream
- CRUD methods: `addKb`, `removeKb`, `setActiveKb`, `signIn`, `signOut`,
  `addOpenResource`, etc.
- `getKbSessionStatus(kbId)` — synchronous status check for KB-list UI

All persistence goes through a `SessionStorage` adapter provided at
construction. The classes never touch `localStorage` or `window` directly.

### `SessionStorage`

```ts
interface SessionStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  subscribe?(handler: (key: string, newValue: string | null) => void): () => void;
}
```

Implementations:

- `InMemorySessionStorage` (in `@semiont/api-client`) — for tests / in-memory.
- `WebBrowserStorage` (in `@semiont/react-ui`) — wraps `localStorage` and
  the `window` `storage` event for cross-tab sync.
- Future `FileSystemSessionStorage` for CLI persistence — not yet built.

## React surface

### `<SemiontProvider>` + `useSemiont()`

```tsx
import { SemiontProvider } from '@semiont/react-ui';

export default function AppLayout({ children }) {
  return (
    <SemiontProvider>
      {children}
    </SemiontProvider>
  );
}
```

`SemiontProvider` defaults to constructing its `SemiontBrowser` with
`new WebBrowserStorage()` via `getBrowser({ storage: new WebBrowserStorage() })`.
Tests can inject a different browser:

```tsx
<SemiontProvider browser={testBrowser}>{...}</SemiontProvider>
```

Inside components:

```tsx
import { useSemiont, useObservable } from '@semiont/react-ui';

function MyComponent() {
  const browser = useSemiont();
  const session = useObservable(browser.activeSession$);
  const user = useObservable(session?.user$);

  if (!user) return <SignInPrompt />;
  return <div>Hello, {user.name}</div>;
}
```

### Event emission & subscription

Components emit via `session.client.emit(...)`:

```tsx
function MarkButton({ annotationId }) {
  const session = useObservable(useSemiont().activeSession$);
  return (
    <button onClick={() => session?.client.emit('browse:click', { annotationId })}>
      Click me
    </button>
  );
}
```

Components subscribe via `useEventSubscription` — a hook that handles
stale-closure + cleanup correctly:

```tsx
import { useEventSubscription } from '@semiont/react-ui';

function AnnotationReactor() {
  useEventSubscription('mark:create-ok', ({ annotationId }) => {
    triggerSparkleAnimation(annotationId);
  });
  return null;
}
```

Internally `useEventSubscription` calls `session.client.on(channel, handler)`.

### ViewModel hooks

`useBrowseVM` (and friends) construct ViewModels over the active session's
client:

```tsx
export function useBrowseVM(): BrowseVM {
  const client = useObservable(useSemiont().activeSession$)?.client;
  return useViewModel(() => createBrowseVM(client!, {
    initialPanel: readPanel(),
    onPanelChange: persistPanel,
  }));
}
```

ViewModel factories take `client: SemiontApiClient` — never a raw
`EventBus`. They call `client.stream(channel).subscribe(...)` for
subscriptions and `client.emit(channel, payload)` for emissions.

## Invariants

1. **One client per KB.** The session owns it; the browser owns the
   session; `setActiveKb` is the only path to swap.
2. **Session classes are environment-agnostic.** No `window` or
   `localStorage` references. Storage goes through `SessionStorage`.
3. **`client.eventBus` is private.** All bus access is `client.emit` /
   `client.on` / `client.stream` — enforced by TypeScript.
4. **VM factories import only from `@semiont/api-client`.** No
   `import { EventBus } from '@semiont/core'` in view-model files.
5. **React layer is provider + hook only.** All session types live in
   `@semiont/api-client`; the React package exports only `SemiontProvider`,
   `useSemiont`, and `WebBrowserStorage`.

## Non-React consumers

Because session/browser now live in `@semiont/api-client`, CLI and MCP can
use them directly:

```ts
import { SemiontBrowser, InMemorySessionStorage } from '@semiont/api-client';

const browser = new SemiontBrowser({ storage: new InMemorySessionStorage() });
// ...
```

CLI commands that previously needed ad-hoc `new EventBus()` plumbing now
just use the client's `emit`/`on`/`stream` methods directly — no bus
wiring required.

## Testing

Tests use `InMemorySessionStorage` (or a simple subclass adding
`subscribe()` for cross-context sync simulation) to drive session state
without depending on jsdom's `localStorage`. See
`packages/api-client/src/session/__tests__/test-storage-helpers.ts` for
the test harness pattern.

ViewModel factory tests use `makeTestClient()` from
`packages/api-client/src/__tests__/test-client.ts`:

```ts
import { makeTestClient } from '../../../__tests__/test-client';

const { client, bus } = makeTestClient({
  mark: { annotation: vi.fn().mockResolvedValue({ annotationId: 'x' }) },
});
const vm = createMarkVM(client, resourceId);
client.emit('mark:submit', { ... });
// ... assert ...
bus.destroy(); // in afterEach
```
