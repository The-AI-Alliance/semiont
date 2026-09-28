# Gateway Testing

The gateway's behavioural contract is one suite, and it lives outside this
crate: [`tests/gateway-conformance`](../../../tests/gateway-conformance/README.md).
It is black-box. It starts gateway processes, talks to them over HTTP and SSE,
and checks what they answer against the protocol as `specs/` states it — the
OpenAPI document and the bus registry — and as
[TRANSPORT-HTTP.md](../../../docs/protocol/TRANSPORT-HTTP.md) states the
semantics a schema cannot hold. It imports nothing from the gateway, so it
checks any implementation that answers to the same spec — it judged the
TypeScript gateway before this one, case for case.

Every case runs on both signal planes — in-process, and NATS against a real
`nats-server` — except those that need a broker (two replicas) or do not depend
on the plane.

## What checks what

| Where | Checks |
|---|---|
| `npm run lint:spec-protocol` (repository root) | The spec states the whole protocol: every operation says whether it is public; every response has a body schema, every error body is an `ErrorResponse`, every 401 a challenge; the stream's messages, frame and id formats are schemas; the limits are positive integers |
| The build (`build.rs`) | The spec bundles and every component schema compiles, or the gateway does not build; the bus registry names only schemas the spec declares |
| `tests/gateway-conformance` | A running gateway conforms: spec-derived probes of every operation, every response and stream message validated against the spec, and hand-written cases for credentials, content, emitting, the stream, the connection bounds, replicas, readiness, boot refusals, the headers on every response, the environment, and the telemetry census |
| The gateway's boot | Its route table is exactly the spec's operations — no undeclared route, no declared operation unserved ([src/routes/mod.rs](../src/routes/mod.rs)) — and every Archivist operation it calls is in the Archivist's spec; every suite run boots gateways, so a route added without a spec entry fails CI |
| `cargo test` (this crate) | The runners for the shared case tables ([tests/tables.rs](../tests/tables.rs)): the principals and the knowledge base's resource identifier, as core and the launcher compute them |
| `npm run lint:gateway-environment`, `lint:service-role` | The environment it reads is exactly [variables.json](../../../specs/src/gateway-environment/variables.json)'s; its role names are the launcher's and core's |
| `scripts/lint/check-gateway-crates.mjs` | Every crate it links is under a permitted licence, and credited in the image's NOTICE |
| `scripts/container/check-gateway-image.sh` | The built image carries no source and serves `/api/health` within its start bound |

## Running it

```bash
(cd apps/gateway && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test && cargo build --release)
npm run build:packages
cd tests/gateway-conformance
npm ci
npm test
```

The suite needs `nats-server` 2.10 or later on `PATH`.

## Adding to the protocol

Change the spec first — a gateway whose routes are not the spec's operations
refuses to start. A new route is probed by the spec-derived cases as soon as the
spec declares it — unauthenticated, with a bad credential, with a body that does
not validate — and every reply it gives is checked against its declaration.
Then write the cases no schema can state, each citing the text it checks, and
watch each fail against a gateway that does not do it yet.
