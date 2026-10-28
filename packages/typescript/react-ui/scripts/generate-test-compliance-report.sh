#!/bin/bash
set -e

# Thin wrapper for react-ui test compliance reporting
# Calls shared compliance scripts with workspace-specific paths

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../src" && pwd)"
REPORT_DIR="$REPO_ROOT/.compliance"
mkdir -p "$REPORT_DIR"
REPORT_FILE="$REPORT_DIR/REACT-UI-TESTS-COMPLIANCE.md"

# Shared compliance script
AUDIT_TESTS="$REPO_ROOT/scripts/compliance/batch-audit-tests.ts"

echo "🧪 Auditing test files in $SRC_DIR..."
# The audit exits non-zero when a test file fails. Its status is kept, so the
# report is still previewed below, and is this script's own.
audit_status=0
npx tsx "$AUDIT_TESTS" "$SRC_DIR" > "$REPORT_FILE" || audit_status=$?

echo "📊 Test compliance report generated: $REPORT_FILE"
echo ""

if [ -f "$REPORT_FILE" ]; then
  echo "Report preview:"
  echo "==============="
  head -n 20 "$REPORT_FILE"
  echo ""
  echo "Full report available at: $REPORT_FILE"
fi

exit "$audit_status"
