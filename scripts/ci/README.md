# scripts/ci — Build and Publish

Portable scripts that run identically in GitHub Actions and in local containers.
No npm is required on the host for local builds.

## Scripts

| Script | Purpose |
|--------|---------|
| `build.sh` | Install deps + build packages and apps |
| `publish.sh` | Version stamp + stage + publish to a registry |
| `publish-npm-apps.mjs` | Stage backend/frontend into `.npm-stage/` for publishing |
| `local-build.sh` | Host-side wrapper: start Verdaccio + build + publish in a container + build the `:local` service/frontend images, fanned out to every container engine on the machine |
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
who built — `CONTAINER_RUNTIME` picks the *build* engine only:

```bash
# 1. Build all packages, publish to local Verdaccio, build all five images
#    (backend, worker, smelter, weaver, frontend)
./scripts/ci/local-build.sh

# 2. Run the full stack from your KB against the :local images
cd /path/to/your-kb
SEMIONT_VERSION=local ./.semiont/scripts/start.sh \
  --email admin@example.com --password password

# 3. Iterate — edit code, rebuild only what changed:
./scripts/ci/local-build.sh --package cli,backend --image backend
# Verdaccio restarts fresh each run; the publish step always publishes all
# packages, and --image narrows which images are rebuilt.

# 4. Done for the day
container rm -f semiont-verdaccio
```

## local-build.sh Options

```
Usage:
  local-build.sh [options]

Options:
  --package <list>   Comma-separated packages to build (default: all)
  --start-from <pkg> Skip packages before this one in the build order
  --skip-build       Skip build, publish only (reuse previous build artifacts)
  --image <list>     Comma-separated images to build
                     (default: backend,worker,smelter,weaver,frontend)
```

Package names for `--package`:

| Libraries | Apps |
|-----------|------|
| http-transport, ontology, core, content | cli |
| event-sourcing, graph, inference | backend |
| jobs, make-meaning, react-ui | frontend |

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
