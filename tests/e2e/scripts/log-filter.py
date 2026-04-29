#!/usr/bin/env python3
"""
Compact filter for the structured JSON logs of long-running Semiont
containers (backend, worker, smelter — all use winston JSON via
``createProcessLogger``). Reads JSON lines on stdin and emits only the
interesting ones, prefixed with a ``--source`` label.

Designed for the **live monitoring** workflow described in
``tests/e2e/docs/live-monitoring.md`` — start one tail per container::

    container logs --follow semiont-backend 2>&1 \\
      | python3 tests/e2e/scripts/log-filter.py --source backend &
    container logs --follow semiont-worker 2>&1 \\
      | python3 tests/e2e/scripts/log-filter.py --source worker &
    container logs --follow semiont-smelter 2>&1 \\
      | python3 tests/e2e/scripts/log-filter.py --source smelter &

Each background tail surfaces only:

- lines whose ``level`` is in ``{warn, warning, error, fatal}``
- HTTP responses with ``status >= 400``

Noisy components (``event-loop-monitor`` by default) are suppressed.
Non-JSON lines (boot banners, panic traces) pass through verbatim with
a ``(raw)`` marker so anomalies aren't silently dropped.

Output format (one line per surfaced event)::

    [<source>] <timestamp> <LEVEL> <message>  key=value key=value ...

Why a separate filter rather than just ``grep``? The structured logs
are JSON, so ``grep "error"`` matches anything containing the literal
substring (including ``"error":null``, channel names like ``mark:error``,
etc.). JSON parsing + level-aware filtering avoids those false positives
and produces compact one-line output suitable for a live-monitoring
terminal.
"""
import sys
import json
import argparse

NOISY_COMPONENTS = {'event-loop-monitor'}
INTERESTING_LEVELS = {'warn', 'warning', 'error', 'fatal'}

ap = argparse.ArgumentParser()
ap.add_argument('--source', required=True)
args = ap.parse_args()

src = args.source
for raw in sys.stdin:
    raw = raw.rstrip('\n')
    if not raw:
        continue
    try:
        e = json.loads(raw)
    except json.JSONDecodeError:
        # non-JSON: emit as-is (boot lines, frontend stdout, etc.)
        print(f'[{src}] (raw) {raw}', flush=True)
        continue
    if not isinstance(e, dict):
        continue
    level = (e.get('level') or '').lower()
    component = e.get('component') or ''
    status = e.get('status')
    msg = e.get('message') or ''

    if component in NOISY_COMPONENTS:
        continue

    is_error_level = level in INTERESTING_LEVELS
    is_http_error = isinstance(status, int) and status >= 400
    if not (is_error_level or is_http_error):
        continue

    # Compact one-line output.
    extras = []
    for k in ('status', 'method', 'path', 'channel', 'jobId', 'resourceId', 'annotationId',
              'error', 'errorCode', 'requestId', 'correlationId', 'trace_id'):
        v = e.get(k)
        if v is not None and v != '':
            extras.append(f'{k}={v}')
    extras_str = ' '.join(extras)
    ts = e.get('timestamp', '')
    print(f'[{src}] {ts} {level.upper():5} {msg}  {extras_str}', flush=True)
