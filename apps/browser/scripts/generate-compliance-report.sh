#!/bin/bash
set -e

# Thin wrapper for Browser compliance reporting
# Calls shared compliance scripts with workspace-specific paths

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../src" && pwd)"
SYMBOLS_FILE="$SCRIPT_DIR/symbols.json"
REPORT_DIR="$REPO_ROOT/.compliance"
mkdir -p "$REPORT_DIR"
REPORT_FILE="$REPORT_DIR/BROWSER-COMPLIANCE.md"

# Shared compliance scripts
DISCOVER="$REPO_ROOT/scripts/compliance/discover-symbols.ts"
AUDIT="$REPO_ROOT/scripts/compliance/batch-audit.ts"

echo "🔍 Discovering symbols in $SRC_DIR..."
npx tsx "$DISCOVER" "$SRC_DIR" "$SYMBOLS_FILE"

if command -v jq &> /dev/null; then
  SYMBOL_COUNT=$(jq length "$SYMBOLS_FILE")
  echo "✅ Found $SYMBOL_COUNT symbols"
else
  echo "✅ Symbols discovered"
fi

echo ""
echo "🔬 Running compliance audit..."
npx tsx "$AUDIT" "$SRC_DIR" "$SYMBOLS_FILE" > "$REPORT_FILE"

echo "📊 Compliance report generated: $REPORT_FILE"
echo ""

if [ -f "$REPORT_FILE" ]; then
  echo "Report preview:"
  echo "==============="
  head -n 20 "$REPORT_FILE"
  echo ""
  echo "Full report available at: $REPORT_FILE"
fi
