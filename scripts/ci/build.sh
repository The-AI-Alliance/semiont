#!/usr/bin/env bash
set -euo pipefail

# Build Semiont packages and apps.
#
# Usage:
#   ./scripts/ci/build.sh                        # build everything
#   ./scripts/ci/build.sh --package cli,backend   # build only CLI and backend
#   ./scripts/ci/build.sh --start-from react-ui   # skip packages before react-ui
#
# Build order (deterministic):
#   api-client, ontology, core, content, event-sourcing, graph, inference,
#   jobs, make-meaning, react-ui, backend, frontend, cli
#
# Dependencies are always installed. OpenAPI spec is always bundled.

cd "$(git rev-parse --show-toplevel)"

# --- Colors ---

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

banner() { echo -e "\n${CYAN}${BOLD}══════════════════════════════════════════════════════════════${RESET}"; echo -e "${CYAN}${BOLD}  $1${RESET}"; echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════════${RESET}\n"; }
step()   { echo -e "${GREEN}▸${RESET} $1"; }
ok()     { echo -e "${GREEN}✓${RESET} $1"; }

# --- Parse arguments ---

PACKAGES=""
START_FROM=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --package) PACKAGES="$2"; shift 2 ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    *) echo -e "${RED}Unknown argument: $1${RESET}" >&2; exit 1 ;;
  esac
done

# Full build order
ALL=(api-client ontology core content event-sourcing graph inference jobs make-meaning react-ui backend frontend cli)

# Resolve which packages to build
if [[ -n "$START_FROM" ]]; then
  TARGETS=()
  FOUND=false
  for pkg in "${ALL[@]}"; do
    if [[ "$pkg" == "$START_FROM" ]]; then
      FOUND=true
    fi
    if [[ "$FOUND" == "true" ]]; then
      TARGETS+=("$pkg")
    fi
  done
  if [[ "$FOUND" != "true" ]]; then
    echo -e "${RED}Unknown package: $START_FROM${RESET}" >&2
    echo "Valid packages: ${ALL[*]}" >&2
    exit 1
  fi
elif [[ -n "$PACKAGES" ]]; then
  IFS=',' read -ra TARGETS <<< "$PACKAGES"
else
  TARGETS=("${ALL[@]}")
fi

should_build() {
  local name="$1"
  for t in "${TARGETS[@]}"; do
    [[ "$t" == "$name" ]] && return 0
  done
  return 1
}

# --- Install + OpenAPI (always) ---

banner "INSTALL DEPENDENCIES"
npm install --include=optional

banner "BUNDLE OPENAPI SPEC"
npm run openapi:bundle

# --- Library packages ---

banner "BUILD LIBRARY PACKAGES"

LIBS=(api-client ontology core content event-sourcing graph inference jobs make-meaning react-ui)
for pkg in "${LIBS[@]}"; do
  if should_build "$pkg"; then
    step "Building @semiont/$pkg..."
    npm run build --workspace=@semiont/$pkg
    ok "@semiont/$pkg"
  fi
done

# --- Apps ---

banner "BUILD APPS"

if should_build backend; then
  step "Building backend..."
  (cd apps/backend && npm run build)
  ok "backend"
fi

if should_build frontend; then
  step "Building frontend..."
  (cd apps/frontend && npm run build)
  ok "frontend"
fi

# Stage frontend before CLI — the CLI bundles dist/frontend/ from .npm-stage/frontend
if should_build cli; then
  step "Staging apps for CLI bundling..."
  node scripts/ci/publish-npm-apps.mjs
  ok "Apps staged"

  step "Building CLI..."
  (cd apps/cli && npm run build)
  ok "CLI"
fi

banner "BUILD COMPLETE ✓"
