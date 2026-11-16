#!/usr/bin/env bash
set -euo pipefail

# Build the Semiont desktop app (.dmg) in a container.
# No Rust or Tauri CLI required on the host.
#
# This script:
#   1. Builds the frontend SPA (apps/frontend/dist/)
#   2. Compiles the Tauri desktop shell
#   3. Produces a .dmg (macOS) in apps/desktop/src-tauri/target/release/bundle/
#
# Prerequisites:
#   - Container runtime (Apple Container, Docker, or Podman)
#
# Usage:
#   apps/desktop/build.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

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

# --- Build frontend ---

echo ""
echo "Building frontend SPA..."
$RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -w /workspace \
  -m 8g \
  -e NODE_OPTIONS="--max-old-space-size=4096" \
  node:24-alpine \
  sh -c "apk add --no-cache bash git > /dev/null && npm install --include=optional && npm run build -w semiont-frontend"

# --- Ensure builder image exists ---

BUILDER_IMAGE="semiont-tauri-builder"
if ! $RT image inspect "$BUILDER_IMAGE" > /dev/null 2>&1; then
  echo ""
  echo "Building Tauri builder image (one-time)..."
  $RT build --tag "$BUILDER_IMAGE" --file "$SCRIPT_DIR/Dockerfile.builder" "$REPO_ROOT"
fi

# --- Build Tauri desktop app ---

echo ""
echo "Building Tauri desktop app..."
$RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -w /workspace/apps/desktop/src-tauri \
  -m 8g \
  "$BUILDER_IMAGE" \
  cargo tauri build

echo ""
echo "Build complete. Artifacts:"
ls -la "$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle/"* 2>/dev/null || echo "  (check src-tauri/target/release/bundle/)"
