# Jaeger evidence

Companion to [`bus-logging.md`](./bus-logging.md). Where `bus` captures
the frontend's grep-friendly `[bus OP]` lines (Tier 1), the `jaeger`
fixture pulls the **distributed spans** those events trigger across
backend / worker / smelter / frontend (Tier 2) and attaches them to the
Playwright report on teardown.

A failing test's artifact bundle ends up with the cross-process trace
tree alongside its trace.zip, video, and screenshot — so the developer
can correlate a frontend bus event with the matching backend span tree
without manually fetching from the Jaeger UI.

## How it wires

The `jaeger` fixture depends on `bus`. At test entry, the bus fixture
flips `globalThis.__SEMIONT_BUS_LOG__ = true` so frontend `busLog()`
calls write `console.debug` lines that include a `trace=<8hex>` suffix
when an OTel SDK is initialized in the page (or when the line was
emitted from a backend handler whose response carried the propagated
traceparent).

At test exit, the `jaeger` fixture:

1. Reads the captured trace-id prefixes from `bus.entries`.
2. Queries Jaeger's `/api/traces` for each configured service over
   the test's time window (with 5s slack on both sides).
3. Filters returned traces by ID prefix match.
4. Attaches the matched traces, a summary, and convenience trace links
   to the Playwright test report.

## Configuration

Three env vars, all optional:

| Variable | Default | Purpose |
|---|---|---|
| `JAEGER_QUERY_URL` | `http://192.168.64.16:16686` | Jaeger UI/Query base URL. |
| `JAEGER_SERVICES` | `semiont-backend,semiont-worker,semiont-smelter,semiont-frontend` | Comma-separated services to query. |
| `JAEGER_ATTACH` | `failure` | When to attach evidence — `failure` (default), `always`, or `off`. |

The default `failure` mode means passing tests don't pay the per-test
Jaeger query latency. `always` is useful when designing new tests and
you want to see what spans fire on the happy path; `off` skips the
fixture entirely (e.g. on a developer's laptop without the observability
container running).

## Usage

The fixture is included automatically — every test that imports `test`
from `fixtures/auth.ts` already depends on `jaeger` transitively
through `signedInPage`. No spec-level changes needed.

For tests that want to inspect captured spans inline:

```ts
test('something', async ({ signedInPage: page, bus, jaeger }) => {
  await page.goto('/some/route');
  // ... test logic ...

  // Optional: inspect what traces were active during the test.
  // The fixture's teardown will attach matching spans to the report,
  // but if the test wants to assert on them, it can pull them itself.
});
```

## Attached artifacts

On a failing test (or always with `JAEGER_ATTACH=always`):

| Attachment | Contents |
|---|---|
| `jaeger-summary.json` | Test name, duration, services queried, trace-id prefixes the frontend saw, matched-trace count, window-trace count, list of unmatched prefixes (cases where the bus saw a trace prefix but no service returned a matching span — usually transient export delays). |
| `jaeger-matched-traces.json` *(when prefixes match)* | Array of `{ service, traces: JaegerTrace[] }` objects with the full span JSON for each prefix-matched trace. |
| `jaeger-window-traces.json` *(fallback when no prefixes match)* | Array of `{ service, traces: JaegerTrace[] }` for every trace in the test's time window across all configured services. Always populated when Jaeger has data — useful when the frontend isn't OTel-instrumented and we still want the cross-service span tree. |
| `jaeger-trace-links.txt` | Newline-separated `${JAEGER_QUERY_URL}/trace/<id>` URLs. Click to open in the Jaeger UI. |

## Companion: container log slices

Apple Container's CLI is host-only and not reachable from inside the
Playwright container, so per-test container logs can't be captured by
a fixture. [`scripts/slice-container-logs.py`](../scripts/slice-container-logs.py)
fills that gap as a host-side post-process: after a Playwright run, it
walks `test-results/`, reads each test's `jaeger-summary.json` for the
`startedAtIso` / `endedAtIso` window, dumps logs from each container,
and writes a `<container>.log` slice into the test's output directory.

```sh
# After `npx playwright test`
python3 tests/e2e/scripts/slice-container-logs.py
```

That writes `semiont-backend.log`, `semiont-worker.log`, and
`semiont-smelter.log` (when each has events in the test window) into
every test directory next to the existing Jaeger artifacts. Combined
with the `jaeger-*.json` artifacts and the Playwright trace.zip, a
failing test's directory ends up with the full cross-process record.

Defaults:

- **Containers**: `semiont-backend,semiont-worker,semiont-smelter`. The
  frontend container is omitted because its log format is mostly
  unstructured stdout without timestamps. Override with
  `--containers <comma-list>`.
- **Filtering**: lines whose JSON `timestamp` is in the test window.
  Lines without a parseable timestamp (boot banners, panic dumps) are
  dropped — pass `--keep-full` to also write the verbatim
  `<container>.full.log` per test.
- **Volume**: dumps the full container log per container once, then
  slices in memory per test. For long-running containers with high
  log volume use `--max-lines N` to cap the dump from the tail.

The script reads `startedAtIso` / `endedAtIso` from each test's
`jaeger-summary.json` (written by the `jaeger` fixture in this same
package), so it's safe to run multiple times — only the slices change,
the underlying container logs are immutable for the duration of the
container's runtime.

## Limitations

- **Frontend doesn't currently emit OTel spans.** The captured prefixes
  are mostly backend-originated; we still query the frontend service
  in case a frontend SDK is added later.
- **Trace-id prefixes are 8 hex (32 bits).** Within a single test's
  time window collisions are unlikely but not impossible. The fixture
  surfaces every trace that prefix-matches; false positives are cheap
  diagnostic noise, not silent test failures.
- **The log slicer runs on the host, not inside the test process.**
  Slices appear after the Playwright run, not interleaved with the
  HTML report's per-test attachment list. A failing test's directory
  contains both — Playwright's report + the slicer's `<container>.log`
  files alongside.

## Implementation

- [`fixtures/jaeger.ts`](../fixtures/jaeger.ts) — the fixture itself.
- [`fixtures/auth.ts`](../fixtures/auth.ts) — wires `jaeger` into the
  shared `test` export so every spec gets it transitively.
- [`scripts/slice-container-logs.py`](../scripts/slice-container-logs.py)
  — the host-side post-process that slices container logs to test
  windows.
