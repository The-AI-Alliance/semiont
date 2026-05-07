#!/usr/bin/env python3
"""
On-demand "what just happened" snapshot for the live Semiont stack.

Companion to ``log-filter.py``: where the filter streams interesting
events as they happen, ``snapshot.py`` rewinds the last N seconds across
all containers and Jaeger and dumps a single coherent report. Used in
the live-monitoring workflow (``tests/e2e/docs/live-monitoring.md``)
when a human says "I just clicked X and something looked off — what
just fired?"

Usage::

    python3 tests/e2e/scripts/snapshot.py [--seconds 60] [--errors-only]
    python3 tests/e2e/scripts/snapshot.py --seconds 30 --errors-only
    python3 tests/e2e/scripts/snapshot.py --jaeger-url http://192.168.64.16:16686

Dumps:

- Backend / worker / smelter log lines whose ``timestamp`` is in the
  window (full lines, not just errors, unless ``--errors-only``).
- Jaeger trace counts per service + the first 20 trace deeplinks.

Defaults:

- ``--seconds 60`` — window size. Bump up for longer interactions.
- ``--containers semiont-backend,semiont-worker,semiont-smelter`` —
  matches the production stack's structured-log containers. Frontend
  is omitted (its logs are mostly unstructured Next.js stdout).
- ``--jaeger-url http://192.168.64.16:16686`` — local Jaeger from
  ``start.sh --observe``. Override for non-local stacks.
- ``--max-lines-per-container 40`` — caps verbose dumps so the report
  stays scannable.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

ap = argparse.ArgumentParser()
ap.add_argument('--seconds', type=int, default=60)
ap.add_argument('--errors-only', action='store_true')
ap.add_argument('--jaeger-url', default='http://192.168.64.16:16686')
ap.add_argument('--containers', default='semiont-backend,semiont-worker,semiont-smelter')
ap.add_argument('--max-lines-per-container', type=int, default=40)
args = ap.parse_args()

now = datetime.now(timezone.utc)
start = now - timedelta(seconds=args.seconds)
start_ms = int(start.timestamp() * 1000)
now_ms = int(now.timestamp() * 1000)

print(f'=== Snapshot: last {args.seconds}s ({start.strftime("%H:%M:%S")} → {now.strftime("%H:%M:%S")} UTC) ===')

INTERESTING = {'warn', 'warning', 'error', 'fatal'}

def parse_ts(s: str) -> int | None:
    try:
        dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except (ValueError, AttributeError):
        return None

for name in args.containers.split(','):
    name = name.strip()
    print(f'\n--- {name} ---')
    try:
        raw = subprocess.run(['container', 'logs', name], capture_output=True, text=True, check=False)
    except FileNotFoundError:
        print('  (container CLI not on PATH)')
        continue
    if raw.returncode != 0:
        print(f'  (failed: {raw.stderr.strip()})')
        continue
    matched = []
    for line in raw.stdout.splitlines():
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(e, dict):
            continue
        ts_ms = parse_ts(e.get('timestamp', ''))
        if ts_ms is None or ts_ms < start_ms or ts_ms > now_ms:
            continue
        if e.get('component') == 'event-loop-monitor':
            continue
        if args.errors_only:
            level = (e.get('level') or '').lower()
            status = e.get('status')
            if level not in INTERESTING and not (isinstance(status, int) and status >= 400):
                continue
        matched.append(e)
    print(f'  {len(matched)} matching lines')
    for e in matched[-args.max_lines_per_container:]:
        ts = e.get('timestamp', '')
        level = (e.get('level') or '?').upper()[:5]
        msg = e.get('message', '')
        # compact extra fields
        extras = []
        for k in ('status', 'method', 'path', 'channel', 'jobId', 'resourceId',
                  'annotationId', 'error', 'errorCode', 'requestId', 'correlationId'):
            v = e.get(k)
            if v is not None and v != '':
                extras.append(f'{k}={v}')
        print(f'  {ts} {level:5} {msg}  {" ".join(extras)}')

# Jaeger traces in window
print(f'\n--- Jaeger traces ({args.jaeger_url}) ---')
services = ['semiont-backend', 'semiont-worker', 'semiont-smelter']
total = 0
all_traces = []
for svc in services:
    url = f'{args.jaeger_url}/api/traces?service={svc}&start={start_ms*1000}&end={now_ms*1000}&limit=200&lookback=custom'
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read())
        traces = data.get('data') or []
        total += len(traces)
        all_traces.extend((svc, t) for t in traces)
        # find spans with error status
        err_count = 0
        for t in traces:
            for sp in t.get('spans', []):
                for tag in sp.get('tags', []):
                    if tag.get('key') in ('error', 'otel.status_code') and tag.get('value') in (True, 'ERROR'):
                        err_count += 1
                        break
        print(f'  {svc}: {len(traces)} traces ({err_count} with error spans)')
    except Exception as err:
        print(f'  {svc}: query failed ({err})')

print(f'\n  Total: {total} traces in window')
shown = 0
for svc, t in all_traces[:20]:
    print(f'  {args.jaeger_url}/trace/{t["traceID"]}  ({svc})')
    shown += 1
if total > shown:
    print(f'  ... +{total-shown} more')
