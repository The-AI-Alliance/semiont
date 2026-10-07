# Testing

How Semiont's test suites are organized, configured and run, and what CI gates on.

## The suites

| Suite | Where | What it exercises | Needs |
|---|---|---|---|
| Workspace suites | every npm workspace in `apps/*` and `packages/*` with a `test` script | Units and in-process integration: components, hooks, SDK namespaces, services composed over test doubles | Nothing running, except `nats-server` on `PATH` for `@semiont/jobs` |
| Rust | the Cargo workspace (`cargo test --workspace`) | The Rust SDK (its session, cache, bus and live queries, and the shared case tables), its transport, and the gateway's and dispatcher's own crates | The toolchain [`rust-toolchain.toml`](../../rust-toolchain.toml) names |
| Go | `apps/launcher`, `packages/sdk-go` | The launcher driving a fake runtime through real start and stop lifecycles; the Go bus client's wire contract | The Go toolchain each `go.mod` names |
| Python | `packages/sdk-python` (`uv run pytest`) | The Python SDK: its transport, sign-in and session, its client, cache and live queries, the shared case tables, and the programs its README shows, under `mypy` and `pyright`, both strict | Python 3.12 or later and `uv` |
| Gateway conformance | [`tests/conformance/gateway`](../../tests/conformance/gateway/README.md) | A running gateway, black-box, against `specs/`: every declared operation, every response and stream message, and hand-written protocol cases, on both signal planes | A built gateway; `nats-server` 2.10 or later on `PATH` |
| Dispatcher conformance | [`tests/conformance/dispatcher`](../../tests/conformance/dispatcher/README.md) | A running dispatcher, black-box, behind a real gateway on a real JetStream broker, against [JOBS.md](../protocol/JOBS.md) and every channel's schema | A built gateway and dispatcher; `nats-server` |
| SDK conformance | [`tests/conformance/sdk`](../../tests/conformance/sdk/README.md) | Every SDK, through a driver, as a client of a real gateway: one corpus of cases, on the wire and in live queries | A built gateway and the Rust drivers; `@semiont/sdk` built; `uv` and Python 3.12 or later, for the Python drivers; `nats-server` |
| End-to-end | [`tests/e2e`](../../tests/e2e/README.md) | The live Browser against a live gateway and knowledge base | A running stack and a user at its issuer |

The conformance suites import nothing from what they check. One line per service and per SDK in [`harness/paths.ts`](../../tests/conformance/harness/paths.ts) names the implementation, so the same cases judge any implementation of the same spec.

The tools: **Vitest** runs every TypeScript suite; **React Testing Library**, with the `jest-dom` and `jest-axe` matchers, tests components under jsdom; **Playwright** drives the end-to-end suite; Go's `testing` package, Cargo's test harness and **pytest** cover the rest.

## How suites are configured

There is no test orchestrator and no test environment to select. A suite's configuration is its own config file, and anything else a test needs it builds for itself: a temporary directory, a test double, a child process. No variable selects a profile.

### One shared Vitest config

[`vitest.shared.config.ts`](../../vitest.shared.config.ts) at the repository root holds what every workspace suite has in common:

- `globals: true` and the `node` environment;
- the test files, `src/**/*.test.{ts,tsx}`, excluding `node_modules` and `dist`;
- coverage: the `v8` provider; the reporters `text`, `json`, `json-summary`, `html`, `lcov` and `cobertura`; and the excludes — test files, config files, declaration files, `index.ts` barrels, generated `types.ts`, and the sidecars' `src/*-main.ts` process wiring.

It sets no coverage thresholds.

Each workspace's `vitest.config.*` merges it with `mergeConfig` and adds only what is local. `npm run lint:vitest-coverage` enforces this: every workspace that declares `test:coverage` must have a vitest config, that config must derive from the shared one, and it must not re-declare `coverage.reporter` — `mergeConfig` concatenates arrays, so a local list would run every reporter twice.

### What each workspace adds

