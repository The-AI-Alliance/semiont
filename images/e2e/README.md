# End-to-End Smoke Tests

Real-browser Playwright tests that drive the Browser against a locally
running gateway. Intended to catch cross-layer regressions (SSE timing,
React lifecycle, bus round-trips) that unit and component tests can't.

## With `make`

From the repository root (from anywhere, `make -C <repository root> <target>`):

```sh
make stack-up     # a new knowledge base's stack from :local images, checked, left up
make e2e          # the default tier, on a knowledge base and user of its own beside it
make e2e          # again: each run makes its own, and removes it when it passes
make e2e E2E_SCRIPT=test:slow                                 # another of the suite's npm scripts
make e2e E2E_SCRIPT=test:slow E2E_MODEL=gemma4:26b            # on a knowledge base bound to another model
make e2e E2E_ARGS='specs/01-sign-in.spec.ts --repeat-each=5'  # Playwright's arguments
make stack-down   # stop the stack and each knowledge base a failed e2e left; check every port is released
make smoke        # all three in one run
```

`make stack-up` builds what it needs first: the `:local` images, as
`make local PACKAGE_NAMES=typescript` does, when the build finds them or the
TypeScript packages they install older than the checkout, and the launcher when it is
older than its Go source. It then runs `semiont init` in a new directory and
`semiont start`, and checks health, the realm the start created and the Browser's origin.
`SMOKE_TAG=<tag>` boots a published release's images instead, and `CONTAINER_RUNTIME`
selects the engine. Every `semiont` command it runs is shown as it runs.

