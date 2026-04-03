# scripts/ci — Build and Publish

Portable scripts that run identically in GitHub Actions and in local containers.
No npm is required on the host for local builds.

## Scripts

| Script | Purpose |
|--------|---------|
| `build.sh` | Install deps + build packages and apps |
| `publish.sh` | Version stamp + stage + publish to a registry |
| `publish-npm-apps.mjs` | Stage backend/frontend into `.npm-stage/` for publishing |
| `local-build.sh` | Host-side wrapper: start Verdaccio + run build + publish in a container |
| `verdaccio.yaml` | Verdaccio config for local registry (proxies non-@semiont packages to npmjs.com) |

## GitHub Actions

The `publish-npm-packages.yml` workflow calls `build.sh` and `publish.sh`:

```yaml
- run: ./scripts/ci/build.sh
- run: ./scripts/ci/publish.sh --version $VERSION --tag latest
```

## Local Development (no npm on host)

Build and publish to a local Verdaccio registry, then test in KB containers:

```bash
# 1. Build all packages and publish to local Verdaccio
./scripts/ci/local-build.sh

# 2. Build KB containers against local registry
cd /path/to/your-kb
container build --tag semiont-backend \
  --build-arg NPM_REGISTRY=http://host.docker.internal:4873 \
  --file .semiont/containers/Dockerfile.backend .

container build --tag semiont-frontend \
  --build-arg NPM_REGISTRY=http://host.docker.internal:4873 \
  --file .semiont/containers/Dockerfile.frontend .

# 3. Run and test
container run --publish 4000:4000 --volume $(pwd):/kb \
  --env NEO4J_URI=... --env ANTHROPIC_API_KEY=... \
  -it semiont-backend

container run --publish 3000:3000 -it semiont-frontend

# 4. Iterate — edit code, rebuild only what changed:
./scripts/ci/local-build.sh --package cli,backend
# Verdaccio stays running. Old versions are unpublished, new ones published.
# Rebuild whichever KB container changed.

# 5. Done for the day
container rm -f semiont-verdaccio
```

If cached packages are causing issues:

```bash
./scripts/ci/local-build.sh --nuclear
```

This restarts Verdaccio with empty storage and does a full clean rebuild.

## local-build.sh Options

```
Usage:
  local-build.sh [options]

Options:
  --package <list>   Comma-separated packages to build (default: all)
  --skip-build       Skip build, publish only (reuse previous build artifacts)
  --nuclear          Restart Verdaccio with empty storage before building
```

Package names for `--package`:

| Libraries | Apps |
|-----------|------|
| api-client, ontology, core, content | cli |
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
