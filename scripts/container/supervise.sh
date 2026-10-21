#!/bin/sh
# supervise.sh — the in-container supervisor for every long-running Semiont
# service, shared by every service image.
#
# Exists because no runtime mechanism can: Apple container has no --restart
# flag, and plain docker cannot restart-on-unhealthy. One loop gives all
# three runtimes the same behavior: a crashed child restarts, a hung child is
# probed and killed, a deterministic boot refusal fails fast instead of
# looping, a child that keeps dying soon after it starts is said to be
# crash-looping and waits longer each time, and `semiont stop` (TERM) is
# forwarded and never fought.
#
# TWO KINDS OF SHORT LIFE. A child that exits within RAPID_SECS of its start
# refused to boot: the same refusal comes every time, so after MAX_RAPID in a
# row the supervisor gives up and exits, and the failure is seen. A child that
# lives longer than that and still dies within SHORT_SECS booted and then
# failed at its work, and may be making progress between deaths (work it kept
# on disk, as a Smelter's derived text is): it is started again, after a wait
# that doubles each time up to MAX_WAIT, and each death says plainly that it
# is crash-looping and how it died. A life of SHORT_SECS or more ends both
# counts.
#
# ONE COPY, parameterized by environment — a second copy would be two places
# deciding one policy. Invoked by boot.sh with the image CMD as arguments —
# the command to supervise arrives as "$@", stated once, in CMD, so there is
# no entry-path variable. Required environment:
#
#   SUPERVISE_NAME    service name, used in every event line and the state dir
#   SUPERVISE_PROBE   health URL polled once armed
#
# LOGGING, deliberately minimal: the child writes to STDOUT as it would unsupervised —
# the container outlives child deaths, so the runtime's own log keeps every
# life, `container logs`/dumpLogs work natively, and the launcher's preflight
# snapshot archives it before teardown. Only the supervisor's OWN events
# (starts, exit codes, kills) also go to a small capped file on the state
# mount, so the death record survives even a torn-down container: without
# that file a death takes its own evidence with it. A service with no
# writable /semiont-state (the browser) falls back to /tmp/<name>-supervisor
# and keeps only the runtime log — restart without the durable record, by
# design, not by accident.

: "${SUPERVISE_NAME:?supervise.sh: SUPERVISE_NAME is required}"
: "${SUPERVISE_PROBE:?supervise.sh: SUPERVISE_PROBE is required}"
[ "$#" -gt 0 ] || { echo "supervise.sh: no command given — expected the image CMD as arguments"; exit 1; }

NAME="$SUPERVISE_NAME"
PROBE_URL="$SUPERVISE_PROBE"

# The child reads this back to report `semiont.process.restarts`, so the path
# is a contract between this script and the service's observability wiring.
EVDIR="/semiont-state/${NAME}-supervisor"
mkdir -p "$EVDIR" 2>/dev/null || { EVDIR="/tmp/${NAME}-supervisor"; mkdir -p "$EVDIR"; }
EVENTS="$EVDIR/events.log"

# The child reads the count back out of this file to report
# `semiont.process.restarts`. Export the RESOLVED path rather than letting the
# reader rebuild it: the mkdir above can fall back to /tmp/<name>-supervisor (a service with no
# writable /semiont-state — worker, smelter, weaver, browser), so the path is
# not derivable from the name alone. Two places computing it is one place
# computing it wrong the day a mount changes.
export SUPERVISE_EVENTS="$EVENTS"

PROBE_EVERY=10      # seconds between probes, once armed
PROBE_FAILS=3       # consecutive failures before the child is killed
MAX_RAPID=5         # exits under RAPID_SECS in a row before giving up
RAPID_SECS=10
SHORT_SECS=60       # a death sooner than this after a start, past RAPID_SECS, is a crash loop's
MAX_WAIT=60         # the longest wait before a crash-looping child is started again
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

# How a child died, as a clause of the line that says it is crash-looping.
# An exit status above 128 is a signal's: 137 is 9, a kill, which under a
# container's memory ceiling is almost always the ceiling.
died_by() {
  if [ "$1" -gt 128 ]; then
    signal=$(( $1 - 128 ))
    if [ "$signal" -eq 9 ]; then
      echo "killed by signal 9, which under a memory ceiling is almost always running out of memory"
    else
      echo "killed by signal $signal"
    fi
  else
    echo "exited with status $1"
  fi
}

rapid=0
short=0
backoff=0
while [ -z "$stopping" ]; do
  started=$(date +%s)
  # "starting <name>" is the line the restart-count provider counts. Changing
  # its shape breaks `semiont.process.restarts` in every service.
  note "starting $NAME (rapid failures so far: $rapid)"
  "$@" &
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
  pause=2
  if [ "$lived" -lt "$RAPID_SECS" ]; then
    rapid=$((rapid+1))
    if [ "$rapid" -ge "$MAX_RAPID" ]; then
      note "gave up: $rapid rapid failures — a deterministic refusal should be visible, not looped"
      exit 1
    fi
  elif [ "$lived" -lt "$SHORT_SECS" ]; then
    rapid=0
    short=$((short+1))
    if [ "$backoff" -eq 0 ]; then backoff=2; else backoff=$((backoff * 2)); fi
    [ "$backoff" -gt "$MAX_WAIT" ] && backoff=$MAX_WAIT
    pause=$backoff
    # Never the words "starting $NAME" here: the restart count counts every line that has them.
    note "$NAME is crash-looping: $(died_by "$code") ${lived}s after it started; deaths in a row within ${SHORT_SECS}s of a start: $short; the next start is in ${pause}s"
  else
    rapid=0
    short=0
    backoff=0
  fi
  # Waited on in the background, so that a TERM is answered at once rather than when the wait is over.
  sleep "$pause" &
  sleeper=$!
  wait "$sleeper"
  kill "$sleeper" 2>/dev/null
done
note "stopped by TERM between lives — not restarting"
exit 0
