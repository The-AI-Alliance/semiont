#!/usr/bin/env bash
set -euo pipefail

# List packages published to the local Verdaccio registry.
#
# Usage:
#   ./scripts/ci/verdaccio-ls.sh
#   ./scripts/ci/verdaccio-ls.sh http://localhost:4873
#
# The publish timestamp is the reason this listing exists rather than a bare
# package count: a same-version republish is invisible to npm, so a row whose
# time predates the current run is a package that did NOT get rebuilt. Keep the
# date — not just the clock time — for exactly that reason.

REGISTRY="${1:-http://localhost:4873}"

# Colour only when stdout is a terminal. This runs inside local-build.sh, whose
# output is routinely captured to a log; escape codes there are noise.
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  RED='\033[0;31m'
  RESET='\033[0m'
else
  GREEN='' CYAN='' BOLD='' DIM='' RED='' RESET=''
fi

if ! curl -sf "$REGISTRY/-/ping" > /dev/null 2>&1; then
  echo -e "${RED}✗${RESET} Verdaccio not running at $REGISTRY"
  exit 1
fi

PACKAGES=$(curl -sf "$REGISTRY/-/verdaccio/data/packages")
COUNT=$(echo "$PACKAGES" | jq 'length')

echo -e "${CYAN}${BOLD}$REGISTRY${RESET}  ${DIM}($COUNT packages)${RESET}\n"

if [[ "$COUNT" -eq 0 ]]; then
  echo -e "  ${DIM}(nothing published)${RESET}\n"
  exit 0
fi

# Sorted here rather than relying on the registry's response order, so the
# listing is diffable between runs.
ROWS=$(echo "$PACKAGES" | jq -r 'sort_by(.name) | .[] | "\(.name)\t\(.version)\t\(.time // "")"')

# Pass 1 — widest `name@version`, so the timestamp column lines up. Measured on
# the PLAIN text: the colour codes below are zero-width on screen but count
# toward printf's field width, which is why this is computed by hand rather than
# with a `%-*s` over the already-coloured string.
WIDTH=0
while IFS=$'\t' read -r NAME VERSION _; do
  [[ -z "$NAME" ]] && continue
  LEN=$(( ${#NAME} + 1 + ${#VERSION} ))
  if (( LEN > WIDTH )); then WIDTH=$LEN; fi
done <<< "$ROWS"

# Pass 2 — emit.
while IFS=$'\t' read -r NAME VERSION TIME; do
  [[ -z "$NAME" ]] && continue

  PAD=$(( WIDTH - ${#NAME} - 1 - ${#VERSION} ))

  # 2026-08-12T10:12:39.123Z -> 2026-08-12 10:12:39  (also tolerates no fraction)
  TIME_FMT="${TIME/T/ }"
  TIME_FMT="${TIME_FMT%%.*}"
  TIME_FMT="${TIME_FMT%Z}"
  [[ -z "$TIME_FMT" ]] && TIME_FMT="—"

  printf "  ${GREEN}✓${RESET} ${BOLD}%s${RESET}@%s%*s  ${DIM}%s${RESET}\n" \
    "$NAME" "$VERSION" "$PAD" "" "$TIME_FMT"
done <<< "$ROWS"

echo ""
