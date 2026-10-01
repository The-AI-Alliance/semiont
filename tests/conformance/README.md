# Conformance suites

Black-box suites for Semiont's services. Each one starts processes, meets them
only where the protocol says a client meets them, and checks what they do
against `specs/` and `docs/protocol/`. None imports anything from the
implementation it checks: [harness/paths.ts](harness/paths.ts) holds the one
line per service that names it, so the same cases judge any implementation of
the same spec.

| Suite | Checks | Run |
|---|---|---|
| [gateway](gateway/README.md) | a gateway, over HTTP and its bus stream | `npm run test:gateway` |
| [dispatcher](dispatcher/README.md) | a dispatcher, on the bus through a real gateway, and at its health port | `npm run test:dispatcher` |

They share one harness ([harness/](harness/)): the trusted issuer, a real
`nats-server`, gateway and dispatcher processes, bus streams checked message by
message against the spec, and a stand-in Archivist held to the Archivist's
spec. [vitest.config.ts](vitest.config.ts) runs each suite as a project of its
own; `npm test` runs both.

## Running them

Both need a built gateway and `nats-server` (2.10 or later) on `PATH`; the
dispatcher suite also needs the packages built:

```bash
cargo build --release -p semiont-gateway
npm run build:packages
cd tests/conformance
npm ci
npm test
```

The spec is bundled from `specs/src` at the start of every run, so a suite
never checks against a stale bundle.
