# Event internals

How to use the event buses from a React app is in the builder docs:
[EVENTS.md](../../../docs/builder/react-ui/EVENTS.md). This page holds what
only someone working on react-ui itself needs.

## The wire log in e2e tests

**Enable in e2e tests:** automatic via the `bus` fixture — see
[tests/e2e/docs/bus-logging.md](../../../tests/e2e/docs/bus-logging.md).

Today's wire log covers the Browser-to-gateway edge. An equivalent
instrumentation on the gateway's own bus — gated behind the same
flag — would extend a single trace from Browser EMIT through
gateway SSE-write to Browser RECV, eliminating the blind spot
where an event reaches `/bus/emit` but never produces a response
(the shape of bug the SSE parser regression would have been
detectable in seconds rather than hours, had it existed).

## Gotchas in the implementation

- **Large SSE payloads can span multiple reader chunks.** The
  parser in `ActorStateUnit` holds event-assembly state across
  `reader.read()` calls. Any replacement parser must do the same,
  or events larger than the first TCP segment silently disappear.
  Regression test: `actor-state-unit.test.ts` → "reassembles an event whose
  bytes span multiple reader.read() chunks".
- **URL-match assertions pass immediately if the URL already
  matches.** In e2e, `toHaveURL(/know/)` doesn't wait for sign-in
  to complete when the page is already on a `/know/` route post-
  sign-out. Wait for a real state change instead (password form
  hides, session status text changes, etc.).

## Channels that never leave the page

Some channels are published on a client's own bus and never cross the wire. The
protocol's flow docs say which channels cross ([Browse](../../../docs/protocol/flows/BROWSE.md),
[Beckon](../../../docs/protocol/flows/BECKON.md)); this section is the other half.

### The rule: `browse:*` may cross, `nav:*` never does

`browse:*` carries domain intent (*open resource R*) and may cross a transport.
`nav:*` carries framework routing (*push path P*) and never does.

`ResourceViewerPage` is where the two meet: it subscribes to
`browse:resource-open`, calls `routes.resourceDetail(resourceId)`, and emits
`nav:push` with the result. Bridging `nav:push` instead would put host route
paths and locale prefixes on the wire, and force every remote caller (the
launcher, an agent) to know the Browser's route shapes.

### Host routing (`nav:*`)

react-ui emits; the Browser's `NavigationHandler` performs.

| Channel | Payload | Meaning |
|---|---|---|
| `nav:push` | `{ path, reason? }` | Navigate to a route in the app |
| `nav:external` | `{ url, resourceId?, cancelFallback }` | Navigate to an external URL |
| `nav:link-clicked` | `{ href, label? }` | A tracked link was clicked |

- **`nav:push`** is emitted by `useObservableRouter` (a wrapper around whatever
  router the host supplies), by `ResourceViewerPage` for clone, reference-link
  and entity-type-filter navigation, and by `KnowledgeBasePanel` on a
  knowledge-base switch. `reason` labels the cause: `'clone'`,
  `'reference-link'`, `'entity-type-filter'`, `'kb-switch'`.
- **`nav:external`** is emitted by `useObservableExternalNavigation`. Its
  `cancelFallback` is a live function: a subscriber that handles the navigation
  calls it to prevent the default redirect. A function cannot cross a
  transport, which is a second reason this channel stays local.
- **`nav:link-clicked`** is emitted by `ObservableLink`. Nothing subscribes to it.

react-ui emits intent rather than calling a router because it is a component
library with no router of its own: the host subscribes and translates.

### One more local signal, and one that crosses

**`browse:entity-type-clicked`** `{ entityType }` stays in the page. It is
consumed by `ResourceViewerPage`, which applies the filter by emitting
`nav:push`. Nothing in the repository emits it.

**`browse:resource-viewed`** crosses the wire. It is emitted on the viewer's
load-complete transition by `useResourceViewedReport`, gated on the same
condition as the accessibility load announcement, so "viewed" means the content
reached the screen.

### Panel and sidebar state

Panel state is not an event flow. It is held by `ShellStateUnit` and consumed
through `useShellStateUnit`:

- `activePanel$` tracks which panel is open, or `null`.
- `useShellStateUnit` persists it to `localStorage` under `activeToolbarPanel`
  and restores it as the unit's `initialPanel` on load.
- `COMMON_PANELS` (`knowledge-base`, `user`, `settings`) are available on every
  page. `RESOURCE_PANELS` (`history`, `info`, `annotations`, `collaboration`,
  `jsonld`) are available on resource viewer pages only.

How clicks and hovers on annotations coordinate the panels and the document
view is in [ANNOTATION-CLICK.md](ANNOTATION-CLICK.md).
