# Contributing to Semiont: orientation

A contributor changes Semiont itself: fixes a bug, adds a feature, writes a driver, improves a doc. These pages say where the code lives, how to build and run a change, how it is tested, and how it is released.

The process around a change (forks, branches, pull requests, review) is in **[CONTRIBUTING.md](../../CONTRIBUTING.md)**. How Semiont works inside is in **[../architecture/](../architecture/README.md)**, and what its parts agree on is in **[../protocol/](../protocol/README.md)**. Read those before changing behavior.

## What you need

A container runtime (Apple `container`, Docker or Podman) and `git`. Nothing else has to be installed: [`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) builds every package, every image and the launcher inside containers. See [Local Development](LOCAL-DEVELOPMENT.md).

To run tools directly on your machine instead, the versions are:

| Toolchain | Version | Stated in |
|---|---|---|
| Node.js | 24 | `engines` in [`package.json`](../../package.json) |
| Rust | the pinned channel | [`rust-toolchain.toml`](../../rust-toolchain.toml) |
| Go | the `toolchain` line | `go.mod` in [`apps/launcher`](../../apps/launcher/go.mod) and [`packages/sdk-go`](../../packages/sdk-go/go.mod) |

## Three workspaces, one spec

The repository holds code in three languages, and none of them depends on another. What they agree on is in `specs/`, and each generates its types from it.

- **npm workspaces** (`apps/*`, `packages/*`, `tests/doc-snippets`): the TypeScript packages and the Browser.
- **A Cargo workspace**: the gateway, the dispatcher, and the Rust SDK's crates.
- **Two Go modules**: the launcher (`apps/launcher`) and the Go SDK (`packages/sdk-go`).

[Package Architecture](../architecture/PACKAGE-ARCHITECTURE.md) draws both dependency graphs and says what each service image runs.

## Repository layout

```text
semiont/
├── specs/                  # The spec every implementation is built against
│   └── src/                #   OpenAPI paths and schemas, the bus registry, and the
│                           #   shared case tables (principals, retry, media types, …)
├── apps/
│   ├── gateway/            # Rust: verifies tokens, relays the bus, proxies content
│   ├── dispatcher/         # Rust: owns the job queue
│   ├── archivist/          # Image definitions for the five Node services;
│   ├── librarian/          #   their code is in @semiont/make-meaning
│   ├── smelter/            #   and @semiont/jobs
│   ├── weaver/
│   ├── worker/
│   ├── browser/            # The Semiont Browser: a Vite + React single-page app
│   ├── desktop/            # The Browser as a desktop app (Tauri)
│   └── launcher/           # Go: the `semiont` command
├── packages/
│   ├── core/               # Generated types, typed ids, the bus protocol, config loaders
│   ├── sdk/                # The TypeScript SDK
│   ├── http-transport/     # The SDK's transport over a gateway
│   ├── react-ui/           # React components and hooks
│   ├── make-meaning/       # The knowledge-system actors and four services' entry points
│   ├── jobs/               # The job worker and its entry point
│   ├── event-sourcing/     # The event log and the views
│   ├── content/            # Working-tree storage and text extraction
│   ├── graph/ vectors/ inference/ ontology/ observability/ mcp-server/
│   ├── sdk-rust/           # The Rust SDK (crate `semiont`), with
│   ├── http-transport-rust/ telemetry-rust/ codegen-rust/
│   ├── core-rust/ observability-rust/    # what the Rust services share
│   └── sdk-go/             # The Go SDK
├── tests/
│   ├── conformance/        # Black-box suites: the gateway, the dispatcher, every SDK
│   ├── e2e/                # Playwright, against a live stack
│   └── doc-snippets/       # Typechecks the code in the docs
├── scripts/                # ci/, release/, lint/, compliance/, spec/, container/, dev/
├── docs/                   # By persona: analyst/, builder/, operator/, contributor/;
│                           #   and for every reader: architecture/, protocol/
└── website/                # The project site
```

Each app and package has a README, and most have a `docs/` directory about how that part is built. [packages/README.md](../../packages/README.md) and [apps/README.md](../../apps/README.md) list them.

## The docs for contributors

| Doc | What it covers |
|---|---|
| [LOCAL-DEVELOPMENT.md](LOCAL-DEVELOPMENT.md) | Building your working tree into images and running a stack on them; working on one package without a stack |
| [TESTING.md](TESTING.md) | The suites, how each is configured and run, the test doubles, and what CI gates |
| [DEPENDENCIES.md](DEPENDENCIES.md) | Dependabot, fixing a CVE, the lockfile rule, and how packages in this repository depend on each other |
| [RELEASE.md](RELEASE.md) | Releasing: one dispatch, what it publishes, and how to verify it |

## Adding a package

1. Create `packages/<name>/` with a `package.json`, `tsconfig.json` and build config, following a neighbor. Name it `@semiont/<name>`. Depend on other `@semiont/*` packages as `"*"`, never a version ([why](DEPENDENCIES.md#how-packages-here-depend-on-each-other)).
2. Add it to [`version.json`](../../version.json), after the packages it depends on. The order there is the build order, and `publish` says whether it ships to npm. A package missing from `version.json` is not built by `local-build.sh`, and anything that installs it gets a 404.
3. Give it a `vitest.config.ts` that merges the [shared config](../../vitest.shared.config.ts), and a `test:coverage` script. `npm run lint:vitest-coverage` and `npm run lint:coverage-roster` say what else has to list it.
4. A package that will be published needs seeding on npm before its first release ([Release](RELEASE.md#a-new-package)).

## Where to go for the rest

- [CONTRIBUTING.md](../../CONTRIBUTING.md): the pull-request process
- [Architecture](../architecture/README.md): the actors, the stores, and why the pieces are shaped as they are
- [Adding a media type](../architecture/MEDIA-TYPES.md#adding-a-media-type): what a media type declares, and what each declaration costs
- [Protocol](../protocol/README.md): the flows, the bus, the transport contract
- [Builder docs](../builder/README.md): the SDKs, as someone building on them sees them
- [Operator docs](../operator/README.md): running what you built
