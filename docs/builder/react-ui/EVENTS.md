# Event-Driven Architecture

Guide to the event buses in `@semiont/react-ui` — how they're scoped,
how to emit and subscribe, and how to debug wire-level problems.

For the underlying class model (`SemiontBrowser`, `SemiontClient`,
`SemiontSession`) see [SESSION.md](SESSION.md). For the canonical
channel list, see `packages/core/src/bus-protocol.ts` —
`EventMap` is the single source of truth.

What only someone working on react-ui itself needs, the wire log in e2e tests
and two gotchas in the implementation, is in the package's
[EVENTS.md](../../../packages/react-ui/docs/EVENTS.md).

## Two buses

The app has **two independent `EventBus` instances**:

| Bus | Owner | Lifetime | Channels |
|---|---|---|---|
| **Session bus** | `SemiontClient` (`client.bus`) | One per KB session — reborn on every `signIn` / `setActiveKb` | KB-content traffic: `browse:*`, `mark:*`, `beckon:*`, `gather:*`, `match:*`, `bind:*`, `yield:*`, `job:*` |
| **Shell bus** | `SemiontBrowser` (private) | App lifetime — survives sign-out, KB swap, and zero-KB state | UI shell traffic: `panel:*`, `shell:*`, `tabs:*`, `nav:*`, `settings:*` |

The split exists because the shell must keep working when there is
no active session: sidebar toggles, panel switches, tab reorders,
settings changes, and in-app nav clicks all fire with or without a
signed-in user.

The shell bus is reached through `SemiontBrowser`'s `.emit(channel, payload)`,
`.on(channel, handler)` and `.stream(channel)`; its `EventBus` is private.
The session bus is reached through the client's typed namespace methods,
with `session.subscribe(channel, handler)` as the one generic
subscription. Every channel lives on exactly **one** bus; emitting to
the wrong bus is a silent no-op.

## Subscribing

Use `useEventSubscription` — one channel at a time:

```tsx
import { useEventSubscription, useResourceAnnotations } from '@semiont/react-ui';

function AnnotationReactor() {
  const { triggerSparkleAnimation } = useResourceAnnotations();
  useEventSubscription('mark:added', (stored) => {
    triggerSparkleAnimation(stored.payload.annotation.id);
  });
  return null;
}
```

Or `useEventSubscriptions` for multiple channels in one hook:

```tsx
useEventSubscriptions({
  'mark:added': (stored) => { /* stored.payload.annotation */ },
  'mark:create-error': ({ resourceId, message }) => { /* ... */ },
});
```

**Internally, these hooks subscribe on both buses.** The caller
doesn't need to know which bus carries the channel — the correct
one fires, the other stays silent. When the active session swaps
(KB switch, sign-out/sign-in), the hook rewires automatically.

## Emitting

Pick the bus that owns the channel:

```tsx
function Toolbar() {
  const semiont = useSemiont();

  // Shell channel — works regardless of session.
  return (
    <button onClick={() => semiont.emit('panel:toggle', { panel: 'settings' })}>
      Settings
    </button>
  );
}

function MarkButton({ resourceId, selector }: {
  resourceId: ResourceId;
  selector: EventMap['mark:requested']['selector'];
}) {
  const session = useObservable(useSemiont().activeSession$);
  if (!session) return null;

  // Session channel — requires an active session. A typed namespace method
  // says it; nothing here names the channel.
  return (
    <button onClick={() => session.client.mark.request(resourceId, selector, 'highlighting')}>
      Annotate
    </button>
  );
}
```

If you can't tell which bus to target from the channel name, look
it up in `packages/core/src/bus-protocol.ts`. Don't guess — a
mis-routed emit silently vanishes and the bug shows up as "the UI
stopped reacting" with no error in the console.

## Channel conventions

Prefixes encode scope + direction:

