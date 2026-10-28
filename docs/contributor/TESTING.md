# Testing

How Semiont's test suites are organized, configured and run, and what CI gates on.

## The suites

| Suite | Where | What it exercises | Needs |
|---|---|---|---|
| Workspace suites | every npm workspace in `apps/*`, `images/*` and `packages/*` with a `test` script | Units and in-process integration: components, hooks, SDK namespaces, services composed over test doubles | Nothing running |
| Rust | the Cargo workspace (`cargo test --workspace`) | The Rust SDK (its session, cache, bus and live queries, and the shared case tables), its transport, and the gateway's and dispatcher's own crates | The toolchain [`rust-toolchain.toml`](../../rust-toolchain.toml) names |
| Go | `apps/launcher`, `packages/go/sdk` | The launcher driving a fake runtime through real start and stop lifecycles; the Go bus client's wire contract | The Go toolchain each `go.mod` names |
| Python | `packages/sdk-python` (`uv run pytest`) | The Python SDK: its transport, sign-in and session, its client, cache and live queries, the shared case tables, and the programs its README shows, under `mypy` and `pyright`, both strict | Python 3.12 or later and `uv` |
| Python | `packages/inference-python` (`uv run pytest`) | The Python inference drivers: each driver against a provider the test plays over HTTP, what a driver raises, the extras, the telemetry rows against the spec, and the program its README shows, under `mypy` and `pyright`, both strict | Python 3.12 or later and `uv` |
| Python | `packages/service-python` (`uv run pytest`) | What every Python service is built on: a configuration document read and refused, the health endpoint asked over a socket, each form of the log, the readings a process takes of itself against the telemetry table, a resource's bytes, its annotations and the record by position read from an Archivist a test plays over HTTP, how a follower of the record takes each log against its case table and beyond it (the stream it watches, a sweep tried again, a log taken again, its cursors' file), where a file of the record is filed against its case table, what white space is, and what the package is made of, under `mypy` and `pyright`, both strict | Python 3.12 or later and `uv` |
| Python | `images/worker` (`uv run pytest`) | The Worker service's Python code: the case tables that state how a failure is classed, where a text is cut and how its pieces are planned, and what the project is made of, under `mypy` and `pyright`, both strict | Python 3.12 or later and `uv` |
| Python | `packages/graph-python` (`uv run pytest`) | The Python graph stores: the codecs against the case table of what the graph holds, one store contract against the in-memory store, the two Gremlin stores against fake clients, the extras, and what the package is made of, under `mypy` and `pyright`, both strict | Python 3.12 or later and `uv` |
| Python | `packages/graph-python` (`uv run pytest tests/neo4j_live.py`) | The same store contract against a real neo4j, which it clears | The above, and a neo4j of its own, named in `NEO4J_HOST` and `NEO4J_PASSWORD` |
| Python | `packages/vectors-python` (`uv run pytest`) | The Python vector stores and embedding providers: what a point is against its case table, one store contract of both case tables against the in-memory store, each provider against one the test plays over HTTP, and what the package is made of, under `mypy` and `pyright`, both strict | Python 3.12 or later and `uv` |
| Python | `packages/vectors-python` (`uv run pytest tests/qdrant_live.py`) | The same store contract against a real Qdrant, and what the Qdrant then holds of each point; it deletes that Qdrant's two collections | The above, and a Qdrant of its own, named in `QDRANT_HOST` |
| Python | `images/weaver` (`uv run pytest`) | The Weaver's Python code: the fold against the case table of what each event does to the graph, and the Weaver over a scripted transport and a graph in the process (its order, its fold taken as a follower's take, a store that fails, a start, a rewound record, reconcile, rebuild, what it refuses to start on), and what the project is made of, under `mypy` and `pyright`, both strict | Python 3.12 or later and `uv` |
| Python | `images/smelter` (`uv run pytest`) | The Smelter's Python code: reading a PDF with PDFium and a scanned page with the `tesseract` program, each against the real engine; the rules that make a document's text, against the case table of what deriving a PDF's text comes to; how a text is cut and the work a start plans, each against its case table; the anchored-text store, its entries held to their schema; the Smelter over a scripted transport and an index in the process (what each event does, its order, what it decides, reconcile, rebuild, what it refuses to start on); and what the project is made of, under `mypy` and `pyright`, both strict | Python 3.12 or later, `uv`, and the `tesseract` program with its English data |
| Python | `images/librarian` (`uv run pytest`) | The Librarian's Python code, over a fake of everything it reads by: the protocols it is handed, and what the project is made of, under `mypy` and `pyright`, both strict | Python 3.12 or later and `uv` |
| Gateway conformance | [`tests/conformance/gateway`](../../tests/conformance/gateway/README.md) | A running gateway, black-box, against `specs/`: every declared operation, every response and stream message, and hand-written protocol cases, on both signal planes | A built gateway; `nats-server` 2.10 or later on `PATH` |
| Dispatcher conformance | [`tests/conformance/dispatcher`](../../tests/conformance/dispatcher/README.md) | A running dispatcher, black-box, behind a real gateway on a real JetStream broker, against [JOBS.md](../protocol/JOBS.md) and every channel's schema | A built gateway and dispatcher; `nats-server` |
| Archivist conformance | [`tests/conformance/archivist`](../../tests/conformance/archivist/README.md) | A running Archivist, black-box, on the bus through a real gateway, at its HTTP surface and in the files it keeps, against [ARCHIVIST.md](../protocol/ARCHIVIST.md) | A built gateway and Archivist; `git`; `nats-server` |
| SDK conformance | [`tests/conformance/sdk`](../../tests/conformance/sdk/README.md) | Every SDK, through a driver, as a client of a real gateway: one corpus of cases, on the wire and in live queries | A built gateway and the Rust drivers; `@semiont/sdk` built; `uv` and Python 3.12 or later, for the Python drivers; `nats-server` |
| Worker conformance | [`tests/conformance/worker`](../../tests/conformance/worker/README.md) | A worker written on each SDK, through a driver, with the suite playing the dispatcher, against [WORKER-CONTRACT.md](../protocol/WORKER-CONTRACT.md) | A built gateway and the Rust drivers; the packages built; `uv` and Python 3.12 or later, for the Python driver; `nats-server` |
| Worker-service conformance | [`tests/conformance/worker-service`](../../tests/conformance/worker-service/README.md) | The Worker service as a running process, black-box, behind a real gateway, with the suite playing the dispatcher, the record, the Smelter and the model's provider, against [WORKER-SERVICE.md](../protocol/WORKER-SERVICE.md) | A built gateway; `@semiont/core` built; the Worker service's environment, which `uv` makes; `nats-server` |
| Weaver conformance | [`tests/conformance/weaver`](../../tests/conformance/weaver/README.md) | The Weaver as a running process, black-box, behind a real gateway and a real Archivist, writing a real neo4j that the suite reads back with a reader of its own, and exporting telemetry the suite receives, against [WEAVER.md](../protocol/WEAVER.md) | A built gateway and Archivist; the Weaver's Python environment (`uv sync --locked --no-dev --all-extras --project images/weaver`); `@semiont/core` built; `git`; `nats-server`; a neo4j of its own, named in `NEO4J_HOST` and `NEO4J_PASSWORD` |
| Smelter conformance | [`tests/conformance/smelter`](../../tests/conformance/smelter/README.md) | The Smelter as a running process, black-box, behind a real gateway and a real Archivist, with an embedding provider the suite plays, writing a real Qdrant that the suite reads back, and exporting telemetry the suite receives, against [SMELTER.md](../protocol/SMELTER.md) | A built gateway and Archivist; `@semiont/core` built; the Smelter's Python environment (`uv sync --locked --no-dev --project images/smelter`) and the `tesseract` program; `git`; `nats-server`; a Qdrant of its own, named in `QDRANT_HOST` |
| Librarian conformance | [`tests/conformance/librarian`](../../tests/conformance/librarian/README.md) | The Librarian as a running process, black-box, behind a real gateway and a real Archivist, reading a neo4j a real Weaver writes and a Qdrant a real Smelter writes, with an embedding provider and two models the suite plays, and exporting telemetry the suite receives, against [LIBRARIAN.md](../protocol/LIBRARIAN.md) | Everything the Weaver's and the Smelter's suites need, since it starts both: a built gateway and Archivist; `@semiont/core` built; the Librarian's, the Weaver's and the Smelter's Python environments and the `tesseract` program; `git`; `nats-server`; a neo4j and a Qdrant of its own, named in `NEO4J_HOST`, `NEO4J_PASSWORD` and `QDRANT_HOST` |
| End-to-end | [`tests/e2e`](../../tests/e2e/README.md) | The live Browser against a live gateway and knowledge base | A running stack and a user at its issuer |

