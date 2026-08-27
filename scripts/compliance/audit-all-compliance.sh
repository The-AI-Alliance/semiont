#!/bin/bash
set -e

# Run compliance audits for all workspaces
# Reads the generated reports from .compliance/ (gitignored build output).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPLIANCE_DIR="$REPO_ROOT/scripts/compliance"

echo "🔬 Running compliance audits for all workspaces..."
echo ""

# React Hooks ordering check (must run first - catches critical runtime violations)
echo "⚛️  Checking React Hooks ordering..."
npx tsx "$COMPLIANCE_DIR/audit-hooks-ordering.ts"
echo ""

# EventBus/SSE architecture check (detects legacy callback patterns)
echo "🔌 Checking EventBus/SSE architecture..."
npx tsx "$COMPLIANCE_DIR/audit-eventbus-sse.ts" "$REPO_ROOT/packages/react-ui/src" || echo "⚠️  EventBus/SSE violations found in react-ui"
npx tsx "$COMPLIANCE_DIR/audit-eventbus-sse.ts" "$REPO_ROOT/apps/browser/src" || echo "⚠️  EventBus/SSE violations found in browser"
npx tsx "$COMPLIANCE_DIR/audit-eventbus-sse.ts" "$REPO_ROOT/packages/mcp-server/src" || echo "⚠️  EventBus/SSE violations found in mcp-server"
echo ""

# Raw bus access check — forbid client.emit/.on/.stream outside http-transport
echo "🚌 Checking for raw bus access outside http-transport..."
bash "$COMPLIANCE_DIR/audit-raw-bus.sh"
echo ""

# StateUnit pattern static checks (A1-static no-class, X3-static no-module-state, X5 fire-and-forget)
echo "🧩 Checking StateUnit pattern (no class / no module-scoped state / fire-and-forget signals)..."
bash "$COMPLIANCE_DIR/audit-state-unit-no-class.sh"
bash "$COMPLIANCE_DIR/audit-state-unit-module-state.sh"
bash "$COMPLIANCE_DIR/audit-gathered-context-component-state.sh"
bash "$COMPLIANCE_DIR/audit-fire-and-forget-promise-void.sh"
bash "$COMPLIANCE_DIR/audit-session-typed-factories.sh"
echo ""

# Toolbar prefs are controlled props; persistence only in the policy layer
echo "🎛️  Checking toolbar-pref storage stays in useToolbarPrefs()..."
bash "$COMPLIANCE_DIR/audit-toolbar-pref-storage.sh"
echo ""

# Weaver structural invariants (WEAVER-AXIOMS.md G1–G5)
echo "🕸️  Checking Weaver invariants (no event-store/fs, standalone-only, single mark/signal writer, channel↔fold sync)..."
bash "$COMPLIANCE_DIR/audit-weaver-invariants.sh"
echo ""
# One annotation codec for all four graph stores (GRAPH-ANNOTATION-CODEC A1/A5)
echo "🗺️  Checking the graph annotation codec (single envelope, no manufactured values)..."
bash "$COMPLIANCE_DIR/audit-graph-annotation-codec.sh"
bash "$COMPLIANCE_DIR/audit-spec-validator.sh"
echo ""

# SDK doc snippets compile against dist (SAFE-DOCS; post-build — FAILS if dist is
# missing, since a gate that silently skips proves nothing; run build:packages first)
echo "📚 Checking sdk doc snippets..."
bash "$COMPLIANCE_DIR/audit-doc-snippets.sh"
echo ""

# React-UI source code
echo "📦 Auditing packages/react-ui source..."
cd "$REPO_ROOT/packages/react-ui"
npm run audit:compliance
echo ""

# React-UI tests
echo "🧪 Auditing packages/react-ui tests..."
npm run audit:compliance:tests
echo ""

# Browser source code
echo "📦 Auditing apps/browser source..."
cd "$REPO_ROOT/apps/browser"
npm run audit:compliance
echo ""

# Browser tests
echo "🧪 Auditing apps/browser tests..."
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