`make e2e` runs `npm run test:ci`, which typechecks the specs and leaves out `@slow` and
`@model`, in the Playwright image this suite's version pins, with a user made by
`semiont useradd` for the run. `E2E_SCRIPT` names another of the suite's npm scripts
(`test`, `test:slow`, `test:model`), and `E2E_ARGS` gives Playwright arguments, split at
spaces: a spec file, `--grep`, `--repeat-each`. The run's knowledge base is bound to the
model `semiont init` picks, `gemma3:270m`, unless `E2E_MODEL` names another, which
`semiont init --model` binds; `@slow` and `@model` ask more than `gemma3:270m` can answer.
`make smoke` passes all three on to its `e2e`.
After the suite, `make e2e` reads the knowledge base's job queue from `semiont status` until
nothing is pending or running; a job still pending or running two minutes later fails the
run, though every test passed. A run that passes removes its knowledge base. One that fails
leaves it running, its logs, jobs and traces there to read, and prints where it is;
`make stack-down` removes it with the stack. The report is in `playwright-report/`. The script and the
steps it takes are described in [How CI runs the suite](#how-ci-runs-the-suite), which runs
the same script.

To run the suite by hand instead, against a stack you started yourself, see the
[Quick start](#quick-start) and [Running against a freshly-built stack](#running-against-a-freshly-built-stack).

## Quick start

Prereqs: the dev stack is up, with its ports published on the host. Full
rebuild/start flow in [docs/containers.md](docs/containers.md).

```sh
# The image tag MUST match the installed library — see "Version pinning" below.
PW=$(node -p "require('./node_modules/@playwright/test/package.json').version")

container run --rm \
  -v "$(git rev-parse --show-toplevel):/workspace" \
  -w /workspace/images/e2e \
  -e E2E_EMAIL=admin@example.com \
  -e E2E_PASSWORD=password \
  -e E2E_BROWSER_URL=http://localhost:3000 \
  -e E2E_GATEWAY_URL=http://localhost:4000 \
  -e CI=1 \
  "mcr.microsoft.com/playwright:v$PW-noble" \
  sh -c 'node e2e-localhost-bridge.mjs & sleep 1; npm test'
```

> **`localhost`, through the bridge.** `e2e-localhost-bridge.mjs` forwards the
> container's `localhost` ports to the host bridge address, `192.168.64.1`,
> where a container reaches the stack. See
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
> `images/e2e` is not a root workspace, so this gate is the ONLY thing that
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

**Nothing else catches this on a laptop.** `images/e2e` is not a root
workspace, so its dependencies are installed only by a person deciding to, or
by [Stack Smoke](#how-ci-runs-the-suite), which runs `npm ci` before every
run. After a Dependabot bump, sync before running:

```sh
npm ci        # installs the lockfile EXACTLY; never rewrites it
```

Use `npm ci`, not `npm install`: `ci` cannot alter `package-lock.json`, so
syncing your `node_modules` can never quietly re-resolve the suite's
dependencies for everyone else. The lockfile is tracked and is the authority.

## Container networking: reaching the host

The suite runs in a Playwright **container**, but the stack is published on
the **host**. Inside the container `localhost` is the container itself, and a
container's own IP changes on every restart.

Under Apple `container` the stack publishes what a person opens on the Mac's
loopback, which no container reaches, and what the containers dial on the
**host bridge address**, `192.168.64.1`, which every container reaches and
which is stable across restarts. The Browser and the gateway, which a person
and a container both open, take a second port there, 10000 above their own:
`:13000` and `:14000`.

`e2e-localhost-bridge.mjs` joins the two. Run inside the container, it listens
on the container's `localhost` and forwards each port to where a container
reaches it: `:3000`→`:13000`, `:4000`→`:14000`, and `:8080` (Keycloak) and
`:24100` (the worker's health) as they are. The suite then uses
`http://localhost:*` throughout, which gives Chromium the secure context PKCE
needs, and the knowledge base it registers is the origin the launcher
advertises. The launcher's tests hold the bridge's ports to the launcher's own.

Under Docker, `images/tests/stack/smoke-stack.sh e2e` runs the suite with
`--network host`, where `localhost` is the host, and starts no bridge.

> **No CORS origin to configure.** The gateway serves open CORS
> (`Access-Control-Allow-Origin: *`, bearer-only — no credentials), so the
> browser signs in from *any* origin.

Run the suite with the bridge in front of it:

```sh
container run --rm \
  -v "$(git rev-parse --show-toplevel):/workspace" \
  -w /workspace/images/e2e \
  -e E2E_EMAIL=admin@example.com \
  -e E2E_PASSWORD=password \
  -e E2E_BROWSER_URL=http://localhost:3000 \
  -e E2E_GATEWAY_URL=http://localhost:4000 \
  -e CI=1 \
  "mcr.microsoft.com/playwright:v$PW-noble" \
  sh -c 'node e2e-localhost-bridge.mjs & sleep 1; npm test'
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
- [Known gotchas](docs/gotchas.md) — sharp edges:
  `crypto.randomUUID`, form-field ordering,
  stale tabs, fixture ordering, etc.

## The specs

[`specs/`](specs/) holds one `NN-short-name.spec.ts` per path it
guards; a regression in that path fails that spec. Specs tagged
`@slow` run only under `npm run test:slow`.

Tests tagged `@model` pass or fail on what the inference model returns: a
delegated job's annotations, a generation, a structured reply. A model too small
to answer in valid JSON, or too slow on the machine, fails them while every
other test passes. They are in the default tier, which `npm test` runs;
`npm run test:model` runs them alone. CI runs `npm run test:ci`, the default
tier without them: on a four-core runner with no GPU, neither `gemma3:270m`
nor `gemma3:1b` answered them correctly within their timeouts.

## Scope

- **Not a gate on pull requests.** Stack Smoke runs the default tier nightly
  (see [How CI runs the suite](#how-ci-runs-the-suite)); otherwise run it
  against a stack you brought up.
- **Seeded.** Playwright's global setup ([`scripts/seed.ts`](scripts/seed.ts))
  authenticates through `@semiont/sdk` and uploads the fixtures the specs
  assume: text resources for the annotation specs, PDFs for the PDF specs.
  Each seed has a stable
  storage URI, so a re-run against a seeded knowledge base skips it.
- **Real sign-in.** Connect leaves the Browser for the launcher-run
  Keycloak, and the `signIn` fixture types the credentials into its login
  page. An account's first sign-in asks for a name, which `semiont useradd`
  does not set; the seed's sign-in, always the run's first, gives one.
- **One worker, no retries.** Specs share the knowledge base; a flake is
  diagnosed, not retried away.
- **Chromium only.**

## How CI runs the suite

[`stack-smoke.yml`](../../.github/workflows/stack-smoke.yml) runs
[`images/tests/stack/smoke-stack.sh run <images> --e2e`](../tests/stack/smoke-stack.sh),
nightly on `main`, on dispatch, and on a pull request that changes the
workflow or its script. The script boots a new knowledge base's stack on
the runtime selected by `CONTAINER_RUNTIME` (or the first responding engine), with the inference and embedding models `semiont init` names, and,
after its own checks and before it stops the stack, makes a second knowledge base
beside it, as `semiont init` makes one, and:

- makes the suite's user in its realm with `semiont useradd`, a password generated for the
  run, and passes both as `E2E_EMAIL` and `E2E_PASSWORD`;
- runs `npm ci && npm run test:ci` here, in `mcr.microsoft.com/playwright:v<version>-noble`,
  `<version>` read from `package.json`, with `--network host` on Docker/Podman
  or the existing localhost bridge on Apple `container`, so the `localhost` defaults reach the stack;
- adds a JSON report to the list and HTML ones, at
  `test-results/report.json`;
- reads the knowledge base's job queue from `semiont status` until nothing is pending or
  running, and fails when a job is still pending or running two minutes after the suite.

It passes that knowledge base's gateway as `E2E_GATEWAY_URL`, which the bridge forwards
too. A failing suite fails the job and still stops the stack; a container whose health
gate fails has its last log lines printed by the launcher. Whatever the result, `playwright-report/` and
`test-results/` are kept as the run's `e2e-report` artifact for 30 days, and a
table of the specs with the tier's wall time is written to the run's summary.
On a laptop, `make smoke` does the same against `:local` images, including on Apple
`container`; `make stack-up`, `make e2e` and `make stack-down` run its steps apart, each
`make e2e` on a fresh knowledge base ([With `make`](#with-make)). Use
`CONTAINER_RUNTIME=container make smoke` to select it explicitly.
A selected runtime that is not responding fails with startup instructions; nothing is
started automatically. The [Quick start](#quick-start) runs the suite alone against a stack
that is already up.

## Running against a freshly-built stack

The e2e harness assumes containers are already up. To bring up a stack
that exactly matches the current branch's source:

```sh
# 1. Build all @semiont/* packages, publish to local Verdaccio,
#    build the semiont-browser image.
make local

# 2. From the KB project (typically ../semiont-template-kb), bring up
#    the full stack from the :local images just built: name them in
#    .semiont/stack/*.yaml (ghcr.io/the-ai-alliance/semiont-gateway:local,
#    and so on), and the Browser's and the worker's in their own documents. The
#    --config anthropic flag avoids host-Ollama networking issues (see
#    "Gotchas" below).
cd ../semiont-template-kb
perl -pi -e 's#(semiont-browser):\S+#$1:local#' "$(semiont settings browser --path)"
perl -pi -e 's#(semiont-worker):\S+#$1:local#' "$(semiont settings worker --path)"
ANTHROPIC_API_KEY="$(op read op://OSS/Anthropic/credential)" \
  semiont start --config anthropic
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
- **Code changes require rebuilding the `:local` images.** `make stack-up` does it
  for you. On a stack you started yourself, rerun `make local`, then restart
  the stack with `semiont start`, its documents naming the `:local` images. Without the
  rebuild + restart, you'll run yesterday's images with today's source.
- **SPA tracing is not wired.** Gateway / worker / smelter
  produce traces; the Browser SPA does not. End-to-end traces
  therefore start at `bus.dispatch:*` (server-side EMIT receive)
  rather than the SPA's `bus.emit:*`. Enabling SPA tracing
  would need `VITE_OTEL_OTLP_ENDPOINT` threaded
  through `make local` into the vite build container, plus
  `COLLECTOR_OTLP_HTTP_CORS_ALLOWED_ORIGINS=*` on the Jaeger sidecar.