The conformance suites import nothing from what they check. One line per service and per SDK in [`harness/paths.ts`](../../tests/conformance/harness/paths.ts) names the implementation, so the same cases judge any implementation of the same spec.

The tools: **Vitest** runs every TypeScript suite; **React Testing Library**, with the `jest-dom` and `jest-axe` matchers, tests components under jsdom; **Playwright** drives the end-to-end suite; Go's `testing` package, Cargo's test harness and **pytest** cover the rest.

## How suites are configured

There is no test orchestrator and no test environment to select. A suite's configuration is its own config file, and anything else a test needs it builds for itself: a temporary directory, a test double, a child process. No variable selects a profile.

### One shared Vitest config

[`vitest.shared.config.ts`](../../vitest.shared.config.ts) at the repository root holds what every workspace suite has in common:

- `globals: true` and the `node` environment;
- the test files, `src/**/*.test.{ts,tsx}`, excluding `node_modules` and `dist`;
- coverage: the `v8` provider; the reporters `text`, `json`, `json-summary`, `html`, `lcov` and `cobertura`; and the excludes — test files, config files, declaration files, `index.ts` barrels and generated `types.ts`.

It sets no coverage thresholds.

Each workspace's `vitest.config.*` merges it with `mergeConfig` and adds only what is local. `npm run lint:vitest-coverage` enforces this: every workspace that declares `test:coverage` must have a vitest config, that config must derive from the shared one, and it must not re-declare `coverage.reporter` — `mergeConfig` concatenates arrays, so a local list would run every reporter twice.

