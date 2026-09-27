# Testing Guide - Semiont

This guide covers how Semiont's test suites are organized, configured and run: the in-process suites in every workspace, the black-box gateway conformance suite, the Go suites, and the end-to-end suite that drives a live stack.

## Overview

- **Vitest** runs every TypeScript suite: each workspace under `apps/` and `packages/`, and the gateway conformance suite.
- **React Testing Library**, with the `@testing-library/jest-dom` and `jest-axe` matchers, tests the components in `@semiont/react-ui` and the Browser under jsdom.
- **The SDK's test doubles** (`@semiont/sdk/testing`, `@semiont/core/testing`) stand in for a knowledge base: a real `SemiontClient` over a scriptable in-memory transport. Unit tests make no network requests.
- **Playwright** drives the live Browser in the end-to-end suite.
- **Go's `testing` package** covers the launcher and `packages/sdk-go`.

## Test Suites

| Suite | Where | What it exercises | Needs |
|---|---|---|---|
| Workspace suites | every workspace in `apps/*` and `packages/*` with a `test` script, the gateway aside | Units and in-process integration: components, hooks, SDK namespaces, services composed over test doubles | Nothing running, except `nats-server` on `PATH` for `@semiont/jobs` |
| Gateway manifest census | `apps/gateway` (`npm test`) | The gateway's `package.json`: its runtime dependencies are exactly what its source imports | Nothing |
| Gateway conformance | [`tests/gateway-conformance`](../../tests/gateway-conformance/README.md) | A running gateway, black-box, against `specs/`: every declared operation, every response and stream message, and hand-written protocol cases, on both signal planes | A built gateway and `nats-server` 2.10 or later on `PATH` |
| Go | `apps/launcher`, `packages/sdk-go` | The launcher driving a fake runtime through real start/stop lifecycles; the Go bus client's wire contract | The Go toolchain named in each `go.mod` |
| End-to-end | [`tests/e2e`](../../tests/e2e/README.md) | The live Browser against a live gateway and knowledge base | A running stack and a user in its issuer |

The Browser's `test:unit`, `test:integration`, `test:security` and `test:a11y` scripts are filters over its one suite, not separate suites — see [Running Tests](#running-tests).

