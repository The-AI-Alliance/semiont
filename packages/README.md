# @semiont Packages

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/branch/main/graph/badge.svg)](https://codecov.io/gh/The-AI-Alliance/semiont)

Modular packages for the Semiont platform. For the layered design, dependency graph, and architectural principles that organize them, see **[docs/architecture/PACKAGE-ARCHITECTURE.md](../docs/architecture/PACKAGE-ARCHITECTURE.md)**.

## npm Packages

An application installs [`@semiont/sdk`](./sdk/), and [`@semiont/react-ui`](./react-ui/) if it has a UI. [`@semiont/mcp-server`](./mcp-server/) is a tool in its own right, run from a checkout. The rest are what Semiont's services are built from: each README says who uses the package and what a change to it must keep.

| Package | Version | Source | Description |
| ------- | ------- | ------ | ----------- |
| [@semiont/http-transport](https://www.npmjs.com/package/@semiont/http-transport) | [![npm](https://img.shields.io/npm/v/@semiont/http-transport)](https://www.npmjs.com/package/@semiont/http-transport) | [http-transport](./http-transport/) | HTTP transport adapter — `HttpTransport` (REST + SSE), `HttpContentTransport` (binary I/O). Consumed by `@semiont/sdk` |
| [@semiont/content](https://www.npmjs.com/package/@semiont/content) | [![npm](https://img.shields.io/npm/v/@semiont/content)](https://www.npmjs.com/package/@semiont/content) | [content](./content/) | A resource's bytes read from the Archivist, and text derived from PDFs (text layer, OCR, tables, forms) |
| [@semiont/core](https://www.npmjs.com/package/@semiont/core) | [![npm](https://img.shields.io/npm/v/@semiont/core)](https://www.npmjs.com/package/@semiont/core) | [core](./core/) | OpenAPI-generated types, branded IDs, EventBus + ITransport contract, event protocol, W3C / locale / text helpers, config loaders |
| [@semiont/event-sourcing](https://www.npmjs.com/package/@semiont/event-sourcing) | [![npm](https://img.shields.io/npm/v/@semiont/event-sourcing)](https://www.npmjs.com/package/@semiont/event-sourcing) | [event-sourcing](./event-sourcing/) | Reading a resource's materialized view from the state tree |
| [@semiont/graph](https://www.npmjs.com/package/@semiont/graph) | [![npm](https://img.shields.io/npm/v/@semiont/graph)](https://www.npmjs.com/package/@semiont/graph) | [graph](./graph/) | Graph database abstraction (Neo4j, Neptune, JanusGraph, in-memory) |
| [@semiont/inference](https://www.npmjs.com/package/@semiont/inference) | [![npm](https://img.shields.io/npm/v/@semiont/inference)](https://www.npmjs.com/package/@semiont/inference) | [inference](./inference/) | The model providers the services call, behind one interface: text and structured generation, discovered limits (Anthropic, Ollama) |
| [@semiont/jobs](https://www.npmjs.com/package/@semiont/jobs) | [![npm](https://img.shields.io/npm/v/@semiont/jobs)](https://www.npmjs.com/package/@semiont/jobs) | [jobs](./jobs/) | The job worker: processors for each job, the `worker-main` container entry point for `semiont-worker`, and the job-claim adapter |
| [@semiont/make-meaning](https://www.npmjs.com/package/@semiont/make-meaning) | [![npm](https://img.shields.io/npm/v/@semiont/make-meaning)](https://www.npmjs.com/package/@semiont/make-meaning) | [make-meaning](./make-meaning/) | Knowledge-base actor implementations (Gatherer, Matcher, Smelter, Weaver) and the three container entry points they run under (`librarian-main`, `smelter-main`, `weaver-main`) |
| [@semiont/mcp-server](./mcp-server/) | Not on npm: built from a checkout | [mcp-server](./mcp-server/) | Model Context Protocol server: ten tools over a knowledge base, for Claude Desktop and other MCP clients |
| [@semiont/observability](https://www.npmjs.com/package/@semiont/observability) | [![npm](https://img.shields.io/npm/v/@semiont/observability)](https://www.npmjs.com/package/@semiont/observability) | [observability](./observability/) | OpenTelemetry helpers for the TypeScript services and transports: `withSpan`, trace context across the bus, metric recorders, the process logger. No-op when no exporter is configured |
| [@semiont/ontology](https://www.npmjs.com/package/@semiont/ontology) | [![npm](https://img.shields.io/npm/v/@semiont/ontology)](https://www.npmjs.com/package/@semiont/ontology) | [ontology](./ontology/) | The entity types a knowledge base starts with |
| [@semiont/react-ui](https://www.npmjs.com/package/@semiont/react-ui) | [![npm](https://img.shields.io/npm/v/@semiont/react-ui)](https://www.npmjs.com/package/@semiont/react-ui) | [react-ui](./react-ui/) | React components and hooks; `useStateUnit` / `useObservable` adapters over the SDK's state-unit layer |
| [@semiont/sdk](https://www.npmjs.com/package/@semiont/sdk) | [![npm](https://img.shields.io/npm/v/@semiont/sdk)](https://www.npmjs.com/package/@semiont/sdk) | [sdk](./sdk/) | `SemiontClient`, verb-oriented namespaces, `SemiontSession` + `SemiontBrowser`, state units, `bus-request` + cache. Transport-agnostic — pair with `@semiont/http-transport` (HTTP) |
| [@semiont/vectors](https://www.npmjs.com/package/@semiont/vectors) | [![npm](https://img.shields.io/npm/v/@semiont/vectors)](https://www.npmjs.com/package/@semiont/vectors) | [vectors](./vectors/) | The vector index: a vector store (Qdrant, in-memory) and an embedding provider (Voyage, Ollama), each behind an interface |

## Rust Crates

Seven crates of the Rust workspace live here. Four are published to crates.io, and are how a Rust program uses Semiont. Three are the Rust services' own: they are built into the gateway, the dispatcher and the Archivist, and published nowhere.

| Crate | Version | Source | Description |
| ----- | ------- | ------ | ----------- |
| [semiont](https://crates.io/crates/semiont) | [![crates.io](https://img.shields.io/crates/v/semiont.svg)](https://crates.io/crates/semiont) | [sdk-rust](./sdk-rust/) | The Rust SDK: the client of a knowledge base, the protocol's types, sessions and state units. A full peer of `@semiont/sdk` |
| [semiont-http-transport](https://crates.io/crates/semiont-http-transport) | [![crates.io](https://img.shields.io/crates/v/semiont-http-transport.svg)](https://crates.io/crates/semiont-http-transport) | [http-transport-rust](./http-transport-rust/) | The SDK's transport over a gateway, and signing a person or a service in |
| [semiont-telemetry](https://crates.io/crates/semiont-telemetry) | [![crates.io](https://img.shields.io/crates/v/semiont-telemetry.svg)](https://crates.io/crates/semiont-telemetry) | [telemetry-rust](./telemetry-rust/) | The SDK's spans and counts, reported to whatever OpenTelemetry the application installed. It exports nothing |
| [semiont-codegen](https://crates.io/crates/semiont-codegen) | [![crates.io](https://img.shields.io/crates/v/semiont-codegen.svg)](https://crates.io/crates/semiont-codegen) | [codegen-rust](./codegen-rust/) | The build-time generator of Rust types from the spec. A build dependency of `semiont`; nobody adds it by hand |
| semiont-core | not published | [core-rust](./core-rust/) | What the Rust services share and no client needs: the embedded spec and its validators, the configuration documents, the reach to the messaging broker |
| semiont-archivist-record, semiont-archivist-staging | not published | [apps/archivist](../apps/archivist/) | The Archivist's own crates beside its binary: the record (event log, views, projections), which reaches no network and runs no program, and the staging drivers |
| semiont-http-service | not published | [http-service-rust](./http-service-rust/) | What the Rust services that serve HTTP share: connections a service can close from its side, the bearer credential, and the verifier of tokens from the trusted issuer |
| semiont-observability | not published | [observability-rust](./observability-rust/) | What a Rust service writes about itself: telemetry exported over OTLP, and log lines |

## Python Package

One distribution, published to PyPI.

| Package | Version | Source | Description |
| ------- | ------- | ------ | ----------- |
| [semiont](https://pypi.org/project/semiont/) | [![PyPI](https://img.shields.io/pypi/v/semiont.svg)](https://pypi.org/project/semiont/) | [sdk-python](./sdk-python/) | The Python SDK: the client of a knowledge base, its transport over a gateway, signing in, live queries, and the doubles a test is built on. On asyncio, typed for `mypy` and `pyright` |

The Go client is [sdk-go](./sdk-go/).

## Getting Started

To work on these packages, start at the contributor's [orientation](../docs/contributor/README.md): building and running a change, testing it, and [adding a package](../docs/contributor/README.md#adding-a-package).

## License

Apache-2.0

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md)