### What each workspace adds

| Workspace | Local configuration |
|---|---|
| `images/browser` | `jsdom`; [`vitest.setup.ts`](../../images/browser/vitest.setup.ts); the React plugin; the `@` → `src` alias; the `threads` pool with `maxConcurrency: 2`; `dangerouslyIgnoreUnhandledErrors`, for tests that throw on purpose; `tsconfig.test.json` for `vitest typecheck`; extra coverage excludes |
| `packages/react-ui` | `jsdom`; [`vitest.setup.ts`](../../packages/react-ui/vitest.setup.ts); the `@` → `src` alias; a coverage `include` of `src/**/*.{ts,tsx}` |
| `packages/core` | the `@` → `src` alias; a coverage `include` of `src/**/*.ts` |
| `packages/` `http-transport`, `observability`, `sdk` | nothing |

A coverage `include` also reports the files it matches that no test loads; without one, a report covers only the files the tests load.

The two jsdom setup files:

- **The Browser's** adds the jest-dom matchers; polyfills `DOMMatrix`, `matchMedia` and `getAnimations`; fixes `window.location` at `http://localhost:3000/`; stubs `URL.createObjectURL`; resolves relative `fetch` URLs against `http://localhost:3000`; mocks `react-router`'s hooks, `react-i18next` (serving the real English strings from the generated `messages/en.json`) and `@/i18n/routing`; and cleans up after each test.
- **react-ui's** adds the jest-dom and jest-axe matchers; fills jsdom's gaps (`DOMMatrix`, `scrollIntoView`, a `focus` that moves `document.activeElement`); cleans up after each test; and replaces `globalThis.fetch` with one that throws `Unit test attempted a network request: <url>`.

### Environment variables

No Vitest suite takes configuration from the shell. A test that exercises code which reads a variable sets it and restores it; a setup file sets only what production code in its process reads. The Boot Contract audit enforces the second rule: [`audit-test-env-hygiene.sh`](../../scripts/compliance/audit-test-env-hygiene.sh) fails when a test file under `images/gateway`, `images/browser` or `packages/*` exports a `SEMIONT_*` variable that no production code in the same process — the workspace and the `@semiont/*` packages it depends on — reads.

`NODE_ENV` selects nothing. Vitest sets it to `test` when it is unset; no code compares it to `test`, and the only reads — react-ui's error boundaries and the Browser's translation manager — check for `development` to show diagnostics.

### Test doubles, not services

Workspace suites run with nothing listening. CI's package matrix starts no database, vector store or model server.

- **The SDK.** `@semiont/sdk/testing` provides a real `SemiontClient` (`createTestClient`) or `SemiontSession` (`createTestSession`) over `FaultyTransport`, the scriptable in-memory transport from `@semiont/core/testing`. An operation the test did not script throws `No response scripted for bus operation "<op>"` rather than answering with a fabricated reply. `stubGateway()` supplies gateway operations that each reject with their own name; `inMemoryContent()` stores content and throws on an unknown id. The Rust, Python and Go SDKs ship the same doubles, `semiont::testing`, `semiont.testing` and `semionttest`, for what is built on them.
- **React.** `@semiont/react-ui/test-utils` assembles those doubles into providers: `renderWithProviders` renders inside a real `SemiontBrowser` whose active session runs on them. The Browser's tests import it directly.
- **Property axioms.** `@semiont/core/testing/axioms` holds the StateUnit and liveness axiom harnesses. It needs `fast-check` in the importing package's devDependencies.
- **An identity provider.** `@semiont/core/testing/issuer` is an in-process OIDC issuer: signing keys, signed tokens, and the discovery and JWKS documents. It serves nothing; the consumer answers the two URLs.
- **A real broker where a mock would prove nothing.** The conformance suite's NATS plane spawns `nats-server` from `PATH`. A missing binary fails the run with instructions; it never skips.

