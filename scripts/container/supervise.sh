#!/bin/sh
# supervise.sh — the in-container supervisor for every long-running Semiont
# service (ARCHIVIST-STAYS-UP P1, generalized by GATEWAY-SUPERVISION F1).
#
# Exists because no runtime mechanism can: Apple container has no --restart
# flag, and plain docker cannot restart-on-unhealthy. One loop gives all
# three runtimes the same behavior: a crashed child restarts, a hung child is
# probed and killed, a deterministic boot refusal fails fast instead of
# looping, and `semiont stop` (TERM) is forwarded and never fought.
#
# ONE COPY, parameterized by environment — a second copy would be two places
# deciding one policy. Required:
#
#   SUPERVISE_NAME    service name, used in every event line and the state dir
#   SUPERVISE_ENTRY   absolute path to the node entry point
#   SUPERVISE_PROBE   health URL polled once armed
#
# LOGGING, deliberately minimal: the child writes to STDOUT exactly as before —
# the container outlives child deaths, so the runtime's own log keeps every
# life, `container logs`/dumpLogs work natively, and the launcher's preflight
# snapshot archives it before teardown. Only the supervisor's OWN events
# (starts, exit codes, kills) also go to a small capped file on the state
# mount, so the death record survives even a torn-down container. That file is
# what made the Archivist's crash loop diagnosable and what the gateway lacked
# on 2026-09-08, when a death took its own evidence with it. A service with no
# writable /semiont-state (the browser) falls back to /tmp and keeps only the
# runtime log — restart without the durable record, by design, not by accident.

: "${SUPERVISE_NAME:?supervise.sh: SUPERVISE_NAME is required}"
: "${SUPERVISE_ENTRY:?supervise.sh: SUPERVISE_ENTRY is required}"
: "${SUPERVISE_PROBE:?supervise.sh: SUPERVISE_PROBE is required}"

NAME="$SUPERVISE_NAME"
ENTRY="$SUPERVISE_ENTRY"
PROBE_URL="$SUPERVISE_PROBE"

# The child reads this back to report `semiont.process.restarts`, so the path
# is a contract between this script and the service's observability wiring.
EVDIR="/semiont-state/${NAME}-supervisor"
mkdir -p "$EVDIR" 2>/dev/null || EVDIR=/tmp
EVENTS="$EVDIR/events.log"

# The child reads the count back out of this file to report
# `semiont.process.restarts`. Export the RESOLVED path rather than letting the
# reader rebuild it: the mkdir above can fall back to /tmp (a service with no
# writable /semiont-state — worker, smelter, weaver, browser), so the path is
# not derivable from the name alone. Two places computing it is one place
# computing it wrong the day a mount changes.
export SUPERVISE_EVENTS="$EVENTS"

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
  # "starting <name>" is the line the restart-count provider counts. Changing
  # its shape breaks `semiont.process.restarts` in every service.
  note "starting $NAME (rapid failures so far: $rapid)"
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
  note "$NAME exited code=$code after ${lived}s"
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
