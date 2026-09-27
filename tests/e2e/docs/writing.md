# Writing tests

## Minimal spec

Signed-in page + protocol-level assertion:

```ts
// specs/NN-short-name.spec.ts
import { test, expect } from '../fixtures/auth';

test.describe('short description', () => {
  test('does the thing', async ({ signedInPage: page, bus }) => {
    await page.goto('/en/know/discover');
    bus.clear();  // scope assertions to what follows

    await page.getByRole('button', { name: /some action/i }).click();

    // Assert protocol (strongest), not just UI:
    await bus.expectRequestResponse('foo:requested', 'foo:result');

    // And/or UI:
    await expect(page.getByText(/success/i)).toBeVisible();
  });
});
```

The `signedInPage` fixture (in [`fixtures/auth.ts`](../fixtures/auth.ts))
leaves the page on `/en/know/discover` with a live authenticated
session. The `bus` fixture enables and captures the Browser's
[wire-level bus log](bus-logging.md).

## Fixture ordering matters

The `bus` fixture's `addInitScript` must run **before** `page.goto` —
the init script flips the `__SEMIONT_BUS_LOG__` flag that the Browser
reads at startup. That ordering is guaranteed when you:

- Destructure `bus` in the test params, **or**
- Use `signedInPage` (which depends on `bus` — see its definition).

If you build a helper that creates its own `page` context, re-attach
the bus log there with `attachBusLog(page)` before the first
`goto`.

## Assert on protocol, not just UI

"The highlight appeared on screen" is a weak assertion. It passes even
if the UI accidentally ended up right via a stale cache, a different
endpoint, or a broken handler that got backfilled by a refetch.

"A `mark:create-request` was emitted, and a `mark:create-ok` arrived
with matching correlationId" is a strong assertion. If the wire
protocol regresses, this fails immediately.

Use `bus.expectRequestResponse('req', 'ok')` whenever the action
you're testing is a request/response round-trip. Use
`bus.waitForEmit` / `bus.waitForRecv` for fire-and-forget events.
Use raw `bus.entries` when you need to assert on counts or ordering.

See [bus-logging.md](bus-logging.md) for the full capture API.

## Seed assumptions

Playwright's global setup, [`scripts/seed.ts`](../scripts/seed.ts),
uploads the resources the specs assume — text resources for the
annotation specs, PDFs for the PDF specs — and the Archivist bootstraps
the entity types. A spec that needs a fixture of its own adds it there,
with a stable `storageUri` so a re-run skips it; `openResourceByName`
(`fixtures/discover.ts`)
opens it by name. There is no per-test isolation: specs share one
knowledge base, so:

- Assert properties that hold whatever earlier specs created (e.g. "the
  first resource"), not exact counts,
- Or `test.skip(...)` with a one-line reason when the state a spec needs
  is absent.

Skipping is **explicit, never implicit**. Never leave a test passing
because it silently returned early.

## Selectors

Prefer role + accessible name over CSS classes or text. When that
isn't enough (e.g. a raw input with only a `placeholder`), fall back
to `getByPlaceholder`. There's no `data-testid` convention yet — that
would be a reasonable follow-up together with a selector audit.

If a test fails because "the button isn't visible", it's usually one of:

- The aria-label text changed (likely in an i18n bundle).
- The component was restructured and lost its role.
- The element is off-screen (CSS changed).

Update the selector in the test, not the test's assertion.

## What to target

The bar for adding an e2e test: **a path that has broken before and
which unit tests can't catch.** Cross-layer regressions — SSE timing,
React lifecycle + bus interaction, navigation + subscription tear-down
— are the sweet spot. Pure component logic should stay in unit tests.
