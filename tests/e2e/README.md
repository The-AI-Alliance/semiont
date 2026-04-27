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
  mcr.microsoft.com/playwright:v1.59.1-noble \
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
   BeckonVM focus/sparkle signal flows. Auto-skips if the fixture
   resource has no annotations (the template KB starts empty;
   tests 04 and 05 create annotations when they run).
9. `99-diagnose-entity-types.spec.ts` — instance-tracking diagnostic
   for the entity-types flow (ActorVM / BrowseNamespace construction
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
#    backend / worker / smelter against the local Verdaccio. The
#    --config anthropic flag avoids host-Ollama networking issues
#    (see "Gotchas" below).
cd ../semiont-template-kb
ANTHROPIC_API_KEY="$(op read op://OSS/Anthropic/credential)" \
  NPM_REGISTRY=http://192.168.64.1:4873 \
  .semiont/scripts/start.sh --observe --no-cache --config anthropic \
  --email admin@example.com --password password

# 3. Run the frontend container (separate — start.sh manages backend
#    services only).
container run -d --name semiont-frontend-e2e -p 3000:3000 semiont-frontend

# 4. Grab IPs and run the e2e suite (see Quick start above).
container ls | grep -E 'semiont-(frontend-e2e|backend)'
```

Use `--observe` on `start.sh` to pull in a Jaeger sidecar and wire
`OTEL_EXPORTER_OTLP_ENDPOINT` for backend / worker / smelter — useful
for inspecting cross-service traces while debugging an e2e failure.
Jaeger UI lands on http://localhost:16686.

## Gotchas

- **Apple Container `--rm` is unreliable.** Stopped semiont-* containers
  often linger and conflict on next start with `Error: container with
  id semiont-foo already exists`. Wipe with `container stop $name &&
  container rm $name` before retrying.
- **Host Ollama needs `OLLAMA_HOST=0.0.0.0`.** Otherwise the backend
  container can't reach it. Either configure Ollama Desktop with
  `launchctl setenv OLLAMA_HOST 0.0.0.0` (and quit/relaunch), or use
  `start.sh --config anthropic` to skip Ollama entirely.
- **Code changes require backend image rebuild.** `start.sh --no-cache`
  forces `npm install @semiont/backend@latest` to re-resolve deps from
  Verdaccio. Without it, you'll run yesterday's image with today's
  frontend.
- **SPA tracing is not currently wired.** Backend / worker / smelter
  produce traces; the frontend SPA does not. End-to-end traces
  therefore start at `bus.dispatch:*` (server-side EMIT receive)
  rather than the SPA's `bus.emit:*`. To enable SPA tracing in a
  future iteration, you'd need `VITE_OTEL_OTLP_ENDPOINT` threaded
  through `local-build.sh` into the vite build container, plus
  `COLLECTOR_OTLP_HTTP_CORS_ALLOWED_ORIGINS=*` on the Jaeger sidecar.
