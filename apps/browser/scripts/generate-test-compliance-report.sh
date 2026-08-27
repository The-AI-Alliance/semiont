#!/bin/bash
set -e

# Thin wrapper for Browser test compliance reporting
# Calls shared compliance scripts with workspace-specific paths

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../src" && pwd)"
REPORT_FILE="$REPO_ROOT/BROWSER-TESTS-COMPLIANCE.md"

# Shared compliance script
AUDIT_TESTS="$REPO_ROOT/scripts/compliance/batch-audit-tests.ts"

echo "🧪 Auditing test files in $SRC_DIR..."
npx tsx "$AUDIT_TESTS" "$SRC_DIR" > "$REPORT_FILE"

echo "📊 Test compliance report generated: $REPORT_FILE"
echo ""

if [ -f "$REPORT_FILE" ]; then
  echo "Report preview:"
  echo "==============="
  head -n 20 "$REPORT_FILE"
  echo ""
  echo "Full report available at: $REPORT_FILE"
fi
