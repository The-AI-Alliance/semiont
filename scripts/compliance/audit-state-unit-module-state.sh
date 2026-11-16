#!/usr/bin/env bash
set -euo pipefail

# Audit: no module-scoped mutable state in state-unit files (X3-static).
#
# A state unit holds all its state in the factory CLOSURE — never at module scope.
# A module-scoped `let`/`var`, or a `const x = new Map/Set/Subject/...`, is shared
# across every instance the factory produces, breaking instance isolation. The
# runtime X3 axiom catches leakage *through* shared state; this static check catches
# its *existence* — and the shapes (e.g. a monotonic counter) whose leak doesn't
# change a surface's emission count, which property-based X3 can miss.
#
# Module scope = column 0 (no indentation); factory-internal declarations are
# indented and fine. Immutable module consts (`const FOO = 1`, `const X = {...}`)
# are fine — only mutable bindings (`let`/`var`) and mutable instances
# (`const x = new Map/Subject/...`) are flagged.
#
# Scope: `*-state-unit.ts` factories + the core `state-unit.ts`.
# Allowlist: empty.
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

VIOLATIONS=$(grep -rnE "^(let|var)[[:space:]]|^const[[:space:]]+[A-Za-z0-9_]+[[:space:]]*=[[:space:]]*new[[:space:]]+(Map|Set|WeakMap|WeakSet|BehaviorSubject|Subject|ReplaySubject|AsyncSubject|Observable)[(<]" \
  packages \
  --include='*-state-unit.ts' --include='state-unit.ts' \
  2>/dev/null \
  | grep -vE "/node_modules/|/dist/|/__tests__/" \
  || true)

if [ -n "$VIOLATIONS" ]; then
  echo "❌ X3-static: module-scoped mutable state in state-unit file(s) — move it into the factory closure:"
  echo ""
  echo "$VIOLATIONS"
  echo ""
  echo "A module-scoped let/var or new Map/Set/Subject/... is shared across every instance the"
  echo "factory produces (breaks instance isolation). Declare it inside createXStateUnit so each"
  echo "instance gets its own."
  exit 1
fi

echo "✅ X3-static: no module-scoped mutable state in state-unit files"
exit 0
