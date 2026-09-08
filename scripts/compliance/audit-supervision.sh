#!/bin/bash
set -euo pipefail

# Audit: every service image is supervision-CAPABLE and orchestrator-native
# (GATEWAY-SUPERVISION F1 + ORCHESTRATOR-NATIVE-IMAGES D1/D3/D4/D6).
#
# The image half of a split gate. Supervision is decided per RUN by the
# launcher (SEMIONT_SUPERVISE), so this gate can only prove an image is
# CAPABLE of it: tini as PID 1, a boot entrypoint that branches on the flag,
# the shared supervisor on board, and a conventional exec-form `node` CMD —
# the single statement of what the image runs, in both modes. The launcher
# half (launcher_test.go) proves local runs actually pass the flag; landing
# one half without the other is silent unsupervised operation.
#
# Also fails on: a second copy of supervise.sh/boot.sh (two supervisors is
# two policies), a CMD that runs supervise.sh directly (the pre-split shape —
# it defeats every orchestrator's restart policy), and any reappearance of
# SUPERVISE_ENTRY (deleted; the entry path lives in CMD alone).
#
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SHARED="scripts/container/supervise.sh"
BOOT="scripts/container/boot.sh"
# No exemption list, deliberately. The browser was exempt until 2026-09-08 on
# the reasoning that a static server has nothing in flight to lose — an
# argument about the death record used to deny the restart. Every service in
# apps/ is supervised; an exemption list is where the next one would hide.

FAIL=0
[ -f "$SHARED" ] || { echo "❌ supervision: $SHARED is missing"; FAIL=1; }
[ -f "$BOOT" ]   || { echo "❌ supervision: $BOOT is missing"; FAIL=1; }

for stem in supervise boot; do
  copies=$(find apps packages -name "${stem}*.sh" -not -path '*/node_modules/*' | wc -l | tr -d ' ')
  if [ "$copies" -ne 0 ]; then
    echo "❌ supervision: $copies copy/copies of ${stem}.sh outside scripts/container — two supervisors is two policies"
    find apps packages -name "${stem}*.sh" -not -path '*/node_modules/*' | sed 's/^/     /'
    FAIL=1
  fi
done

checked=0
for df in apps/*/Dockerfile; do
  case "$df" in *builder*) continue ;; esac
  checked=$((checked + 1))

  grep -q "$SHARED" "$df" || { echo "❌ supervision: $df does not COPY $SHARED"; FAIL=1; }
  grep -q "$BOOT" "$df"   || { echo "❌ supervision: $df does not COPY $BOOT"; FAIL=1; }
  grep -qE 'apk add [^&|;]*tini' "$df" || { echo "❌ supervision: $df does not install tini"; FAIL=1; }

  # PID 1 is tini, exec'ing a boot script (boot.sh, or a service-specific
  # *-boot.sh that ends by exec'ing the shared one — the gateway's shape).
  if ! grep -qE '^ENTRYPOINT \["/sbin/tini", "--", "/usr/local/bin/[a-z-]*boot\.sh"\]' "$df"; then
    echo "❌ supervision: $df has no tini→boot ENTRYPOINT"
    FAIL=1
  fi

  # CMD is the conventional exec form a Kubernetes user expects to see, and
  # the ONLY statement of the entry path (D4).
  if ! grep -qE '^CMD \["node", "/[^"]+\.js"\]$' "$df"; then
    echo "❌ supervision: $df has no exec-form CMD [\"node\", \"<entry>.js\"]"
    FAIL=1
  fi
  if sed -n '/^CMD/,$p' "$df" | grep -q "supervise.sh"; then
    echo "❌ supervision: $df runs supervise.sh from CMD — the pre-split shape; supervision is the launcher's per-run decision"
    FAIL=1
  fi
  if grep -q "SUPERVISE_ENTRY" "$df"; then
    echo "❌ supervision: $df mentions SUPERVISE_ENTRY — deleted; the entry path is stated once, in CMD"
    FAIL=1
  fi

  for var in SUPERVISE_NAME SUPERVISE_PROBE; do
    grep -q "$var" "$df" || { echo "❌ supervision: $df sets no $var"; FAIL=1; }
  done
done

if [ "$FAIL" -eq 0 ]; then
  echo "✅ supervision clean ($checked service images: tini→boot ENTRYPOINT, exec-form CMD, shared supervisor on board)"
fi
exit "$FAIL"
