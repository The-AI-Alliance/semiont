# Bus logging

Protocol-level visibility into every bus and content event that crosses
a transport boundary, in either direction. Each event is logged as a
single line in a grep-friendly format, the same in every process:

```
[bus EMIT] <channel> scope=<resource> cid=<first8> trace=<first8> <payload>
[bus RECV] <channel> scope=<resource> cid=<first8> trace=<first8> <payload>
[bus SSE] <channel> scope=<resource> cid=<first8> trace=<first8> <payload>
[bus PUT] content trace=<first8> <payload>
[bus GET] content trace=<first8> <payload>
```

`scope=`, `cid=` and `trace=` are each written only where there is one:
a frame that is about no resource has no `scope=`, and one that answers
no request has no `cid=`.

The `trace=` suffix is present only when an OTel SDK is initialized in
the process and a span is active when the line is emitted (Tier 2, the
traces of [Observability](../../../docs/operator/administration/OBSERVABILITY.md)). It's the
first 8 hex of the W3C trace-id, so it correlates the grep timeline
with the span tree in any APM UI.

No line holds a credential. Every bus log writes the value of a member
whose whole name is one a credential goes by (`token`, `password`,
`apiKey` and the rest of a short list) as `[withheld]`, wherever in a
payload the member is; everything else of a payload is written as it is.
The list and the rule are one table,
[`specs/src/bus/log-cases.json`](../../../specs/src/bus/log-cases.json),
which every bus log runs.

Cost when disabled: a single truthy check, zero allocations.

This is **Tier 1 of the three-tier observability stack** —
correlation-ID discipline at the transport contract layer. Tier 2
(OpenTelemetry spans) and Tier 3 (metrics + log correlation) reuse the
same choke points;
[`@semiont/observability`](../../../packages/typescript/observability/README.md)
lists the three.

## Choke points

Instrumentation lives at `ITransport` and `IContentTransport` — the
transport contract layer — not at any single implementation. Every
event flows through one of these.

| Op     | Site                                                         |
|--------|--------------------------------------------------------------|
| `EMIT` | `HttpTransport.emit()` (http-transport)                          |
| `RECV` | HttpTransport's wire-parse (SSE-side fan-in inside actor-state-unit) |
| `EMIT` | Gateway `/bus/emit` HTTP route                               |
| `SSE`  | Gateway `Connection::deliver` in `images/gateway/src/routes/stream.rs`|
| `PUT`  | `HttpContentTransport.putBinary()`                           |
| `GET`  | `HttpContentTransport.getBinary()` / `getBinaryStream()` + matching gateway route |

`ActorStateUnit` and namespace methods (`client.mark.delegate`, etc.) are
**not** choke points. Namespace methods ride on top of the transport;
their traffic shows up as the transport calls they make.

The table names the TypeScript transport's sites. The Rust and Python
transports log at the same points, in the same form.

## Enable

### Browser

Run-time toggle in DevTools or e2e init script:

```js
window.__SEMIONT_BUS_LOG__ = true;
```

Clears on refresh.

### Processes (gateway, worker, smelter, MCP, tests)

Process-env toggle, set to any value that is not empty and read once (in
Node at module load, in Rust and Python when the first line would be
written):

```bash
SEMIONT_BUS_LOG=1 <command>
```

Where the lines go depends on what the process is written in. A Node
process writes them with `console.debug`, to stdout. A Rust process (the
gateway, and a client of the Rust SDK) writes them to stderr. A Python
process (the Worker, and any client of the Python SDK) writes them to
stdout.

The gateway runs in a container, so the variable has to reach the
container — and the launcher passes a container only the variables its
config references, so `SEMIONT_BUS_LOG=1 semiont start` does not. The
launcher has no option to set it.

## A typical full-trace timeline

With both flags on, opening a resource produces a contiguous timeline:

```
[browser] [bus EMIT] browse:resource-requested cid=a89a670a {resourceId, ...}
[gateway]  [bus EMIT] browse:resource-requested cid=a89a670a {resourceId, _userId, ...}
[gateway]  [bus SSE]  browse:resource-result    cid=a89a670a {response}
[browser] [bus RECV] browse:resource-result    cid=a89a670a {response}
```

