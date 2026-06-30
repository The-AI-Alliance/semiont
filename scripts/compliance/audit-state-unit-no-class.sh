#!/usr/bin/env bash
set -euo pipefail

# Audit: no `class` declarations in state-unit files (A1-static).
#
# State units are plain-object factories: `createXStateUnit(...)` returns a
# closure-backed plain object with a `dispose()` method — never a class instance.
# The runtime A1 axiom enforces this per-unit at test time
# (`Object.getPrototypeOf(unit) === Object.prototype`); this is the static
# complement, catching an intentional `class` declaration even if it returns a
# plain object. See `.plans/STATE-UNIT-AXIOMS.md`.
#
# Scope: `*-state-unit.ts` factories + the core `state-unit.ts` interface file.
# Allowlist: empty (no class declarations expected in any state-unit file).
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

VIOLATIONS=$(grep -rnE "^[[:space:]]*(export[[:space:]]+)?(default[[:space:]]+)?(abstract[[:space:]]+)?class[[:space:]]+[A-Za-z_]" \
  packages \
  --include='*-state-unit.ts' --include='state-unit.ts' \
  2>/dev/null \
  | grep -vE "/node_modules/|/dist/|/__tests__/" \
  || true)

if [ -n "$VIOLATIONS" ]; then
  echo "❌ A1-static: class declaration(s) in state-unit file(s) — use a factory returning a plain object:"
  echo ""
  echo "$VIOLATIONS"
  echo ""
  echo "State units are plain-object factories (createXStateUnit). Replace the class with a"
  echo "factory function that returns a plain object literal with a dispose() method."
  exit 1
fi

echo "✅ A1-static: no class declarations in state-unit files"
exit 0
