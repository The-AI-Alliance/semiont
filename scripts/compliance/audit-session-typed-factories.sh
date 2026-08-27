#!/usr/bin/env bash
set -euo pipefail

# Audit: session-bound state units are constructed via `useSessionStateUnit`,
# never via `useStateUnit` with a non-null-asserted client.
#
# SESSION-TYPED-FACTORIES.md (D1, settled 2026-07-29): a state-unit factory's
# parameter is the lifetime it must not outlive — a `SemiontSession`. The
# `useSessionStateUnit` hook constructs only under a live session and rebuilds
# (dispose-first) on session swap, so `!` assertions on clients/sessions inside
# factory closures are the tell that a call site regressed to the pattern that
# crashed auth/welcome in production.
#
# Rule 1: no `!`-asserted identifier inside a `useStateUnit`/`useSessionStateUnit`
#         call line (catches `createX(semiont!, …)` reintroductions).
# Rule 2: `useStateUnit(` appears ONLY in the allowlist below — everything
#         session-bound uses `useSessionStateUnit`.
#
# Allowlist (rule 2): units whose lifetime is genuinely NOT a session's —
# today only the shell (browser-lifetime, spans sessions).
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

STATUS=0

BANG=$(grep -rnE "use(Session)?StateUnit\(" packages/react-ui/src apps/browser/src \
  --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -v __tests__ \
  | grep -E "[A-Za-z_]+!(,|\.|\))" || true)
if [ -n "$BANG" ]; then
  echo "❌ non-null-asserted client/session inside a state-unit factory call:"
  echo "$BANG"
  STATUS=1
fi

PLAIN=$(grep -rnE "useStateUnit\(" packages/react-ui/src apps/browser/src \
  --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -v __tests__ \
  | grep -v "useSessionStateUnit(" \
  | grep -v "packages/react-ui/src/hooks/useStateUnit.ts" \
  | grep -v "packages/react-ui/src/hooks/useShellStateUnit.ts" || true)
if [ -n "$PLAIN" ]; then
  echo "❌ useStateUnit( outside the sessionless allowlist (shell only) —"
  echo "   session-bound units must use useSessionStateUnit:"
  echo "$PLAIN"
  STATUS=1
fi

if [ "$STATUS" -eq 0 ]; then
  echo "✅ session-typed factories: no !-asserted factory args; useStateUnit confined to the sessionless allowlist"
fi
exit $STATUS