| Workspace | Local configuration |
|---|---|
| `apps/browser` | `jsdom`; [`vitest.setup.ts`](../../apps/browser/vitest.setup.ts); the React plugin; the `@` → `src` alias; the `threads` pool with `maxConcurrency: 2`; `dangerouslyIgnoreUnhandledErrors`, for tests that throw on purpose; `tsconfig.test.json` for `vitest typecheck`; extra coverage excludes |
| `packages/react-ui` | `jsdom`; [`vitest.setup.ts`](../../packages/react-ui/vitest.setup.ts); the `@` → `src` alias; a coverage `include` of `src/**/*.{ts,tsx}` |
| `packages/core` | the `@` → `src` alias; a coverage `include` of `src/**/*.ts` |
| `packages/content` | a global setup that regenerates the gitignored PDF fixtures before every run |
| `packages/event-sourcing`, `packages/make-meaning` | a setup file that points `XDG_STATE_HOME` into the OS temp directory; make-meaning's also sets a 10-second test timeout |
| `packages/mcp-server` | test files limited to `src/**/*.test.ts`; a coverage `include` of `src/**/*.ts`, less `src/index.ts`, which boots a stdio server on import and is tested as a process |
| `packages/` `graph`, `http-transport`, `inference`, `jobs`, `observability`, `ontology`, `sdk`, `vectors` | nothing |

A coverage `include` also reports the files it matches that no test loads; without one, a report covers only the files the tests load.

The two jsdom setup files:

- **The Browser's** adds the jest-dom matchers; polyfills `DOMMatrix`, `matchMedia` and `getAnimations`; fixes `window.location` at `http://localhost:3000/`; stubs `URL.createObjectURL`; resolves relative `fetch` URLs against `http://localhost:3000`; mocks `react-router`'s hooks, `react-i18next` (serving the real English strings from the generated `messages/en.json`) and `@/i18n/routing`; and cleans up after each test.
- **react-ui's** adds the jest-dom and jest-axe matchers; fills jsdom's gaps (`DOMMatrix`, `scrollIntoView`, a `focus` that moves `document.activeElement`); cleans up after each test; and replaces `globalThis.fetch` with one that throws `Unit test attempted a network request: <url>`.

### Environment variables

No Vitest suite takes configuration from the shell. A test that exercises code which reads a variable sets it and restores it; a setup file sets only what production code in its process reads — `XDG_STATE_HOME`, above. The Boot Contract audit enforces the second rule: [`audit-test-env-hygiene.sh`](../../scripts/compliance/audit-test-env-hygiene.sh) fails when a test file under `apps/gateway`, `apps/browser` or `packages/*` exports a `SEMIONT_*` variable that no production code in the same process — the workspace and the `@semiont/*` packages it depends on — reads.

`NODE_ENV` selects nothing. Vitest sets it to `test` when it is unset; no code compares it to `test`, and the only reads — react-ui's error boundaries and the Browser's translation manager — check for `development` to show diagnostics.

### Test doubles, not services

Workspace suites run with nothing listening. CI's package matrix starts no database, vector store or model server, and the `graph`, `vectors` and `inference` suites pass without Neo4j, Qdrant or Ollama.

- **The SDK.** `@semiont/sdk/testing` provides a real `SemiontClient` (`createTestClient`) or `SemiontSession` (`createTestSession`) over `FaultyTransport`, the scriptable in-memory transport from `@semiont/core/testing`. An operation the test did not script throws `No response scripted for bus operation "<op>"` rather than answering with a fabricated reply. `stubGateway()` supplies gateway operations that each reject with their own name; `inMemoryContent()` stores content and throws on an unknown id. The Rust and Python SDKs ship the same doubles, `semiont::testing` and `semiont.testing`, for what is built on them.
- **React.** `@semiont/react-ui/test-utils` assembles those doubles into providers: `renderWithProviders` renders inside a real `SemiontBrowser` whose active session runs on them. The Browser's tests import it directly.
- **Property axioms.** `@semiont/core/testing/axioms` holds the StateUnit and liveness axiom harnesses. It needs `fast-check` in the importing package's devDependencies.
- **An identity provider.** `@semiont/core/testing/issuer` is an in-process OIDC issuer: signing keys, signed tokens, and the discovery and JWKS documents. It serves nothing; the consumer answers the two URLs.
- **A real broker where a mock would prove nothing.** `@semiont/jobs`' JetStream tests and the conformance suite's NATS plane spawn `nats-server` from `PATH`. A missing binary fails the run with instructions; it never skips.

### How the conformance suites are configured

[`tests/conformance/vitest.config.ts`](../../tests/conformance/vitest.config.ts) is its own config, not derived from the shared one. It holds three projects over one shared harness: `gateway`, `dispatcher` and `sdk`. It uses the `forks` pool with up to four workers, since each file boots its own gateways, issuer and broker, and a 60-second test timeout.

