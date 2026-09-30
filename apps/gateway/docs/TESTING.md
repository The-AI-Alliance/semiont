# Gateway Testing

The gateway's behavioural contract is one suite, and it lives outside this
crate: [`tests/conformance/gateway`](../../../tests/conformance/gateway/README.md).
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
| `npm run lint:spec-protocol` (repository root) | The spec states the whole protocol: every operation says whether it is public; every response has a body schema, every error body is an `ErrorResponse`, every 401 a challenge; the stream's messages, frame and id formats are schemas; every JSON body has a `maxBodyBytes` and a 413; the limits are positive integers |
| The build (`semiont-core`'s `build.rs`) | The spec bundles and every component schema compiles, or the gateway does not build; the bus registry names only schemas the spec declares; the service-only types (`semiont-core`) and the protocol's (`semiont`) are generated from the schemas, and a schema of a shape the generator does not know fails the build |
| `tests/conformance/gateway` | A running gateway conforms: spec-derived probes of every operation, every response and stream message validated against the spec, and hand-written cases for credentials, content, emitting, the stream, the connection bounds, the limits on one principal (a person and an agent alike) and on one process, replicas, readiness, boot refusals, the headers on every response, the environment, and the telemetry census |
| The gateway's boot | Its route table is exactly the spec's operations — no undeclared route, no declared operation unserved ([src/routes/mod.rs](../src/routes/mod.rs)) — and every Archivist operation it calls is in the Archivist's spec; every suite run boots gateways, so a route added without a spec entry fails CI |
| `cargo test --workspace` | The runners for the shared case tables ([packages/sdk-rust/tests/tables.rs](../../../packages/sdk-rust/tests/tables.rs)), against the SDK the gateway names its principals with: the principals and the knowledge base's resource identifier, as core and the launcher compute them |
| `npm run lint:broker-boundary` | The broker is reached only through its interface: `async_nats` only in `signal/nats.rs`, that plane chosen only in `app.rs`, the `nats` npm client only in the JetStream job queue |
| `npm run lint:gateway-environment`, `lint:service-role` | The environment it reads is exactly [variables.json](../../../specs/src/gateway-environment/variables.json)'s; its role names are the launcher's and core's |
| `scripts/lint/check-gateway-crates.mjs` | Every crate it links is under a permitted licence, and credited in the image's NOTICE; every crate that compiles native code in says what, and a library under a licence of its own is credited too |
| `cargo deny` ([deny.toml](../deny.toml); the Gateway Crate Advisories workflow, on every change to what it links and daily) | No crate it links has a RustSec advisory, except those ignored with a reason, and an ignore that stops matching fails; no crate is yanked; every crate comes from crates.io, named by a version, not a wildcard |
| `scripts/container/check-gateway-image.sh` | The built image carries no source and serves `/api/health` within its start bound |

## Running it

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && cargo build --release -p semiont-gateway
npm run build:packages
cd tests/conformance
npm ci
npm run test:gateway
```

The suite needs `nats-server` 2.10 or later on `PATH`.

## Load

[bench/load.sh](../bench/load.sh) puts gateway binaries under the same load, one
after another, on Alpine as the image is: `GET /api/health`, and `POST /bus/emit`
with an empty payload and with an 8 KiB one, each from `wrk` on CPUs the gateway
does not use. It is a measurement, not a gate, and nothing in CI runs it. The
allocator was chosen by it (2026-09-28, eight gateway CPUs, 256 connections,
median of three 10 s runs):

| Allocator | health req/s | emit req/s | emit p50 | peak RSS |
|---|---|---|---|---|
| musl's malloc | 39,869 | 15,527 | 14.8 ms | 40 MiB |
| musl's, with no counting wrapper | 39,876 | 15,681 | 15.0 ms | 40 MiB |
| jemalloc | 589,293 | 266,000 | 0.9 ms | 49 MiB |

The counting wrapper the heap gauge used cost nothing measurable; musl's malloc itself was the bottleneck under eight workers.

## Adding to the protocol

Change the spec first — a gateway whose routes are not the spec's operations
refuses to start. A new route is probed by the spec-derived cases as soon as the
spec declares it — unauthenticated, with a bad credential, with a body that does
not validate — and every reply it gives is checked against its declaration.
Then write the cases no schema can state, each citing the text it checks, and
watch each fail against a gateway that does not do it yet.
