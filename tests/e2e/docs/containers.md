# Containers and rebuild flow

The e2e harness drives the Browser **container**, which talks to the
gateway **container**. All five Semiont images bundle `@semiont/*`
packages — a change to a package isn't visible to the tests until the
images are rebuilt and the stack is restarted from them. This doc walks
through that lifecycle.

## The moving parts

| Container | What's inside | Where it comes from |
|---|---|---|
| `semiont-browser` | Vite-built SPA served on `:3000` | published image, or `:local` via `scripts/ci/local-build.sh` |
| `semiont-gateway` | `@semiont/gateway` on `:4000` | published image, or `:local` via `scripts/ci/local-build.sh` |
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
| `packages/react-ui`, `packages/http-transport`, `packages/core` | `local-build.sh` | browser |
| `apps/browser` only | `local-build.sh` | browser |
| `packages/make-meaning`, `packages/event-sourcing`, etc. — anything the gateway imports | `local-build.sh` (rebuilds the `:local` images) | the stack: `SEMIONT_VERSION=local semiont start` |
| `apps/gateway` | `local-build.sh` | the stack: `SEMIONT_VERSION=local semiont start` |

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

Use `container logs -f semiont-gateway` when diagnosing a failing test
— the gateway's structured logs often reveal whether a bus handler
actually ran. (`semiont logs`, from the KB directory, follows all
services at once with `[svc]` prefixes.)

## <a name="ip-refresh"></a>IP refresh after every restart

Apple's container runtime assigns a **fresh bridge IP** on every
`container run` and every `container start`. The `192.168.64.x` value
from your last session is stale the moment either the gateway or
Browser restarts, even if you didn't rebuild.

Symptom: every request in your first test times out because the
browser is dialing a dead address.

```sh
container ls | grep -E 'semiont-(browser|gateway)'    # inspection only
```

> Useful for *seeing* what is running. Do **not** feed these IPs to the e2e
> suite — they change on every restart, and pointing the suite at the gateway
> container also breaks `19-worker-vitals`, which expects the worker's `:9090`
> on the same host as the gateway. Use `192.168.64.1` for both URLs.

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
echo password | semiont useradd --email admin@example.com --admin
```

The `ollama-gemma` config avoids the API-key requirement if you only
need to exercise non-inference paths.

`semiont start` stops and recreates the running containers, so their IPs
change. **That is exactly why e2e should not use them** — target the host
bridge gateway `192.168.64.1`, which routes to the published ports and is
stable across restarts. See
[running.md](running.md#running-from-a-container-recommended-on-macos).

## Playwright image tag must match `@playwright/test`

The container invocation must use a tag matching the installed
`@playwright/test`. Derive it (`PW=$(node -p "require('./node_modules/@playwright/test/package.json').version")`)
rather than hardcoding — this page previously named `v1.61.0-noble` while the
lockfile carried 1.62.0. If `npm install` upgrades the library, pull the
matching image:

```sh
container image pull mcr.microsoft.com/playwright:v<version>-noble
```

A mismatch produces a "please update docker image as well" error at
test startup.
