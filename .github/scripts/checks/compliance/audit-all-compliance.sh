#!/bin/bash
set -e

# Run compliance audits for all workspaces
# Reads the generated reports from .compliance/ (gitignored build output).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

echo "🔬 Running compliance audits for all workspaces..."
echo ""

# React Hooks ordering check (must run first - catches critical runtime violations)
echo "⚛️  Checking React Hooks ordering..."
npx tsx "$REPO_ROOT/packages/typescript/scripts/compliance/audit-hooks-ordering.ts"
echo ""

# Raw bus access check — forbid client.emit/.on/.stream outside http-transport
echo "🚌 Checking for raw bus access outside http-transport..."
bash "$REPO_ROOT/.github/scripts/checks/compliance/audit-raw-bus.sh"
echo ""

# StateUnit pattern static checks (no class in a state-unit file, X3-static no-module-state, X5 fire-and-forget)
echo "🧩 Checking StateUnit pattern (no class / no module-scoped state / fire-and-forget signals)..."
bash "$REPO_ROOT/packages/typescript/scripts/compliance/audit-state-unit-no-class.sh"
bash "$REPO_ROOT/packages/typescript/scripts/compliance/audit-state-unit-module-state.sh"
bash "$REPO_ROOT/packages/typescript/scripts/compliance/audit-gathered-context-component-state.sh"
bash "$REPO_ROOT/packages/typescript/scripts/compliance/audit-fire-and-forget-promise-void.sh"
bash "$REPO_ROOT/packages/typescript/scripts/compliance/audit-session-typed-factories.sh"
echo ""

# storageUri one-home check — the field lives on Representation, and the
# descriptor's index signature means the compiler can't police revivals
echo "📦 Checking storageUri stays on the Representation (one home)..."
bash "$REPO_ROOT/.github/scripts/checks/compliance/audit-storage-uri-one-home.sh"
echo ""

# Toolbar prefs are controlled props; persistence only in the policy layer
echo "🎛️  Checking toolbar-pref storage stays in useToolbarPrefs()..."
bash "$REPO_ROOT/packages/typescript/react-ui/scripts/audit-toolbar-pref-storage.sh"
echo ""

# No path has a fallback; tests export no dead SEMIONT_* vars
echo "🐳 Checking path environment (P1-P3), test-env hygiene (H1) and vi.mock targets..."
bash "$REPO_ROOT/.github/scripts/checks/compliance/audit-path-env.sh"
bash "$REPO_ROOT/.github/scripts/checks/compliance/audit-test-env-hygiene.sh"
bash "$REPO_ROOT/.github/scripts/checks/compliance/audit-mock-targets.sh"
bash "$REPO_ROOT/images/scripts/audit-supervision.sh"
echo ""

echo "📐 Checking the spec validator..."
bash "$REPO_ROOT/.github/scripts/checks/compliance/audit-spec-validator.sh"
echo ""

# SDK doc snippets compile against dist (post-build — FAILS if dist is
# missing, since a gate that silently skips proves nothing; run build:packages first)
echo "📚 Checking sdk doc snippets..."
bash "$REPO_ROOT/tests/doc-snippets/audit-doc-snippets.sh"
echo ""

# The source and test audits below decide by exit status; hold them to it first
echo "🧪 Checking the compliance audits can fail..."
bash "$REPO_ROOT/packages/typescript/scripts/compliance/audit-compliance-gate.sh"
echo ""

# React-UI source code
echo "📦 Auditing packages/typescript/react-ui source..."
cd "$REPO_ROOT/packages/typescript/react-ui"
npm run audit:compliance
echo ""

# React-UI tests
echo "🧪 Auditing packages/typescript/react-ui tests..."
npm run audit:compliance:tests
echo ""

# Browser source code
echo "📦 Auditing images/browser source..."
cd "$REPO_ROOT/images/browser"
npm run audit:compliance
echo ""

# Browser tests
echo "🧪 Auditing images/browser tests..."
npm run audit:compliance:tests
echo ""

# Summary
echo "✅ All compliance audits complete!"
echo ""
echo "Reports generated:"
echo "  - $REPO_ROOT/.compliance/REACT-UI-COMPLIANCE.md"
echo "  - $REPO_ROOT/.compliance/REACT-UI-TESTS-COMPLIANCE.md"
echo "  - $REPO_ROOT/.compliance/BROWSER-COMPLIANCE.md"
echo "  - $REPO_ROOT/.compliance/BROWSER-TESTS-COMPLIANCE.md"
echo ""

# Show combined summary
echo "📊 Combined Summary:"
echo "===================="

echo ""
echo "React-UI Source Code:"
grep -A 8 "## Summary" "$REPO_ROOT/.compliance/REACT-UI-COMPLIANCE.md" | grep -E "Total|Passing|Warnings|Failing|Bypassed|compliance rate" || echo "(Report not found)"

echo ""
echo "React-UI Tests:"
grep -A 8 "## Summary" "$REPO_ROOT/.compliance/REACT-UI-TESTS-COMPLIANCE.md" | grep -E "Total|Passing|Failing|Bypassed|compliance rate" || echo "(Report not found)"

echo ""
echo "Browser Source Code:"
grep -A 8 "## Summary" "$REPO_ROOT/.compliance/BROWSER-COMPLIANCE.md" | grep -E "Total|Passing|Warnings|Failing|Bypassed|compliance rate" || echo "(Report not found)"

echo ""
echo "Browser Tests:"
grep -A 8 "## Summary" "$REPO_ROOT/.compliance/BROWSER-TESTS-COMPLIANCE.md" | grep -E "Total|Passing|Failing|Bypassed|compliance rate" || echo "(Report not found)"

echo ""
echo "View full reports:"
echo "  cat .compliance/REACT-UI-COMPLIANCE.md"
echo "  cat .compliance/REACT-UI-TESTS-COMPLIANCE.md"
echo "  cat .compliance/BROWSER-COMPLIANCE.md"
echo "  cat .compliance/BROWSER-TESTS-COMPLIANCE.md"
