# Conformance suites

Black-box suites for Semiont's services and its SDKs. Each one starts
processes, meets them only where the protocol says a client meets them, and
checks what they do against `specs/` and `docs/protocol/`. None imports
anything from the implementation it checks: [harness/paths.ts](harness/paths.ts)
holds the one line per service, and per SDK, that names it, so the same cases
judge any implementation of the same spec.

| Suite | Checks | Run |
|---|---|---|
| [gateway](gateway/README.md) | a gateway, over HTTP and its bus stream | `npm run test:gateway` |
| [dispatcher](dispatcher/README.md) | a dispatcher, on the bus through a real gateway, and at its health port | `npm run test:dispatcher` |
| [archivist](archivist/README.md) | an Archivist, on the bus through a real gateway, at its HTTP surface, and in the files it keeps | `npm run test:archivist` |
| [sdk](sdk/README.md) | every SDK, through a driver, as a client of a real gateway | `npm run test:sdk` |

They share one harness ([harness/](harness/)): the trusted issuer, a real
`nats-server`, gateway, dispatcher and Archivist processes, bus streams checked message by
message against the spec, a stand-in Archivist held to the Archivist's spec,
and a proxy that stands between a client and the gateway.
[vitest.config.ts](vitest.config.ts) runs each suite as a project of its own;
`npm test` runs all four.

## Running them

All need a built gateway and `nats-server` (2.10 or later) on `PATH`. The
dispatcher suite also needs a built dispatcher, the Archivist suite the
packages built and `git`, and the SDK suite the Rust drivers and the packages
built:

```bash
cargo build --release -p semiont-gateway -p semiont-dispatcher -p semiont-conformance-drivers
npm run build:packages
cd tests/conformance
npm ci
npm test
```

The spec is bundled from `specs/src` at the start of every run, so a suite
never checks against a stale bundle.
