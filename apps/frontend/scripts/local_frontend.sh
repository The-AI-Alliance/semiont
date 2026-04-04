#!/usr/bin/env bash
set -euo pipefail

# Start a local Semiont frontend in a container.
#
# This script:
#   1. Detects your container runtime (Apple Container, Docker, or Podman)
#   2. Builds the frontend container image from .semiont/containers/Dockerfile.frontend
#   3. Runs the frontend container (port 3000)
#
# The script stays attached and streams frontend logs. Press Ctrl+C to stop.
# To run in the background: .semiont/scripts/local_frontend.sh &
#
# Prerequisites:
#   - Container runtime (Apple Container, Docker, or Podman)
#   - Backend running on http://localhost:4000 (see local_backend.sh)
#
# Options:
#   --no-cache    Force a fresh container build (skip layer cache)
#
# Usage:
#   .semiont/scripts/local_frontend.sh
#   .semiont/scripts/local_frontend.sh --no-cache
#
# Equivalent without this script (npm required):
#   npm install -g @semiont/cli
#   semiont init
#   semiont provision --service frontend
#   semiont start --service frontend

cd "$(git rev-parse --show-toplevel)"

# --- Parse arguments ---

CACHE_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --no-cache) CACHE_FLAG="--no-cache" ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# --- Detect container runtime ---

for rt in container docker podman; do
  if command -v "$rt" > /dev/null 2>&1; then
    RT="$rt"
    break
  fi
done
if [[ -z "${RT:-}" ]]; then
  echo "No container runtime found. Install Apple Container, Docker, or Podman."
  exit 1
fi
echo "Using container runtime: $RT"

NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
echo "npm registry: $NPM_REGISTRY"

# --- Build frontend ---

echo ""
echo "Building frontend..."
$RT build $CACHE_FLAG --tag semiont-frontend \
  --build-arg NPM_REGISTRY="$NPM_REGISTRY" \
  --file .semiont/containers/Dockerfile.frontend .

# --- Run frontend ---

echo ""
echo "Starting frontend on http://localhost:3000..."
$RT run --publish 3000:3000 -it semiont-frontend
