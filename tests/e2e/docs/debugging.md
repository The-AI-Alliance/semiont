# Debugging failures

## Fastest inner loop

In order:

1. **Run just that test with the bus log**: `-g '<title>' --repeat-each 3`.
   Three runs tells you flaky vs. deterministic in under a minute. See
   [running.md](running.md).
2. **Tail backend logs during the run**: `container logs -f semiont-backend`.
   If the event never reaches the backend, it's a frontend-side
   emit/subscribe problem; if the backend logs the emit but no
   response comes back through SSE, it's a result-channel or SSE
   wiring problem.
3. **Open the trace report**: `npm run show-report`. Each failed test
   has DOM + network + console tabs.
4. **Pull console errors without the viewer** — see
   [below](#pulling-a-js-error-from-a-trace).
5. **Write a throwaway diagnostic spec** — see
   [below](#diagnostic-specs).
6. **Last resort: `npm run test:headed`** on the host to watch the
   browser. Slow but unambiguous for "element isn't visible" failures.

**Instrument, don't speculate.** Add `console.log` or a logger call to
the product code, rebuild + restart the relevant container, re-run the
test. That's a 90-second round-trip — usually faster than 20 minutes
of reasoning about what *should* happen.

## Show the HTML report

```sh
npm run show-report
```

Each failed test has:

- The exact step that threw.
- A DOM snapshot at failure.
- A screenshot (`test-failed-1.png`).
- A video (`video.webm`, full test run).
- A trace file (`trace.zip`) — open in Playwright's trace viewer for
  time-travel debugging of the DOM, network, and console.

The trace is usually the fastest path to a diagnosis.

## <a name="pulling-a-js-error-from-a-trace"></a>Pulling a JS error from a trace without opening the viewer

Each test run drops a zipped trace under
`test-results/<spec-slug>/trace.zip`. When all tests failed with the
same stack, you often want to see it quickly without booting the
trace viewer UI. Every `console.error` and `console.debug` is in the
trace as a JSONL entry:

```sh
unzip -p test-results/<spec-slug>/trace.zip 0-trace.trace | \
  python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        e = json.loads(line)
        if e.get("type") == "console" and e.get("messageType") == "error":
            print(e.get("text", "")[:2000])
    except: pass
'
```

Swap `"error"` → `"debug"` and filter on `"[bus "` to print the full
wire log — useful when the failure is protocol-shaped (emit without
response, out-of-order events, etc.).

The trace also carries a `0-trace.network` file in the same JSONL
format, with every HTTP request/response as a `snapshot` entry —
handy for checking what the browser actually sent and what status it
got.

## Error-boundary symptom

When the frontend crashes during initial render, the error boundary
catches it and renders:

```
Something went wrong
An unexpected error occurred. Try again, or refresh the page.
  [ Try Again ]  [ Refresh Page ]
```

The sign-in fixture races "email field visible" against "add knowledge
base button visible" — with the error boundary up, neither appears,
so every test fails at the fixture with a `toPass` timeout. That
stack on its own tells you nothing; the real error is in the page's
`console.error`, recoverable via the JSONL recipe above.

## <a name="diagnostic-specs"></a>Diagnostic specs

When a real test fails and you suspect the **test's own setup** is
wrong — not the product — write a diagnostic spec with the minimum
flow and no assertions:

```ts
// specs/XX-diag.spec.ts  — delete when done
test('diag', async ({ signedInPage: page, bus }) => {
  await page.goto('/en/know/discover');
  await page.getByRole('button', { name: /open resource:/i }).first().click();
  await page.waitForTimeout(10_000);
  console.log('ENTRIES:', JSON.stringify(bus.entries, null, 2));
});
```

If the diagnostic succeeds where the real test fails, the delta
between them *is* the bug — usually a too-tight assertion, a race
against an async effect, or a selector that matches something
different than you think.

Delete the diagnostic as soon as you know.

## Tailing backend logs during a test

```sh
container logs -f semiont-backend
```

Useful columns in the JSONL log lines:

- `"component":"bus"` — every emit goes through `/bus/emit` and logs
  a line. Absent ⇒ the frontend didn't reach the backend.
- `"correlationId"` — match with the `cid=...` in the frontend's bus
  log to trace one request end-to-end.
- `"message":"Incoming request"` / `"Outgoing response"` — HTTP-level
  entries.

If backend logs are unexpectedly a firehose of `401 Invalid token
signature` when no test is running, a lingering browser tab from an
earlier session is retrying SSE with an expired token. Close the tab.
