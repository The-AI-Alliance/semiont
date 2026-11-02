# Local builds

The root [Makefile](../Makefile) is the public build interface. Run one operation per
invocation; `make -j packages launcher` is refused because sessions share caches and a registry.
GNU Make 3.81 is supported. The host needs Bash, Git, Python 3, curl and a container runtime.
Language compilers and package managers run in containers; Make does not replace them.

```sh
make help
make local-build
make plan PACKAGE_NAMES=rust IMAGE_NAMES=worker
```

`make local-build` checks generated code and lockfiles, builds changed packages, publishes
npm packages to fresh local Verdaccio when an image needs them, builds and verifies images,
copies them to other responsive runtimes, and builds the host launcher. It does not start a KB.
Images are tagged `ghcr.io/the-ai-alliance/semiont-<name>:local` and are never pushed.

## Select work

```sh
make local-build PACKAGE_NAMES=typescript IMAGE_NAMES=browser
make packages PACKAGE_NAMES=rust
make packages PACKAGE_NAMES=typescript
make packages PACKAGE_NAMES=typescript/sdk
make images-only IMAGE_NAMES=worker
make launcher
```

`PACKAGE_NAMES` accepts comma-separated `language/name` values or a whole language. Package
names and signatures come from manifests; npm ordering comes from `version.json`. Explicit
selections force their builds. They do not automatically expand a package dependency closure:
build the full language first when a selected TypeScript package's dependency output is missing.
A whole-language TypeScript package operation also builds publishable app artifacts (the Browser).
`packages` builds no images or launcher and starts no registry.

`IMAGE_NAMES` accepts comma-separated image names discovered from Dockerfiles. A selected
image forces rebuilding. `images-only` skips packages, drift/lockfile gates and the launcher;
for the Browser it requires a populated registry left by an earlier local build/publication.
Other images build from source without a registry. It is not a prerequisite-aware image command.

Use `FORCE=1` to rebuild every selected package/image, `FANOUT=0` to leave images only in the
building engine, and `CONTAINER_RUNTIME=container|docker|podman` to choose that engine.
`LAYER_CACHE=directory` enables the Docker Rust layer cache used by Stack Smoke. `make plan`
reads package signatures and selection without building, publishing or updating build state;
image content/store decisions are made during the build, as its output states.

## Publish built npm packages locally

```sh
make packages PACKAGE_NAMES=typescript
make npm-publish-local
```

The publication operation verifies every publishable entry in `version.json`, including the
Browser's built app assets, before starting fresh local Verdaccio at `http://localhost:4873`.
It publishes all entries at the repository version under the local `latest` tag and leaves
Verdaccio running. Missing artifacts fail with a build instruction; presence is not a freshness
proof. It compiles nothing and builds no images or launcher.

Publication runs the existing npm publisher against an isolated copy of its inputs. Version
stamping, dependency pinning and app staging do not edit source manifests or the root lockfile.
The local target always supplies its local registry and temporary authentication; release
publication remains a separate workflow. An unrelated occupant of port 4873 is refused.

Stop the registry when finished, using the runtime that started it:

```sh
container stop semiont-verdaccio
```

## Generate from specifications

```sh
make generate
make check-generated
make generate-python
make check-generated-python
make generate-go
make generate-typescript
make generate-bus
```

`generate` intentionally updates generated files. `check-generated` fails on stale committed
output without repairing it. Checks may install locked tooling, prepare ignored spec bundles
and generate temporary comparison output. They do not compile the application packages.

Focused pairs use `generate-GROUP` and `check-generated-GROUP`, where GROUP is `bus`,
`typescript`, `python`, `go`, `stack-go`, `mcp-tools-go`, `discovery-go`, `encoding-cases` or
`model-catalogue`. The last two derive fixtures from pinned external data rather than OpenAPI.
Python includes both spec tables and OpenAPI models. Go includes shared bus generation and
the OpenAPI client. The aggregate deduplicates shared operations. Existing npm command lists,
Go directives/configuration and toolchain readers own the generator inventory and versions.

TypeScript package builds retain their automatic generation chain. Rust's Cargo build scripts
generate their spec-derived types into build output: `make packages PACKAGE_NAMES=rust` runs
that generation through Cargo. Ordinary local builds check committed drift and never invoke
`make generate` to repair it automatically.

## Launcher and desktop

```sh
make launcher
make desktop
make desktop-macos
make desktop-linux
```

`launcher` builds `apps/launcher/dist/semiont` for the host OS/architecture using the derived
Go container. It runs no unrelated package or image work.

`desktop` selects by caller OS: macOS builds an arm64 DMG, Linux builds an x64 Debian package.
The explicit targets select the installer platform; macOS packaging requires macOS's `hdiutil`.
Linux packaging works from Linux or macOS; macOS cross-packaging with Apple Container uses
Rosetta on Apple Silicon. An ARM Linux host needs its runtime to support amd64 emulation.
The desktop helper uses the selected available runtime, builds its
workspace dependencies, and writes installers to `apps/desktop/release/`. The macOS packaging
step uses a downloaded, checksum-verified temporary Node runtime. Unsupported host OSes fail.
Desktop is not part of `local-build`.

## Verification and implementation

`make smoke SMOKE_TAG=local` runs [the real-stack smoke](tests/stack/smoke-stack.sh) and its
e2e tier. This boots services and requires the selected images and the checkout's launcher.
Stack Smoke CI calls `make local-build` with TypeScript selection, fan-out disabled and a
Docker layer cache. Existing native CI build and release publication commands remain direct.

The Makefile forwards arguments to [the session](scripts/build-session.sh). Owner stages under
`scripts/local-build/` retain drift gates, seven language builds, registry lifecycle, the
three-image batch, exclusive timed image checks, launcher build and cache maintenance.
[Codegen](../packages/codegen/run.py) and [desktop](../apps/desktop/build.sh) retain their owners.

Unchanged packages use content signatures, including transitive dependencies and codegen.
Image reuse also checks the selected runtime's store. The existing build state is shared under
`${XDG_CACHE_HOME:-$HOME/.cache}/semiont`; concurrent sessions remain unsupported. The image
batch remains capped at three builds, independent of Make's job count. Timed Rust checks wait
for competing builds; secondary-runtime copy failures warn without discarding the primary image.
The cache maintenance loop bounds npm, Go, uv, Cargo and Gradle caches; SwiftPM/NuGet are not
bounded by that loop. Failed image builds retain logs and do not record successful signatures.
