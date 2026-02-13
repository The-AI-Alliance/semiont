#!/bin/bash

# Event Subscription Audit Script
# Finds all instances of raw useEffect + event bus subscriptions

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "================================================"
echo "Event Subscription Audit"
echo "================================================"
echo ""

# Find all files using event bus
echo "Finding files using event bus..."
EVENT_BUS_FILES=$(find apps/frontend/src packages/react-ui/src -name "*.tsx" -o -name "*.ts" | \
  xargs grep -l "eventBus\.on\|useEventBus()\|useNavigationEvents()\|useMakeMeaningEvents()\|useGlobalSettingsEvents()" 2>/dev/null | \
  grep -v __tests__ | \
  grep -v node_modules | \
  sort -u)

echo "Found $(echo "$EVENT_BUS_FILES" | wc -l | tr -d ' ') files using event bus"
echo ""

# Function to check a file for anti-patterns
check_file() {
  local file=$1
  local has_issues=0

  # Check for useEffect with eventBus.on
  if grep -q "useEffect" "$file" && grep -q "\.on(" "$file"; then
    echo "  🔴 FOUND: useEffect with .on() subscription"
    has_issues=1

    # Try to extract the event names
    grep -n "\.on(" "$file" | head -5 | while read line; do
      echo "     Line: $line"
    done
    echo ""
  fi

  # Check for useEffect with event bus hooks
  if grep -q "useEffect" "$file" && \
     (grep -q "useEventBus()" "$file" || \
      grep -q "useNavigationEvents()" "$file" || \
      grep -q "useMakeMeaningEvents()" "$file" || \
      grep -q "useGlobalSettingsEvents()" "$file"); then

    # Count how many useEffect blocks
    effect_count=$(grep -c "useEffect" "$file" || echo "0")
    if [ "$effect_count" -gt 0 ]; then
      echo "  ⚠️  Has $effect_count useEffect blocks and event bus hooks"
      has_issues=1
    fi
  fi

  return $has_issues
}

# Categorize files
echo "Auditing files..."
echo ""

CRITICAL_FILES=()
NEEDS_REVIEW=()
CLEAN_FILES=()

for file in $EVENT_BUS_FILES; do
  echo "📄 $file"

  if check_file "$file"; then
    # Check if it's a known high-priority file
    case "$file" in
      *"/resource/[id]/page.tsx")
        CRITICAL_FILES+=("$file")
        echo "  🔥 PRIORITY: HIGH (Resource viewer)"
        ;;
      *"/compose/page.tsx")
        CRITICAL_FILES+=("$file")
        echo "  🔥 PRIORITY: HIGH (Compose page)"
        ;;
      *"ResourceViewerPage.tsx")
        CRITICAL_FILES+=("$file")
        echo "  🔥 PRIORITY: HIGH (Core viewer)"
        ;;
      *)
        NEEDS_REVIEW+=("$file")
        echo "  🟡 PRIORITY: MEDIUM (Needs review)"
        ;;
    esac
  else
    CLEAN_FILES+=("$file")
    echo "  ✅ CLEAN: No obvious issues"
  fi
  echo ""
done

# Summary
echo "================================================"
echo "Summary"
echo "================================================"
echo ""
echo "🔥 Critical Files (${#CRITICAL_FILES[@]}):"
for file in "${CRITICAL_FILES[@]}"; do
  echo "   - $file"
done
echo ""

echo "🟡 Needs Review (${#NEEDS_REVIEW[@]}):"
for file in "${NEEDS_REVIEW[@]}"; do
  echo "   - $file"
done
echo ""

echo "✅ Clean Files (${#CLEAN_FILES[@]}):"
for file in "${CLEAN_FILES[@]}"; do
  echo "   - $file"
done
echo ""

echo "================================================"
echo "Recommendations"
echo "================================================"
echo ""
echo "1. Review CRITICAL files first - likely have stale closure bugs"
echo "2. Convert to useEventSubscription or useEventSubscriptions"
echo "3. Remove dependency arrays from event subscriptions"
echo "4. Test thoroughly after each conversion"
echo ""
echo "See EVENT-SUBSCRIPTION-AUDIT.md for detailed conversion guide"
echo ""
