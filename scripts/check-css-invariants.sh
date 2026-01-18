#!/bin/bash

# Check CSS invariants for the Semiont project
# This script enforces our CSS coding standards

echo "🔍 Checking CSS invariants..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track if any errors were found
ERRORS_FOUND=0

# Function to check for Tailwind classes in react-ui
check_tailwind_in_react_ui() {
    echo "Checking for Tailwind utility classes in react-ui..."

    # Common Tailwind patterns to check
    PATTERNS=(
        "className=.*\b(p|m)(t|r|b|l|x|y)?-[0-9]"
        "className=.*\bw-[0-9]"
        "className=.*\bh-[0-9]"
        "className=.*\btext-(xs|sm|base|lg|xl|2xl|3xl)"
        "className=.*\bfont-(thin|light|normal|medium|semibold|bold)"
        "className=.*\bbg-(white|black|gray|red|yellow|green|blue)"
        "className=.*\bflex-(row|col|wrap|nowrap)"
        "className=.*\bjustify-(start|end|center|between|around)"
        "className=.*\bitems-(start|end|center)"
        "className=.*\bgrid-cols-[0-9]"
        "className=.*\brounded-(none|sm|md|lg|xl|full)"
        "className=.*\bhover:"
        "className=.*\bdark:"
    )

    for pattern in "${PATTERNS[@]}"; do
        results=$(grep -r "$pattern" packages/react-ui/src --include="*.tsx" --include="*.jsx" 2>/dev/null | grep -v "// Allow" | grep -v ".test." | grep -v ".stories.")
        if [ ! -z "$results" ]; then
            echo -e "${RED}❌ Found Tailwind classes:${NC}"
            echo "$results" | head -5
            ERRORS_FOUND=1
        fi
    done

    if [ $ERRORS_FOUND -eq 0 ]; then
        echo -e "${GREEN}✓ No Tailwind utility classes found in react-ui${NC}"
    fi
}

# Function to check for semiont- prefix in react-ui CSS
check_semiont_prefix() {
    echo "Checking for proper semiont- prefix in react-ui CSS classes..."

    # Look for class definitions that don't start with semiont- or allowed exceptions
    results=$(grep -r "^\." packages/react-ui/src/styles --include="*.css" |
              grep -v "\.semiont-" |
              grep -v "\.annotation-" |
              grep -v "\.red-underline" |
              grep -v "\.cm-" |
              grep -v "\.md-" |
              grep -v "\.sr-only" |
              grep -v "@keyframes" |
              grep -v "@media" |
              head -10)

    if [ ! -z "$results" ]; then
        echo -e "${YELLOW}⚠ Found non-semiont classes (first 10):${NC}"
        echo "$results"
        echo -e "${YELLOW}Consider using semiont- prefix for consistency${NC}"
    else
        echo -e "${GREEN}✓ All CSS classes follow naming convention${NC}"
    fi
}

# Function to check for hardcoded colors
check_hardcoded_colors() {
    echo "Checking for hardcoded colors in CSS..."

    # Look for hex colors and named colors (except in comments)
    hex_colors=$(grep -r "#[0-9a-fA-F]\{3,6\}" packages/react-ui/src/styles --include="*.css" |
                 grep -v "^[[:space:]]*\*" |
                 grep -v "^[[:space:]]*\/\/" |
                 grep -v "rgba\|rgb\|hsl" |
                 head -10)

    if [ ! -z "$hex_colors" ]; then
        echo -e "${YELLOW}⚠ Found hardcoded hex colors (first 10):${NC}"
        echo "$hex_colors"
        echo -e "${YELLOW}Consider using CSS variables${NC}"
    fi

    # Check for named colors
    named_colors=$(grep -r "\bcolor:[[:space:]]*\(red\|blue\|green\|yellow\|black\|white\|gray\)" packages/react-ui/src/styles --include="*.css" |
                   grep -v "var(--" |
                   head -5)

    if [ ! -z "$named_colors" ]; then
        echo -e "${RED}❌ Found hardcoded named colors:${NC}"
        echo "$named_colors"
        ERRORS_FOUND=1
    fi
}

# Function to check for theme selector issues
check_theme_selectors() {
    echo "Checking for problematic theme selectors..."

    # Look for the problematic :root:not pattern
    bad_selectors=$(grep -r ":root:not(\[data-theme" packages/react-ui/src/styles --include="*.css")

    if [ ! -z "$bad_selectors" ]; then
        echo -e "${RED}❌ Found problematic :root:not selectors:${NC}"
        echo "$bad_selectors"
        echo -e "${RED}Use [data-theme=\"dark\"] instead${NC}"
        ERRORS_FOUND=1
    else
        echo -e "${GREEN}✓ No problematic theme selectors found${NC}"
    fi
}

# Run all checks
check_tailwind_in_react_ui
echo ""
check_semiont_prefix
echo ""
check_hardcoded_colors
echo ""
check_theme_selectors

# Run Stylelint for comprehensive checking
echo ""
echo "Running Stylelint..."
cd packages/react-ui
npm run lint:css 2>/dev/null
STYLELINT_EXIT=$?
cd ../..

if [ $STYLELINT_EXIT -ne 0 ]; then
    echo -e "${RED}❌ Stylelint found issues${NC}"
    ERRORS_FOUND=1
else
    echo -e "${GREEN}✓ Stylelint checks passed${NC}"
fi

# Final result
echo ""
if [ $ERRORS_FOUND -eq 0 ]; then
    echo -e "${GREEN}✅ All CSS invariants check passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ CSS invariants check failed. Please fix the issues above.${NC}"
    exit 1
fi