# Page errors

Fixture that surfaces uncaught **browser-side** errors during a
Playwright test — exceptions, unhandled promise rejections (relayed
through the browser's `unhandledrejection`), and red-text
`console.error` lines. Sibling to [bus](bus-logging.md) (cross-wire
event capture) and [jaeger](jaeger.md) (cross-process span capture);
this one observes what the browser surfaces directly, not what flows
on the wire.

## When it matters

The other capture fixtures see *protocol* failures (a `mark:create-failed`
event, a span with `status=ERROR`). They don't see *frontend* failures —
React render exceptions, RxJS Subject recursion, parsing errors in a
component's effect, anything that doesn't reach the wire. The hover
investigation that motivated this fixture (a `RangeError: Maximum
call stack size exceeded` in `Subject.next` triggered by a token-refresh
401 cascading through a downstream subscriber) was invisible to every
other capture mechanism — the symptom was visible only in the browser
DevTools console.

Without `pageErrors`, that class of bug stays invisible to the e2e
suite even when it fires during a test that's otherwise asserting on
some other condition.

## How it wires

[`fixtures/page-errors.ts`](../fixtures/page-errors.ts) attaches
`page.on('pageerror', …)` and `page.on('console', …)` listeners and
collects each entry into a `PageErrorsCapture`:

```ts
interface PageErrorEntry {
  kind: 'pageerror' | 'console.error';
  message: string;
  stack?: string;
  at: number;
}
```

On test teardown:

- **No entries** → no artifact, no impact.
- **≥1 entry** → `page-errors.json` attached to the Playwright report
  with the full list (count, fail-mode flag, every entry with stack).
- **`PAGE_ERRORS_FAIL=1` env var set** → the test fails with a
  truncated summary in the assertion message, in addition to attaching
  the artifact.

Soft mode (default) lets the capture roll out across the suite as
*evidence* without immediately turning latent errors into failures.
Once the suite passes clean, flip `PAGE_ERRORS_FAIL=1` in CI to lock
the baseline.

## Usage

The fixture is included automatically — every test that uses
`signedInPage` gets it transitively through `auth.ts`'s fixture chain.
No spec-level changes needed.

For tests that want to assert directly:

```ts
test('something', async ({ signedInPage: page, pageErrors }) => {
  await page.goto('/some/route');
  // ... interact ...
  expect(pageErrors.entries).toEqual([]);   // strict — fail this test on any error
  // or, scoped to a phase of the test:
  pageErrors.clear();
  await doSomethingThatShouldNotError();
  expect(pageErrors.entries).toHaveLength(0);
});
```

For most tests, the soft default is enough — the artifact appears in
the report when something fires, no spec changes required.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PAGE_ERRORS_FAIL` | unset (soft) | When `=1`, any uncaught error during a test fails the test (in addition to attaching the artifact). |

## Attached artifact

`page-errors.json` shape (one per failing test, when entries exist):

```json
{
  "test": "the test title",
  "count": 1,
  "failOnErrors": false,
  "entries": [
    {
      "kind": "pageerror",
      "message": "Maximum call stack size exceeded",
      "stack": "RangeError: Maximum call stack size exceeded\n    at Object.next (index.js:787:20)\n    ...",
      "at": 1730000000000
    }
  ]
}
```

The `stack` is what the browser handed Playwright — for production
bundles this is minified by default. Source maps in the bundle make
it readable; without them the stack points at minified line numbers
and you'll need DevTools to map them back.

## Coverage gap this closes

Before this fixture, a class of frontend bugs was invisible to e2e:

- **Render exceptions** in components that an error boundary swallows.
- **RxJS Subject feedback loops** — a subscriber that synchronously
  re-emits, hitting `Maximum call stack size exceeded`.
- **Unhandled promise rejections** from `void`-returning callbacks
  (event handlers, effect cleanups).
- **Console errors** from third-party libraries (React strict-mode
  warnings, validation errors, deprecation notices).

The bus capture surfaces wire-level failures; jaeger surfaces
cross-process span errors; the container log slicer surfaces
backend-side errors. None of them caught what was visible in the
DevTools console as a red error message. `pageErrors` does.

## Limitations

- **Doesn't catch silent failures** — a swallowed exception in a try/catch,
  a Promise that's neither awaited nor caught, an Observable's `error`
  callback that just logs and exits.
- **Source maps not auto-resolved** — the captured `stack` is whatever
  the browser produced; resolving back to source requires the bundle
  to publish source maps and a separate tool.
- **No correlation with bus events** — the entry's `at` timestamp is
  recorded but not cross-referenced to bus or jaeger captures. If you
  need that correlation, the `at` field plus the test's
  `jaeger-summary.json` window gives a manual way.

## Implementation

- [`fixtures/page-errors.ts`](../fixtures/page-errors.ts) — the fixture
  itself.
- [`fixtures/auth.ts`](../fixtures/auth.ts) — wires `pageErrors` into
  the shared `test` export so every spec gets it transitively through
  `signedInPage`.
