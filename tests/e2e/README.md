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