### How the conformance suites are configured

[`tests/conformance/vitest.config.ts`](../../tests/conformance/vitest.config.ts) is its own config, not derived from the shared one. It holds nine projects over one shared harness: `gateway`, `dispatcher`, `archivist`, `sdk`, `worker`, `worker-service`, `weaver`, `smelter` and `librarian`. It uses the `forks` pool with up to four workers, since each file boots its own gateways, issuer and broker, and a 60-second test timeout.

Each gateway the suite starts gets a fresh temporary directory holding its `GatewayConfig` document, and an environment of `PATH` plus the variables the case sets, such as `JWT_SECRET` and `SEMIONT_OIDC_CLIENT_ID`. Nothing else from your shell reaches it.

## Running tests

Tests run through each workspace's npm scripts, `cargo`, `go` and `uv`. The `semiont` launcher runs knowledge bases, not this repository's tests.

### From the repository root

`npm test` fans out to every workspace that defines a `test` script, and `npm run typecheck` does the same for `typecheck`. To target one workspace:

```bash
npm test --workspace=@semiont/sdk
```

`tests/conformance` and `tests/e2e` are not root workspaces. Each has its own `package.json` and lockfile and runs from its own directory.

### The npm workspaces

Every package under `packages/` runs `npm test` as `vitest run`, except `@semiont/react-ui`, which runs its suite as four sequential shards with an 8 GB heap. Every package defines `test:coverage`.

The Browser (`images/browser/`) has one suite and several filters over it:

```bash
npm test                    # everything
npm run test:unit           # tests whose names do not match "integration"
npm run test:integration    # tests whose names match "integration"
npm run test:security       # session gates, locale layout, validation
npm run test:a11y           # tests whose names match "Accessibility"
npm run test:coverage       # everything, with coverage
npm run test:watch          # watch mode
```

`test`, `test:coverage` and `test:security` first generate the gitignored `messages/` directory the i18n mock reads; the other scripts expect it to exist. The Browser's own guide is [images/browser/docs/TESTING.md](../../images/browser/docs/TESTING.md), and react-ui's is [packages/react-ui/docs/TESTING.md](../../packages/react-ui/docs/TESTING.md).

### Rust

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`cargo test` checks the crates from inside. What the gateway, the dispatcher and the Archivist do as running services is the conformance suites' to check.

### The conformance suites

```bash
cargo build --release -p semiont-gateway -p semiont-dispatcher -p semiont-archivist -p semiont-conformance-drivers
npm run build:packages
cd tests/conformance
npm ci
npm run test:gateway        # or test:dispatcher, test:archivist, test:sdk, test:worker, test:worker-service, test:weaver, test:smelter, test:librarian; npm test runs all nine
```

Each script typechecks the cases first. What each suite checks is in its README, linked in the table above, and the gateway's is also described in [images/gateway/docs/TESTING.md](../../images/gateway/docs/TESTING.md).

### Go

As CI runs them:

```bash
cd apps/launcher && go test -timeout 30m ./...
cd packages/go/launcher && go test -timeout 30m ./...
cd packages/go/sdk && go test -timeout 5m ./...
```

The launcher's suite takes minutes; its notes are in [apps/launcher/README.md](../../apps/launcher/README.md#development).

### Python

As CI runs them, from `packages/sdk-python`, and the same from `packages/inference-python`, `packages/graph-python`, `packages/vectors-python`, `packages/service-python`, `images/worker`, `images/weaver`, `images/smelter` and `images/librarian`:

```bash
uv sync --locked
uv run mypy
uv run pyright
uv run ruff check && uv run ruff format --check
uv run pytest
```

Both type checkers are part of the suite: `tests/refusals` holds programs that must not type-check, and `tests/readme` the programs the package's README shows, which `tests/test_readme.py` runs. The Python block of the [`semiont-worker` skill](../builder/skills/semiont-worker/SKILL.md) is held to one of them, word for word, by the same file. The skill's complete TypeScript worker is run, as the skill shows it, by `packages/sdk/src/__tests__/worker-skill.test.ts`, which needs the packages built. The package's own tests are built on `semiont.testing`, the doubles it ships.

### In a container

None of the toolchains has to be on your machine. Two things to know:

