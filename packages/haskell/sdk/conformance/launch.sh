#!/usr/bin/env bash
set -euo pipefail
directory=$(cd "$(dirname "$0")" && pwd)
coverage=$(mktemp -d)
child=
cleanup() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  rm -rf "$coverage"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
# GHC reads an existing .tix at startup, before Main. Each process needs its own
# file so parallel drivers and a rebuilt binary never reuse incompatible ticks.
HPCTIXFILE="$coverage/driver.tix" "$directory/semiont-haskell-wire-driver.native" "$@" <&0 &
child=$!
result=0
wait "$child" || result=$?
child=
exit "$result"
