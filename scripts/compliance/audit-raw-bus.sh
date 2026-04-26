#!/usr/bin/env bash
set -euo pipefail

# Audit Raw Bus Access Compliance
#
# Flags two forms of direct bus access outside the allowlist:
#
# 1. `.client.emit(`, `.client.on(`, `.client.stream(` — the original
#    raw transport primitives.
# 2. `.bus.get(<channel>).next(` and `.bus.get(<channel>).subscribe(` —
#    the post-SDK-split equivalent that goes through the bridged
#    `client.bus` directly.
#
# The typed namespace methods (session.client.mark.assist etc.) are the
# only public API surface. Direct bus access is reserved for the SDK
# implementation (`@semiont/sdk`), the LocalTransport adapter
# (`@semiont/make-meaning`), and HTTP adapters (`@semiont/api-client`).
#
# Generic-channel subscription (the case `useEventSubscription` needs —
# channel name is a hook parameter, not known statically) goes through
# the explicit `session.subscribe(channel, handler)` carve-out. That is
# the only sanctioned bridge between arbitrary channel names and
# component lifetimes.
#
# Allowlist:
#   - packages/sdk/src/**               — SemiontClient, namespaces, VMs, session
#   - packages/api-client/src/**        — HTTP adapters
#   - packages/make-meaning/src/local-transport.ts
#                                       — LocalTransport implements ITransport
#                                          on top of EventBus (bus.get is the
#                                          natural backing primitive there)
#   - **/__tests__/**                   — tests may assert on bus behavior
#   - **/test-utils.tsx                 — test helpers
#   - packages/react-ui/src/contexts/useEventSubscription.ts — generic hook
#                                          (uses session.subscribe internally)
#
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Common-allowlist filter applied to both pattern searches.
filter_allowlist() {
  grep -v "/node_modules/" \
    | grep -v "/dist/" \
    | grep -v "__tests__/" \
    | grep -v "/test-utils\." \
    | grep -v "^packages/sdk/src/" \
    | grep -v "^packages/api-client/src/" \
    | grep -v "^packages/make-meaning/src/local-transport\.ts:" \
    | grep -v "^packages/react-ui/src/contexts/useEventSubscription\.ts:"
}

cd "$REPO_ROOT"

# Pattern 1: client.emit/.on/.stream
EMIT_VIOLATIONS=$(grep -rn "client\.\(emit\|on\|stream\)(" \
  packages apps \
  --include='*.ts' --include='*.tsx' \
  2>/dev/null \
  | filter_allowlist \
  || true)

# Pattern 2: bus.get(channel).next( or .subscribe(
# Matches `<anything>.bus.get('channel').next(...)` and `.subscribe(...)`.
# The channel argument may be any expression; we only key off the .next /
# .subscribe call that follows the .bus.get(...).
BUS_GET_VIOLATIONS=$(grep -rnE "\.bus\.get\([^)]*\)\.(next|subscribe)\(" \
  packages apps \
  --include='*.ts' --include='*.tsx' \
  2>/dev/null \
  | filter_allowlist \
  || true)

VIOLATIONS=""
if [ -n "$EMIT_VIOLATIONS" ]; then
  VIOLATIONS+="${EMIT_VIOLATIONS}"$'\n'
fi
if [ -n "$BUS_GET_VIOLATIONS" ]; then
  VIOLATIONS+="${BUS_GET_VIOLATIONS}"$'\n'
fi

if [ -n "$VIOLATIONS" ]; then
  echo "❌ Raw bus access violations found (use namespace methods instead):"
  echo ""
  echo "$VIOLATIONS"
  echo "Use typed namespace methods (e.g. session.client.mark.delete(rid, aid))"
  echo "instead of session.client.emit('mark:delete', ...) or"
  echo "session.client.bus.get('mark:delete').next(...)."
  exit 1
fi

echo "✅ No raw bus access outside the allowlist"
exit 0
