# Packages

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/branch/main/graph/badge.svg)](https://codecov.io/gh/The-AI-Alliance/semiont)

The libraries Semiont is built from, in five languages. The services are in [images/](../images/README.md), and the tools that run on a host in [apps/](../apps/README.md). What they share, and what a program outside this repository installs, is here.

| Language | What is here | Published to |
|---|---|---|
| [TypeScript](./typescript/README.md) | The SDK, its transport and its telemetry, and the React components | npm |
| [Rust](./rust/README.md) | The SDK and its transport, and what the gateway, the dispatcher and the Archivist share | crates.io: the SDK, its transport, and the codegen and telemetry crates they are built on |
| [Python](./python/README.md) | The SDK, and what the Librarian, the Smelter, the Weaver and the Worker share | PyPI: the SDK alone |
| [Go](./go/README.md) | The SDK, and the launcher's libraries | The Go module proxy, by a tag at each release: the SDK alone |
| [Kotlin](./kotlin/README.md) | The SDK, for Kotlin and Java programs; its client is not yet written | Not published |

Each language's README lists its packages, with what each is and its coverage, and says how the language's packages are built and measured.

Semiont's own services are built on these SDKs too, each on the one of its language.

## What a program installs

A program that builds on a knowledge base installs one SDK. [Building with the Semiont SDK](../docs/builder/README.md) starts there.

| | Install | Read |
|---|---|---|
| TypeScript | `npm install @semiont/sdk` | [typescript/sdk](./typescript/sdk/README.md) |
| Rust | `cargo add semiont`, and `cargo add semiont-http-transport --features sign-in` | [rust/sdk](./rust/sdk/README.md), [rust/http-transport](./rust/http-transport/README.md) |
| Python | `pip install semiont` | [python/sdk](./python/sdk/README.md) |
| Go | `go get github.com/The-AI-Alliance/semiont/packages/go/sdk` | [go/sdk](./go/sdk/README.md) |
| A React interface | `npm install @semiont/react-ui`, beside the SDK | [typescript/react-ui](./typescript/react-ui/README.md) |

The rest is what those are built on, and what Semiont's own services are built on.

## Working on a package

- [Package Architecture](../docs/architecture/PACKAGE-ARCHITECTURE.md) draws how the packages depend on one another in each language, and says what each service image runs.
- The contributor's [orientation](../docs/contributor/README.md) covers building and running a change, testing it, and [adding a package](../docs/contributor/README.md#adding-a-package). The pull-request process is in [CONTRIBUTING.md](../CONTRIBUTING.md).
- Each package's README says who uses it and what a change to it must keep.

## License

Apache-2.0
