# Conformance suites

Black-box suites for Semiont's services, its SDKs and the workers written on them. Each one starts
processes, meets them only where the protocol says a client meets them, and
checks what they do against `specs/` and `docs/protocol/`. None imports
anything from the implementation it checks (the weaver suite reads the graph
with `@semiont/graph`, the reader the rest of Semiont uses, and says why): [harness/paths.ts](harness/paths.ts)
holds the one line per service, and per SDK, that names it, so the same cases
judge any implementation of the same spec.

| Suite | Checks | Run |
|---|---|---|
| [gateway](gateway/README.md) | a gateway, over HTTP and its bus stream | `npm run test:gateway` |
| [dispatcher](dispatcher/README.md) | a dispatcher, on the bus through a real gateway, and at its health port | `npm run test:dispatcher` |
| [archivist](archivist/README.md) | an Archivist, on the bus through a real gateway, at its HTTP surface, and in the files it keeps | `npm run test:archivist` |
| [sdk](sdk/README.md) | every SDK, through a driver, as a client of a real gateway | `npm run test:sdk` |
| [worker](worker/README.md) | a worker written on an SDK, through a driver, with the suite playing the dispatcher | `npm run test:worker` |
| [worker-service](worker-service/README.md) | a Worker service, as a process: on the bus through a real gateway, at a stand-in for each of its providers, and at its health port, with the suite playing the dispatcher, the record and the Smelter | `npm run test:worker-service` |
| [weaver](weaver/README.md) | a Weaver, as a process: behind a real gateway and a real Archivist, in the neo4j it writes, on the bus and at its health port | `npm run test:weaver` |

They share one harness ([harness/](harness/)): the trusted issuer, a real
`nats-server`, gateway, dispatcher, Archivist and Worker service processes, bus streams checked message by
message against the spec, a stand-in Archivist held to the Archivist's spec, a stand-in Ollama
and a stand-in Anthropic, and a proxy that stands between a client and the gateway.
[vitest.config.ts](vitest.config.ts) runs each suite as a project of its own;
`npm test` runs all seven.

## Running them

All need a built gateway and `nats-server` (2.10 or later) on `PATH`. The
dispatcher suite also needs a built dispatcher, the Archivist suite a built
Archivist and `git`, the SDK suite and the worker suite the Rust drivers
and the packages built, the worker-service suite the Worker service's
environment, which `uv` makes, and the weaver suite a built Archivist, the
Weaver's environment, which `uv` makes too, the packages built, and a neo4j of
its own, whose address and password it is told
in `NEO4J_HOST` and `NEO4J_PASSWORD` ([weaver/README.md](weaver/README.md)):

```bash
cargo build --release -p semiont-gateway -p semiont-dispatcher -p semiont-archivist -p semiont-conformance-drivers
npm run build:packages
uv sync --locked --no-dev --all-extras --project apps/worker
cd tests/conformance
npm ci
npm test
```

The spec is bundled from `specs/src` at the start of every run, so a suite
never checks against a stale bundle.
