# Local builds

Portable scripts that run identically in GitHub Actions and in local containers.
No npm is required on the host for local builds.

## Build tooling

| Script | Purpose |
|--------|---------|
| `packages/typescript/scripts/build.sh` | Install deps + build packages and apps |
| `packages/typescript/scripts/publish.sh` | Version stamp + stage + publish to a registry, each package with the repository's `LICENSE` copied into the directory it publishes from |
| `packages/typescript/scripts/publish-npm-apps.mjs` | Stage the Browser into `.npm-stage/` for publishing |
| `packages/python/sdk/scripts/build-python-sdk.sh` | Build the Python SDK's source distribution and wheel at `version.json`'s version, and check them: named for the version, holding the package and no more, each carrying the repository's `LICENSE` (copied beside `pyproject.toml` for the build) and naming it in its metadata, and every module importable from the installed wheel alone. CI and `local-build.sh` run it; `publish-pypi.yml` uploads what it leaves |
| `images/scripts/image-tags.sh` | The image a service publishes to and its tags (version, `sha-<commit>`, optionally `latest`), for every job of `publish-service-images.yml` that names one |
| `images/local-build.sh` | Host-side wrapper: build every package, each in its language's container, and every `:local` image, fanned out to every container engine on the machine, skipping what is unchanged; publish the npm packages to a Verdaccio it starts when an image installs from one; then the launcher |
| `images/scripts/package-signatures.py` | The packages `local-build.sh` builds, `packages/<language>/<name>`, and the signature of what each is built from, its dependencies' among it, by which it skips one that is unchanged |
| `packages/go/scripts/go-toolchain.sh` | Print the Go toolchain `apps/launcher/go.mod` pins. The one reader of that line, for everything that names a Go image: `local-build.sh` and the `go:generate` lines of `packages/go/sdk` and `apps/launcher` |
| `packages/swift/scripts/swift-version.sh` | Print the Swift version pinned by `packages/swift/sdk/.swift-version` for local builds and CI. |
| `packages/kotlin/scripts/jdk-version.sh` | Print the JDK the Kotlin SDK is built on, what `packages/kotlin/sdk/.java-version` holds. The one script that reads that file, for everything that names a JDK image: `local-build.sh` and the Kotlin SDK's job of `ci.yml` (setup-java and the SDK's Gradle build read it themselves) |
| `packages/go/launcher/scripts/neo4j-image.sh` | Print the neo4j image the launcher starts for the graph role, from its row of `packages/go/launcher/descriptors.go`. The one reader of that row for a test: the "Python Graph Stores (neo4j)", "Weaver Conformance" and "Librarian Conformance" jobs of `ci.yml`, and a developer starting a container for any of those suites |
| `packages/go/launcher/scripts/keycloak-image.sh` | Print the Keycloak image the launcher starts for the identity role, from its row of `packages/go/launcher/descriptors.go`. The one reader of that row for a test: the "Launcher Tests (Go, Keycloak)" job of `ci.yml`, and a developer starting a container for the launcher's live tests |
| `packages/go/launcher/scripts/qdrant-image.sh` | Print the Qdrant image the launcher starts for the vectors role, from its row of `packages/go/launcher/descriptors.go`. The one reader of that row for a test: the "Python Vector Stores (Qdrant)", "Smelter Conformance" and "Librarian Conformance" jobs of `ci.yml`, and a developer starting a container for any of those suites |
| `packages/typescript/scripts/node-version.sh` | Print the Node that builds and tests the repository, what `.node-version` holds. The one reader of that file for the scripts: `local-build.sh`, `apps/desktop/build.sh` and `.github/release/version-bump.sh` |
| `packages/python/scripts/python-floor.sh` | Print the oldest Python the SDK supports, the `requires-python` of `packages/python/sdk/pyproject.toml`. The one reader of that line: `local-build.sh`, `publish-service-images.yml` (the four Python images run on it), the SDK's model generator and `lint:python-version` ask it |
| `packages/rust/scripts/rust-toolchain.sh` | Print the Rust toolchain `rust-toolchain.toml` names. The one reader of its `channel`, for everything that builds a Rust image: `local-build.sh`, `apps/desktop/build.sh`, `publish-service-images.yml` and `images/scripts/build-images.js` |
| `packages/rust/scripts/instrument-coverage.sh` | cargo's `RUSTC_WORKSPACE_WRAPPER` for the Rust binaries CI builds for the conformance suites: the workspace's own crates instrumented for coverage, their dependencies not |
| `images/scripts/verdaccio.yaml` | Verdaccio config for local registry (proxies non-@semiont packages to npmjs.com) |

## GitHub Actions

The `publish-npm-packages.yml` workflow calls `build.sh` and `publish.sh`:

```yaml
- run: ./packages/typescript/scripts/build.sh
- run: ./packages/typescript/scripts/publish.sh --version $VERSION --tag latest
```

## Local Development (no npm on host)

Build and publish to a local Verdaccio registry, build the container images
against it, then run them from a KB. KBs don't build anything — they consume
images (the same production Dockerfiles the publish workflows use), tagged
`ghcr.io/the-ai-alliance/semiont-<svc>:local` (local-only, never pushed).
Built images are loaded into every responsive container engine on the machine
(container/docker/podman), so the KB's `--runtime` choice is independent of
who built — `CONTAINER_RUNTIME` picks the *build* engine only, and
`--no-fanout` leaves them in that engine's store alone:

```bash
# 1. Build all packages, publish to local Verdaccio, build every image
./images/local-build.sh

# 2. Run the full stack from your KB against the :local images: name them in
#    .semiont/stack/*.yaml (e.g. ghcr.io/the-ai-alliance/semiont-gateway:local),
#    and the Browser's and the worker's in their own documents
cd /path/to/your-kb
perl -pi -e 's#(semiont-browser):\S+#$1:local#' "$(/path/to/semiont/apps/launcher/dist/semiont settings browser --path)"
perl -pi -e 's#(semiont-worker):\S+#$1:local#' "$(/path/to/semiont/apps/launcher/dist/semiont settings worker --path)"
/path/to/semiont/apps/launcher/dist/semiont start
/path/to/semiont/apps/launcher/dist/semiont useradd --email admin@example.com

# 3. Iterate — edit code and run it again: what is unchanged is skipped, or
#    name what to build:
./images/local-build.sh --package typescript/core,typescript/react-ui --image browser
# Verdaccio restarts fresh each run; the publish step always publishes all
# npm packages, and --image narrows which images are rebuilt.

# 4. Done for the day
container rm -f semiont-verdaccio
```

## local-build.sh Options

`./images/local-build.sh --help` lists them.

`--package` takes `<language>/<name>`, or a language for all of its packages;
the npm packages build in the order `version.json` lists them. An unknown name
is refused with the list.

The publish step always publishes all packages regardless of `--package`.

## build.sh Options

```
Usage:
  build.sh [options]

Options:
  --package <list>   Comma-separated packages to build (default: all)
```

Dependencies are always installed and the OpenAPI spec is always bundled.

## publish.sh Options

```
Usage:
  publish.sh [options]

Options:
  --registry <url>   Target registry (default: https://registry.npmjs.org)
  --tag <tag>        Dist tag: latest or dev (default: latest)
  --version <ver>    Override publish version (default: from version.json)
  --clean            Unpublish existing versions before publishing (for local Verdaccio)
  --npmrc <path>     Path to .npmrc for registry auth
  --dry-run          Stage but do not publish
```
