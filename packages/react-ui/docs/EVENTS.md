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