Each gateway the suite starts gets a fresh temporary directory holding its `GatewayConfig` document, and an environment of `PATH` plus the variables the case sets, such as `JWT_SECRET` and `SEMIONT_OIDC_CLIENT_ID`. Nothing else from your shell reaches it.

## Running tests

Tests run through each workspace's npm scripts, `cargo`, `go` and `uv`. The `semiont` launcher runs knowledge bases, not this repository's tests.

### From the repository root

`npm test` fans out to every workspace that defines a `test` script, and `npm run typecheck` does the same for `typecheck`. To target one workspace:

```bash
npm test --workspace=@semiont/make-meaning
```

`tests/conformance` and `tests/e2e` are not root workspaces. Each has its own `package.json` and lockfile and runs from its own directory.

### The npm workspaces

Every package under `packages/` runs `npm test` as `vitest run`, except `@semiont/react-ui`, which runs its suite as four sequential shards with an 8 GB heap. Every package defines `test:coverage`.

The Browser (`apps/browser/`) has one suite and several filters over it:

```bash
npm test                    # everything
npm run test:unit           # tests whose names do not match "integration"
npm run test:integration    # tests whose names match "integration"
npm run test:security       # session gates, locale layout, validation
npm run test:a11y           # tests whose names match "Accessibility"
npm run test:coverage       # everything, with coverage
npm run test:watch          # watch mode
```

`test`, `test:coverage` and `test:security` first generate the gitignored `messages/` directory the i18n mock reads; the other scripts expect it to exist. The Browser's own guide is [apps/browser/docs/TESTING.md](../../apps/browser/docs/TESTING.md), and react-ui's is [packages/react-ui/docs/TESTING.md](../../packages/react-ui/docs/TESTING.md).

### Rust

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`cargo test` checks the crates from inside. What the gateway and the dispatcher do as running services is the conformance suites' to check.

### The conformance suites

```bash
cargo build --release -p semiont-gateway -p semiont-dispatcher -p semiont-conformance-drivers
npm run build:packages
cd tests/conformance
npm ci
npm run test:gateway        # or test:dispatcher, test:sdk; npm test runs all three
```

Each script typechecks the cases first. What each suite checks is in its README, linked in the table above, and the gateway's is also described in [apps/gateway/docs/TESTING.md](../../apps/gateway/docs/TESTING.md).

### Go

As CI runs them:

```bash
cd apps/launcher && go test -timeout 30m ./...
cd packages/sdk-go && go test -timeout 5m ./...
```

The launcher's suite takes minutes; its notes are in [apps/launcher/README.md](../../apps/launcher/README.md#development).

### Python

As CI runs them, from `packages/sdk-python`:

```bash
uv sync --locked
uv run mypy
uv run pyright
uv run ruff check && uv run ruff format --check
uv run pytest
```

Both type checkers are part of the suite: `tests/refusals` holds programs that must not type-check, and `tests/readme` the programs the package's README shows, which `tests/test_readme.py` runs. The package's own tests are built on `semiont.testing`, the doubles it ships.

### In a container

None of the toolchains has to be on your machine. Two things to know:

**`node_modules` holds native binaries for the platform that installed it** (rolldown, lightningcss). Run tests in the same image family you installed with. An install made under the Alpine image (`node:<version>-alpine`) fails under the glibc one (`node:<version>`) with a `*.linux-<arch>-gnu.node` module-not-found, and the reverse fails the other way. `tsc --noEmit` runs under either.

```bash
container run --rm -v "$(pwd)":/work -w /work "node:$(scripts/ci/node-version.sh)-alpine" \
  sh -c 'npm test --workspace=@semiont/make-meaning'
```

**`@semiont/jobs` and the conformance suites need `nats-server`**, which Alpine packages:

```bash
container run --rm -v "$(pwd)":/work -w /work "node:$(scripts/ci/node-version.sh)-alpine" \
  sh -c 'apk add --no-cache nats-server && npm test --workspace=@semiont/jobs'
```

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

Coverage is measured per workspace and reported to Codecov. [`codecov.yml`](../../codecov.yml) sets the gates:

- **Project:** target 70%, allowed to drop by 1%.
- **Patch:** new code targets 80%, with a 5% threshold.

Each package and the Browser has a flag (with carryforward) and a component. `package-tests.yml` uploads each package's `lcov.info` under its flag; `security-tests.yml` uploads the Browser's. `npm run lint:coverage-roster` fails when the workspaces declaring `test:coverage`, the package matrix, and codecov's flags and components disagree. No vitest config sets a threshold, so a coverage run never fails a suite.

