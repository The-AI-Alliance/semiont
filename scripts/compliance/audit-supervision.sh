#!/bin/bash
set -euo pipefail

# Audit: every long-running Semiont service runs under the SHARED supervisor.
#
# GATEWAY-SUPERVISION F1: "the service list belongs in ONE place, not repeated
# per Dockerfile." A service that ships with a bare `CMD ["node", ...]` has no
# restart and leaves no death record — which is exactly how the 2026-09-08
# gateway death became unrecoverable. A new service is one copied Dockerfile
# away from repeating it, and nothing else would notice.
#
# Also fails on a SECOND copy of supervise.sh: two supervisors is two policies.
#
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SHARED="scripts/container/supervise.sh"
# No exemption list, deliberately. The browser was exempt until 2026-09-08 on
# the reasoning that a static server has nothing in flight to lose — an
# argument about the death record used to deny the restart. Every service in
# apps/ is supervised; an exemption list is where the next one would hide.

FAIL=0
[ -f "$SHARED" ] || { echo "❌ supervision: $SHARED is missing"; exit 1; }

copies=$(find apps packages -name 'supervise*.sh' -not -path '*/node_modules/*' | wc -l | tr -d ' ')
if [ "$copies" -ne 0 ]; then
  echo "❌ supervision: $copies copy/copies of supervise.sh outside $SHARED — two supervisors is two policies"
  find apps packages -name 'supervise*.sh' -not -path '*/node_modules/*' | sed 's/^/     /'
  FAIL=1
fi

checked=0
for df in apps/*/Dockerfile; do
  case "$df" in *builder*) continue ;; esac
  checked=$((checked + 1))
  if ! grep -q "$SHARED" "$df"; then
    echo "❌ supervision: $df does not COPY $SHARED — the service would run unsupervised"
    FAIL=1
    continue
  fi
  for var in SUPERVISE_NAME SUPERVISE_PROBE; do
    grep -q "$var" "$df" || { echo "❌ supervision: $df sets no $var"; FAIL=1; }
  done
  # SUPERVISE_ENTRY may be set in ENV or exported by the CMD (the gateway does
  # the latter, because its entry path comes from $GATEWAY_DIR).
  grep -q "SUPERVISE_ENTRY" "$df" || { echo "❌ supervision: $df sets no SUPERVISE_ENTRY"; FAIL=1; }
  # The vars being present does not mean the supervisor RUNS. Read from the
  # last CMD to EOF so both forms count: a plain exec form, and the gateway's
  # multi-line shell CMD that ends in `exec /bin/sh .../supervise.sh`.
  if ! sed -n '/^CMD/,$p' "$df" | grep -q "supervise.sh"; then
    echo "❌ supervision: $df sets SUPERVISE_* but its CMD does not run supervise.sh"
    FAIL=1
  fi
done

if [ "$FAIL" -eq 0 ]; then
  echo "✅ supervision clean ($checked service images under $SHARED, none exempt)"
fi
exit "$FAIL"
