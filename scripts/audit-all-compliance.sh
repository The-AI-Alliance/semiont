#!/bin/bash
set -e

# Run compliance audits for all workspaces
# Generates REACT-UI-COMPLIANCE.md and FRONTEND-COMPLIANCE.md

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "🔬 Running compliance audits for all workspaces..."
echo ""

# React-UI
echo "📦 Auditing packages/react-ui..."
cd "$REPO_ROOT/packages/react-ui"
npm run audit:compliance
echo ""

# Frontend
echo "📦 Auditing apps/frontend..."
cd "$REPO_ROOT/apps/frontend"
npm run audit:compliance
echo ""

# Summary
echo "✅ All compliance audits complete!"
echo ""
echo "Reports generated:"
echo "  - $REPO_ROOT/REACT-UI-COMPLIANCE.md"
echo "  - $REPO_ROOT/FRONTEND-COMPLIANCE.md"
echo ""

# Show combined summary
echo "📊 Combined Summary:"
echo "===================="

echo ""
echo "React-UI:"
grep -A 8 "## Summary" "$REPO_ROOT/REACT-UI-COMPLIANCE.md" | grep -E "Total|Passing|Warnings|Failing|compliance rate"

echo ""
echo "Frontend:"
grep -A 8 "## Summary" "$REPO_ROOT/FRONTEND-COMPLIANCE.md" | grep -E "Total|Passing|Warnings|Failing|compliance rate"

echo ""
echo "View full reports:"
echo "  cat REACT-UI-COMPLIANCE.md"
echo "  cat FRONTEND-COMPLIANCE.md"