Excluded from coverage: what the shared config excludes (see [One shared Vitest config](#one-shared-vitest-config)), plus codecov's `ignore` list — test files and directories, build output, config files, generated files, and `scripts/`.

`npm run test:coverage` writes a workspace's `coverage/` directory: `lcov.info`, `coverage-summary.json`, `cobertura-coverage.xml`, and an HTML report at `coverage/index.html`.

## Continuous integration

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on pushes to `main` and `develop`, on pull requests into them, and on manual dispatch:

| Job | What it covers |
|---|---|
| `test-browser` | `npm run typecheck` and `npm test` for `apps/browser` |
| `test-gateway` | `cargo fmt --check`, `clippy -D warnings` and `cargo test` for the Rust workspace; which crates may depend on which; the published crates' set and version, and each packaged and built from its packaged form (`cargo publish --dry-run`); the licence policy for the crates each image links |
| `gateway-conformance` | Builds the gateway and runs the conformance suite's `gateway` project |
| `dispatcher-conformance` | Builds the gateway and the dispatcher and runs the `dispatcher` project |
| `sdk-conformance` | Builds the gateway, the Rust drivers and `@semiont/sdk`, installs the Python SDK's locked environment, and runs the `sdk` project |
| `test-sdk-python` | `mypy` and `pyright`, each as Linux and as Windows, `ruff`, and `pytest` on Python 3.12, 3.13 and 3.14, for `packages/sdk-python`; the distributions a release uploads are built and checked |
| `test-sdk-python-windows` | The Python SDK's sign-in store and state directory tests, on Windows |
| `test-comprehensive` | The Browser suite again, after a full package build |
| `validate-config` | `npm ci --include=optional` and `npm run build:packages` |
| `check-phantom-deps` | Every import in a published `dist` is declared by its package |
| `build-all` | `npm run build`, after `test-browser` and `test-gateway` pass |
| `generated-artifacts` | Drift between the bus registry and its generated TypeScript and Go, between the bundled OpenAPI spec and `packages/sdk-go/client_gen.go`, between `specs/` and the Python SDK's generated modules and models, and Go schema coverage |
| `test-launcher` | `gofmt` over both Go modules; `go vet` and `go test` for the launcher; `go vet`, `go build` and `go test` for `packages/sdk-go`; `govulncheck` for the launcher |
| `test-launcher-windows` | `go vet` and `go test` for the launcher on Windows |

Four other workflows gate the same pushes and pull requests:

| Workflow | What it runs |
|---|---|
| [`package-tests.yml`](../../.github/workflows/package-tests.yml) | A matrix over every package with a suite: typecheck, `npm test`, then `test:coverage` and the Codecov upload, neither of which fails the job |
| [`security-tests.yml`](../../.github/workflows/security-tests.yml) | The Browser's `test:security` and `test:coverage`; a built Browser probed for privileged content in its shell; a built gateway probed for 401s on protected routes, the error shape, and leaked secrets |
| [`accessibility-tests.yml`](../../.github/workflows/accessibility-tests.yml) | react-ui's `test:a11y`; the Browser's suite; Lighthouse against a built Browser, failing below an accessibility score of 90. Also daily |
| [`architecture-compliance.yml`](../../.github/workflows/architecture-compliance.yml) | The audits in [`scripts/compliance/`](../../scripts/compliance/) and the `lint:*` gates: the doc snippets, raw bus use, the state-unit axioms, the boot contract, the spec's own consistency, and more. Also on pushes to `feature/**` |

[`stack-smoke.yml`](../../.github/workflows/stack-smoke.yml) is not a gate on every pull request. On manual dispatch it builds every image and the launcher from the commit, or takes a published tag, and runs [`scripts/release/smoke-stack.sh`](../../scripts/release/smoke-stack.sh), which boots a real stack and says what it checks.

Locally, run the suite for the code you changed. CI runs the whole matrix.

## Related

- [Local Development](LOCAL-DEVELOPMENT.md): building a stack from your tree to test against
- [Browser testing](../../apps/browser/docs/TESTING.md), [react-ui testing](../../packages/react-ui/docs/TESTING.md), [gateway testing](../../apps/gateway/docs/TESTING.md): each part's own guide
- [The conformance suites](../../tests/conformance/README.md): what they are and how the harness works
- [Testing with the SDK's doubles](../builder/react-ui/TESTING.md): for anyone building on the SDK
