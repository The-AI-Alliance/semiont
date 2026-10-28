# Packages

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/branch/main/graph/badge.svg)](https://codecov.io/gh/The-AI-Alliance/semiont)

The libraries Semiont is built from, in four languages. The services are in [images/](../images/README.md), and the tools that run on a host in [apps/](../apps/README.md). What they share, and what a program outside this repository installs, is here.

| Language | What is here | Published to |
|---|---|---|
| [TypeScript](#typescript) | The SDK, its transport and its telemetry, the React components, and an MCP server | npm |
| [Rust](#rust) | The SDK and its transport, and what the gateway, the dispatcher and the Archivist share | crates.io |
| [Python](#python) | The SDK, and what the Librarian, the Smelter, the Weaver and the Worker share | PyPI |
| [Go](#go) | The SDK, which the launcher is built on | nowhere |

Semiont's own services are built on these SDKs too, each on the one of its language.

## What a program installs

A program that builds on a knowledge base installs one SDK. [Building with the Semiont SDK](../docs/builder/README.md) starts there.

| | Install | Read |
|---|---|---|
| TypeScript | `npm install @semiont/sdk` | [sdk](./sdk/README.md) |
| Rust | `cargo add semiont`, and `cargo add semiont-http-transport --features sign-in` | [sdk-rust](./sdk-rust/README.md), [http-transport-rust](./http-transport-rust/README.md) |
| Python | `pip install semiont` | [sdk-python](./sdk-python/README.md) |
| Go | The module `github.com/The-AI-Alliance/semiont/packages/go/sdk`, by a `replace` on its path: it is published nowhere | [go/sdk](./go/sdk/README.md) |
| A React interface | `npm install @semiont/react-ui`, beside the SDK | [react-ui](./react-ui/README.md) |

The rest is what those are built on, and what Semiont's own services are built on.

## TypeScript

The client side: the SDK and what it stands on. The Browser ([images/browser](../images/browser/README.md)) is built on these.

| Package | Published | What it is |
|---|---|---|
| [@semiont/sdk](./sdk/README.md) | [![npm](https://img.shields.io/npm/v/@semiont/sdk)](https://www.npmjs.com/package/@semiont/sdk) | The TypeScript SDK: `SemiontClient` and its verb namespaces, `SemiontSession` and `SemiontBrowser`, state units, and the cache behind live queries |
| [@semiont/react-ui](./react-ui/README.md) | [![npm](https://img.shields.io/npm/v/@semiont/react-ui)](https://www.npmjs.com/package/@semiont/react-ui) | React components and hooks over the SDK: the resource viewer, the annotation components, and the `useStateUnit` and `useObservable` adapters |
| [@semiont/http-transport](./http-transport/README.md) | [![npm](https://img.shields.io/npm/v/@semiont/http-transport)](https://www.npmjs.com/package/@semiont/http-transport) | How the SDK reaches a knowledge base over HTTP: `HttpTransport` and `HttpContentTransport`. The SDK depends on it |
| [@semiont/core](./core/README.md) | [![npm](https://img.shields.io/npm/v/@semiont/core)](https://www.npmjs.com/package/@semiont/core) | What every TypeScript package stands on: the protocol's types, generated from the spec, the ids, the event bus, and the contracts a transport implements |
| [@semiont/observability](./observability/README.md) | [![npm](https://img.shields.io/npm/v/@semiont/observability)](https://www.npmjs.com/package/@semiont/observability) | Tracing and metrics for the TypeScript transport, on OpenTelemetry. It does nothing until a process is given somewhere to export to |

## Rust

The first four are how a Rust program uses Semiont. The last three are what the Rust services share, and are built into their binaries. A service's own crates are beside its binary in [images/](../images/README.md).

| Crate | Published | What it is |
|---|---|---|
| [semiont](./sdk-rust/README.md) | [![crates.io](https://img.shields.io/crates/v/semiont.svg)](https://crates.io/crates/semiont) | The Rust SDK: the client of a knowledge base, the protocol's types, sessions and state units |
| [semiont-http-transport](./http-transport-rust/README.md) | [![crates.io](https://img.shields.io/crates/v/semiont-http-transport.svg)](https://crates.io/crates/semiont-http-transport) | The SDK's transport over a gateway, and signing a person or a service in |
| [semiont-telemetry](./telemetry-rust/README.md) | [![crates.io](https://img.shields.io/crates/v/semiont-telemetry.svg)](https://crates.io/crates/semiont-telemetry) | The SDK's spans and counts, reported to whatever OpenTelemetry the application installed. It exports nothing |
| [semiont-codegen](./codegen-rust/README.md) | [![crates.io](https://img.shields.io/crates/v/semiont-codegen.svg)](https://crates.io/crates/semiont-codegen) | The build-time generator of Rust types from the spec. A build dependency of `semiont`: nobody adds it by hand |
| [semiont-core](./core-rust/README.md) | Not published | What the Rust services share and no client needs: the embedded spec and its validators, the configuration documents, the reach to the messaging broker |
| [semiont-http-service](./http-service-rust/README.md) | Not published | What the Rust services that serve HTTP share: connections a service can close from its side, the bearer credential, and the verifier of tokens from the trusted issuer |
| [semiont-observability](./observability-rust/README.md) | Not published | What a Rust service writes about itself: telemetry exported over OTLP, and log lines |

## Python

The first is how a Python program uses Semiont. The other four are what the Python services are built from.

| Distribution | Published | What it is |
|---|---|---|
| [semiont](./sdk-python/README.md) | [![PyPI](https://img.shields.io/pypi/v/semiont.svg)](https://pypi.org/project/semiont/) | The Python SDK: the client of a knowledge base, its transport over a gateway, signing in, live queries, and the doubles a test is built on. On asyncio, typed for `mypy` and `pyright` |
| [semiont-service](./service-python/README.md) | Not published | What every Python service does to be one: read its configuration document, answer for its health, write its log and export its telemetry |
| [semiont-inference](./inference-python/README.md) | Not published | The model providers a Python service calls, behind one interface: text and structured generation, and discovered limits. A provider's own library is an extra |
| [semiont-graph](./graph-python/README.md) | Not published | The graph databases a Python service writes and reads, behind one interface. A database's own client is an extra |
| [semiont-vectors](./vectors-python/README.md) | Not published | The vector index a Python service writes and searches, and the embedding providers that make its vectors, each behind one interface |

## Go

| Module | Published | What it is |
|---|---|---|
| [go/sdk](./go/sdk/README.md) | Not published | The Go SDK: the client of a knowledge base, its transport over a gateway, signing in, live queries, the state units, a worker's claims, and the doubles a test is built on (`semionttest`). The `semiont` launcher ([apps/launcher](../apps/launcher/README.md)) is built on it |
| [go/launcher](./go/launcher/README.md) | Not published | The launcher's libraries: its engine, the reader of a knowledge base's documents (`stack`), what an image declares (`images`) and whether a release built it (`provenance`), the verbs on the command line and over MCP (`verbs`), and the fake runtime its tests drive (`fakert`). The program, [apps/launcher](../apps/launcher/README.md), is built on them |

## Working on a package

- [Package Architecture](../docs/architecture/PACKAGE-ARCHITECTURE.md) draws how the packages depend on one another in each language, and says what each service image runs.
- The contributor's [orientation](../docs/contributor/README.md) covers building and running a change, testing it, and [adding a package](../docs/contributor/README.md#adding-a-package). The pull-request process is in [CONTRIBUTING.md](../CONTRIBUTING.md).
- Each package's README says who uses it and what a change to it must keep.

## License

Apache-2.0
