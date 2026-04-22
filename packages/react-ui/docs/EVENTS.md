# Event-Driven Architecture

Guide to the event buses in `@semiont/react-ui` — how they're scoped,
how to emit and subscribe, and how to debug wire-level problems.

For the underlying class model (`SemiontBrowser`, `SemiontApiClient`,
`SemiontSession`) see [SESSION.md](SESSION.md). For the canonical
channel list, see `packages/core/src/bus-protocol.ts` —
`EventMap` is the single source of truth.

## Two buses

The app has **two independent `EventBus` instances**:

| Bus | Owner | Lifetime | Channels |
|---|---|---|---|
| **Session bus** | `SemiontApiClient` (private) | One per KB session — reborn on every `signIn` / `setActiveKb` | KB-content traffic: `browse:*`, `mark:*`, `beckon:*`, `gather:*`, `match:*`, `bind:*`, `yield:*`, `job:*` |
| **Shell bus** | `SemiontBrowser` (private) | App lifetime — survives sign-out, KB swap, and zero-KB state | UI shell traffic: `panel:*`, `shell:*`, `tabs:*`, `nav:*`, `settings:*` |

The split exists because the shell must keep working when there is
no active session: sidebar toggles, panel switches, tab reorders,
settings changes, and in-app nav clicks all fire with or without a
signed-in user.

Both buses expose the same surface — `.emit(channel, payload)`,
`.on(channel, handler)`, `.stream(channel)`. Neither exposes the
raw `EventBus` (both fields are private). Every channel lives on
exactly **one** bus; emitting to the wrong bus is a silent no-op.

## Subscribing

Use `useEventSubscription` — one channel at a time:

```tsx
import { useEventSubscription } from '@semiont/react-ui';

function AnnotationReactor() {
  useEventSubscription('mark:create-ok', ({ annotationId }) => {
    triggerSparkleAnimation(annotationId);
  });
  return null;
}
```

Or `useEventSubscriptions` for multiple channels in one hook:

```tsx
useEventSubscriptions({
  'mark:create-ok': ({ annotationId }) => { ... },
  'mark:create-failed': ({ error }) => { ... },
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

function MarkButton({ selection }) {
  const session = useObservable(useSemiont().activeSession$);
  if (!session) return null;

  // Session channel — requires an active session.
  return (
    <button onClick={() => session.client.emit('mark:create-request', selection)}>
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
| `beckon:` | session | Hover-driven focus / sparkle animations | Fire-and-forget on `beckon:hover`, VM reacts with `beckon:sparkle` |
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

Session channels that expect a reply follow a consistent pattern:

```ts
// Client side
const cid = crypto.randomUUID();
client.emit('browse:resource-requested', { correlationId: cid, resourceId });
client.on('browse:resource-result', ({ correlationId, response }) => {
  if (correlationId === cid) { /* handle response */ }
});
client.on('browse:resource-failed', ({ correlationId, message }) => {
  if (correlationId === cid) { /* handle failure */ }
});
```

The backend Browser actor subscribes to `*-requested`, handles the
request, and fires either `*-result` or `*-failed` on the same bus
with the same `correlationId`. The SSE subscription delivers it
back to the client.

Callers rarely write this loop by hand — `busRequest(client, ...)`
in `@semiont/api-client` wraps it with a Promise. But the wire
format is what every protocol-level assertion keys on.

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

**Enable in e2e tests:** automatic via the `bus` fixture — see
[tests/e2e/docs/bus-logging.md](../../../tests/e2e/docs/bus-logging.md).

**Why this matters.** Protocol assertions are strictly stronger
than UI assertions. "The highlight appeared" passes even if the
UI ended up right via a stale cache or a backfilled refetch.
"`mark:create-request` went out, `mark:create-ok` came back with
matching correlationId" fails the moment the wire protocol
regresses, even if the UI eventually converges.

Today's wire log covers the frontend-to-backend edge. An equivalent
instrumentation on the backend's own bus — gated behind the same
flag — would extend a single trace from frontend EMIT through
backend SSE-write to frontend RECV, eliminating the blind spot
where an event reaches `/bus/emit` but never produces a response
(the shape of bug the SSE parser regression would have been
detectable in seconds rather than hours, had it existed).

## Common patterns

### State machines driven by events

Most VMs in `packages/api-client/src/view-models/flows/` follow the
same shape: listen for `*-requested`/`*-ok`/`*-failed` triples on
the session client, project the state machine into BehaviorSubjects,
and expose them as `vm.state$`. Components read via
`useObservable(vm.state$)` and emit user intents back through
`client.emit(...)`. No shared mutable state; correlationIds thread
request and response.

### Cache invalidation on broadcast

Persisted domain events (`mark:added`, `mark:removed`,
`yield:created`, ...) are broadcast to everyone viewing the
resource. Subscribers typically invalidate the relevant React Query
keys — the next render refetches.

```tsx
const queryClient = useQueryClient();
useEventSubscription('mark:added', () => {
  queryClient.invalidateQueries({ queryKey: ['annotations', rId] });
});
```

The bridge between backend-broadcast events and resource-scoped
subscriptions lives in `ResourceViewerPage` via
`client.addChannels(..., rId)` — it extends the SSE subscription
to include scoped channels for the open resource.

## Gotchas learned the hard way

- **Wrong-bus emit is silent.** If `panel:toggle` were emitted on
  the session client instead of the browser shell, the toolbar
  wouldn't react and nothing would log an error. When a UI
  "doesn't respond," first check which bus you emitted on.
- **Session swap invalidates any direct handler.** If you stashed
  a `.on(...)` callback's unsubscribe into a ref or module-level
  variable, and then `signIn`/`setActiveKb` constructed a new
  client, the old unsubscribe does nothing and the handler no
  longer fires. Prefer `useEventSubscription` — it re-subscribes
  on session swap.
- **Large SSE payloads can span multiple reader chunks.** The
  parser in `ActorVM` holds event-assembly state across
  `reader.read()` calls. Any replacement parser must do the same,
  or events larger than the first TCP segment silently disappear.
  Regression test: `actor-vm.test.ts` → "reassembles an event whose
  bytes span multiple reader.read() chunks".
- **URL-match assertions pass immediately if the URL already
  matches.** In e2e, `toHaveURL(/know/)` doesn't wait for sign-in
  to complete when the page is already on a `/know/` route post-
  sign-out. Wait for a real state change instead (password form
  hides, session status text changes, etc.).
