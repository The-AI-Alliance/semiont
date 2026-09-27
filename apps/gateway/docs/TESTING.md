# Gateway Testing

The gateway's behavioural contract is one suite, and it lives outside this
package: [`tests/gateway-conformance`](../../../tests/gateway-conformance/README.md).
It is black-box. It starts gateway processes, talks to them over HTTP and SSE,
and checks what they answer against the protocol as `specs/` states it — the
OpenAPI document and the bus registry — and as
[TRANSPORT-HTTP.md](../../../docs/protocol/TRANSPORT-HTTP.md) states the
semantics a schema cannot hold. It imports nothing from the gateway, so it
checks any implementation that answers to the same spec.

Every case runs on both signal planes — in-process, and NATS against a real
`nats-server` — except those that need a broker (two replicas) or do not depend
on the plane.

## What checks what

| Where | Checks |
|---|---|
| `npm run lint:spec-protocol` (repository root) | The spec states the whole protocol: every operation says whether it is public; every response has a body schema, every error body is an `ErrorResponse`, every 401 a challenge; the stream's messages, frame and id formats are schemas; the limits are positive integers |
| `tests/gateway-conformance` | A running gateway conforms: spec-derived probes of every operation, every response and stream message validated against the spec, and hand-written cases for credentials, content, emitting, the stream, the connection bounds, replicas, boot refusals, the headers on every response, and the span and metric names |
| The gateway's boot | Its route table is exactly the spec's operations — no undeclared route, no declared operation unserved ([spec-routes.ts](../src/spec-routes.ts)); every suite run boots gateways, so a route added without a spec entry fails CI |
| `apps/gateway`'s own `npm test` | Only the manifest census: the gateway's runtime dependencies are core and observability plus what its source imports, and nothing it imports is undeclared |
| `packages/make-meaning` | The Archivist's side of what the gateway proxies: the recording upload, the description, the content and replay reads — every reply checked against the Archivist's spec (`specs/src/archivist/`), and every operation it declares exercised. The suite holds its stand-in Archivist, and the gateway's requests to it, to the same document |

## Running the suite

It needs a built gateway and `nats-server` 2.10 or later on `PATH`:

```bash
npm run build:packages
npm run build -w semiont-gateway
cd tests/gateway-conformance
npm ci
npm test
```

## Adding to the protocol

Change the spec first — a gateway that registers a route the spec does not
declare refuses to start. A new route is probed by the spec-derived cases as soon
as the spec declares it — unauthenticated, with a bad credential, with a body
that does not validate — and every reply it gives is checked against its
declaration. Then write the cases no schema can state, each citing the text it
checks, and watch each fail against a gateway that does not do it yet.