CI adds checks that are not test suites: the security workflow starts a built Browser and gateway and probes them with `curl`, the accessibility workflow runs Lighthouse against a built Browser, and the architecture workflow runs the lint and compliance audits. See [Continuous Integration](#continuous-integration).

The end-to-end suite has its own section below: [End-to-End Tests](#end-to-end-tests).

## Test Environment Configuration

There is no test orchestrator and no test environment to select. A suite's configuration is its own config file — a `vitest.config.*`, or the e2e suite's `playwright.config.ts` — and anything else a test needs it builds for itself: a temporary directory, a test double, a child process. No configuration file is handed to a test run, and no variable selects a profile.

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
| `apps/gateway`, and `packages/` `graph`, `http-transport`, `inference`, `jobs`, `observability`, `ontology`, `sdk`, `vectors` | nothing |

A coverage `include` also reports the files it matches that no test loads; without one, a report covers only the files the tests load.

The two jsdom setup files:

- **The Browser's** adds the jest-dom matchers; polyfills `DOMMatrix`, `matchMedia` and `getAnimations`; fixes `window.location` at `http://localhost:3000/`; stubs `URL.createObjectURL`; resolves relative `fetch` URLs against `http://localhost:3000`; mocks `react-router`'s hooks, `react-i18next` (serving the real English strings from the generated `messages/en.json`) and `@/i18n/routing`; and cleans up after each test.
- **react-ui's** adds the jest-dom and jest-axe matchers; fills jsdom's gaps (`DOMMatrix`, `scrollIntoView`, a `focus` that moves `document.activeElement`); cleans up after each test; and replaces `globalThis.fetch` with one that throws `Unit test attempted a network request: <url>`.

### Environment variables

No Vitest suite takes configuration from the shell. A test that exercises code which reads a variable sets it and restores it; a setup file sets only what production code in its process reads — `XDG_STATE_HOME`, above. The Boot Contract audit enforces the second rule: [`audit-test-env-hygiene.sh`](../../scripts/compliance/audit-test-env-hygiene.sh) fails when a test file under `apps/gateway`, `apps/browser` or `packages/*` exports a `SEMIONT_*` variable that no production code in the same process — the workspace and the `@semiont/*` packages it depends on — reads.

`NODE_ENV` selects nothing. Vitest sets it to `test` when it is unset; no code compares it to `test`, and the only reads — react-ui's error boundaries and the Browser's translation manager — check for `development` to show diagnostics.

### Test doubles, not services

Workspace suites run with nothing listening. CI's package matrix starts no database, vector store or model server, and the `graph`, `vectors` and `inference` suites pass without Neo4j, Qdrant or Ollama.

- **The SDK.** `@semiont/sdk/testing` provides a real `SemiontClient` (`createTestClient`) or `SemiontSession` (`createTestSession`) over `FaultyTransport`, the scriptable in-memory transport from `@semiont/core/testing`. An operation the test did not script throws `No response scripted for bus operation "<op>"` rather than answering with a fabricated reply. `stubGateway()` supplies gateway operations that each reject with their own name; `inMemoryContent()` stores content and throws on an unknown id.
- **React.** `@semiont/react-ui/test-utils` assembles those doubles into providers: `renderWithProviders` renders inside a real `SemiontBrowser` whose active session runs on them. The Browser's [`src/test-utils.tsx`](../../apps/browser/src/test-utils.tsx) builds on it.
- **Property axioms.** `@semiont/core/testing/axioms` holds the StateUnit and liveness axiom harnesses. It needs `fast-check` in the importing package's devDependencies.
- **An identity provider.** `@semiont/core/testing/issuer` is an in-process OIDC issuer: signing keys, signed tokens, and the discovery and JWKS documents. It serves nothing; the consumer answers the two URLs.
- **A real broker where a mock would prove nothing.** `@semiont/jobs`' JetStream tests and the conformance suite's NATS plane spawn `nats-server` from `PATH`. A missing binary fails the run with instructions; it never skips.

### The gateway conformance suite

[`tests/gateway-conformance/vitest.config.ts`](../../tests/gateway-conformance/vitest.config.ts) is its own config, not derived from the shared one: test files `cases/**/*.test.ts`; the `forks` pool with up to four workers, since each file boots its own gateways, issuer, Archivist and broker on ports of its own; and 60-second test and hook timeouts. Its global setup refuses to start without a built gateway (`apps/gateway/dist/index.js`) or `nats-server`, and bundles the gateway's and the Archivist's specs from `specs/src` at the start of every run.

Each gateway the suite starts gets a fresh temporary `HOME` holding `~/.semiontconfig` — the `GatewayConfig` document — and an environment of `PATH`, `HOME`, and the variables the case sets, such as `JWT_SECRET`, `SEMIONT_OIDC_CLIENT_ID`, `SEMIONT_OIDC_CLIENT_SECRET` and `OTEL_EXPORTER_OTLP_ENDPOINT`. Nothing else from the developer's shell reaches it.

### The end-to-end suite

[`tests/e2e/playwright.config.ts`](../../tests/e2e/playwright.config.ts) reads four variables: `E2E_EMAIL` and `E2E_PASSWORD`, which are required — the config exits before any test runs if either is missing — and `E2E_BROWSER_URL` and `E2E_GATEWAY_URL`, which default to `http://localhost:3000` and `http://localhost:4000`. Its global setup seeds the knowledge base through `@semiont/sdk`. See [End-to-End Tests](#end-to-end-tests).

## Browser Testing Stack

### Core Technologies

#### Vitest
- ESM-first test runner built on Vite
- Jest-compatible API
- Parallel test execution
- Native TypeScript support

#### React Testing Library
- Encourages testing user interactions
- Focuses on accessibility and user experience
- `@testing-library/jest-dom` matchers for DOM assertions, `jest-axe` for accessibility violations

#### The SDK's test doubles
- A real `SemiontClient` and `SemiontSession` over a scriptable in-memory transport
- Unscripted operations fail loudly, naming the operation
- Composed into React providers by `@semiont/react-ui/test-utils`

The Vitest configs and setup files are described under [Test Environment Configuration](#test-environment-configuration).

### TypeScript Configuration for Tests

The Browser typechecks its test files with a separate [`tsconfig.test.json`](../../apps/browser/tsconfig.test.json). It extends `tsconfig.json`, adds the `vitest`, `vitest/globals`, `@testing-library/jest-dom`, `node`, `react` and `react-dom` types, and includes `vitest.setup.ts` and every test file. Three scripts use the two configs:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit --project tsconfig.json",
    "typecheck:test": "tsc --noEmit -p tsconfig.test.json",
    "typecheck:all": "npm run typecheck && npm run typecheck:test"
  }
}
```

**Note**: When using Vitest with TypeScript, you may encounter issues with the `vi` namespace in type annotations. To fix this, import types explicitly:

```typescript
// Instead of:
const mock = fn as vi.MockedFunction<typeof fn>

// Use:
import type { MockedFunction } from 'vitest'
const mock = fn as MockedFunction<typeof fn>
```

## Writing Tests

### Component Tests

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SemiontBranding } from '@semiont/react-ui'

describe('SemiontBranding', () => {
  it('renders the tagline the host supplies', () => {
    const t = (key: string) => (key === 'tagline' ? 'make meaning' : key)
    render(<SemiontBranding t={t} />)

    expect(screen.getByText('make meaning')).toBeInTheDocument()
  })

  it('omits the tagline when asked to', () => {
    const t = vi.fn((key: string) => key)
    render(<SemiontBranding t={t} showTagline={false} />)

    expect(screen.queryByText('tagline')).not.toBeInTheDocument()
    expect(t).not.toHaveBeenCalledWith('tagline')
  })
})
```

### Code That Talks to a Knowledge Base

Script the transport, then observe through a real client:

```typescript
import { createTestClient } from '@semiont/sdk/testing'

const { client, transport } = createTestClient()
transport.queueReply('browse:resources-requested', { resources: [], total: 0, offset: 0 })
// Hand `client` to the unit under test. An operation nobody scripted throws
// "No response scripted for bus operation ..." instead of answering.
```

`queueReply` scripts what the gateway answers; the transport's `schedule` scripts the wire (`deliver`, `drop-reply`, `delay`, `duplicate-reply`, `reject-emit`). For components, `renderWithProviders` from `@semiont/react-ui/test-utils` renders inside a `SemiontBrowser` on the same doubles, or inside one the test passes as `browser`. The patterns are in [react-ui's testing guide](../../packages/react-ui/docs/TESTING.md).

## Best Practices

### 1. Test User Behavior, Not Implementation
```typescript
// ❌ Bad - Testing implementation details
expect(component.state.isOpen).toBe(true)

// ✅ Good - Testing user-visible behavior
expect(screen.getByText('Modal content')).toBeInTheDocument()
```

### 2. Use Accessible Queries
```typescript
// ❌ Bad - Using test IDs
const button = screen.getByTestId('submit-button')

// ✅ Good - Using accessible roles and text
const button = screen.getByRole('button', { name: /submit/i })
```

### 3. Script the SDK, Not the Network
```typescript
// ❌ Bad - a hand-rolled mock encodes its author's model of the contract
vi.mock('@semiont/http-transport', () => ({
  HttpTransport: vi.fn(() => ({ emit: vi.fn() }))
}))

// ✅ Good - a real client over the scriptable transport
const { client, transport } = createTestClient()
transport.queueReply('browse:resources-requested', { resources: [], total: 0, offset: 0 })
```

Unit tests never reach the network: react-ui's setup file makes any `fetch` throw.

### 4. Keep Tests Focused
```typescript
// Each test should verify one behavior
it('should show error message when loading fails', async () => {
  // Arrange - a data source that fails
  const load = vi.fn().mockRejectedValue(new Error('offline'))

  // Act - Render component
  render(<DataDisplay load={load} />)

  // Assert - Check error is displayed
  await waitFor(() => {
    expect(screen.getByText(/error loading data/i)).toBeInTheDocument()
  })
})
```

### 5. Use Descriptive Test Names
```typescript
// ❌ Bad
it('should work', () => {})

// ✅ Good
it('should display user name after successful login', () => {})
```

### 6. Give `beforeEach`/`beforeAll` a Block Body

Vitest treats a function *returned* from a setup hook as that test's teardown
callback. `mockClear()`, `mockReset()`, and `mockRestore()` all return the mock
itself for chaining, so a concise-arrow hook silently registers the mock as
teardown — and the runner calls it after every test in the describe.

```typescript
// ❌ Bad - returns the mock; vitest calls it as teardown after each test
beforeEach(() => scrollSpy.mockClear());

// ✅ Good - block body returns undefined
beforeEach(() => { scrollSpy.mockClear(); });
```

This stays invisible until someone gives that mock a throwing or rejecting
implementation. Then the test body's assertions pass, teardown invokes the mock,
and the throw propagates — the test fails with the error's *construction* site as
the reported location and no assertion diff, which reads like a bug anywhere but
the hook. Only the mock-method forms are affected; `beforeAll(() =>
vi.clearAllMocks())` is fine, because `vi` is an object rather than a function.

## End-to-End Tests

The e2e suite at [`tests/e2e/`](../../tests/e2e/) is its own package, with its own lockfile, running Playwright against a real running stack. It exists to catch regressions that no in-process test can see: SSE timing windows, lifecycle-vs-bus race conditions, navigation tear-down, sign-out/sign-in session rebuild, and end-to-end persistence of annotations across reload.

The suite is **deliberately scoped**. It is the smallest set of paths that has broken before and that unit/integration tests can't catch. Pure component logic stays in unit tests; multi-component interaction in a composed tree stays in integration tests; e2e is reserved for cross-layer behavior that requires the real wire.

### What's in scope

- **Not in CI.** No workflow runs it. Run it locally against a stack you brought up.
- **Seeded.** Playwright's global setup, [`scripts/seed.ts`](../../tests/e2e/scripts/seed.ts), authenticates through `@semiont/sdk` and uploads the fixtures the specs assume: text resources for the annotation specs, PDFs for the PDF specs. Each seed has a stable storage URI, so a re-run against a seeded knowledge base skips it.
- **Real sign-in.** Connect leaves the Browser for the launcher-run Keycloak, and the fixture types the credentials into its login page.
- **Single-worker, no retries.** One worker; a flake is diagnosed, not retried away.
- **Chromium only.** No cross-browser matrix.
- **Slow specs opt in.** `npm test` excludes specs tagged `@slow`; `npm run test:slow` runs only those.

### Layout

```text
tests/e2e/
├── specs/                # NN-short-name.spec.ts, one per guarded path
├── fixtures/             # auth (signedInPage), bus-log, discover, generate,
│                         #   generated, jaeger, page-errors, sdk-session
├── lib/
├── scripts/              # seed.ts (the global setup) and live-monitoring helpers
├── docs/                 # the operations manual (linked below)
├── playwright.config.ts
├── package.json          # own dependencies
└── package-lock.json     # own lockfile — the authority for them
```

### Protocol-level assertions, not just UI

The unique feature of the e2e suite is **wire-level assertions** via the bus-log capture. UI assertions are weak — "the highlight appeared" passes if the UI ended up right via a stale cache, a different endpoint, or a broken handler that got backfilled by a refetch. Protocol assertions are strong — "a `mark:create-request` was emitted, and a `mark:create-ok` arrived with matching `correlationId`" fails immediately if the wire regresses.

Every emit/recv/SSE/PUT/GET that crosses a transport boundary is logged in a grep-friendly format the moment `__SEMIONT_BUS_LOG__` is on:

```
[bus EMIT] mark:create-request [scope=res-1] [cid=a89a670a] [trace=8f3ca4ed] {...}
[bus RECV] mark:create-ok      [scope=res-1] [cid=a89a670a] [trace=8f3ca4ed] {...}
```

The `bus` fixture flips that flag via `addInitScript` before page load and collects the lines into a structured capture:

```ts
import { test, expect } from '../fixtures/auth';

test('manual highlight persists', async ({ signedInPage: page, bus }) => {
  await page.goto('/en/know/discover');
  bus.clear();  // scope assertions to what follows

  await page.getByRole('button', { name: /open resource/i }).first().click();
  // ... drive the highlight gesture ...

  // Wire-level assertion — strongest:
  await bus.expectRequestResponse('mark:create-request', 'mark:create-ok');

  // UI assertion — weaker, but catches rendering bugs:
  await expect(page.getByText(/your highlight/i)).toBeVisible();
});
```

The same bus log works in Node — set `SEMIONT_BUS_LOG=1` and every gateway / worker / smelter emit gets logged. Useful well beyond e2e; covered in [`tests/e2e/docs/bus-logging.md`](../../tests/e2e/docs/bus-logging.md).

### Required environment

Two required, two with local-dev defaults:

| Var | Default | Purpose |
|---|---|---|
| `E2E_EMAIL` | (required) | User to sign in as |
| `E2E_PASSWORD` | (required) | Password for that user |
| `E2E_BROWSER_URL` | `http://localhost:3000` | The Browser the tests drive |
| `E2E_GATEWAY_URL` | `http://localhost:4000` | Gateway the sign-in form points at |

No fallback for the credentials, on purpose — the suite fails fast if `E2E_EMAIL`/`E2E_PASSWORD` aren't set, so it never silently uses a default account. The user must exist in the stack's issuer; the stack flow in [`tests/e2e/README.md`](../../tests/e2e/README.md#running-against-a-freshly-built-stack) creates `admin@example.com` with `semiont useradd`.

### Quick run

The recommended path on macOS is the official Playwright container. From inside it, `localhost` is the container itself, so reach the stack's host-published ports through the host bridge gateway, `192.168.64.1` — it is stable across restarts, where a container's own IP is not:

```sh
# 1. Bring up the stack (Browser + gateway + KB), once per session.
#    See tests/e2e/README.md "Running against a freshly-built stack".

# 2. The image tag must match the installed @playwright/test.
PW=$(node -p "require('./tests/e2e/node_modules/@playwright/test/package.json').version")

# 3. Run the suite.
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

Use `npm test` rather than `npx playwright test`: `pretest` runs
`tsc --noEmit` over the specs and aborts before any browser starts.
`tests/e2e` is not a root workspace, so nothing else typechecks it.

Run from the host (with Node + Playwright installed):

```sh
cd tests/e2e
npm ci                             # installs the lockfile exactly; never rewrites it
npx playwright install chromium    # one-time browser download
npm test
npm run test:slow       # only the @slow specs
npm run test:headed     # watch the browser
npm run test:debug      # Playwright inspector (step through)
npm run test:ui         # Playwright runner UI
```

Run a single spec or a single test by title:

```sh
npm test -- specs/02-open-resource.spec.ts
npm test -- -g 'opens the first resource'
```

(`npm test -- <args>` keeps the typecheck gate; bare `npx playwright test`
skips it.)

`--repeat-each 5` is the default flake check — a deterministic test passes 5/5; a race fails a fraction of the time. Reach for it before claiming a flake is fixed.

### Debugging failures

Inner loop, in priority order:

1. **Re-run the failing test with the bus log** under `--repeat-each 3` to separate flake from determinism.
2. **Tail the gateway** during the run: `container logs -f semiont-gateway`. If the event never reaches the gateway, it's a Browser emit/subscribe problem; if the gateway logs the emit but no SSE write follows, it's a result-channel problem.
3. **Open the trace report** (`npm run show-report`). Each failed test has a DOM snapshot, a screenshot, a video, and a `trace.zip` for time-travel debugging in Playwright's trace viewer.
4. **Pull `console.error` from the trace** without booting the viewer — see [`tests/e2e/docs/debugging.md`](../../tests/e2e/docs/debugging.md#pulling-a-js-error-from-a-trace) for the JSONL recipe.
5. **Write a throwaway diagnostic spec** with the minimum flow and no assertions. If the diagnostic succeeds where the real test fails, the delta between them is the bug.
6. **Last resort: `npm run test:headed`** and watch.

The recurring lesson: instrument, don't speculate. A `console.log` in the product code → rebuild → restart → re-run is a 90-second round-trip. Twenty minutes of "what should happen" reasoning rarely beats it.

### Container rebuild flow (when you've changed product code)

Anything inside `@semiont/*` is published to a local Verdaccio and consumed via `npm install` in the container builds — your local source tree is invisible to the running stack until you republish.

After any product-code change, run `./scripts/ci/local-build.sh`, then restart the stack with `SEMIONT_VERSION=local semiont start`. The script builds every service image and the Browser image, plus the launcher, against the local registry, tagged `:local`.

Two pitfalls that have caught real time before:

- **`SEMIONT_VERSION=local` is load-bearing.** A stack consumes the `:local` images only when started with it. Without it, the launcher pulls the published images and your local changes are invisible.
- **Apple container `--rm` is unreliable.** Stopped containers linger and conflict on next start. Wipe with `container stop $name && container rm $name` before retrying.

Full step-by-step in [`tests/e2e/docs/containers.md`](../../tests/e2e/docs/containers.md).

### Writing a new e2e test

Keep the bar high: **a path that has broken before, that unit/integration tests can't catch.** Cross-layer regressions are the sweet spot.

Spec template:

```ts
// specs/NN-short-name.spec.ts
import { test, expect } from '../fixtures/auth';

test.describe('short description', () => {
  test('does the thing', async ({ signedInPage: page, bus }) => {
    await page.goto('/en/know/discover');
    bus.clear();

    await page.getByRole('button', { name: /some action/i }).click();

    // Strong: protocol assertion.
    await bus.expectRequestResponse('foo:requested', 'foo:result');

    // Optional: UI assertion for rendering details.
    await expect(page.getByText(/success/i)).toBeVisible();
  });
});
```

Key conventions:

- **Fixture ordering matters.** The `bus` fixture's `addInitScript` runs *before* `page.goto`. That ordering is guaranteed when you destructure `bus` in the test params or use `signedInPage` (which depends on `bus`). If you build a helper that creates its own `page`, re-attach the bus log there with `attachBusLog(page)` first.
- **Selectors prefer role + accessible name.** Fall back to `getByPlaceholder` only when role-based queries can't disambiguate.
- **Skip explicitly.** `test.skip(...)` with a one-line reason. Never let a test pass by silently returning early.
- **Tag long specs `@slow`** so `npm test` leaves them to `npm run test:slow`.

Full guide: [`tests/e2e/docs/writing.md`](../../tests/e2e/docs/writing.md).

### Known gotchas

The ones that have cost real debugging time, captured so you don't re-discover them:

- **`crypto.randomUUID` requires a secure context.** `localhost` and `127.0.0.1` count as secure; `http://192.168.x.x` does not, and there `crypto.randomUUID` is undefined. Browser-reachable code takes its ids from `@semiont/core`'s helpers, built on `crypto.getRandomValues()`, so the suite needs no polyfill. A "crypto.randomUUID is not a function" error means someone added a direct call to browser-reachable code.
- **Container IPs change on every restart.** Apple's container runtime assigns a fresh bridge IP on every `container run` and `container start`. Point the suite at the host bridge gateway, `192.168.64.1`, never a container's own IP.
- **Stale browser tabs poison gateway logs.** A lingering tab from an earlier dev session retries SSE with an expired token, flooding `container logs` with `401`s. Close the tab before debugging.
- **Playwright image tag must match `@playwright/test`.** Derive it from the installed package, as in [Quick run](#quick-run); after a dependency bump, `npm ci` in `tests/e2e` before running.

Full list in [`tests/e2e/docs/gotchas.md`](../../tests/e2e/docs/gotchas.md).

### Where to read next

The operational depth lives in [`tests/e2e/docs/`](../../tests/e2e/docs/):

- **[running.md](../../tests/e2e/docs/running.md)** — invocation, single spec, headed, `--repeat-each`, host vs. container.
- **[containers.md](../../tests/e2e/docs/containers.md)** — Apple container CLI, Verdaccio, full rebuild lifecycle.
- **[writing.md](../../tests/e2e/docs/writing.md)** — spec template, fixture ordering, selector conventions.
- **[debugging.md](../../tests/e2e/docs/debugging.md)** — traces, JSONL recipes, diagnostic specs.
- **[bus-logging.md](../../tests/e2e/docs/bus-logging.md)** — `__SEMIONT_BUS_LOG__`, the `bus` capture fixture, every helper.
- **[jaeger.md](../../tests/e2e/docs/jaeger.md)** — the `jaeger` fixture that attaches matching distributed traces to the report.
- **[page-errors.md](../../tests/e2e/docs/page-errors.md)** — the `pageErrors` fixture for uncaught browser-side errors.
- **[live-monitoring.md](../../tests/e2e/docs/live-monitoring.md)** — bug-hunting on the running stack without Playwright.
- **[gotchas.md](../../tests/e2e/docs/gotchas.md)** — full list of sharp edges.

## Coverage

Coverage is measured per workspace and reported to Codecov. [`codecov.yml`](../../codecov.yml) sets the gates:

- **Project:** target 70%, allowed to drop by 1%.
- **Patch:** new code targets 80%, with a 5% threshold.

Each package and the Browser has a flag (with carryforward) and a component. `package-tests.yml` uploads each package's `lcov.info` under its flag; `security-tests.yml` uploads the Browser's. `npm run lint:coverage-roster` fails when the workspaces declaring `test:coverage`, the package matrix, and codecov's flags and components disagree. No vitest config sets a threshold, so a coverage run never fails a suite.

Excluded from coverage: what the shared config excludes (see [One shared Vitest config](#one-shared-vitest-config)), plus codecov's `ignore` list — test files and directories, build output, config files, generated files, examples and demos, and `scripts/`.

## Running Tests

Tests run through each workspace's npm scripts. There is no `semiont test` command: the `semiont` launcher runs knowledge bases, not this monorepo's test suite.

### From the repository root

`npm test` fans out to every workspace that defines a `test` script (`--workspaces --if-present` over `apps/*`, `packages/*` and `packages/sdk/docs/__snippets__`), and `npm run typecheck` does the same for `typecheck`. `tests/gateway-conformance` and `tests/e2e` are not root workspaces — each has its own `package.json` and lockfile and runs from its own directory — and the Go modules run under `go test`.

To target one workspace from the root, use `--workspace`:

```bash
npm test --workspace=@semiont/make-meaning
```

### Per-workspace scripts

Every npm package under `packages/` runs `npm test` as `vitest run`, except `@semiont/react-ui`, which runs its suite as four sequential shards (`test:shard:1`–`4`) with an 8 GB heap. Every package defines `test:coverage`.

Browser (`apps/browser/`):

```bash
npm test                    # Everything
npm run test:unit           # Tests whose names do not match "integration"
npm run test:integration    # Tests whose names match "integration"
npm run test:security       # Session gates, locale layout, validation
npm run test:a11y           # Tests whose names match "Accessibility"
npm run test:coverage       # Everything, with coverage
npm run test:watch          # Watch mode
npm run test:ui             # Vitest UI
```

`test`, `test:coverage` and `test:security` first run `scripts/merge-translations.js`, which generates the gitignored `messages/` directory the i18n mock reads; the other scripts expect it to exist.

Gateway (`apps/gateway/`): `npm test` runs only the manifest census. The gateway's behaviour is the conformance suite's, run against a built gateway:

```bash
npm run build:packages
npm run build -w semiont-gateway
cd tests/gateway-conformance
npm ci
npm test
```

Its `pretest` typechecks the cases first. What each check covers is in the gateway's [TESTING.md](../../apps/gateway/docs/TESTING.md).

Go, as CI runs them:

```bash
cd apps/launcher && go test -timeout 30m ./...
```

```bash
cd packages/sdk-go && go test -timeout 5m ./...
```

The launcher suite takes minutes; its development notes are in [`apps/launcher/README.md`](../../apps/launcher/README.md#development).

### Run them in a container

This repo's `node_modules` carries **musl** native binaries (rolldown,
lightningcss), so use an Alpine image — a glibc `node:24` fails with a
`*.linux-<arch>-gnu.node` module-not-found:

```bash
container run --rm -v "$(pwd)":/work -w /work node:24-alpine \
  sh -c 'npm test --workspace=@semiont/make-meaning'
```

`tsc --noEmit` is libc-agnostic and runs under either image.

`@semiont/jobs` and the conformance suite need `nats-server`; Alpine packages it:

```bash
container run --rm -v "$(pwd)":/work -w /work node:24-alpine \
  sh -c 'apk add --no-cache nats-server && npm test --workspace=@semiont/jobs'
```

For Go, use the `golang` image whose tag satisfies the `toolchain` line in the module's `go.mod`:

```bash
container run --rm -v "$(pwd)":/work -w /work/packages/sdk-go golang:1.27.1 go test -timeout 5m ./...
```

### Coverage reports

`npm run test:coverage` writes the workspace's `coverage/` directory — `lcov.info`, `coverage-summary.json`, `cobertura-coverage.xml`, and an HTML report at `coverage/index.html` — alongside the console summary.

### End-to-end tests

E2E tests run against a live stack, not a workspace script — see
[End-to-End Tests](#end-to-end-tests) above for the environment they need and how
to bring the stack up.

## Debugging Tests

### Common Issues

1. **A unit test attempted a network request**
   ```text
   Unit test attempted a network request: <url>
   ```
   react-ui's setup file refuses every `fetch`. Build the client from `@semiont/sdk/testing` (or through `renderWithProviders`) and script the response, rather than issuing a request no server answers.

2. **No response scripted for a bus operation**
   ```text
   No response scripted for bus operation "<op>".
   ```
   The unit reached an operation the test did not script. Add `transport.queueReply('<op>', <response>)`, or pass a `makeResponse` that handles it.

3. **Vitest globals not found**
   ```typescript
   // A config that merges vitest.shared.config.ts gets globals: true.
   // Otherwise import explicitly:
   import { describe, it, expect } from 'vitest'
   ```

4. **Async tests timing out**
   ```typescript
   // Use waitFor for async operations
   await waitFor(() => {
     expect(screen.getByText('Loaded')).toBeInTheDocument()
   }, { timeout: 5000 })
   ```

### Debugging Tools

- `screen.debug()` - Print current DOM
- `screen.logTestingPlaygroundURL()` - Get testing playground link
- `vi.mocked(module).mock.calls` - Inspect mock calls
- `transport.requestLog` - Every request a `FaultyTransport` saw, in order, with the action its schedule applied

## Continuous Integration

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on pushes to
`main` and `develop`, on pull requests into them, and on manual dispatch, on
Node 24, with these jobs:

| Job | What it covers |
|---|---|
| `test-browser` | `npm run typecheck` + `npm test` for `apps/browser` |
| `test-gateway` | `npm run typecheck` + the manifest census for `apps/gateway` |
| `gateway-conformance` | Builds the gateway, installs `nats-server`, runs `tests/gateway-conformance` |
| `test-comprehensive` | The Browser suite and the gateway census again, one subshell each |
| `validate-config` | `npm ci --include=optional` + `npm run build:packages` |
| `check-phantom-deps` | Every import in a published `dist` is declared by its package |
| `build-all` | `npm run build`, after `test-browser` and `test-gateway` pass |
| `generated-artifacts` | Drift checks: the bus registry vs its generated TypeScript and Go, the bundled OpenAPI spec vs `packages/sdk-go/client_gen.go`, and Go schema coverage |
| `test-launcher` | `gofmt` over both Go modules; `go vet` and `go test` for `apps/launcher`; `go vet`, `go build` and `go test` for `packages/sdk-go`; `govulncheck` for the launcher |

Four other workflows carry test gates of their own, on the same pushes and pull requests:

| Workflow | What it runs |
|---|---|
| [`package-tests.yml`](../../.github/workflows/package-tests.yml) | A matrix over every package in `packages/` with a suite: typecheck, `npm test`, then `test:coverage` and the Codecov upload (neither of which fails the job); `nats-server` is installed for `jobs` only |
| [`security-tests.yml`](../../.github/workflows/security-tests.yml) | The Browser's `test:security` and `test:coverage`, then a built Browser probed for privileged content in its SPA shell; a built gateway probed for `401`s on protected routes, the JSON error shape, and no leaked secrets |
| [`accessibility-tests.yml`](../../.github/workflows/accessibility-tests.yml) | react-ui's `test:a11y`; the Browser's full suite; Lighthouse against a built Browser, failing below an accessibility score of 90. Also daily at 06:00 UTC |
| [`architecture-compliance.yml`](../../.github/workflows/architecture-compliance.yml) | After `build:packages`: the doc-snippet, raw-bus, StateUnit, boot-contract (with test-env hygiene and `vi.mock` targets) and storage-URI audits; the lint gates, among them `lint:vitest-coverage`, `lint:coverage-roster` and `lint:spec-protocol`; the react-ui and Browser compliance reports. Also on pushes to `feature/**` |

[`stack-smoke.yml`](../../.github/workflows/stack-smoke.yml) is not a per-PR gate: on manual dispatch (and on pull requests that change it, its script or `local-build.sh`), it builds every image and the launcher from the commit with [`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh), pushing nothing — or, dispatched with a published tag, only the launcher — and runs [`scripts/release/smoke-stack.sh`](../../scripts/release/smoke-stack.sh), which boots the stack and checks that every service is healthy, the staged realm answers and allows the Browser's origin, and `stop` releases every port. The script runs locally the same way, against any tag or `local`. The e2e suite runs in no workflow.

Locally, prefer the targeted script for the code you changed over re-running
everything — CI runs the full matrix.

## Related Documentation

### Workspace Testing Guides
- [Browser Testing](../../apps/browser/docs/TESTING.md) - Browser test layout and scripts
- [react-ui Testing](../../packages/react-ui/docs/TESTING.md) - Component testing by composition, test utilities
- [Gateway Testing](../../apps/gateway/docs/TESTING.md) - What checks the gateway: the spec lint, the conformance suite, the boot, the census
- [Gateway Conformance Suite](../../tests/gateway-conformance/README.md) - What the black-box suite checks and how to run it

### End-to-End Testing
- [tests/e2e/README.md](../../tests/e2e/README.md) - Suite overview, container networking, full stack-rebuild flow
- [running.md](../../tests/e2e/docs/running.md) - Invocation, single spec, headed mode, repeat-each
- [containers.md](../../tests/e2e/docs/containers.md) - Container rebuild lifecycle, Verdaccio publishing
- [writing.md](../../tests/e2e/docs/writing.md) - Spec template, fixture ordering, protocol assertions
- [debugging.md](../../tests/e2e/docs/debugging.md) - Trace report, JSONL extraction, diagnostic specs
- [bus-logging.md](../../tests/e2e/docs/bus-logging.md) - Wire-level capture API and helpers
- [gotchas.md](../../tests/e2e/docs/gotchas.md) - Known sharp edges

### Component Testing
- [Annotation Rendering Principles](../../packages/react-ui/docs/ANNOTATION-RENDERING-PRINCIPLES.md) - Property-based testing for annotation renderer
- [Browser Architecture](../../apps/browser/docs/ARCHITECTURE.md) - Component structure and testing strategy

### W3C Compliance Testing
- [W3C-WEB-ANNOTATION.md](../protocol/W3C-WEB-ANNOTATION.md) - W3C Web Annotation compliance and testing

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/)
- [Testing Library Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)
- [Playwright Documentation](https://playwright.dev/)