A worker generation that uploads new content adds a content line; the
gateway writes none for an upload:

```
[worker]  [bus PUT]  content {name, format, storageUri, sizeBytes}
```

Failure modes — each obvious from a missing line:

| Missing line   | Diagnosis                                                          |
|----------------|--------------------------------------------------------------------|
| Gateway `EMIT` | Client never reached the server (auth, CORS, network).             |
| Gateway `SSE`  | The answering service never emitted a result, or no stream was subscribed to it. |
| Browser `RECV`| Gateway wrote to the SSE stream but bytes never parsed client-side.|

## E2E capture API

Automatic. The `bus` fixture in
[`fixtures/auth.ts`](../fixtures/auth.ts) flips the flag via
`page.addInitScript` before the page loads, and collects matching
`console.debug` lines into a structured capture.

```ts
import { test, expect } from '../fixtures/auth';

test('...', async ({ signedInPage: page, bus }) => {
  bus.clear();  // drop earlier traffic if you want to scope assertions
  await page.getByRole('button', { name: /open/i }).click();

  // Wait for a request/response pair with matching correlationId:
  await bus.expectRequestResponse('browse:resource-requested', 'browse:resource-result');

  // Or target individual events:
  await bus.waitForEmit('mark:create-request');
  await bus.waitForRecv('mark:create-ok', { cid: '...' });

  // Or inspect the full log after the fact:
  const emits = bus.emits('browse:resource-requested');
  expect(new Set(emits.map(e => e.cid)).size).toBeGreaterThanOrEqual(2);
});
```

| Method                                              | Purpose                                                                 |
|-----------------------------------------------------|-------------------------------------------------------------------------|
| `bus.entries`                                       | Raw array of all captured entries (in order).                           |
| `bus.emits(channel)`                                | Filter to `EMIT` on one channel.                                        |
| `bus.receives(channel)`                             | Filter to `RECV` on one channel.                                        |
| `bus.sses(channel)`                                 | Filter to `SSE` on one channel (server-side write).                     |
| `bus.contentPuts()`                                 | Filter to `PUT` on the synthetic `content` channel.                     |
| `bus.contentGets()`                                 | Filter to `GET` on the synthetic `content` channel.                     |
| `bus.byOp(op, channel?)`                            | Generic op + optional channel filter.                                   |
| `bus.waitForEmit(channel, { cid?, timeout? })`      | Resolve when an `EMIT` is seen, with optional cid match.                |
| `bus.waitForRecv(channel, { cid?, timeout? })`      | Resolve when a `RECV` is seen, with optional cid match.                 |
| `bus.waitForPut({ timeout? })`                      | Resolve when a content `PUT` is seen.                                   |
| `bus.waitForGet({ timeout? })`                      | Resolve when a content `GET` is seen.                                   |
| `bus.waitForOp(op, channel, { cid?, timeout? })`    | Generic poller.                                                         |
| `bus.expectRequestResponse(req, ok, timeout?)`      | Assert matching-cid request→response round-trip.                        |
| `bus.clear()`                                       | Empty the capture (use between phases).                                 |

Entry shape:

```ts
type BusOp = 'EMIT' | 'RECV' | 'SSE' | 'PUT' | 'GET';

interface BusLogEntry {
  op: BusOp;
  channel: string;
  scope: string | undefined;
  cid: string | undefined;     // correlationId, first 8 hex
  trace: string | undefined;   // W3C trace-id, first 8 hex (Tier 2)
  raw: string;                 // original console.debug text
  at: number;                  // Date.now() at capture
}
```

All helpers poll at 50ms and default to a 10-second timeout (20
seconds for `expectRequestResponse`). Override via the `timeout`
option.

## Why this matters

Protocol assertions are strictly stronger than UI assertions:

- UI assertion: "the highlight appeared." Passes even if the UI
  ended up right via a stale cache, a different endpoint, or a
  broken handler backfilled by a refetch.
- Protocol assertion: "`mark:create-request` was emitted,
  `mark:create-ok` arrived with matching correlationId." Fails
  immediately if the wire protocol regresses — even if the UI
  eventually converges.

Prefer protocol assertions for any test whose point is verifying a
round-trip. Keep UI assertions for rendering details (element visible,
text content, aria state).
