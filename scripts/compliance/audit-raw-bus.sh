#!/usr/bin/env bash
set -euo pipefail

# Audit Raw Bus Access Compliance
#
# Flags two forms of direct bus access outside the allowlist:
#
# 1. `.transport.emit(`, `.transport.on(`, `.transport.stream(` — the raw
#    transport primitives (`ITransport`), reached as `client.transport`.
# 2. Any call through a `.bus.` receiver — `.bus.emit(`, `.bus.on(`,
#    `.bus.frames(`, `.bus.scope(` — which goes through the bridged
#    `client.bus` (`EventBus`) directly.
#
# The typed namespace methods (session.client.mark.assist etc.) are the
# only public API surface. Direct bus access is reserved for the SDK
# implementation (`@semiont/sdk`), the LocalTransport adapter
# (`@semiont/make-meaning`), and HTTP adapters (`@semiont/http-transport`).
#
# Generic-channel subscription (the case `useEventSubscription` needs —
# channel name is a hook parameter, not known statically) goes through
# the explicit `session.subscribe(channel, handler)` carve-out. That is
# the only sanctioned bridge between arbitrary channel names and
# component lifetimes.
#
# Allowlist:
#   - packages/sdk/src/**               — SemiontClient, namespaces, flow VMs,
#                                          session
#   - packages/http-transport/src/**        — HTTP adapters
#   - packages/jobs/src/**              — job-claim adapter and worker loop
#                                          (domain-owned worker adapters that
#                                          subscribe to job:* bus events)
#   - packages/make-meaning/src/local-transport.ts
#                                       — LocalTransport implements ITransport
#                                          on top of EventBus (the bus's own verbs
#                                          are the natural backing primitive there)
#   - packages/make-meaning/src/weaver.ts
#   - packages/make-meaning/src/smelter.ts
#                                       — actors whose `bus` field is a
#                                          `BusRequestPrimitive` — the port they
#                                          announce and request on, in-process or
#                                          through the gateway — not `client.bus`;
#                                          an actor has no namespace method to
#                                          call instead
#   - packages/core/src/faulty-transport.ts
#                                       — FaultyTransport (liveness-axioms
#                                          simulator, @semiont/core/testing)
#                                          implements ITransport on top of
#                                          EventBus, same as LocalTransport;
#                                          consumed by test suites only
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
#   - **/.generated/**                  — build output, not source. The SAFE-DOCS gate
#                                          extracts every doc code fence into
#                                          packages/sdk/docs/__snippets__/.generated/*.ts
#                                          to type-check it; REACTIVE-MODEL.md documents
#                                          `client.bus.on(...)` and
#                                          `client.transport.emit(...)` as the *sanctioned*
#                                          advanced surface (client.bus is public API,
#                                          explicitly "not @internal"), so auditing those
#                                          extracts flags the documentation of a legal
#                                          escape hatch. Same class as /dist/ above.
#   - packages/react-ui/src/contexts/useEventSubscription.ts — generic hook
#                                          (uses session.subscribe internally)
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
    | grep -v "^packages/jobs/src/" \
    | grep -v "^packages/make-meaning/src/local-transport\.ts:" \
    | grep -v "^packages/make-meaning/src/weaver\.ts:" \
    | grep -v "^packages/make-meaning/src/smelter\.ts:" \
    | grep -v "^packages/core/src/faulty-transport\.ts:" \
    | grep -v "^packages/react-ui/src/state/" \
    | grep -v "^packages/react-ui/src/features/[^/]*/state/" \
    | grep -v "^packages/react-ui/src/contexts/useEventSubscription\.ts:"
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

VIOLATIONS=""
if [ -n "$TRANSPORT_VIOLATIONS" ]; then
  VIOLATIONS+="${TRANSPORT_VIOLATIONS}"$'\n'
fi
if [ -n "$BUS_VIOLATIONS" ]; then
  VIOLATIONS+="${BUS_VIOLATIONS}"$'\n'
fi

if [ -n "$VIOLATIONS" ]; then
  echo "❌ Raw bus access violations found (use namespace methods instead):"
  echo ""
  echo "$VIOLATIONS"
  echo "Use typed namespace methods (e.g. session.client.mark.delete(rid, aid))"
  echo "instead of session.client.transport.emit('mark:delete', ...) or"
  echo "session.client.bus.emit('mark:delete', ...)."
  exit 1
fi

echo "✅ No raw bus access outside the allowlist"
exit 0
