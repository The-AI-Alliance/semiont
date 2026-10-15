#!/usr/bin/env bash
set -euo pipefail

# Audit: no `class` declarations in state-unit files.
#
# TypeScript's convention: a state unit in a `*-state-unit.ts` file is made by a
# factory, `createXStateUnit(...)`, which returns a closure-backed plain object
# with a `dispose()` method. It is a convention of how TypeScript writes its
# units, not one of the axioms, which say how a unit behaves and are the same in
# every SDK: a unit elsewhere may be a class (`SemiontSession`).
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
  echo "❌ class declaration(s) in state-unit file(s) — TypeScript makes its units by a factory returning a plain object:"
  echo ""
  echo "$VIOLATIONS"
  echo ""
  echo "State units are plain-object factories (createXStateUnit). Replace the class with a"
  echo "factory function that returns a plain object literal with a dispose() method."
  exit 1
fi

echo "✅ no class declarations in state-unit files"
exit 0
