# Session Architecture

The session layer is the per-KB authentication, token-refresh, event-bus,
and HTTP client glue that sits between the React tree and the gateway.

## Package layout

```text
@semiont/sdk
├── client.ts                    ← SemiontClient (transport + its EventBus)
├── session/                     ← per-KB session, app-level browser, storage
│   ├── session-storage.ts       ← SessionStorage interface + InMemorySessionStorage
│   ├── semiont-session.ts       ← SemiontSession (per-KB)
│   ├── semiont-browser.ts       ← SemiontBrowser (app singleton)
│   ├── session-signals.ts       ← SessionSignals (the modals' state)
│   ├── session-factory.ts       ← SessionFactory type
│   ├── http-session-factory.ts  ← createHttpSessionFactory()
│   ├── registry.ts              ← getBrowser({ storage, sessionFactory }) singleton
│   ├── oauth.ts                 ← issuer discovery, PKCE / device grants, refresh, revoke
│   ├── connect.ts               ← what a completed sign-in learns about the KB
│   ├── storage.ts               ← pure helpers + adapter-fed loaders
│   ├── errors.ts                ← SemiontSessionError
│   ├── knowledge-base.ts        ← KnowledgeBase, KbSessionStatus types
│   └── open-resource.ts         ← OpenResource type
└── state/                       ← state-unit factories; take `client`, not a bus
    ├── flows/                   ← beckon, gather, mark, match, yield
    └── lib/                     ← createDisposer, search pipeline

@semiont/react-ui
├── session/
│   ├── SemiontProvider.tsx      ← React context provider + useSemiont hook
│   └── web-browser-storage.ts   ← WebBrowserStorage (localStorage + storage event)
└── state/
    └── shell-state-unit.ts      ← ShellStateUnit (toolbar panel state)
```

No session logic lives in `@semiont/react-ui`. Its session surface is
`SemiontProvider` / `useSemiont` (context) and `WebBrowserStorage` (the
browser-backed `SessionStorage` implementation).

## Core classes

### `SemiontClient`

Owns its transport (`client.transport` — for HTTP, an `HttpTransport` over
`ky` with one SSE connection) and its `EventBus` (`client.bus`, read-only).
Workspace-scoped: one client per connected KB.

Bus surface:

```ts
import type { Observable } from 'rxjs';

// emit returns how many subscribers the payload reached
const reached: number = client.bus.emit('beckon:hover', { annotationId });
const hovers: Observable<EventMap['beckon:hover']> = client.bus.on('beckon:hover');
```

Typed namespace methods are the way to say something on the bus —
`client.browse.click(id)`,
`client.mark.submit(input)`, `client.beckon.hover(id)` — and StateUnit
factories take `client` and listen through `client.bus.on(...)`.

### `SemiontSession`

Per-KB lifetime object. Owns:

- `client: SemiontClient` — public `readonly`; components say things through
  its typed namespace methods and listen with `session.subscribe(channel,
  handler)`, which returns its own unsubscribe.
- `token$`, `user$` — observable auth state.
- `errors$` — the transport's errors, republished.
- `refresh()` — token refresh entrypoint.

Modal state sits beside the session in its `SessionSignals`
(`browser.activeSignals$`): `sessionEnded$`, `permissionDenied$` and
`kbIdentityConflict$`, each null until raised. A session-ended notice carries
why it ended (`reason`: `expired` or `refused`); a permission notice carries
the refusal's message (`detail`). Neither carries a sentence: the modals write
what a person reads.

The session is **not** a bus wrapper. It does not forward `emit`/`on` —
that surface is on the client directly. Components hold the session, read
`.client`, and call through.

### `SemiontBrowser`

App-level singleton. Owns:

- `kbs$` — configured KB list
- `activeKbId$`, `activeSession$`, `activeSignals$` — active selection,
  its session, and that session's `SessionSignals`
- `sessionActivating$` — true while a session is actively being
  constructed (`setActiveKb`/`signIn` in flight, awaiting
  `session.ready`). Layouts that show a loading spinner while the
  session is under construction must gate on this; otherwise they
  sit on the spinner forever after every `signOut`, which
  intentionally leaves `activeKbId` set with `session` null.
- `openResources$` — open-resource list (tab bar). Per-KB: a projection of
  the active, **connected** KB's tabs, empty while nothing is connected.
- `lastViewedResource$` — the active, connected KB's last-viewed resource id,
  for a landing route to resume from (`setLastViewedResource(id)` records it).
  Per-KB for the same reason as the tabs: one KB's resource id means nothing
  to another, so a global record sends the resume straight into a 404.
- `identityToken$` — optional app-level identity bridge: a slot the host populates (via `setIdentityToken()`) with an external OAuth identity token, for environments that bridge one in
- `error$` — session-level error stream
- CRUD methods: `addKb`, `removeKb`, `setActiveKb`, `signIn`, `signOut`,
  `addOpenResource`, etc.
