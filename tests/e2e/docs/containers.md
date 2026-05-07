# Containers and rebuild flow

The e2e harness drives the frontend **container**, which talks to the
backend **container**, which was built against code installed from a
local **Verdaccio** npm registry. A change to a `@semiont/*` package
isn't visible to the tests until it's republished and the consuming
container is rebuilt. This doc walks through that lifecycle.

## The moving parts

| Container | What's inside | Built by |
|---|---|---|
| `semiont-verdaccio` | Local npm registry on `:4873` | `scripts/ci/local-build.sh` |
| `semiont-frontend` | Vite-built SPA served on `:3000` | `scripts/ci/local-build.sh` (via `apps/frontend/Dockerfile`) |
| `semiont-backend` | Node process running `@semiont/backend` on `:4000` | KB's `.semiont/scripts/start.sh` |
| `semiont-worker`, `semiont-smelter` | Background job workers | KB's `.semiont/scripts/start.sh` |
| plus: `semiont-neo4j`, `semiont-qdrant`, `semiont-ollama`, `semiont-postgres` | Storage + inference | KB's `.semiont/scripts/start.sh` |

**Key fact:** `scripts/ci/local-build.sh` (in this repo) only builds
the **frontend** image and publishes `@semiont/*` packages to
Verdaccio. It does **not** build the backend image. The backend image
is built by the KB's own `start.sh`, which `npm install`s
`@semiont/backend` from `$NPM_REGISTRY`.

So the "full rebuild" flow depends on what changed:

| Change in | Rebuild | Restart |
|---|---|---|
| `packages/react-ui`, `packages/api-client`, `packages/core` | `local-build.sh` | frontend |
| `apps/frontend` only | `local-build.sh` | frontend |
| `packages/make-meaning`, `packages/event-sourcing`, etc. — anything the backend imports | `local-build.sh` (republishes) **and** KB `start.sh --no-cache` | backend (start.sh handles it) |
| `apps/backend` | KB `start.sh --no-cache` | backend |

## Apple container CLI primer

Everything is one container per service on the `192.168.64.0/24`
bridge. No compose, no swarm.

```sh
container ls                              # list running
container ls | grep semiont-              # list the dev stack
container stop <name>                     # graceful stop
container logs <name>                     # tail logs (add -f to follow)
container exec <name> <cmd>               # run a command inside
container image ls                        # list local images
container inspect <name>                  # JSON dump — mounts, env, IP, etc.
```

Use `container logs -f semiont-backend` when diagnosing a failing test
— the backend's structured logs often reveal whether a bus handler
actually ran.

## <a name="ip-refresh"></a>IP refresh after every restart

Apple's container runtime assigns a **fresh bridge IP** on every
`container run` and every `container start`. The `192.168.64.x` value
from your last session is stale the moment either the backend or
frontend restarts, even if you didn't rebuild.

Symptom: every request in your first test times out because the
browser is dialing a dead address.

```sh
container ls | grep -E 'semiont-(frontend|backend)'    # do this EVERY time
```

## Publishing packages to Verdaccio

```sh
./scripts/ci/local-build.sh --package <list>
```

`--help` lists the full package set. The order is:
`api-client, ontology, core, content, event-sourcing, graph,
inference, jobs, make-meaning, react-ui, backend, frontend, cli`. The
flag takes a comma-separated subset.

The script:

1. Starts a fresh `semiont-verdaccio` container on `:4873`.
2. Builds each package in a node:24-alpine container.
3. Publishes to Verdaccio.
4. Builds `semiont-frontend:latest` with `NPM_REGISTRY` pointing at
   Verdaccio, so the frontend installs the freshly-published
   packages.

Output ends with a `DONE ✓` banner. Leave the Verdaccio container up
— the backend rebuild needs it. Stop it manually when done:
`container stop semiont-verdaccio`.

## Rebuilding the frontend

After `local-build.sh` (which already built the image), swap the
container:

```sh
container ls | grep semiont-frontend    # note the current id
container stop <id>
container run --detach --publish 3000:3000 --name semiont-frontend semiont-frontend:latest
```

Then re-grab the frontend IP and re-run e2e (see
[IP refresh](#ip-refresh)).

## Rebuilding the backend

The backend is run from the KB project directory, not this repo. For
the template KB:

```sh
cd /path/to/semiont-template-kb
export NPM_REGISTRY=http://192.168.64.1:4873
# start.sh reads ANTHROPIC_API_KEY from env when --config anthropic.
# Source your secrets first if it's not already exported.
.semiont/scripts/start.sh \
  --config anthropic \
  --email admin@example.com \
  --password password \
  --no-cache
```

The `ollama-gemma` config avoids the API-key requirement if you only
need to exercise non-inference paths.

- `NPM_REGISTRY` points at the local Verdaccio (which
  `local-build.sh` leaves running). Without it, `start.sh` installs
  `@semiont/backend` from npmjs and your local changes are invisible.
- `--no-cache` forces a fresh image build. Without it, the
  `npm install` layer is cached and the new package versions are
  skipped.
- `.semiont/scripts/start.sh` builds `semiont-backend`,
  `semiont-worker`, and `semiont-smelter`, then starts them together
  with the storage + inference containers.

Running `start.sh` will stop and recreate the backend container, so
its IP will change — re-grab it before re-running e2e.

## Playwright image tag must match `@playwright/test`

The container invocation pins a specific tag:
`mcr.microsoft.com/playwright:v1.59.1-noble`. If `npm install`
upgrades `@playwright/test`, pull the matching image:

```sh
container image pull mcr.microsoft.com/playwright:v<version>-noble
```

A mismatch produces a "please update docker image as well" error at
test startup.
