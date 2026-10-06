# scripts/ci — Build and Publish

Portable scripts that run identically in GitHub Actions and in local containers.
No npm is required on the host for local builds.

## Scripts

| Script | Purpose |
|--------|---------|
| `build.sh` | Install deps + build packages and apps |
| `publish.sh` | Version stamp + stage + publish to a registry |
| `publish-npm-apps.mjs` | Stage the Browser into `.npm-stage/` for publishing |
| `build-python-sdk.sh` | Build the Python SDK's source distribution and wheel at `version.json`'s version, and check them: named for the version, holding the package and no more, and every module importable from the installed wheel alone. CI and `local-build.sh` run it; `publish-pypi.yml` uploads what it leaves |
| `image-tags.sh` | The image a service publishes to and its tags (version, `sha-<commit>`, optionally `latest`), for every job of `publish-service-images.yml` that names one |
| `local-build.sh` | Host-side wrapper: start Verdaccio + build + publish in a container + build the `:local` service/browser images, fanned out to every container engine on the machine; then the launcher, and the Python SDK's distributions (`build-python-sdk.sh`), which are built and checked and published nowhere |
| `go-toolchain.sh` | Print the Go toolchain `apps/launcher/go.mod` pins. The one reader of that line, for everything that names a Go image: `local-build.sh` and the `go:generate` lines of `packages/sdk-go` and `apps/launcher` |
| `rust-toolchain.sh` | Print the Rust toolchain `rust-toolchain.toml` names. The one reader of its `channel`, for everything that builds a Rust image: `local-build.sh`, `apps/desktop/build.sh`, `publish-service-images.yml` and `scripts/container/build-images.js` |
| `verdaccio.yaml` | Verdaccio config for local registry (proxies non-@semiont packages to npmjs.com) |

## GitHub Actions

The `publish-npm-packages.yml` workflow calls `build.sh` and `publish.sh`:

```yaml
- run: ./scripts/ci/build.sh
- run: ./scripts/ci/publish.sh --version $VERSION --tag latest
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
./scripts/ci/local-build.sh

# 2. Run the full stack from your KB against the :local images
cd /path/to/your-kb
SEMIONT_VERSION=local /path/to/semiont/apps/launcher/dist/semiont start
/path/to/semiont/apps/launcher/dist/semiont useradd --email admin@example.com

# 3. Iterate — edit code, rebuild only what changed:
./scripts/ci/local-build.sh --package core,make-meaning --image archivist
# Verdaccio restarts fresh each run; the publish step always publishes all
# packages, and --image narrows which images are rebuilt.

# 4. Done for the day
container rm -f semiont-verdaccio
```

## local-build.sh Options

`./scripts/ci/local-build.sh --help` lists them.

The names `--package` takes, and the order they build in, are `version.json`'s
packages; an unknown name is refused with the list.

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
