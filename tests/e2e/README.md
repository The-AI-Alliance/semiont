# End-to-End Smoke Tests

Real-browser Playwright tests that drive the frontend against a locally
running backend. Intended to catch cross-layer regressions (SSE timing,
React lifecycle, bus round-trips) that unit and component tests can't.

See [.plans/E2E-SMOKE.md](../../.plans/E2E-SMOKE.md) for the design
rationale and the five-test roadmap.

## Requirements

- A running backend with a known user account.
- A running frontend pointing at that backend.
- Both reachable from the host where Playwright runs.

## Environment variables

Tests read four env vars. Two are required (no defaults, on purpose —
we don't want tests to silently use a fallback account); two have
local-dev defaults.

| Var | Default | Purpose |
|---|---|---|
| `E2E_EMAIL` | (required) | User to sign in as. |
| `E2E_PASSWORD` | (required) | Password for that user. |
| `E2E_FRONTEND_URL` | `http://localhost:3000` | Frontend the browser drives. |
| `E2E_BACKEND_URL` | `http://localhost:4000` | Backend the sign-in form points at. |

## Running from a container (recommended on macOS / Apple container CLI)

The repo's dev stack runs in Apple containers on the `192.168.64.0/24`
bridge. A containerized Playwright image can reach both the frontend
and backend containers directly by IP — no host port-forwarding needed.

**Bring up the stack first** (backend + frontend, however you
normally start them), then find the container IPs:

```sh
container ls | grep -E 'semiont-(frontend|backend)'
```

Pick the IPs from the `ADDR` column and plug them into the env vars
below. Frontend port is `3000`; backend port is `4000`.

**First-time image pull** (once per Playwright version):

```sh
container image pull mcr.microsoft.com/playwright:v1.59.1-noble
```

Keep the image tag in sync with the `@playwright/test` version in
`package.json`; a mismatch produces a "please update docker image as
well" error.

**Run all tests:**

```sh
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

**Run one spec:** append `specs/01-sign-in.spec.ts` (or any other
spec path) as the last argument.

**Install deps into `tests/e2e/node_modules`** (one-time, inside the
container so its glibc matches what Playwright was built against):

```sh
container run --rm \
  -v "$(git rev-parse --show-toplevel):/workspace" \
  -w /workspace/tests/e2e \
  mcr.microsoft.com/playwright:v1.59.1-noble \
  npm install
```

## Running from the host (if you have Node + Playwright installed)

```sh
cd tests/e2e
npm install
npx playwright install chromium    # one-time browser download

export E2E_EMAIL=admin@example.com
export E2E_PASSWORD=password

# Headless:
npm test

# With a visible browser (useful for diagnosing failures):
npm run test:headed

# Step through with the Playwright inspector:
npm run test:debug

# Playwright's test runner UI:
npm run test:ui
```

When running from the host against the containerized stack, you can
use `http://localhost:3000` / `http://localhost:4000` IF the container
runtime exposes those ports to the host. If not, use the bridge IPs
like the container-run invocation above.

## Current tests

Each targets a bug we've already shipped and fixed. A regression in any
of these paths fails the corresponding test.

1. `01-sign-in.spec.ts` — sign-in succeeds, lands on the knowledge
   section.
2. `02-open-resource.spec.ts` — open a resource from Discover, content
   loads (guards the "Loading resource..." regression).
3. `03-navigate-resources.spec.ts` — click between two open-resource
   sidebar tabs, content actually updates (guards the
   `useViewModel`-stale-factory bug).
4. `04-manual-highlight.spec.ts` — select text with motivation=highlight,
   confirm a highlight is persisted (guards the
   `mark:create-request`-to-dead-channel bug), survives reload.
5. `05-manual-reference.spec.ts` — select text with motivation=linking
   and an entity-type chip, confirm a tagged reference is persisted
   (guards the chip-selection-to-submit-body threading), survives
   reload.
6. `06-assisted-reference.spec.ts` — click the assist widget's
   "Annotate" button with entity types selected, confirm a `job:create`
   / `job:created` pair crosses the wire (guards the assist-dispatch
   regression on a different UI surface than test 2's entity-types
   fetch).

## Bus logging — protocol-level debugging and assertions

The frontend has an opt-in, runtime-toggleable logger at the
browser↔backend boundary. When enabled, every event that crosses the
wire in either direction is logged as a single `console.debug` line
with a grep-friendly format:

```
[bus EMIT] <channel> [scope=X] [cid=<first8>] <payload>
[bus RECV] <channel> [scope=X] [cid=<first8>] <payload>
```

Both call sites live in `ActorVM` ([`packages/api-client/src/view-models/domain/actor-vm.ts`](../../packages/api-client/src/view-models/domain/actor-vm.ts))
— one inside `emit()` (outgoing) and one inside the SSE parser
(incoming). Anything that crosses the wire goes through one of those
two lines, so the log is exhaustive. Local-only events (purely
in-browser) stay invisible; that's by design.

Cost when disabled is a single truthy check; zero allocations.

### Enable in a running browser

From DevTools console:

```js
window.__SEMIONT_BUS_LOG__ = true;
```

Then reproduce. Clears on refresh.

### Enable in e2e tests

Automatic. Every test written against `fixtures/auth.ts` gets a `bus`
capture object by default:

```ts
import { test, expect } from '../fixtures/auth';

test('...', async ({ signedInPage: page, bus }) => {
  bus.clear();  // drop earlier traffic if you want to scope assertions
  await page.getByRole('button', { name: /open/i }).click();

  // Wait for a request/response pair with matching correlationId:
  await bus.expectRequestResponse('browse:resource-requested', 'browse:resource-result');

  // Or target individual events:
  await bus.waitForEmit('mark:create-request');
  await bus.waitForRecv('mark:create-ok', { cid: '...' });

  // Or inspect the full log after the fact:
  const emits = bus.emits('browse:resource-requested');
  expect(new Set(emits.map(e => e.cid)).size).toBeGreaterThanOrEqual(2);
});
```

The fixture toggles `__SEMIONT_BUS_LOG__` before page init (via
`page.addInitScript`) and captures `console.debug` messages matching
the `[bus ...]` format.

**Why this matters**: it lets tests assert **protocol-level**
behavior, not just UI outcomes. "The highlight appeared" is weaker
than "`mark:create-request` was emitted, `mark:create-ok` arrived with
matching correlationId." The latter catches regressions where the UI
accidentally ends up right via a different code path (e.g. stale
cache, wrong endpoint, broken handler that got backfilled by
refetch).

## Known gotchas

A few sharp edges that took real debugging the first time. Documented
here so future-you doesn't repeat the journey.

- **`crypto.randomUUID` requires a secure context.** `http://localhost`
  and `http://127.0.0.1` count as secure; `http://<any-other-IP>` does
  not. When the tests run against container IPs (e.g.
  `http://192.168.64.60:3000`), the frontend's calls to
  `crypto.randomUUID` throw "is not a function". The auth fixture
  polyfills it via `page.addInitScript`. This is also a latent product
  bug — any user hitting the frontend via HTTP from a non-localhost
  hostname will hit it.
- **LoginForm's host field resets the protocol.** The form's
  `handleHostChange` calls `defaultProtocol(newHost)`, which picks
  HTTPS for IP-like hostnames. Set host *before* protocol in any
  fixture filling in the form, or the dropdown flips back to HTTPS.
- **The Connect form auto-opens with zero KBs, stays closed with
  ≥ 1.** The auth fixture races "email-field-visible" against
  "add-knowledge-base-button-visible" and acts on whichever appears
  first.
- **Playwright version must match the Docker image tag.** If `npm
  install` upgrades `@playwright/test`, pull the matching
  `mcr.microsoft.com/playwright:<version>-noble` image.

## When a test fails

```sh
npm run show-report
```

Opens the HTML report. Each failed test has:

- The exact step that threw.
- A DOM snapshot at failure.
- A screenshot.
- A video (full test run).
- A trace file — open in Playwright's trace viewer for time-travel
  debugging of the DOM, network, and console.

The trace file is usually the fastest path to a diagnosis.

## Selectors

Tests prefer role + accessible name over CSS classes or text. When that
isn't enough (e.g. a raw input with only a `placeholder`), we fall back
to `getByPlaceholder`. There's not yet a `data-testid` convention —
adding one is a planned follow-up and should be done together with a
selector audit of this suite.

If a test fails because "the button isn't visible", it's usually one of:

- The aria-label text changed (likely in an i18n bundle).
- The component was restructured and lost its role.
- The element is off-screen (CSS changed).

Update the selector in the test, not the test's assertion.

## Non-goals (right now)

- Not wired into CI. Designed to be run locally against a
  manually-brought-up stack.
- Not seeding fixtures. Assumes the target KB has ≥2 resources and ≥1
  entity type. This is true of the default template KB.
- Not testing real OAuth. Credentials sign-in only.
- Not parallel. Single worker until fixtures are per-test-isolated.
- Not cross-browser. Chromium only.

Each of these is addressed in the phased plan at
[.plans/E2E-SMOKE.md](../../.plans/E2E-SMOKE.md).
