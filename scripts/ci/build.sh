#!/usr/bin/env bash
set -euo pipefail

# Build Semiont packages and apps.
#
# Usage:
#   ./scripts/ci/build.sh                        # build everything
#   ./scripts/ci/build.sh --package cli,backend   # build only CLI and backend
#   ./scripts/ci/build.sh --package react-ui      # build only react-ui
#
# Package names match workspace short names:
#   Libraries: api-client, ontology, core, content, event-sourcing,
#              graph, inference, jobs, make-meaning, react-ui
#   Apps:      cli, backend, frontend
#
# Dependencies are always installed. OpenAPI spec is always bundled.

cd "$(git rev-parse --show-toplevel)"

# --- Parse arguments ---

PACKAGES=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --package) PACKAGES="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Split comma-separated packages into an array
if [[ -n "$PACKAGES" ]]; then
  IFS=',' read -ra TARGETS <<< "$PACKAGES"
else
  TARGETS=()
fi

should_build() {
  # Build everything if no --package flag
  [[ ${#TARGETS[@]} -eq 0 ]] && return 0
  local name="$1"
  for t in "${TARGETS[@]}"; do
    [[ "$t" == "$name" ]] && return 0
  done
  return 1
}

# --- Install + OpenAPI (always) ---

echo "==> Installing dependencies..."
npm ci --include=optional

echo "==> Bundling OpenAPI spec..."
npm run openapi:bundle

# --- Library packages ---

LIBS=(api-client ontology core content event-sourcing graph inference jobs make-meaning react-ui)
for pkg in "${LIBS[@]}"; do
  if should_build "$pkg"; then
    echo "==> Building @semiont/$pkg..."
    npm run build --workspace=@semiont/$pkg
  fi
done

# --- Apps ---

if should_build cli; then
  echo "==> Building CLI..."
  (cd apps/cli && npm run build)
fi

if should_build backend; then
  echo "==> Building backend..."
  (cd apps/backend && npm run build)
fi

if should_build frontend; then
  echo "==> Building frontend..."
  (cd apps/frontend && npm run build)
fi

echo "==> Build complete."
