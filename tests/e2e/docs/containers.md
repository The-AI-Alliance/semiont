# Containers and rebuild flow

The e2e harness drives the frontend **container**, which talks to the
backend **container**. All five Semiont images bundle `@semiont/*`
packages — a change to a package isn't visible to the tests until the
images are rebuilt and the stack is restarted from them. This doc walks
through that lifecycle.

## The moving parts

| Container | What's inside | Where it comes from |
|---|---|---|
| `semiont-frontend` | Vite-built SPA served on `:3000` | published image, or `:local` via `scripts/ci/local-build.sh` |
| `semiont-backend` | `@semiont/backend` on `:4000` | published image, or `:local` via `scripts/ci/local-build.sh` |
| `semiont-worker`, `semiont-smelter`, `semiont-weaver` | Background workers / pipeline actors | published images, or `:local` via `scripts/ci/local-build.sh` |
| plus: `semiont-neo4j`, `semiont-qdrant`, `semiont-ollama`, `semiont-postgres` | Storage + inference | started by `semiont start` |

**Key fact:** `scripts/ci/local-build.sh` (in this repo) publishes the
`@semiont/*` packages to a throwaway local Verdaccio and builds **all
five** Semiont images from them as local-only `:local` tags (plus the
launcher binary). KB repos build nothing — the stack consumes the
`:local` images only when started with `SEMIONT_VERSION=local semiont
start`; without that, the launcher pulls the published images and your
local changes are invisible.

So the "full rebuild" flow depends on what changed:

| Change in | Rebuild | Restart |
|---|---|---|
| `packages/react-ui`, `packages/http-transport`, `packages/core` | `local-build.sh` | frontend |
| `apps/frontend` only | `local-build.sh` | frontend |
| `packages/make-meaning`, `packages/event-sourcing`, etc. — anything the backend imports | `local-build.sh` (rebuilds the `:local` images) | the stack: `SEMIONT_VERSION=local semiont start` |
| `apps/backend` | `local-build.sh` | the stack: `SEMIONT_VERSION=local semiont start` |

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
actually ran. (`semiont logs`, from the KB directory, follows all
services at once with `[svc]` prefixes.)

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

## Building the `:local` images

```sh
./scripts/ci/local-build.sh                 # everything
./scripts/ci/local-build.sh --package <list>  # narrow the package set
./scripts/ci/local-build.sh --image <list>    # narrow the image set
```

`--help` lists the full package set. The script:

1. Starts a fresh `semiont-verdaccio` container on `:4873`.
2. Builds each package in a node:24-alpine container and publishes it
   to Verdaccio.
3. Builds the five Semiont images against Verdaccio, tagged
   `ghcr.io/the-ai-alliance/semiont-<svc>:local` (never pushed), and
   loads them into every container engine on the machine.
4. Builds the launcher binary to `apps/launcher/dist/semiont`.

Output ends with a `DONE ✓` banner. `--no-cache` matters when you
republish the **same package version**: the `npm install` layer is
cached by version, so a same-version republish is invisible without it.

## Restarting the stack on new images

The stack is run from the KB project directory, not this repo. For the
template KB:

```sh
cd /path/to/semiont-template-kb
# semiont start reads ANTHROPIC_API_KEY from env when --config anthropic.
# Source your secrets first if it's not already exported.
SEMIONT_VERSION=local semiont start --config anthropic
semiont useradd --email admin@example.com --password password --admin
```

The `ollama-gemma` config avoids the API-key requirement if you only
need to exercise non-inference paths.

`semiont start` stops and recreates the running containers, so their
IPs change — re-grab them before re-running e2e (see
[IP refresh](#ip-refresh)).

## Playwright image tag must match `@playwright/test`

The container invocation pins a specific tag:
`mcr.microsoft.com/playwright:v1.61.0-noble`. If `npm install`
upgrades `@playwright/test`, pull the matching image:

```sh
container image pull mcr.microsoft.com/playwright:v<version>-noble
```

A mismatch produces a "please update docker image as well" error at
test startup.