**`node_modules` holds native binaries for the platform that installed it** (rolldown, lightningcss). Run tests in the same image family you installed with. An install made under the Alpine image (`node:<version>-alpine`) fails under the glibc one (`node:<version>`) with a `*.linux-<arch>-gnu.node` module-not-found, and the reverse fails the other way. `tsc --noEmit` runs under either.

```bash
container run --rm -v "$(pwd)":/work -w /work "node:$(scripts/ci/node-version.sh)-alpine" \
  sh -c 'npm test --workspace=@semiont/sdk'
```

**The conformance suites need `nats-server`**, which Alpine packages: `apk add --no-cache nats-server` in the same container, before the suite.

For Go, use the `golang` image whose tag satisfies the `toolchain` line in the module's `go.mod`. For Python, use a `python` image at or above the `requires-python` of `packages/sdk-python/pyproject.toml`, with `uv` and, for `pyright`, Node.js.

## Writing tests

### Code that talks to a knowledge base

Script the transport, then observe through a real client:

```typescript
import { createTestClient } from '@semiont/sdk/testing'

const { client, transport } = createTestClient()
transport.queueReply('browse:resources-requested', { resources: [], total: 0, offset: 0 })
// Hand `client` to the unit under test. An operation nobody scripted throws
// "No response scripted for bus operation ..." instead of answering.
```

`queueReply` scripts what the gateway answers; the transport's `schedule` scripts the wire (`deliver`, `drop-reply`, `delay`, `duplicate-reply`, `reject-emit`). A reply that names what it answers for beside its response, as a gathered context names its resource, takes that from the request, so a test queues the response alone. For components, `renderWithProviders` from `@semiont/react-ui/test-utils` renders inside a `SemiontBrowser` on the same doubles. The patterns are in [react-ui's testing guide](../builder/react-ui/TESTING.md).

Do not mock the transport by hand. A hand-rolled mock encodes its author's model of the contract, and the contract moves:

```typescript
// Not this
vi.mock('@semiont/http-transport', () => ({
  HttpTransport: vi.fn(() => ({ emit: vi.fn() }))
}))
```

### Components

Assert what a person can see or do, and find elements by role and accessible name rather than by test id:

```typescript
const button = screen.getByRole('button', { name: /submit/i })
expect(screen.getByText('Modal content')).toBeInTheDocument()
```

### Two Vitest traps

**Give `beforeEach` and `beforeAll` a block body.** Vitest treats a function *returned* from a setup hook as that test's teardown. `mockClear()`, `mockReset()` and `mockRestore()` return the mock itself, so a concise-arrow hook registers the mock as teardown, and the runner calls it after every test.

```typescript
// Returns the mock; Vitest calls it as teardown after each test
beforeEach(() => scrollSpy.mockClear());

// Block body returns undefined
beforeEach(() => { scrollSpy.mockClear(); });
```

This stays invisible until the mock is given a throwing implementation. Then the test's assertions pass, teardown invokes the mock, and the test fails at the error's construction site with no assertion diff.

**Import mock types by name.** `vi.MockedFunction` in a type annotation does not always resolve; `import type { MockedFunction } from 'vitest'` does.

### When a test fails oddly

| It says | What happened |
|---|---|
| `Unit test attempted a network request: <url>` | react-ui's setup file refuses every `fetch`. Build the client from `@semiont/sdk/testing`, or through `renderWithProviders`, and script the response |
| `No response scripted for bus operation "<op>"` | The unit reached an operation the test did not script. Add `transport.queueReply('<op>', <response>)` |
| A global such as `describe` is not defined | The workspace's config does not merge the shared one, which sets `globals: true` |

`transport.requestLog` lists every request a `FaultyTransport` saw, in order, with the action its schedule applied.

## End-to-end tests

The suite at [`tests/e2e/`](../../tests/e2e/) runs Playwright against a real stack. It exists for what no in-process test can see: timing on the event stream, races between a page's lifecycle and the bus, tear-down on navigation, a session rebuilt across sign-out and sign-in, and annotations that persist across a reload.

It is deliberately small. A spec earns its place by guarding a path that has broken before and that a unit or integration test cannot catch.

- **Not in CI.** No workflow runs it. Run it against a stack you brought up, usually one built from your tree ([Local Development](LOCAL-DEVELOPMENT.md)).
- **Seeded.** Its global setup signs in through the SDK and uploads the fixtures the specs assume.
- **Real sign-in.** The fixture is handed to the stack's Keycloak and types the credentials into its page.
- **One worker, no retries, Chromium only.** A flake is diagnosed, not retried away.
- **Slow specs opt in.** `npm test` leaves out specs tagged `@slow`; `npm run test:slow` runs only those.
- **Wire-level assertions.** A spec asserts on the bus as well as on the page: that a `mark:create-request` was emitted and a `mark:create-ok` arrived with the same correlation id. A page can end up right for the wrong reason; the wire cannot.

