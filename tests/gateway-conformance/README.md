# Gateway conformance suite

A black-box suite for the gateway. It starts gateway processes, talks to them
over HTTP, and checks what they answer against the protocol as `specs/`
states it — the OpenAPI document, the bus registry — and as
[docs/protocol/TRANSPORT-HTTP.md](../../docs/protocol/TRANSPORT-HTTP.md)
states the semantics a schema cannot hold. It imports nothing from the
gateway: the one line that names an implementation is `GATEWAY_COMMAND` in
[harness/paths.ts](harness/paths.ts).

Every case runs against a gateway on each signal plane — in-process, and NATS
with a real `nats-server` — except the ones that need a broker (replicas, a
broker outage, what the broker holds) or do not depend on the plane (the slow
heartbeat, reply-retention and key-rotation cases, and knowledge bases
configured another way).

## What it checks

- **Derived from the spec** (`cases/spec-derived.test.ts`): every declared
  operation probed without a credential (and with another scheme, before its
  body is read) and with a bad one, the challenge exact; every public
  operation answered as declared, without a challenge; every JSON request body
  refused when it does not validate; every request limit enforced at its bound
  and not below it; an undeclared path, or an undeclared method on a declared
  one, answered 404 with an `ErrorResponse`. A route added to the spec is
  covered without a new case.
- **On every response and every stream**: a reply's status must be declared for
  its route and its body and headers must match the declaration
  (`nonConformance` in [harness/http.ts](harness/http.ts)), and no error body may
  carry a stack frame, a source path or a secret's name; every stream must come
  as `text/event-stream`, and every message on it must be a `BusStreamMessage`
  with the id format its frame calls for ([harness/stream.ts](harness/stream.ts)).
  A violation fails the case whatever it was about.
- **Hand-written**, each citing the text it checks: credentials, content and
  uploads, emitting (stamping, claims, profiles, unanswerable requests), the
  stream (delivery, reply routing, replay and every gap reason, recovery,
  presence, the heartbeat), the connection bounds, replicas sharing a broker,
  a broker outage, boot refusals (broker credentials among them) and the
  signing key ring, the headers on every response, and the span and metric
  names with the attributes they carry.

The world around a gateway is played by the harness: the trusted issuer
(discovery, keys and the client-credentials grant, signing with
`@semiont/core/testing/issuer`), a fake Archivist over HTTP, a broker that can
require credentials and be taken down and brought back, and an OTLP receiver.

## Running it

It needs a built gateway and `nats-server` (2.10 or later) on `PATH`:

```bash
npm run build:packages
npm run build -w semiont-gateway
cd tests/gateway-conformance
npm ci
npm test
```

The spec is bundled from `specs/src` at the start of every run, so the suite
never checks against a stale bundle.
