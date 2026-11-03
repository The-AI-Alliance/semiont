# Packages

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/branch/main/graph/badge.svg)](https://codecov.io/gh/The-AI-Alliance/semiont)

The libraries Semiont is built from, in five languages. The services are in [images/](../images/README.md), and the tools that run on a host in [apps/](../apps/README.md). What they share, and what a program outside this repository installs, is here.

| Language | What is here | Published to |
|---|---|---|
| [TypeScript](./typescript/README.md) | The SDK, its transport and its telemetry, and the React components | npm |
| [Rust](./rust/README.md) | The SDK and its transport, and what the gateway, the dispatcher and the Archivist share | crates.io: the SDK, its transport, and the codegen and telemetry crates they are built on |
| [Python](./python/README.md) | The SDK, and what the Librarian, the Smelter, the Weaver and the Worker share | PyPI: the SDK alone |
| [Go](./go/README.md) | The SDK, and the launcher's libraries | The Go module proxy, by a tag at each release: the SDK alone |
| [C#](./csharp/README.md) | The .NET SDK, under construction | Not published |
| [Kotlin](./kotlin/README.md) | The SDK, for Kotlin and Java programs | Not published |
| [Swift](./swift/README.md) | The SDK for Apple apps and Linux services | Not published |

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
| C# / .NET | Not published: project reference when implemented | [csharp/sdk](./csharp/sdk/README.md) |
| Kotlin or Java | Not published: [build its jar](./kotlin/sdk/README.md#installing) | [kotlin/sdk](./kotlin/sdk/README.md) |
| A React interface | `npm install @semiont/react-ui`, beside the SDK | [typescript/react-ui](./typescript/react-ui/README.md) |

The rest is what those are built on, and what Semiont's own services are built on.

## Working on a package

- [Package Architecture](../docs/architecture/PACKAGE-ARCHITECTURE.md) draws how the packages depend on one another in each language, and says what each service image runs.
- The contributor's [orientation](../docs/contributor/README.md) covers building and running a change, testing it, and [adding a package](#adding-a-package). The pull-request process is in [CONTRIBUTING.md](../CONTRIBUTING.md).
- Each package's README says who uses it and what a change to it must keep.

## Adding a package

1. Create `packages/<language>/<name>/` with its manifest, following a neighbor. A TypeScript package is named `@semiont/<name>`, and depends on other `@semiont/*` packages as `"*"`, never a version ([why](../docs/contributor/DEPENDENCIES.md#how-packages-here-depend-on-each-other)).
2. A TypeScript package goes in [`version.json`](../version.json) too, after the packages it depends on. The order there is the build order, and `publish` says whether it ships to npm. A package missing from `version.json` is not built by `make local-build`, and anything that installs it gets a 404. Its `vitest.config.ts` merges the [shared config](typescript/vitest.shared.config.ts), and it has a `test:coverage` script; `npm run lint:vitest-coverage` says what else that needs.
3. Its coverage is named five times: a flag and a component `<language>-<name>` in [`codecov.yml`](../.github/codecov.yml), an upload under that flag in `ci.yml`, a badge in its README, and a row in its language's README. `npm run lint:coverage-roster` names each one missing, and `npm run lint:workflows` a directory that no area of `ci.yml` runs on.
4. A package that will be published needs seeding before its first release ([Release](../docs/contributor/RELEASE.md#a-new-package)).

## License

Apache-2.0

## Generation tooling

[codegen/](codegen/README.md) holds shared bus and schema generators across languages.
Their declarative inputs and fixtures stay in `protocol/specs/`. Language-wide build and
release helpers live under each language's `scripts/` directory; tooling for one
package lives with that package.

## Conformance

The packages here are implementations of the protocol, and the conformance kit holds
each SDK, and each service built on them, to it: [protocol/conformance](../protocol/conformance/README.md).
