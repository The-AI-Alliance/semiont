#!/bin/sh
# supervise.sh — the Archivist's in-container supervisor (ARCHIVIST-STAYS-UP P1).
#
# Exists because no runtime mechanism can: Apple container has no --restart
# flag, and plain docker cannot restart-on-unhealthy. One loop gives all
# three runtimes the same behavior: a crashed child restarts, a hung child is
# probed and killed, a deterministic boot refusal fails fast instead of
# looping, and `semiont stop` (TERM) is forwarded and never fought.
#
# LOGGING, deliberately minimal: the child writes to STDOUT exactly as
# before — the container outlives child deaths, so the runtime's own log
# keeps every life, `container logs`/dumpLogs work natively, and the
# launcher's preflight snapshot archives it before teardown. Only the
# supervisor's OWN events (starts, exit codes, kills) also go to a small
# capped file on the state mount, so the death record survives even a
# torn-down container.

ENTRY=/usr/local/lib/node_modules/@semiont/make-meaning/dist/archivist-main.js
EVDIR=/semiont-state/archivist-supervisor
mkdir -p "$EVDIR" 2>/dev/null || EVDIR=/tmp
EVENTS="$EVDIR/events.log"

PROBE_URL="http://localhost:24103/health"
PROBE_EVERY=10      # seconds between probes, once armed
PROBE_FAILS=3       # consecutive failures before the child is killed
MAX_RAPID=5         # exits under RAPID_SECS in a row before giving up
RAPID_SECS=10
EVENTS_CAP=262144   # ~256KB of one-line events; keep the newest half beyond it

note() {
  line="[supervise $(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"
  echo "$line"
  echo "$line" >> "$EVENTS"
  if [ "$(wc -c < "$EVENTS")" -gt "$EVENTS_CAP" ]; then
    tail -c $((EVENTS_CAP / 2)) "$EVENTS" > "$EVENTS.tmp" && mv "$EVENTS.tmp" "$EVENTS"
  fi
}

stopping=""
child=""
trap 'stopping=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null' TERM INT

rapid=0
while [ -z "$stopping" ]; do
  started=$(date +%s)
  note "starting archivist (rapid failures so far: $rapid)"
  node "$ENTRY" &
  child=$!

  # Health self-probe: arms after the FIRST success (boot readiness is the
  # launcher's gate, not ours), then kills a child that stops answering.
  (
    armed=""; fails=0
    while kill -0 "$child" 2>/dev/null; do
      sleep "$PROBE_EVERY"
      if wget -q -T 5 -O /dev/null "$PROBE_URL" 2>/dev/null; then
        armed=1; fails=0
      elif [ -n "$armed" ]; then
        fails=$((fails+1))
        if [ "$fails" -ge "$PROBE_FAILS" ]; then
          echo "[supervise] health probe failed ${fails}x after arming — killing hung child $child"
          kill -TERM "$child" 2>/dev/null; sleep 5; kill -KILL "$child" 2>/dev/null
          break
        fi
      fi
    done
  ) &
  prober=$!

  wait "$child"; code=$?
  kill "$prober" 2>/dev/null; wait "$prober" 2>/dev/null
  child=""
  [ -n "$stopping" ] && { note "stopped by TERM (exit $code) — not restarting"; exit 0; }

  lived=$(( $(date +%s) - started ))
  note "archivist exited code=$code after ${lived}s"
  if [ "$lived" -lt "$RAPID_SECS" ]; then
    rapid=$((rapid+1))
    if [ "$rapid" -ge "$MAX_RAPID" ]; then
      note "gave up: $rapid rapid failures — a deterministic refusal should be visible, not looped"
      exit 1
    fi
  else
    rapid=0
  fi
  sleep 2
done
