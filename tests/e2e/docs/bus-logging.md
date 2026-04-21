# Bus logging

Protocol-level visibility into the frontend↔backend event bus. Every
event that crosses the wire in either direction is logged as a single
`console.debug` line with a grep-friendly format:

```
[bus EMIT] <channel> [scope=X] [cid=<first8>] <payload>
[bus RECV] <channel> [scope=X] [cid=<first8>] <payload>
```

Both call sites live in `ActorVM`
([`packages/api-client/src/view-models/domain/actor-vm.ts`](../../../packages/api-client/src/view-models/domain/actor-vm.ts))
— one inside `emit()` (outgoing), one inside the SSE parser
(incoming). Anything that crosses the wire goes through one of those
two lines, so the log is exhaustive. Local-only events (purely
in-browser) stay invisible — by design.

Cost when disabled: a single truthy check, zero allocations.

## Enable in a running browser

From DevTools console:

```js
window.__SEMIONT_BUS_LOG__ = true;
```

Then reproduce. Clears on refresh.

## Enable in e2e tests

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

## Capture API

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
