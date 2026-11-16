#!/usr/bin/env bash
set -euo pipefail

# Audit Toolbar-Pref Storage Compliance (TOOLBAR-PREFS-AS-PROPS)
#
# Toolbar preferences (mode, click action, selection motivation, shape) are
# React state flowing through controlled props. Their localStorage persistence
# lives in exactly ONE place: the policy layer — `useToolbarPrefs()` plus the
# per-selector-type shape helpers in media-shapes it delegates to. Components
# reading/writing the pref keys directly is the pattern that made preferences
# implicit global mutable state (un-scoped flips, mount drift, hosts poking
# private keys by name).
#
# Allowlist:
#   - packages/react-ui/src/hooks/useToolbarPrefs.ts  — the policy layer
#   - packages/react-ui/src/lib/media-shapes.ts       — svg shape key
#   - test files                                      — seed/assert the keys

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PATTERN="semiont-toolbar-click|semiont-toolbar-selection|semiont-toolbar-shape|localStorage\.(get|set)Item\('annotateMode'"

VIOLATIONS=$(grep -rEn "$PATTERN" \
  "$REPO_ROOT/packages/react-ui/src" \
  "$REPO_ROOT/apps/frontend/src" \
  --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -v "hooks/useToolbarPrefs.ts" \
  | grep -v "lib/media-shapes.ts" \
  | grep -v "__tests__/" \
  | grep -v "\.test\." \
  || true)

if [ -n "$VIOLATIONS" ]; then
  echo "❌ Toolbar-pref storage outside the policy layer (see .plans/TOOLBAR-PREFS-AS-PROPS.md):"
  echo ""
  echo "$VIOLATIONS"
  echo ""
  echo "Preferences are state, not events: components take them as controlled"
  echo "props; ONLY useToolbarPrefs() (+ the media-shapes shape helpers) persist them."
  exit 1
fi

echo "✅ Toolbar-pref storage confined to the policy layer"
exit 0