It reads four variables: `E2E_EMAIL` and `E2E_PASSWORD`, which are required and have no default, and `E2E_BROWSER_URL` and `E2E_GATEWAY_URL`, which default to `http://localhost:3000` and `http://localhost:4000`.

```bash
cd tests/e2e
npm ci
npx playwright install chromium
npm test                                   # typechecks the specs, then runs them
npm test -- specs/02-open-resource.spec.ts # one spec
```

Use `npm test` rather than `npx playwright test`: its `pretest` typechecks the specs, and nothing else does, because `tests/e2e` is not a root workspace.

Everything else is in the suite's own docs:

| Doc | What it covers |
|---|---|
| [README](../../tests/e2e/README.md) | Running from a container, reaching the stack from inside one, and the full flow against a freshly built stack |
| [running.md](../../tests/e2e/docs/running.md) | Invocation: one spec, headed, `--repeat-each` |
| [writing.md](../../tests/e2e/docs/writing.md) | The spec template, fixture ordering, selectors |
| [bus-logging.md](../../tests/e2e/docs/bus-logging.md) | The bus log, the `bus` capture fixture and its helpers |
| [debugging.md](../../tests/e2e/docs/debugging.md) | Traces, pulling an error out of one, diagnostic specs |
| [containers.md](../../tests/e2e/docs/containers.md) | Rebuilding the stack after a code change |
| [jaeger.md](../../tests/e2e/docs/jaeger.md), [page-errors.md](../../tests/e2e/docs/page-errors.md) | The fixtures that attach traces and uncaught page errors to a report |
| [live-monitoring.md](../../tests/e2e/docs/live-monitoring.md) | Hunting a bug on a running stack without Playwright |
| [gotchas.md](../../tests/e2e/docs/gotchas.md) | The sharp edges |

## Coverage

Coverage is measured per workspace and reported to Codecov. [`codecov.yml`](../../.github/codecov.yml) sets the gates:

- **Project:** target 70%, allowed to drop by 1%.
- **Patch:** new code targets 80%, with a 5% threshold.

Each package and the Browser has a flag (with carryforward) and a component. In `ci.yml`, `test-package` uploads each package's `lcov.info` under its flag and `test-browser` uploads the Browser's. `npm run lint:coverage-roster` fails when the workspaces declaring `test:coverage`, the package matrix, and codecov's flags and components disagree. No vitest config sets a threshold, so a coverage run fails exactly when the suite does, and CI runs each suite once, with coverage.