- `getKbSessionStatus(kbId)` — synchronous status check for KB-list UI
- **App-scoped bus surface**: `emit`/`on`/`stream` — see [Two buses](#two-buses).

All persistence goes through a `SessionStorage` adapter provided at
construction. The classes never touch `localStorage` or `window` directly.

## Two buses

There are **two independent `EventBus` instances** in the app, each
with a distinct scope and lifetime:

| Bus | Owner | Lifetime | Channels |
|---|---|---|---|
| Session bus | `SemiontClient` (`client.bus`, read-only) | Per-KB session (reborn every `signIn` / `setActiveKb`) | KB-content traffic: `browse:*` (reads), `mark:*`, `beckon:*`, `gather:*`, `match:*`, `bind:*`, `yield:*`, `job:*` |
| Shell bus | `SemiontBrowser` (private) | App lifetime (survives sign-out / KB swap) | UI shell traffic: `panel:*`, `shell:*`, `tabs:*`, `nav:*`, `settings:*` |

The browser exposes its bus as `emit` / `on` / `stream`; the client exposes
`client.bus` (`emit` / `on`), and components listen on it through
`session.subscribe(channel, handler)`. The split
exists because the shell bus must keep working when there is no
active session: panels can toggle, sidebar can collapse, tabs can
close, and the settings panel is reachable, even on a signed-out KB
or with zero KBs configured.

**Routing rule:** every channel lives on exactly one bus. Emitting
to the wrong bus is a silent no-op — subscribers on the other bus
never see it. `EventMap` is the single source of truth for which
channel belongs where; if you can't tell from the name, check
`packages/core/src/bus-protocol.ts`.

Components pick based on the channel scope:

```tsx
const semiont = useSemiont();                       // browser (shell bus)
const session = useObservable(semiont.activeSession$);

// Shell event — works regardless of session.
semiont.emit('panel:toggle', { panel: 'settings' });

// KB-content event — requires an active session.
session?.client.mark.request(resourceId, { type: 'TextPositionSelector', start: 0, end: 12 }, 'highlighting');
```

The `useEventSubscription(channel, handler)` hook hides this: it
subscribes on **both** buses for the given channel, so callers don't
have to know which one carries it. The correct bus fires; the other
stays silent.

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

- `InMemorySessionStorage` (in `@semiont/sdk`) — for tests / in-memory.
- `WebBrowserStorage` (in `@semiont/react-ui`) — wraps `localStorage` and
  the `window` `storage` event for cross-tab sync.

## React surface

### `<SemiontProvider>` + `useSemiont()`

```tsx
import { SemiontProvider } from '@semiont/react-ui';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SemiontProvider>
      {children}
    </SemiontProvider>
  );
}
```

`SemiontProvider` defaults to the canonical web setup,
`getBrowser({ storage: new WebBrowserStorage(), sessionFactory: createHttpSessionFactory() })`;
its `storage` and `sessionFactory` props override either half. Tests inject a
whole browser — a real `SemiontBrowser` over the SDK's in-memory doubles:

```tsx
import { createTestSession, stubGateway } from '@semiont/sdk/testing';

const { session, storage } = createTestSession({ gateway: stubGateway() });
const testBrowser = new SemiontBrowser({ storage, sessionFactory: () => session });

<SemiontProvider browser={testBrowser}>{children}</SemiontProvider>;
```

Inside components:

```tsx
import { useSemiont, useObservable } from '@semiont/react-ui';

function MyComponent() {
  const browser = useSemiont();
  const session = useObservable(browser.activeSession$);
  const user = useObservable(session?.user$);

  if (!user) return <p>Not signed in</p>;
  return <div>Hello, {user.name}</div>;
}
```

### Event emission & subscription

Components say things through the client's typed namespace methods:

```tsx
function MarkButton({ annotationId }: { annotationId: AnnotationId }) {
  const session = useObservable(useSemiont().activeSession$);
  return (
    <button onClick={() => session?.client.browse.click(annotationId)}>
      Click me
    </button>
  );
}
```

Components subscribe via `useEventSubscription` — a hook that handles
stale-closure + cleanup correctly:

```tsx
import { useEventSubscription } from '@semiont/react-ui';

declare function triggerSparkleAnimation(id: AnnotationId): void; // the host's own

function AnnotationReactor() {
  useEventSubscription('mark:create-ok', ({ response }) => {
    triggerSparkleAnimation(response.annotationId);
  });
  return null;
}
```

Internally `useEventSubscription` subscribes on **both** the browser's
shell bus and the session client's bus, so a caller doesn't need to
know which bus carries the channel. Exactly one of the two subscriptions
receives payloads; the other stays silent. If the active session swaps
(KB switch, sign-out/sign-in) the hook rewires automatically.

### StateUnit hooks

Every state-unit factory takes exactly one bus-owner, matching the bus its
channels live on:

- **Session-scoped state units** (mark, beckon, gather, match, yield) take
  `client: SemiontClient` and route through `client.bus.emit` /
  `client.bus.on`. Their lifetime is tied to the session
  (`useSessionStateUnit`).
- **Shell-scoped state units** (`ShellStateUnit` — toolbar panel state) take
  `browser: SemiontBrowser` and route through
  `browser.emit` / `browser.stream`. Their lifetime is tied to the app.

Why the split matters: `ShellStateUnit` must function on unauth pages
(signed out, no active session). If it were wired to the client bus,
toolbar panel state would fail whenever no session existed.

```tsx
// localStorage-backed, beside the hook
declare function readPanel(): ToolbarPanelType | null;
declare function persistPanel(panel: ToolbarPanelType | null): void;

export function useShellStateUnit(): ShellStateUnit {
  const semiont = useSemiont();
  return useStateUnit(() => createShellStateUnit(semiont, {
    initialPanel: readPanel(),
    onPanelChange: persistPanel,
  }));
}
```

State-unit factories never construct an `EventBus`: they reach the bus
through the client or browser they are given.

### `useKBDiscovery` — launcher-published KBs

The Semiont launcher publishes an export view of every KB it manages
(local stacks and codespace forwards) as a `DiscoveryDocument`, which the
Browser image serves at `DISCOVERY_URL_PATH` (`@semiont/core`). The sdk
owns every consumer-side semantic — validation via the core type guards,
the `version` compatibility gate, the **typed absent-vs-managed
distinction** (`absent` = "no launcher detected"; `managed` with an empty
list = "the launcher is here and manages nothing"), ETag/304 polling, and
diffing keyed `did ?? host:port` (`httpDiscovery` / `textDiscovery` /
`subscribeDiscovery`).

`useKBDiscovery` is the React binding, and it is deliberately thin — it
owns lifecycle, nothing else:

```tsx
import { useKBDiscovery } from '@semiont/react-ui';

const { state, kbs } = useKBDiscovery();          // same-origin httpDiscovery()
// state: DiscoveryState | null (null before the first poll)
// kbs:   DiscoveredKB[] — the managed list, [] otherwise
```

- Polls only while `enabled` (default `true` — pass `false` when the
  consuming surface is closed) **and** the document is visible; pause and
  resume reuse one transport, so `httpDiscovery`'s remembered ETag turns
  the resume poll into a 304.
- Options: `enabled?`, `intervalMs?` (sdk default applies), `transport?`
  (tests and non-default URLs; the injection seam is the test seam).
- **No merge policy** — react-ui owns no KB registry. What a discovered KB
  *means* next to a registered one (adoption, removal rendering, health)
  is the consuming app's policy; discovery yields descriptors and auth
  stays per-KB, user-driven (the sdk never creates sessions from them).

## Invariants

1. **One client per KB.** The session owns it; the browser owns the
   session; `setActiveKb` is the only path to swap.
2. **Session classes are environment-agnostic.** No `window` or
   `localStorage` references. Storage goes through `SessionStorage`.
3. **The browser's bus is private; the client's is read-only.** Shell
   traffic goes through `browser.emit` / `.on` / `.stream`; session
   traffic through the client's typed namespace methods, `client.bus`,
   or `session.subscribe`.
4. **State-unit factories never construct an `EventBus`.** They take the
   client or browser that owns one.
5. **Every channel belongs to exactly one bus.** `EventMap` in
   `@semiont/core/bus-protocol.ts` is the source of truth. Don't
   split a channel across buses; don't emit to both.
6. **`sessionActivating$` is the only valid loading indicator.** UIs
   that want to show a spinner while the session is under
   construction must AND-gate on `sessionActivating$`; otherwise
   they get stuck spinning after `signOut`.
7. **React layer is provider + hook only.** All session types live in
   `@semiont/sdk`; the React package's session surface is `SemiontProvider`,
   `useSemiont`, and `WebBrowserStorage`.

## Non-React consumers

Because session/browser live in `@semiont/sdk`, CLI and MCP can use them
directly:

```ts
import { SemiontBrowser, InMemorySessionStorage, createHttpSessionFactory } from '@semiont/sdk';

const browser = new SemiontBrowser({
  storage: new InMemorySessionStorage(),
  sessionFactory: createHttpSessionFactory(),
});
```

They say things through the client's typed namespace methods — no bus
wiring required.

## Testing

Tests use `InMemorySessionStorage` (or a simple subclass adding
`subscribe()` for cross-context sync simulation) to drive session state
without depending on jsdom's `localStorage`. See
`packages/sdk/src/session/__tests__/test-storage-helpers.ts` for
the test harness pattern.

StateUnit factory tests drive a real `SemiontClient` from `createTestClient()`
(`@semiont/sdk/testing`) — real caches, real `busRequest`, real namespaces
over a scriptable `FaultyTransport`:

```ts
import { createTestClient } from '@semiont/sdk/testing';

const { client, transport } = createTestClient();
const unit = createMarkStateUnit(client, resourceId);
client.mark.request(resourceId, { type: 'TextQuoteSelector', exact: 'hello' }, 'highlighting');
// assert on unit.pendingAnnotation$; script gateway replies with transport.queueReply(...)
unit.dispose();
client.dispose(); // in afterEach
```
