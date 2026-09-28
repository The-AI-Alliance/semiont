# Gateway conformance suite

A black-box suite for the gateway. It starts gateway processes, talks to them
over HTTP, and checks what they answer against the protocol as `specs/`
states it — the OpenAPI document, the bus registry — and as
[docs/protocol/TRANSPORT-HTTP.md](../../docs/protocol/TRANSPORT-HTTP.md)
states the semantics a schema cannot hold. It imports nothing from the
gateway: the one line that names an implementation is `GATEWAY_COMMAND` in
[harness/paths.ts](harness/paths.ts), which [vitest.config.ts](vitest.config.ts)
provides to the cases: the Rust gateway's binary, built in `apps/gateway`.

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
  Behind the gateway, every request it sends the Archivist must be an operation
  the Archivist's spec (`specs/src/archivist/`) declares, with the parameters
  that operation requires, and every reply the stand-in Archivist gives must
  match its declaration ([harness/archivist.ts](harness/archivist.ts)).
  A violation fails the case whatever it was about.
- **Hand-written**, each citing the text it checks: credentials, content and
  uploads, emitting (stamping, claims, profiles, unanswerable requests), the
  stream (delivery, reply routing, replay and every gap reason, recovery,
  presence, the heartbeat), the connection bounds, replicas sharing a broker,
  a broker outage, boot refusals (broker credentials among them) and the
  signing key ring, and the headers on every response.
- **Telemetry** (`cases/observability.test.ts`): each plane exports to its own
  receiver — which reads OTLP/HTTP as JSON or protobuf, as a collector does,
  held to OpenTelemetry's own serializers by `harness/otlp.test.ts` — and its
  last case holds everything received to
  [`specs/src/gateway-telemetry/telemetry.json`](../../specs/src/gateway-telemetry/telemetry.json)
  in both directions — every span and metric a listed row of the listed kind,
  carrying listed attributes, and every row the cases' traffic can produce arrived.
- **Principals** (`cases/tokens.test.ts`): every person and agent case in
  [`specs/src/principals/cases.json`](../../specs/src/principals/cases.json), named
  exactly by a running gateway; every DID the suite expects comes from that table.
- **The environment** (`cases/environment.test.ts`): what each variable
  [`specs/src/gateway-environment/variables.json`](../../specs/src/gateway-environment/variables.json)
  lists changes, and the document's `logFormat`. The harness refuses to start a
  gateway with a variable that table does not list or the document does not
  name, so no case can lean on one the spec does not state.

The world around a gateway is played by the harness: the trusted issuer
(discovery, keys and the client-credentials grant, signing with
`@semiont/core/testing/issuer`), a stand-in Archivist held to the Archivist's
spec, a broker that can
require credentials and be taken down and brought back, and an OTLP receiver.

## Running it

It needs a built gateway and `nats-server` (2.10 or later) on `PATH`:

```bash
(cd apps/gateway && cargo build --release)
npm run build:packages
cd tests/gateway-conformance
npm ci
npm test
```

The spec is bundled from `specs/src` at the start of every run, so the suite
never checks against a stale bundle.
