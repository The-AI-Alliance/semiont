#!/usr/bin/env bash
set -euo pipefail

# Audit Raw Bus Access Compliance
#
# Flags any `.client.emit(`, `.client.on(`, or `.client.stream(` call outside
# the allowlist. The typed namespace methods (session.client.mark.assist etc.)
# are the only public API surface — direct bus access is reserved for the SDK
# implementation (`@semiont/sdk`) and HTTP adapters (`@semiont/api-client`).
#
# Generic-channel subscription (the case `useEventSubscription` needs — channel
# name is a hook parameter, not known statically) goes through the explicit
# `session.subscribe(channel, handler)` carve-out. That is the only sanctioned
# bridge between arbitrary channel names and component lifetimes.
#
# Allowlist:
#   - packages/sdk/src/**               — SemiontClient + namespace impls
#   - packages/api-client/src/**        — HTTP adapters
#   - **/__tests__/**                   — tests may assert on bus behavior
#   - **/test-utils.tsx                 — test helpers
#   - packages/react-ui/src/contexts/useEventSubscription.ts — generic hook
#                                          (uses session.subscribe internally)
#
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Search for .client.emit/.on/.stream call patterns across TS/TSX sources.
# Scope to source directories only (skip node_modules, dist, .plans).
VIOLATIONS=$(cd "$REPO_ROOT" && grep -rn "client\.\(emit\|on\|stream\)(" \
  packages apps \
  --include='*.ts' --include='*.tsx' \
  2>/dev/null \
  | grep -v "/node_modules/" \
  | grep -v "/dist/" \
  | grep -v "__tests__/" \
  | grep -v "/test-utils\." \
  | grep -v "^packages/sdk/src/" \
  | grep -v "^packages/api-client/src/" \
  | grep -v "^packages/react-ui/src/contexts/useEventSubscription\.ts:" \
  || true)

if [ -n "$VIOLATIONS" ]; then
  echo "❌ Raw bus access violations found (use namespace methods instead):"
  echo ""
  echo "$VIOLATIONS"
  echo ""
  echo "Use typed namespace methods (e.g. session.client.mark.delete(rid, aid))"
  echo "instead of session.client.emit('mark:delete', ...)."
  exit 1
fi

echo "✅ No raw bus access outside the allowlist"
exit 0
