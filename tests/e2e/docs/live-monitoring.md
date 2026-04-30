# Live monitoring

Sibling workflow to the e2e suite. Where Playwright tests assert that
specific flows work, **live monitoring** is for the cases the suite
doesn't yet cover: a human poking around the dev stack, finding
something visibly wrong, and needing to know what fired.

This is how you find the bugs the e2e suite is missing — and the
material you collect feeds directly into closing the coverage gap.

## When to reach for this (vs. an e2e spec)

| Situation | Reach for |
|---|---|
| You're testing a known flow that should keep working forever | An e2e spec ([`writing.md`](writing.md)) |
| You're poking around a new feature pre-CI, want to see what fires | Live monitoring |
| A user reported "I clicked X and got Y" and you can repro | Live monitoring (snapshot) → write an e2e spec when fixed |
| A failing e2e spec attached its `jaeger-*.json` artifacts | The auto-attached evidence — see [`jaeger.md`](jaeger.md) |
| A failing e2e spec attached `page-errors.json` | An uncaught browser error fired during the test — see [`page-errors.md`](page-errors.md) |
| A failing e2e spec needs the per-test container log slice | Run [`scripts/slice-container-logs.py`](../scripts/slice-container-logs.py) post-hoc |

The relationship is: **live monitoring catches what the e2e suite
misses; the e2e suite institutionalizes what live monitoring catches.**
Every bug found by poking should turn into an e2e spec so the bug
stays caught.

## Setup

Two scripts under [`tests/e2e/scripts/`](../scripts/) plus the live
Jaeger query API. Both scripts are pure stdlib Python 3.9+ — no
dependencies on the host beyond Python (which macOS ships with).

### Streaming tails (one terminal each, or all backgrounded)

One per container, filtered to errors and warnings:

```sh
container logs --follow semiont-backend 2>&1 \
  | python3 tests/e2e/scripts/log-filter.py --source backend &

container logs --follow semiont-worker 2>&1 \
  | python3 tests/e2e/scripts/log-filter.py --source worker &

container logs --follow semiont-smelter 2>&1 \
  | python3 tests/e2e/scripts/log-filter.py --source smelter &
```

Each tail surfaces only:

- lines whose `level` is in `{warn, warning, error, fatal}`
- HTTP responses with `status >= 400`

Noisy components (`event-loop-monitor` by default) are suppressed.
Non-JSON lines (boot banners, panic traces) pass through verbatim with
a `(raw)` marker so anomalies aren't silently dropped.

Output format:

```
[<source>] <timestamp> <LEVEL> <message>  key=value key=value ...
```

### On-demand snapshot

When something visibly went wrong and you want to rewind:

```sh
# Last 60s of activity, errors only
python3 tests/e2e/scripts/snapshot.py --seconds 60 --errors-only

# Last 5 minutes, full firehose
python3 tests/e2e/scripts/snapshot.py --seconds 300

# Override Jaeger / containers if your stack isn't local-default
python3 tests/e2e/scripts/snapshot.py --jaeger-url http://other:16686 \
  --containers semiont-backend,semiont-other
```

Output: per-container log lines in the window, plus per-service Jaeger
trace counts and the first 20 trace deeplinks. Click a deeplink to
open the span tree in the Jaeger UI.

## Jaeger directly

When you have a specific trace ID and want the raw JSON:

```sh
curl -s "http://192.168.64.16:16686/api/traces/<traceID>" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)['data'][0]
for sp in d['spans']:
    svc = d['processes'][sp['processID']]['serviceName']
    err = next((t for t in sp.get('tags', []) if t['key'] == 'otel.status_code'), None)
    print(f'{svc:24} {sp[\"operationName\"]:30}  {err.get(\"value\") if err else \"\"}')
"
```

That dumps every span in the trace with service, operation name, and
OTel status code. Useful when chasing where in a multi-process trace
an error originated.

The bus-log lines in your tails carry `trace=<8hex>` prefixes when an
OTel SDK is initialized in the emitting process. To find the matching
full trace ID:

```sh
# List recent traces from a service, get full IDs
curl -s "http://192.168.64.16:16686/api/traces?service=semiont-backend&limit=20" \
  | python3 -c "import json,sys; [print(t['traceID']) for t in json.load(sys.stdin)['data']]"
```

Match by prefix — `traceID.startswith('<8hex>')`.

## Worked example

The user reports: "I clicked Generate on an unresolved reference and
got console errors." Steps:

1. **Snapshot** the window covering their interaction:

   ```sh
   python3 tests/e2e/scripts/snapshot.py --seconds 120
   ```

2. **Spot the smoking gun** in the worker's slice:

   ```
   --- semiont-worker ---
   2026-04-29T16:50:22.447Z ERROR Job failed  jobId=job-92dba... error=XMLHttpRequest is not defined
   ```

3. **Pull the Jaeger trace** for the failed span (deeplink in the
   snapshot's bottom section). The `content.put` span shows:

   ```
   semiont-worker  content.put
       error: True
       otel.status_code: ERROR
       otel.status_description: XMLHttpRequest is not defined
   ```

4. **Identify the regression** by following the error message back to
   the source — `HttpContentTransport.putBinary`'s XHR branch firing
   in a Node runtime.

5. **Write the e2e spec** that would have caught it before the merge —
   in this case [`specs/09-generate-from-reference.spec.ts`](../specs/09-generate-from-reference.spec.ts),
   which waits for `job:complete` (vs. the dispatch-only assertions in
   spec 06). The spec failing against the buggy stack with the same
   error message confirms it's the right regression target.

6. **Fix the bug**, rebuild, re-run the spec — green = bug stays
   caught.

## Limitations

- **Frontend not in the snapshot's container list.** Next.js stdout
  is mostly unstructured and not timestamped, so the snapshot's
  per-line-timestamp filter doesn't apply. For frontend errors,
  watch the browser DevTools console (or add `bus.entries` capture
  via a Playwright spec).
- **Live monitoring requires the dev stack to be up** ([`containers.md`](containers.md))
  and Jaeger to be running (`start.sh --observe`).
- **No persistence across container restarts.** The streaming tails
  start from the moment they attach; if you restart a container
  mid-poke, restart the tails too. The snapshot reads the full
  in-container buffer, so it survives tail restarts.

## Implementation

- [`scripts/log-filter.py`](../scripts/log-filter.py) — JSON-aware line
  filter (stdin → stdout).
- [`scripts/snapshot.py`](../scripts/snapshot.py) — point-in-time
  rewind of containers + Jaeger.
- [`scripts/slice-container-logs.py`](../scripts/slice-container-logs.py)
  — companion for *post-test* slicing (driven by Jaeger summary
  windows from a Playwright run).
- [`fixtures/jaeger.ts`](../fixtures/jaeger.ts) — the in-Playwright
  fixture that captures spans per test (auto-attached to the report).

The same Jaeger and container-log substrate underlies all four.
