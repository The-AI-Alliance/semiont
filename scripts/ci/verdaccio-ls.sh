#!/usr/bin/env bash
set -euo pipefail

# List packages published to the local Verdaccio registry.
#
# Usage:
#   ./scripts/ci/verdaccio-ls.sh
#   ./scripts/ci/verdaccio-ls.sh http://localhost:4873

REGISTRY="${1:-http://localhost:4873}"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RED='\033[0;31m'
RESET='\033[0m'

if ! curl -sf "$REGISTRY/-/ping" > /dev/null 2>&1; then
  echo -e "${RED}✗${RESET} Verdaccio not running at $REGISTRY"
  exit 1
fi

PACKAGES=$(curl -sf "$REGISTRY/-/verdaccio/data/packages")

COUNT=$(echo "$PACKAGES" | jq 'length')
echo -e "\n${CYAN}${BOLD}$REGISTRY${RESET}  ${DIM}($COUNT packages)${RESET}\n"

echo "$PACKAGES" | jq -r '.[] | "\(.name)\t\(.version)\t\(.time // "")"' | \
  while IFS=$'\t' read -r NAME VERSION TIME; do
    TIME_FMT=$(echo "$TIME" | sed 's/T/ /;s/\.[0-9]*Z$//')
    echo -e "  ${GREEN}✓${RESET} ${BOLD}${NAME}${RESET}@${VERSION}  ${DIM}${TIME_FMT}${RESET}"
  done

echo ""
