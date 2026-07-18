# End-to-End Smoke Tests

Real-browser Playwright tests that drive the frontend against a locally
running backend. Intended to catch cross-layer regressions (SSE timing,
React lifecycle, bus round-trips) that unit and component tests can't.

## Quick start

Prereqs: the dev stack is up — frontend + backend containers running
against a local KB, reachable by IP. Full rebuild/start flow in
[docs/containers.md](docs/containers.md).

```sh
container ls | grep -E 'semiont-(frontend|backend)'    # grab both IPs

container run --rm \
  -v "$(git rev-parse --show-toplevel):/workspace" \
  -w /workspace/tests/e2e \
  -e E2E_EMAIL=admin@example.com \
  -e E2E_PASSWORD=password \
  -e E2E_FRONTEND_URL=http://<frontend-ip>:3000 \
  -e E2E_BACKEND_URL=http://<backend-ip>:4000 \
  -e CI=1 \
  mcr.microsoft.com/playwright:v1.61.0-noble \
  npx playwright test
```

> If every test fails in the `signIn` fixture with *"Request failed due
> to a network error"*, the Playwright container can't reach the
> host-published backend — see [Container networking](#container-networking-reaching-the-host).

## Container networking: reaching the host

The suite runs in a Playwright **container**, but the frontend and backend
are published on the **host**. A containerized browser **can't use
`localhost`** — inside the container that resolves to the container itself,
not the host. And pinning a container's bridge IP is fragile: container IPs
change on every restart.

The robust target is the **host bridge gateway**, `192.168.64.1`: it's
reachable from inside containers, routes to the host's *published* ports
(`:3000`→frontend, `:4000`→backend), and its address is **stable across
restarts**.

> **No CORS origin to configure.** The backend serves open CORS
> (`Access-Control-Allow-Origin: *`, bearer-only — no credentials), so the
> browser signs in from *any* origin. This removed an earlier
> `corsOrigin`-baked-into-the-image workaround; if you're following older
> notes that tell you to set `services.backend.corsOrigin` and rebuild,
> that config field no longer exists.

Run the suite against the gateway for **both** URLs, with the frontend
published on host port 3000 (`-p 3000:3000`; the backend already publishes
`4000`). No IP-grabbing needed — the gateway doesn't change between runs:

```sh
container run --rm \
  -v "$(git rev-parse --show-toplevel):/workspace" \
  -w /workspace/tests/e2e \
  -e E2E_EMAIL=admin@example.com \
  -e E2E_PASSWORD=password \
  -e E2E_FRONTEND_URL=http://192.168.64.1:3000 \
  -e E2E_BACKEND_URL=http://192.168.64.1:4000 \
  -e CI=1 \
  mcr.microsoft.com/playwright:v1.61.0-noble \
  npx playwright test
```

## Docs

- [Running tests](docs/running.md) — invocation, single spec, headed,
  `--repeat-each`, host vs. container.
- [Containers and rebuild flow](docs/containers.md) — Apple container
  CLI, Verdaccio, rebuilding backend/frontend after code changes, IP
  refresh, Playwright image tag.
- [Writing tests](docs/writing.md) — spec template, fixture ordering,
  protocol-level assertions, seed assumptions, selector conventions.
- [Debugging failures](docs/debugging.md) — traces, report UI, JSONL
  extraction, diagnostic specs, backend-log tailing, instrument don't
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

## Current tests

Each targets a path that has broken before. A regression in any of them
fails the corresponding test.

1. `01-sign-in.spec.ts` — sign-in succeeds, lands on the knowledge
   section.
2. `02-open-resource.spec.ts` — open a resource from Discover, content
   loads.
3. `03-navigate-resources.spec.ts` — click between two open-resource
   sidebar tabs, content actually updates.
4. `04-manual-highlight.spec.ts` — select text with motivation=highlight,
   confirm the highlight is persisted and survives reload.
5. `05-manual-reference.spec.ts` — select text with motivation=linking
   and an entity-type chip, confirm the reference is persisted and
   survives reload.
6. `06-assisted-reference.spec.ts` — click the assist widget's
   "Annotate" button with entity types selected, confirm the assist
   dispatch crosses the wire.
7. `07-sign-out-sign-in.spec.ts` — sign out, sign back in, confirm the
   session state rebuilds and bus round-trips still work on the fresh
   client.
8. `08-hover-beckon.spec.ts` — hover over an annotation, confirm the
   BeckonStateUnit focus/sparkle signal flows. Auto-skips if the fixture
   resource has no annotations (the template KB starts empty;
   tests 04 and 05 create annotations when they run).
9. `99-diagnose-entity-types.spec.ts` — instance-tracking diagnostic
   for the entity-types flow (ActorStateUnit / BrowseNamespace construction
   counts + cache delivery). Not a regression guard — a running
   dashboard for the singleton-ness invariants the SSE reconnect
   logic depends on.

## Non-goals (for now)

- Not wired into CI. Run locally against a manually-brought-up stack.
- Not seeding fixtures. Assumes the target KB has ≥2 resources and ≥1
  entity type — true of the default template KB.
- Not testing real OAuth. Credentials sign-in only.
- Not parallel. Single worker until fixtures are per-test-isolated.
- Not cross-browser. Chromium only.

## Running against a freshly-built stack

The e2e harness assumes containers are already up. To bring up a stack
that exactly matches the current branch's source:

```sh
# 1. Build all @semiont/* packages, publish to local Verdaccio,
#    build the semiont-frontend image.
./scripts/ci/local-build.sh

# 2. From the KB project (typically ../semiont-template-kb), bring up
#    the full stack from the :local images just built. The --config
#    anthropic flag avoids host-Ollama networking issues (see
#    "Gotchas" below).
cd ../semiont-template-kb
ANTHROPIC_API_KEY="$(op read op://OSS/Anthropic/credential)" \
  SEMIONT_VERSION=local semiont start --config anthropic \
  --email admin@example.com --password password

# 3. Grab IPs and run the e2e suite (see Quick start above). The stack
#    includes the frontend container on :3000.
container ls | grep -E 'semiont-(frontend|backend)'
```

The launcher brings up a Jaeger sidecar **by default** and wires
`OTEL_EXPORTER_OTLP_ENDPOINT` for backend / worker / smelter — useful
for inspecting cross-service traces while debugging an e2e failure
(`--no-observe` to skip). Jaeger UI lands on http://localhost:16686.

## Gotchas

- **Apple Container `--rm` is unreliable.** Stopped semiont-* containers
  often linger and conflict on next start with `Error: container with
  id semiont-foo already exists`. Wipe with `container stop $name &&
  container rm $name` before retrying.
- **Host Ollama needs `OLLAMA_HOST=0.0.0.0`.** Otherwise the backend
  container can't reach it. Either configure Ollama Desktop with
  `launchctl setenv OLLAMA_HOST 0.0.0.0` (and quit/relaunch), or use
  `semiont start --config anthropic` to skip Ollama entirely.
- **Code changes require rebuilding the `:local` images.** Rerun
  `./scripts/ci/local-build.sh`, then restart the stack with
  `SEMIONT_VERSION=local semiont start`. Without the rebuild + restart,
  you'll run yesterday's images with today's source.
- **SPA tracing is not currently wired.** Backend / worker / smelter
  produce traces; the frontend SPA does not. End-to-end traces
  therefore start at `bus.dispatch:*` (server-side EMIT receive)
  rather than the SPA's `bus.emit:*`. To enable SPA tracing in a
  future iteration, you'd need `VITE_OTEL_OTLP_ENDPOINT` threaded
  through `local-build.sh` into the vite build container, plus
  `COLLECTOR_OTLP_HTTP_CORS_ALLOWED_ORIGINS=*` on the Jaeger sidecar.
