#!/bin/bash
set -e

# Run compliance audits for all workspaces
# Generates REACT-UI-COMPLIANCE.md and FRONTEND-COMPLIANCE.md

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
npx tsx "$COMPLIANCE_DIR/audit-eventbus-sse.ts" "$REPO_ROOT/apps/frontend/src" || echo "⚠️  EventBus/SSE violations found in frontend"
npx tsx "$COMPLIANCE_DIR/audit-eventbus-sse.ts" "$REPO_ROOT/packages/mcp-server/src" || echo "⚠️  EventBus/SSE violations found in mcp-server"
echo ""

# Raw bus access check — forbid client.emit/.on/.stream outside api-client
echo "🚌 Checking for raw bus access outside api-client..."
bash "$COMPLIANCE_DIR/audit-raw-bus.sh"
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

# Frontend source code
echo "📦 Auditing apps/frontend source..."
cd "$REPO_ROOT/apps/frontend"
npm run audit:compliance
echo ""

# Frontend tests
echo "🧪 Auditing apps/frontend tests..."
npm run audit:compliance:tests
echo ""

# Summary
echo "✅ All compliance audits complete!"
echo ""
echo "Reports generated:"
echo "  - $REPO_ROOT/REACT-UI-COMPLIANCE.md"
echo "  - $REPO_ROOT/REACT-UI-TESTS-COMPLIANCE.md"
echo "  - $REPO_ROOT/FRONTEND-COMPLIANCE.md"
echo "  - $REPO_ROOT/FRONTEND-TESTS-COMPLIANCE.md"
echo ""

# Show combined summary
echo "📊 Combined Summary:"
echo "===================="

echo ""
echo "React-UI Source Code:"
grep -A 8 "## Summary" "$REPO_ROOT/REACT-UI-COMPLIANCE.md" | grep -E "Total|Passing|Warnings|Failing|Bypassed|compliance rate" || echo "(Report not found)"

echo ""
echo "React-UI Tests:"
grep -A 8 "## Summary" "$REPO_ROOT/REACT-UI-TESTS-COMPLIANCE.md" | grep -E "Total|Passing|Failing|Bypassed|compliance rate" || echo "(Report not found)"

echo ""
echo "Frontend Source Code:"
grep -A 8 "## Summary" "$REPO_ROOT/FRONTEND-COMPLIANCE.md" | grep -E "Total|Passing|Warnings|Failing|Bypassed|compliance rate" || echo "(Report not found)"

echo ""
echo "Frontend Tests:"
grep -A 8 "## Summary" "$REPO_ROOT/FRONTEND-TESTS-COMPLIANCE.md" | grep -E "Total|Passing|Failing|Bypassed|compliance rate" || echo "(Report not found)"

echo ""
echo "View full reports:"
echo "  cat REACT-UI-COMPLIANCE.md"
echo "  cat REACT-UI-TESTS-COMPLIANCE.md"
echo "  cat FRONTEND-COMPLIANCE.md"
echo "  cat FRONTEND-TESTS-COMPLIANCE.md"
