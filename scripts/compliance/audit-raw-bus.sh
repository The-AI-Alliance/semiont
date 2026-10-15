#!/usr/bin/env bash
set -euo pipefail

# Audit Raw Bus Access Compliance
#
# Flags three forms of direct bus access outside the allowlist:
#
# 1. `.transport.emit(`, `.transport.on(`, `.transport.stream(` — the raw
#    transport primitives (`ITransport`), reached as `client.transport`.
# 2. Any call through a `.bus.` receiver — `.bus.emit(`, `.bus.on(`,
#    `.bus.frames(`, `.bus.scope(` — which goes through the bridged
#    `client.bus` (`EventBus`) directly.
# 3. Any call through a `.wire.` receiver — `.wire.emit(`, `.wire.frames(`,
#    `.wire.request(` — which goes through the client's typed bus over its
#    transport (`client.wire`) directly.
#
# The typed namespace methods (session.client.mark.delegate etc.) are the
# only public API surface. Direct bus access is reserved for the SDK
# implementation (`@semiont/sdk`) and HTTP adapters (`@semiont/http-transport`).
#
# Generic-channel subscription (the case react-ui's event hooks need —
# channel name is a hook parameter, not known statically) goes through
# react-ui's unexported `session/channel-subscription.ts` for a channel of no
# scope, and through `client.wire.frames(channel, resourceId)` in
# `useResourceEventSubscriptions` for a channel of a resource's scope. Those
# are the only sanctioned bridges between arbitrary channel names and
# component lifetimes.
#
# Allowlist:
#   - packages/sdk/src/**               — SemiontClient, namespaces, flow VMs,
#                                          session
#   - packages/http-transport/src/**        — HTTP adapters
#   - packages/core/src/faulty-transport.ts
#                                       — FaultyTransport (liveness-axioms
#                                          simulator, @semiont/core/testing)
#                                          implements ITransport on top of
#                                          EventBus; consumed by test suites only
#   - packages/react-ui/src/state/**    — cross-feature page state units (shell, session)
#                                          that subscribe to bus events for
#                                          UI workflow coordination
#   - packages/react-ui/src/features/*/state/**
#                                       — per-feature page state units (compose,
#                                          resource-viewer, admin, etc.) that
#                                          subscribe to bus events for the
#                                          same reason
#   - **/__tests__/**                   — tests may assert on bus behavior
#   - **/test-utils.tsx                 — test helpers
#   - **/.generated/**                  — build output, not source. The doc-snippets gate
#                                          extracts every doc code fence into
#                                          tests/doc-snippets/.generated/*.ts
#                                          to type-check it; REACTIVE-MODEL.md documents
#                                          `client.bus.on(...)` and
#                                          `client.wire.emit(...)` as the *sanctioned*
#                                          advanced surface (client.bus and client.wire are
#                                          public API, explicitly "not @internal"), so auditing those
#                                          extracts flags the documentation of a legal
#                                          escape hatch. Same class as /dist/ above.
#   - packages/react-ui/src/session/channel-subscription.ts — a channel read
#                                          by name, for the generic event hooks
#   - packages/react-ui/src/contexts/useEventSubscription.ts, for pattern 3
#                                          only — `useResourceEventSubscriptions`
#                                          reads a resource's channel on the wire,
#                                          by name, for one resource
#
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Common-allowlist filter applied to both pattern searches.
filter_allowlist() {
  grep -v "/node_modules/" \
    | grep -v "/dist/" \
    | grep -v "/\.generated/" \
    | grep -v "__tests__/" \
    | grep -v "/test-utils\." \
    | grep -v "^packages/sdk/src/" \
    | grep -v "^packages/http-transport/src/" \
    | grep -v "^packages/core/src/faulty-transport\.ts:" \
    | grep -v "^packages/react-ui/src/state/" \
    | grep -v "^packages/react-ui/src/features/[^/]*/state/" \
    | grep -v "^packages/react-ui/src/session/channel-subscription\.ts:"
}

cd "$REPO_ROOT"

# Pattern 1: transport.emit( / .on( / .stream(
# Matches `<anything>.transport.emit(...)`, `.on(...)` and `.stream(...)`.
# `ITransport` also carries lifecycle members that are not bus access, so its
# three bus primitives are named.
TRANSPORT_VIOLATIONS=$(grep -rnE "\.transport\.(emit|on|stream)\(" \
  packages apps \
  --include='*.ts' --include='*.tsx' \
  2>/dev/null \
  | filter_allowlist \
  || true)

# Pattern 2: any call through a `.bus.` receiver
# Matches `<anything>.bus.emit(...)`, `.bus.on(...)`, `.bus.frames(...)` and
# `.bus.scope(...)`. Every `EventBus` method is bus access, so the verb is
# not enumerated: a pattern naming one goes dead, silently, when the bus's
# API changes. Nothing is required to follow the call either — an Observable
# from `.on(...)` is raw access whether it is subscribed, piped or passed on.
BUS_VIOLATIONS=$(grep -rnE "\.bus\.[A-Za-z_][A-Za-z0-9_]*\(" \
  packages apps \
  --include='*.ts' --include='*.tsx' \
  2>/dev/null \
  | filter_allowlist \
  || true)

# Pattern 3: any call through a `.wire.` receiver
# Matches `<anything>.wire.emit(...)`, `.wire.frames(...)` and
# `.wire.request(...)`, the verb not enumerated, for the reason above.
WIRE_VIOLATIONS=$(grep -rnE "\.wire\.[A-Za-z_][A-Za-z0-9_]*\(" \
  packages apps \
  --include='*.ts' --include='*.tsx' \
  2>/dev/null \
  | filter_allowlist \
  | grep -v "^packages/react-ui/src/contexts/useEventSubscription\.ts:" \
  || true)

VIOLATIONS=""
if [ -n "$TRANSPORT_VIOLATIONS" ]; then
  VIOLATIONS+="${TRANSPORT_VIOLATIONS}"$'\n'
fi
if [ -n "$BUS_VIOLATIONS" ]; then
  VIOLATIONS+="${BUS_VIOLATIONS}"$'\n'
fi
if [ -n "$WIRE_VIOLATIONS" ]; then
  VIOLATIONS+="${WIRE_VIOLATIONS}"$'\n'
fi

if [ -n "$VIOLATIONS" ]; then
  echo "❌ Raw bus access violations found (use namespace methods instead):"
  echo ""
  echo "$VIOLATIONS"
  echo "Use typed namespace methods (e.g. session.client.mark.delete(rid, aid))"
  echo "instead of session.client.transport.emit('mark:delete', ...),"
  echo "session.client.wire.request('mark:delete', ...) or"
  echo "session.client.bus.emit('mark:delete', ...)."
  exit 1
fi

echo "✅ No raw bus access outside the allowlist"
exit 0
