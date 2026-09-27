# End-to-End Smoke Tests

Real-browser Playwright tests that drive the Browser against a locally
running gateway. Intended to catch cross-layer regressions (SSE timing,
React lifecycle, bus round-trips) that unit and component tests can't.

## Quick start

Prereqs: the dev stack is up, with its ports published on the host. Full
rebuild/start flow in [docs/containers.md](docs/containers.md).

```sh
# The image tag MUST match the installed library — see "Version pinning" below.
PW=$(node -p "require('./node_modules/@playwright/test/package.json').version")

container run --rm \
  -v "$(git rev-parse --show-toplevel):/workspace" \
  -w /workspace/tests/e2e \
  -e E2E_EMAIL=admin@example.com \
  -e E2E_PASSWORD=password \
  -e E2E_BROWSER_URL=http://192.168.64.1:3000 \
  -e E2E_GATEWAY_URL=http://192.168.64.1:4000 \
  -e CI=1 \
  "mcr.microsoft.com/playwright:v$PW-noble" \
  npm test
```

> **Use `192.168.64.1` — the host bridge gateway — not a container's own IP.**
> It is stable across restarts and routes to every published port. See
> [Container networking](#container-networking-reaching-the-host) for why.
>
> A container's own IP (from `container ls`) fails twice over:
>
> - **Container IPs change on every stack restart.** Reusing an address read
>   even minutes earlier fails in `globalSetup` with
>   `connect EHOSTUNREACH <ip>:4000`, before a single spec executes.
> - **It splits services across hosts.** `19-worker-vitals` derives the
>   worker's health endpoint as `<gateway-host>:24100`, because the published
>   ports are co-located on the host. Point the suite at the *gateway
>   container's* IP and that becomes the gateway's own `:24100`, which nothing
>   is listening on — `ECONNREFUSED`.
>
> `--network host` does not help: it is a Docker flag, and Apple's `container`
> rejects it with `Error: network host not found`.

> Use `npm test`, not `npx playwright test`: the `pretest` hook typechecks
> the specs first (`tsc --noEmit`) and aborts before launching a browser.
> `tests/e2e` is not a root workspace, so this gate is the ONLY thing that
> typechecks these files — bypassing it means an SDK signature change
> surfaces as a runtime `TypeError` minutes in, instead of a file:line.

> If every test fails in the `signIn` fixture with *"Request failed due
> to a network error"*, the Playwright container can't reach the
> host-published gateway — see [Container networking](#container-networking-reaching-the-host).

## Version pinning: the image must match the installed library

Playwright refuses to run when the browser image and the `@playwright/test`
library disagree, so the tag is not decorative. Derive it rather than typing
it — `$PW` above reads the version off disk, which is the one source that
cannot be stale relative to what is about to run.

Dependabot bumps `package.json` and `package-lock.json` together, but
nothing installs them here, so the declared and installed versions diverge
silently until someone runs `npm ci`; a hard-coded tag would make a third.

**Nothing else catches this.** `tests/e2e` is not a root workspace and no CI
workflow runs it, so the suite's dependencies are only ever installed by a
person deciding to. After a Dependabot bump, sync before running:

```sh
npm ci        # installs the lockfile EXACTLY; never rewrites it
```

Use `npm ci`, not `npm install`: `ci` cannot alter `package-lock.json`, so
syncing your `node_modules` can never quietly re-resolve the suite's
dependencies for everyone else. The lockfile is tracked and is the authority.

## Container networking: reaching the host

The suite runs in a Playwright **container**, but the Browser and gateway
are published on the **host**. A containerized browser **can't use
`localhost`** — inside the container that resolves to the container itself,
not the host. And pinning a container's bridge IP is fragile: container IPs
change on every restart.

The robust target is the **host bridge gateway**, `192.168.64.1`: it's
reachable from inside containers, routes to the host's *published* ports
(`:3000`→browser, `:4000`→gateway), and its address is **stable across
restarts**.

> **No CORS origin to configure.** The gateway serves open CORS
> (`Access-Control-Allow-Origin: *`, bearer-only — no credentials), so the
> browser signs in from *any* origin.

Run the suite against the gateway for **both** URLs, with the Browser
published on host port 3000 (`-p 3000:3000`; the gateway already publishes
`4000`). No IP-grabbing needed — the gateway doesn't change between runs:

```sh
container run --rm \
  -v "$(git rev-parse --show-toplevel):/workspace" \
  -w /workspace/tests/e2e \
  -e E2E_EMAIL=admin@example.com \
  -e E2E_PASSWORD=password \
  -e E2E_BROWSER_URL=http://192.168.64.1:3000 \
  -e E2E_GATEWAY_URL=http://192.168.64.1:4000 \
  -e CI=1 \
  "mcr.microsoft.com/playwright:v$PW-noble" \
  npm test
```

## Docs

- [Running tests](docs/running.md) — invocation, single spec, headed,
  `--repeat-each`, host vs. container.
- [Containers and rebuild flow](docs/containers.md) — Apple container
  CLI, Verdaccio, rebuilding gateway/Browser after code changes, IP
  refresh, Playwright image tag.
- [Writing tests](docs/writing.md) — spec template, fixture ordering,
  protocol-level assertions, seed assumptions, selector conventions.
- [Debugging failures](docs/debugging.md) — traces, report UI, JSONL
  extraction, diagnostic specs, gateway-log tailing, instrument don't
  speculate.
- [Bus logging](docs/bus-logging.md) — the `__SEMIONT_BUS_LOG__` wire
  logger, the `bus` capture fixture, assertion helpers.
- [Jaeger evidence](docs/jaeger.md) — the `jaeger` fixture that pulls
  matching distributed traces on test teardown and attaches them to
  the Playwright report.
- [Page errors](docs/page-errors.md) — the `pageErrors` fixture that
  surfaces uncaught browser-side errors (exceptions, unhandled
  rejections, `console.error`) — invisible to bus/jaeger captures.
  Soft by default; flip `PAGE_ERRORS_FAIL=1` once clean.
- [Live monitoring](docs/live-monitoring.md) — sibling workflow for
  bug-hunting on the running stack (no Playwright). Streaming
  per-container error tails + on-demand snapshot of the last N
  seconds across logs and Jaeger spans. How "live monitoring caught
  X" turns into "e2e spec Y".
- [Known gotchas](docs/gotchas.md) — sharp edges that took real
  debugging the first time: `crypto.randomUUID`, form-field ordering,
  stale tabs, fixture ordering, etc.

## The specs

[`specs/`](specs/) holds one `NN-short-name.spec.ts` per path that has
broken before; a regression in that path fails that spec. Specs tagged
`@slow` run only under `npm run test:slow`.

## Scope

- **Not in CI.** No workflow runs it; run it locally against a stack you
  brought up.
- **Seeded.** Playwright's global setup ([`scripts/seed.ts`](scripts/seed.ts))
  authenticates through `@semiont/sdk` and uploads the fixtures the specs
  assume: text resources for the annotation specs, PDFs for the PDF specs.
  Each seed has a stable
  storage URI, so a re-run against a seeded knowledge base skips it.
- **Real sign-in.** Connect leaves the Browser for the launcher-run
  Keycloak, and the `signIn` fixture types the credentials into its login
  page.
- **One worker, no retries.** Specs share the knowledge base; a flake is
  diagnosed, not retried away.
- **Chromium only.**

## Running against a freshly-built stack

The e2e harness assumes containers are already up. To bring up a stack
that exactly matches the current branch's source:

```sh
# 1. Build all @semiont/* packages, publish to local Verdaccio,
#    build the semiont-browser image.
./scripts/ci/local-build.sh

# 2. From the KB project (typically ../semiont-template-kb), bring up
#    the full stack from the :local images just built. The --config
#    anthropic flag avoids host-Ollama networking issues (see
#    "Gotchas" below).
cd ../semiont-template-kb
ANTHROPIC_API_KEY="$(op read op://OSS/Anthropic/credential)" \
  SEMIONT_VERSION=local semiont start --config anthropic
echo password | semiont useradd --email admin@example.com

# 3. Run the e2e suite (see Quick start above). The stack publishes
#    :3000 / :4000 / :24100 on the host — reach them from the Playwright
#    container via the gateway 192.168.64.1, never a container's own IP.
```

The launcher brings up a Jaeger sidecar **by default** and wires
`OTEL_EXPORTER_OTLP_ENDPOINT` for gateway / worker / smelter — useful
for inspecting cross-service traces while debugging an e2e failure
(`--no-observe` to skip). Jaeger UI lands on http://localhost:16686.

## Gotchas

- **Apple Container `--rm` is unreliable.** Stopped semiont-* containers
  often linger and conflict on next start with `Error: container with
  id semiont-foo already exists`. Wipe with `container stop $name &&
  container rm $name` before retrying.
- **Host Ollama needs `OLLAMA_HOST=0.0.0.0`.** Otherwise the gateway
  container can't reach it. Either configure Ollama Desktop with
  `launchctl setenv OLLAMA_HOST 0.0.0.0` (and quit/relaunch), or use
  `semiont start --config anthropic` to skip Ollama entirely.
- **Code changes require rebuilding the `:local` images.** Rerun
  `./scripts/ci/local-build.sh`, then restart the stack with
  `SEMIONT_VERSION=local semiont start`. Without the rebuild + restart,
  you'll run yesterday's images with today's source.
- **SPA tracing is not currently wired.** Gateway / worker / smelter
  produce traces; the Browser SPA does not. End-to-end traces
  therefore start at `bus.dispatch:*` (server-side EMIT receive)
  rather than the SPA's `bus.emit:*`. To enable SPA tracing in a
  future iteration, you'd need `VITE_OTEL_OTLP_ENDPOINT` threaded
  through `local-build.sh` into the vite build container, plus
  `COLLECTOR_OTLP_HTTP_CORS_ALLOWED_ORIGINS=*` on the Jaeger sidecar.
