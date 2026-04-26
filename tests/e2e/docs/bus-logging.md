# Bus logging

Protocol-level visibility into every bus and content event that crosses
a transport boundary, in either direction. Each event is logged as a
single `console.debug` line in a grep-friendly format:

```
[bus EMIT] <channel> [scope=X] [cid=<first8>] <payload>
[bus RECV] <channel> [scope=X] [cid=<first8>] <payload>
[bus SSE]  <channel> [scope=X] [cid=<first8>] <payload>
[bus PUT]  content   [cid=<first8>] <payload>
[bus GET]  content   [cid=<first8>] <payload>
```

Cost when disabled: a single truthy check, zero allocations.

This is **Tier 1 of the OBSERVABILITY plan** ([`.plans/OBSERVABILITY.md`](../../../.plans/OBSERVABILITY.md)) —
correlation-ID discipline at the transport contract layer. Tier 2
(OpenTelemetry spans) and Tier 3 (metrics + log correlation) reuse the
same choke points.

## Choke points

Instrumentation lives at `ITransport` and `IContentTransport` — the
transport contract layer — not at any single implementation. Every
event flows through one of these regardless of whether the bytes move
over HTTP+SSE or stay in-process.

| Op     | Site                                                         |
|--------|--------------------------------------------------------------|
| `EMIT` | `HttpTransport.emit()` (api-client)                          |
| `EMIT` | `LocalTransport.emit()` (make-meaning)                       |
| `RECV` | HttpTransport's wire-parse (SSE-side fan-in inside actor-vm) |
| `RECV` | `LocalTransport.bridgeInto` subscriber callback              |
| `EMIT` | Backend `/bus/emit` HTTP route                               |
| `SSE`  | Backend `writeBusEvent()` in `apps/backend/src/routes/bus.ts`|
| `PUT`  | `HttpContentTransport.putBinary()` + matching backend route  |
| `GET`  | `HttpContentTransport.getBinary()` / `getBinaryStream()` + matching backend route |
| `GET`  | `LocalContentTransport.getBinary()` / `getBinaryStream()` (in-process)            |

`ActorVM` and namespace methods (`client.mark.assist`, etc.) are
**not** choke points. Namespace methods ride on top of the transport;
their traffic shows up as the transport calls they make.

## Enable

### Browser (frontend)

Run-time toggle in DevTools or e2e init script:

```js
window.__SEMIONT_BUS_LOG__ = true;
```

Clears on refresh.

### Node (backend, worker, smelter, CLI, MCP, tests)

Process-env toggle, read once at module load:

```bash
SEMIONT_BUS_LOG=1 <command>
```

For local POSIX backend dev: setting `SEMIONT_BUS_LOG=1` in the parent
shell flows through automatically — `apps/cli`'s POSIX backend-start
spreads `process.env` into the child. Container/ECS deployments need
the variable added to their compose / task-definition env list.

## A typical full-trace timeline

With both flags on, opening a resource produces a contiguous timeline:

```
[frontend] [bus EMIT] browse:resource-requested cid=a89a670a {resourceId, ...}
[backend]  [bus EMIT] browse:resource-requested cid=a89a670a {resourceId, _userId, ...}
[backend]  [bus SSE]  browse:resource-result    cid=a89a670a {correlationId, response}
[frontend] [bus RECV] browse:resource-result    cid=a89a670a {correlationId, response}
```

A worker generation that uploads new content adds a content pair:

```
[worker]  [bus PUT]  content size=14823 storageUri=...
[backend] [bus PUT]  content size=14823 storageUri=...
```

Failure modes — each obvious from a missing line:

| Missing line   | Diagnosis                                                          |
|----------------|--------------------------------------------------------------------|
| Backend `EMIT` | Client never reached the server (auth, CORS, network).             |
| Backend `SSE`  | In-process handler never emitted a result, or no subscriber fired. |
| Frontend `RECV`| Backend wrote to the SSE stream but bytes never parsed client-side.|
| Backend `PUT`  | Client started an upload but the body never reached the server.    |

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

| Method | Purpose |
|---|---|
| `bus.entries` | Raw array of all captured entries (in order). |
| `bus.emits(channel)` | Filter to outgoing on one channel. |
| `bus.receives(channel)` | Filter to incoming on one channel. |
| `bus.waitForEmit(channel, { timeout? })` | Resolve when an emit is seen, or throw. |
| `bus.waitForRecv(channel, { cid?, timeout? })` | Resolve when a receive is seen, with optional cid match. |
| `bus.expectRequestResponse(req, ok, timeout?)` | Assert matching-cid request→response round-trip. |
| `bus.clear()` | Empty the capture (use between phases). |

Entry shape:

```ts
interface BusLogEntry {
  direction: 'EMIT' | 'RECV';
  channel: string;
  scope: string | undefined;
  cid: string | undefined;   // correlationId, first 8 chars
  raw: string;               // original console.debug text
  at: number;                // Date.now() at capture
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