Excluded from coverage: what the shared config excludes (see [One shared Vitest config](#one-shared-vitest-config)), plus codecov's `ignore` list — test files and directories, build output, config files, generated files, and `scripts/`.

`npm run test:coverage` writes a workspace's `coverage/` directory: `lcov.info`, `coverage-summary.json`, `cobertura-coverage.xml`, and an HTML report at `coverage/index.html`.

## Continuous integration

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) is the one workflow every pull request runs whole. It also runs on pushes to `main` and `develop`, nightly on `main` at 08:17 UTC, on manual dispatch, and when a release calls it. A push to a pull request cancels the run of the push before it; a push to `main` is never cancelled.

It runs in one of two tiers, which the `changes` job decides. A pull request and a push to `main` run in tier `change`: the jobs whose areas they touched, on Linux. The nightly schedule, a dispatch and a release's call run in tier `full`: every job, and those that run in it alone, today the launcher on Windows. A scheduled run that fails mails whoever last changed its schedule line.

It runs in two stages and ends in a gate. `census`, `changes` and `generated-artifacts` need no build and finish in about two minutes; every other job waits for all three, so a tree that fails a lint or has drifted from its spec starts none of the jobs behind them. `gate` needs every job, runs whatever they did, and fails when any failed or was cancelled; a job skipped by a condition passes it. It is the one check of this workflow the merge ruleset requires.

In tier `change`, a job runs only when the push touched one of its areas. `changes` maps the changed paths to areas (`rust`, `ts`, `conformance`, `go`, `compliance`, one per Python project), comparing a pull request with its base and a push with the commit before it, and each job's `if` names the areas it reads: a conformance suite runs on a change to the Rust workspace, the npm workspaces, `tests/conformance` or the Python projects it installs; a Python package's job on its own tree and the projects its `pyproject.toml` depends on; the launcher's on `apps/launcher` and `packages/go/sdk`; the compliance audits on the code they read, the docs and their own scripts. A change under `.github/`, `scripts/ci/` or `specs/` runs every area. A skipped job is reported as Success and passes the gate.

The Rust binaries the conformance suites start are built once, by `build-rust`, which runs whenever any suite does and publishes them as an artifact; each suite fetches them into `target/release`, where [`harness/paths.ts`](../../tests/conformance/harness/paths.ts) looks, and builds nothing of its own.

`npm run lint:workflows` holds all of this: the `concurrency` of every workflow that runs on pull requests, its group led by the workflow's file name, that no job of them checks out, installs or builds and then checks nothing, that every other workflow running on pull requests names the paths it checks, that `ci.yml` has its first stage, its edges and its gate, that every job behind the first stage reads areas the `changes` job defines or the tier alone, and that `cargo build` runs in `build-rust` alone.

`npm run lint:path-globs` holds every glob over `apps/`, `images/` or `packages/` that a workflow, a script or a test writes to the tree: each matches a file the repository holds, or names what a build makes beneath directories it does match, which git ignores. A glob that matches nothing selects nothing without saying so; a directory that moves, or a naming convention that changes, leaves such globs behind. It cannot see a glob that still matches part of what it should after the rest has moved, nor one assembled from parts.

| Job | What it covers |
|---|---|
| `census` | The `lint:*` gates, over the tree and no build: the stylesheets, the translations, the docs' names, the spec's own consistency, the toolchain versions, the Dependabot entries, the workflows, and more |
| `changes` | Which areas the push touched, for every other job's `if` |
| `test-browser` | `npm run typecheck` and the suite, with coverage, for `images/browser`, uploaded under the `browser` flag |
| `test-package` | A matrix over every npm package with a suite: build, typecheck and the suite with coverage, uploaded under the package's flag |
| `browser-security` | A built Browser probed for privileged content and secret-shaped strings in the shell it serves for the moderation routes |
| `lighthouse-accessibility` | Lighthouse against a built Browser's signed-out pages, failing below an accessibility score of 90 (`images/browser/lighthouserc.json` names the pages and the score) |
| `compliance-check` | The audits in [`scripts/compliance/`](../../scripts/compliance/), each against the built packages: the doc snippets, raw bus use, the state-unit axioms, the boot contract, the one-home rules, and the React-UI and Browser compliance reports |
| `build-rust` | `cargo build --release` of the gateway, the dispatcher, the Archivist and the Rust SDK's three conformance drivers, once, published as an artifact the conformance jobs fetch into `target/release`. The six binaries are cached under a key that hashes what the build reads, the same list Stack Smoke's layer cache hashes, so a run whose Rust sources were built before compiles nothing |
| `test-gateway` | `cargo fmt --check`, `clippy -D warnings` and `cargo test` for the Rust workspace; which crates may depend on which; the published crates' set and version, and each packaged and built from its packaged form (`cargo publish --dry-run`); the licence policy for the crates each image links |
| `gateway-security` | The gateway, on the binaries `build-rust` built, probed for 401s on protected routes, the error shape, and leaked secrets |
| `gateway-conformance` | Runs the conformance suite's `gateway` project against the binaries `build-rust` built |
| `dispatcher-conformance` | Runs the `dispatcher` project |
| `archivist-conformance` | Runs the `archivist` project |
| `sdk-conformance` | Builds `@semiont/sdk`, installs the Python SDK's locked environment, and runs the `sdk` project |
| `worker-conformance` | Builds the packages, installs the Python SDK's locked environment, and runs the `worker` project |
| `worker-service-conformance` | Builds `@semiont/core`, makes the Worker service's locked environment with every provider's library, and runs the `worker-service` project |
| `weaver-conformance` | Builds `@semiont/core`, makes the Weaver's Python environment, starts the neo4j the launcher runs, and runs the `weaver` project |
| `smelter-conformance` | Builds `@semiont/core`, starts the Qdrant the launcher runs, installs the `tesseract` program, makes the Smelter's Python environment, and runs the `smelter` project |
| `librarian-conformance` | Builds `@semiont/core`, starts the neo4j and the Qdrant the launcher runs, installs the `tesseract` program, makes the Librarian's, the Weaver's and the Smelter's Python environments, and runs the `librarian` project |
| `test-sdk-python` | `pytest` on Python 3.12, 3.13 and 3.14, and on 3.12 `mypy` and `pyright`, each as Linux and as Windows, and `ruff`, for `packages/sdk-python`; the distributions a release uploads are built and checked, on 3.12 |
| `test-sdk-python-windows` | The Python SDK's sign-in store and state directory tests, on Windows |
| `test-inference-python` | `pytest` on Python 3.12, 3.13 and 3.14, and `mypy`, `pyright` and `ruff` on 3.12, for `packages/inference-python` |
| `test-service-python` | `pytest` on Python 3.12, 3.13 and 3.14, and `mypy`, `pyright` and `ruff` on 3.12, for `packages/service-python` |
| `test-worker-python` | `pytest` on Python 3.12, 3.13 and 3.14, and `mypy`, `pyright` and `ruff` on 3.12, for `images/worker` |
| `test-graph-python` | `pytest` on Python 3.12, 3.13 and 3.14, and `mypy`, `pyright` and `ruff` on 3.12, for `packages/graph-python` |
| `test-graph-python-neo4j` | Starts the neo4j the launcher runs and holds the Python neo4j store to the store contract against it |
| `test-vectors-python` | `pytest` on Python 3.12, 3.13 and 3.14, and `mypy`, `pyright` and `ruff` on 3.12, for `packages/vectors-python` |
| `test-vectors-python-qdrant` | Starts the Qdrant the launcher runs and holds the Python Qdrant store to the store contract against it |
| `test-weaver-python` | `pytest` on Python 3.12, 3.13 and 3.14, and `mypy`, `pyright` and `ruff` on 3.12, for `images/weaver` |
| `test-smelter-python` | Installs the `tesseract` program, then `pytest` on Python 3.12, 3.13 and 3.14, and `mypy`, `pyright` and `ruff` on 3.12, for `images/smelter` |
| `test-librarian-python` | `pytest` on Python 3.12, 3.13 and 3.14, and `mypy`, `pyright` and `ruff` on 3.12, for `images/librarian` |
| `check-phantom-deps` | Every import in a published `dist` is declared by its package |
| `build-all` | `npm run build` over every npm workspace |
| `generated-artifacts` | Drift between the bus registry and its generated TypeScript and Go, between the bundled OpenAPI spec and `packages/go/sdk/api/client_gen.go`, between `specs/` and the Python SDK's generated modules and models, and Go schema coverage |
| `check-launcher` | `gofmt` over both Go modules; `go vet` for the launcher on every target a release ships; `go vet`, `go build` and `go test` for `packages/go/sdk`; `govulncheck` for the launcher |
| `test-launcher` | The launcher's suite, split across three runners by test: each leg lists the root package's tests and runs its third of them, a block in source order so each test follows the one it follows in a serial run, and the first also runs the module's other packages. The tests bind the stack's real host ports through the fake runtime, so they run side by side only on runners of their own |
| `test-launcher-windows` | `go vet` and `go test` for the launcher on Windows; tier `full` only |
| `gate` | Needs every job above; fails when any failed or was cancelled |

[`codeql-analysis.yml`](../../.github/workflows/codeql-analysis.yml) runs CodeQL over the TypeScript, Go, Rust and Python nightly at 08:17 UTC and when a release calls it, not on pull requests. GitHub's default-setup Code Quality analysis, which no file here configures, runs on pull requests.

[`stack-smoke.yml`](../../.github/workflows/stack-smoke.yml) is not a gate on pull requests; it gates releases. On manual dispatch it builds every image and the launcher from the commit, or takes a published tag, and runs [`scripts/release/smoke-stack.sh`](../../scripts/release/smoke-stack.sh) with `--e2e`, which boots a real stack, says what it checks, and runs [`tests/e2e`](../../tests/e2e/README.md)'s default tier against it with the models a new knowledge base names, less the tests the suite tags `@model` (`npm run test:ci`), which those models on a runner with no GPU do not answer in time. The run's summary has a table of the suite's specs, and its Playwright report is kept for 30 days. A release calls it on the commit it is about to tag. It also runs nightly on `main`, and on a pull request that changes the workflow, that script, `local-build.sh` or `.dockerignore`. The three Rust images share one builder stage, a release build of the workspace for Alpine that takes twelve minutes cold; the workflow keeps its layers between runs under a key that hashes everything the stage copies, so a run whose Rust is unchanged restores the stage and compiles nothing. The nightly run writes `main`'s copy, which a pull request's run can read; GitHub evicts a copy unread for a week. `local-build.sh --layer-cache <dir>` is how, and `npm run lint:workflows` holds every file the Dockerfiles copy to a pattern of the key.

Locally, run the suite for the code you changed. CI runs the whole matrix.

## Related

- [Local Development](LOCAL-DEVELOPMENT.md): building a stack from your tree to test against
- [Browser testing](../../images/browser/docs/TESTING.md), [react-ui testing](../../packages/react-ui/docs/TESTING.md), [gateway testing](../../images/gateway/docs/TESTING.md): each part's own guide
- [The conformance suites](../../tests/conformance/README.md): what they are and how the harness works
- [Testing with the SDK's doubles](../builder/react-ui/TESTING.md): for anyone building on the SDK
