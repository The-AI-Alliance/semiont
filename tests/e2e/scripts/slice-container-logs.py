#!/usr/bin/env python3
"""
Host-side post-process for e2e container logs.

Walks ``tests/e2e/test-results/<test-dir>/jaeger-summary.json``, reads
each test's ``startedAtIso`` / ``endedAtIso`` window, dumps logs from
each configured container (default: semiont-backend, semiont-worker,
semiont-smelter) via ``container logs``, filters lines whose JSON
``timestamp`` falls inside the window, and writes a ``<container>.log``
slice into the test's output directory.

Why a host-side post-process? Apple Container's CLI is not reachable
from inside the Playwright container that runs the tests, so per-test
log capture has to happen outside the test process. Running this after
a Playwright run gives every test (passing or failing) a set of
per-container log slices alongside its other artifacts.

Usage::

    # After `npx playwright test`
    python3 tests/e2e/scripts/slice-container-logs.py

    # Override the test-results root or container list
    python3 tests/e2e/scripts/slice-container-logs.py \\
        --results-dir tests/e2e/test-results \\
        --containers semiont-backend,semiont-worker,semiont-smelter

Limitations
-----------

* Apple Container's ``container logs`` has no ``--since`` / ``--until``,
  so we dump the full container log and parse line-by-line. For
  long-running containers with high log volume this gets expensive;
  ``--max-lines N`` (default unlimited) caps the dump from the tail
  if needed.
* Only structured JSON lines with a ``timestamp`` field are sliced.
  Lines without a parseable timestamp (boot banners, panic dumps,
  unstructured stdout) are skipped — they show up in the verbatim
  ``<container>.full.log`` capture if ``--keep-full`` is passed.
* The frontend container's logs are mostly unstructured and not
  timestamped; it's omitted from the default container list.

Implemented in Python (not Node) because the host runs ``container
logs`` directly — the script can't move into a container without
losing access to the host's container CLI, and Python 3 ships with
macOS while Node does not.
"""

# `from __future__ import annotations` lets the script keep modern
# `X | None` / `list[str]` annotations on Python 3.9 (the macOS system
# Python). We only annotate; nothing introspects annotations at runtime.
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    default_results_dir = here.parent / 'test-results'
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--results-dir', type=Path, default=default_results_dir,
                   help='Playwright test-results root (default: tests/e2e/test-results)')
    p.add_argument('--containers', default='semiont-backend,semiont-worker,semiont-smelter',
                   help='Comma-separated container names to slice (default: backend, worker, smelter)')
    p.add_argument('--max-lines', type=int, default=0,
                   help='If >0, pass `-n N` to `container logs` to cap the dump from the tail')
    p.add_argument('--keep-full', action='store_true',
                   help='Also write the full pre-slice dump to <container>.full.log per test')
    return p.parse_args()


def dump_container_logs(name: str, max_lines: int) -> str | None:
    """Dump full logs from a container. Returns the raw text or None on failure."""
    cmd = ['container', 'logs']
    if max_lines > 0:
        cmd += ['-n', str(max_lines)]
    cmd.append(name)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        sys.stderr.write('[slice-logs] `container` CLI not on PATH — is Apple Container installed?\n')
        return None
    if result.returncode != 0:
        sys.stderr.write(f'[slice-logs] container logs {name} failed: {result.stderr.strip() or f"(exit {result.returncode})"}\n')
        return None
    return result.stdout


def slice_by_timestamp(raw: str, start_ms: int, end_ms: int) -> tuple[list[str], int]:
    """Filter lines whose JSON `timestamp` is in [start_ms, end_ms]. Returns (kept lines, kept count)."""
    kept_lines: list[str] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        ts = entry.get('timestamp') if isinstance(entry, dict) else None
        if not isinstance(ts, str):
            continue
        try:
            # ISO 8601, possibly with `Z` suffix. fromisoformat in 3.11+ handles `Z`;
            # earlier versions require explicit replacement.
            ts_iso = ts.replace('Z', '+00:00')
            ts_dt = datetime.fromisoformat(ts_iso)
            if ts_dt.tzinfo is None:
                ts_dt = ts_dt.replace(tzinfo=timezone.utc)
            ts_ms = int(ts_dt.timestamp() * 1000)
        except (ValueError, OverflowError):
            continue
        if start_ms <= ts_ms <= end_ms:
            kept_lines.append(line)
    return kept_lines, len(kept_lines)


def list_test_dirs(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(d for d in root.iterdir() if d.is_dir() and not d.name.startswith('.'))


def parse_iso_to_ms(iso: str | None) -> int | None:
    if not isinstance(iso, str):
        return None
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except (ValueError, OverflowError):
        return None


def main() -> int:
    args = parse_args()
    containers = [c.strip() for c in args.containers.split(',') if c.strip()]

    test_dirs = list_test_dirs(args.results_dir)
    if not test_dirs:
        sys.stderr.write(f'[slice-logs] no test directories under {args.results_dir} — did you run `npx playwright test` first?\n')
        return 1

    print(f'[slice-logs] results-dir: {args.results_dir}')
    print(f'[slice-logs] containers:  {", ".join(containers)}')
    print(f'[slice-logs] test dirs:   {len(test_dirs)}')

    # Dump each container once (an expensive operation), then slice per-test.
    # Avoids re-dumping for every test directory.
    dumps: dict[str, str] = {}
    for name in containers:
        sys.stderr.write(f'[slice-logs] dumping {name} ... ')
        raw = dump_container_logs(name, args.max_lines)
        if raw is None:
            sys.stderr.write('skipped\n')
            continue
        dumps[name] = raw
        sys.stderr.write(f'{len(raw) / 1024:.1f} KB\n')

    tests_with_evidence = 0
    tests_skipped = 0
    total_lines = 0

    for d in test_dirs:
        summary_path = d / 'jaeger-summary.json'
        if not summary_path.exists():
            tests_skipped += 1
            continue
        try:
            summary = json.loads(summary_path.read_text())
        except (OSError, json.JSONDecodeError) as err:
            sys.stderr.write(f'[slice-logs] {d.name}: invalid jaeger-summary.json ({err})\n')
            tests_skipped += 1
            continue

        start_ms = parse_iso_to_ms(summary.get('startedAtIso'))
        end_ms = parse_iso_to_ms(summary.get('endedAtIso'))
        if start_ms is None or end_ms is None:
            sys.stderr.write(f'[slice-logs] {d.name}: jaeger-summary.json missing startedAtIso/endedAtIso\n')
            tests_skipped += 1
            continue

        per_test_lines = 0
        for name, raw in dumps.items():
            if args.keep_full:
                (d / f'{name}.full.log').write_text(raw)
            lines, kept = slice_by_timestamp(raw, start_ms, end_ms)
            if not lines:
                continue
            (d / f'{name}.log').write_text('\n'.join(lines) + '\n')
            per_test_lines += kept

        if per_test_lines > 0:
            tests_with_evidence += 1
            total_lines += per_test_lines

    print(
        f'[slice-logs] done: {tests_with_evidence}/{len(test_dirs)} tests got log slices '
        f'({total_lines} lines total; {tests_skipped} skipped — no jaeger-summary.json or invalid window)'
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
