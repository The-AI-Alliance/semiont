#!/usr/bin/env bash
set -euo pipefail

# Audit: no fire-and-forget bus emitter typed `Promise<void>` in the SDK namespaces (X5).
#
# Fire-and-forget collaboration signals (beckon.hover, mark.changeShape, browse.click,
# bind.initiate, …) return `void` — they fire onto the bus synchronously and are
# observed by other participants. A `Promise<void>` return implies the caller awaits a
# real backend ack, so it is reserved for *atomic backend ops* that genuinely await a
# round-trip (mark.delete, auth.logout, frame.addEntityType, …).
#
# This check flags any `Promise<void>` namespace method NOT in the ack allowlist, so a
# reviewer consciously decides: real ack (add to the allowlist below) or fire-and-forget
# signal (make it `void`). It is a thin regression speed-bump — every current match is a
# legitimate awaiting op, so the live target set is empty; its job is to keep it that way.
#
# Scope: `packages/sdk/src/namespaces/*.ts`.
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Legit ack methods — each awaits a backend HTTP round-trip and correctly returns
# Promise<void>. Add a method name here only when it genuinely awaits a backend ack.
ACK_ALLOWLIST='[^A-Za-z](body|addEntityType|addEntityTypes|addTagSchema|delete|archive|unarchive|updateEntityTypes|logout|acceptTerms)\('

VIOLATIONS=$(grep -rnE ":[[:space:]]*Promise<void>" \
  packages/sdk/src/namespaces \
  --include='*.ts' \
  2>/dev/null \
  | grep -vE "/node_modules/|/dist/|/__tests__/" \
  | grep -vE "$ACK_ALLOWLIST" \
  || true)

if [ -n "$VIOLATIONS" ]; then
  echo "❌ X5: Promise<void> method(s) in @semiont/sdk namespaces not in the ack allowlist:"
  echo ""
  echo "$VIOLATIONS"
  echo ""
  echo "If this is a fire-and-forget bus emitter, return \`void\` (not Promise<void>) — see"
  echo "beckon.hover / mark.changeShape. If it genuinely awaits a backend ack, add its method"
  echo "name to ACK_ALLOWLIST in this script."
  exit 1
fi

echo "✅ X5: no unexpected Promise<void> in SDK namespaces (fire-and-forget signals stay void)"
exit 0