| Prefix | Bus | Scope | Typical shape |
|---|---|---|---|
| `browse:` | session | KB reads (resources, annotations, entity types) | `*-requested` / `*-result` / `*-failed` request-response pairs, correlated by `correlationId` |
| `mark:` | session | Annotation lifecycle commands + broadcasts | `*-request` (intent), `*-ok`/`*-failed` (response), persisted events (`mark:added` etc.) |
| `beckon:` | session | Hover-driven focus / sparkle animations | Fire-and-forget on `beckon:hover`, state unit reacts with `beckon:sparkle` |
| `gather:` | session | Context assembly (embedding + graph neighborhood) | Long-running; progress events + `*-complete` / `*-failed` |
| `match:` | session | Search / matching flows | Request + paginated results |
| `bind:` | session | Reference resolution wizard | Initiate, search, update-body |
| `yield:` | session | Resource generation / cloning | Commands + progress + persisted events |
| `job:` | session | Background-worker jobs | Create, status, result |
| `panel:` | shell | Toolbar panel open/close/toggle | UI-only |
| `shell:` | shell | Sidebar collapse, app-level shell state | UI-only |
| `tabs:` | shell | Open-resource tab close / reorder | UI-only (persistence via storage) |
| `nav:` | shell | In-app link clicks, router push, external-nav | UI-only |
| `settings:` | shell | Line-numbers, theme, locale, hover-delay changes | UI-only |

## Request-response via correlationId

A session channel that expects a reply is a **bus operation**: a request channel paired with a
result channel and a failure channel (`browse:resource-requested` → `browse:resource-result` /
`browse:resource-failed`). The reply is matched to its request by `correlationId`, which rides
the frame's **envelope**, not the payload.

Nothing in a component writes that loop. `busRequest(transport, operation, payload)` in
`@semiont/core` (`packages/core/src/bus-request.ts`) sends the request, waits for the frame
carrying its `correlationId`, and resolves with the reply or rejects with a `BusRequestError`.
The SDK's namespace methods call it:

```ts
const { annotationId } = await client.mark.annotation({         // mark:create-request → its reply
  motivation: 'highlighting',
  target: { source: resourceId, selector: { type: 'TextQuoteSelector', exact: 'quoted text' } },
});
await client.mark.delete(resourceId, annotationId);              // rejects if it failed
```

The wire format is still what every protocol-level assertion keys on.

## Wire-level observability

Both sides of the SSE boundary have a runtime-toggleable logger.
Set a flag, get a grep-friendly line for every event that crosses
the wire:

```
[bus EMIT] <channel> [scope=X] [cid=<first8>] <payload>
[bus RECV] <channel> [scope=X] [cid=<first8>] <payload>
```

**Enable in a browser:**

```js
window.__SEMIONT_BUS_LOG__ = true
```

Clears on refresh. Zero-cost when off (one truthy check per emit).

**Why this matters.** Protocol assertions are strictly stronger
than UI assertions. "The highlight appeared" passes even if the
UI ended up right via a stale cache or a backfilled refetch.
"`mark:create-request` went out, `mark:create-ok` came back with
matching correlationId" fails the moment the wire protocol
regresses, even if the UI eventually converges.

## Common patterns

### State machines driven by events

Most VMs in `packages/sdk/src/state/flows/` follow the
same shape: listen for `*-requested`/`*-ok`/`*-failed` triples on
the session client, project the state machine into BehaviorSubjects,
and expose them as `vm.state$`. Components read via
`useObservable(vm.state$)` and say user intents back through the
client's typed namespace methods (`client.mark.submit(...)`,
`client.browse.click(...)`). No shared mutable state; correlationIds
thread request and response.

### Cache freshness on broadcast

Persisted domain events (`mark:added`, `mark:removed`,
`yield:created`, ...) are broadcast to everyone viewing the
resource. There is no manual cache invalidation: the SDK's
read-through cache is updated by the bus itself, so the live
queries (`client.browse.*(rId)`) re-emit and any
`useObservable(...)` subscriber re-renders with fresh data.

```tsx
// No manual query-client invalidation — just observe the live query.
const state = useObservable(client.browse.annotations(rId)); // CacheState<Annotation[]>
const annotations = state && readyValue(state); // readyValue from @semiont/sdk
```

The bridge between gateway-broadcast events and resource-scoped
subscriptions is implicit: subscribing to a `browse.*(rId)` live
query acquires the resource's SSE scope (freshness follows
observation), and the last unsubscribe releases it. The client
exposes no explicit channel-extension call; SSE scope is acquired
purely by observing the live queries.

## Gotchas

- **Wrong-bus emit is silent.** If `panel:toggle` were emitted on
  the session client instead of the browser shell, the toolbar
  wouldn't react and nothing would log an error. When a UI
  "doesn't respond," first check which bus you emitted on.
- **Session swap invalidates any direct handler.** If you stashed
  a `.on(...)` callback's unsubscribe into a ref or module-level
  variable, and then `signIn`/`setActiveKb` constructed a new
  client, the old unsubscribe does nothing and the handler stops
  firing. Prefer `useEventSubscription` — it re-subscribes
  on session swap.
