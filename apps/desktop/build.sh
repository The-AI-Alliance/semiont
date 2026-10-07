#!/usr/bin/env bash
set -euo pipefail

# Build the Semiont desktop app's Linux bundles in containers.
# No Node, Rust or Tauri CLI required on the host. A .dmg needs a macOS
# host; see README.md.
#
# This script:
#   1. Builds the browser SPA (apps/browser/dist/)
#   2. Builds the Tauri builder image, from the Rust rust-toolchain.toml
#      names and the Tauri CLI version package-lock.json pins for
#      apps/desktop. Every run asks for the build: the runtime's layer cache
#      rebuilds what changed, and nothing when nothing did
#   3. Compiles the Tauri desktop shell into
#      apps/desktop/src-tauri/target/release/bundle/
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

# The Rust the builder image carries and the Node the browser is built in:
# read first, so a file that names none stops the run before anything is built.
RUST_TOOLCHAIN="$("$REPO_ROOT/scripts/ci/rust-toolchain.sh")"
NODE_IMAGE="node:$("$REPO_ROOT/scripts/ci/node-version.sh")-alpine"

# --- Build browser ---

echo ""
echo "Building browser SPA..."
$RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -w /workspace \
  -m 8g \
  -e NODE_OPTIONS="--max-old-space-size=4096" \
  "$NODE_IMAGE" \
  sh -c "apk add --no-cache bash git > /dev/null && npm install --include=optional && npm run build -w semiont-browser"

# --- Build the builder image ---

# The image is built from three things: the Rust rust-toolchain.toml names, the
# Tauri CLI version package-lock.json pins, and Dockerfile.builder's own text.
# Asking for the build on every run leaves it to the layer cache to say which
# of them changed.
TAURI_CLI_VERSION=$($RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -w /workspace \
  "$NODE_IMAGE" \
  node -p "require('./package-lock.json').packages['node_modules/@tauri-apps/cli'].version")

BUILDER_IMAGE="semiont-tauri-builder"
echo ""
echo "Building Tauri builder image (Rust $RUST_TOOLCHAIN, Tauri CLI $TAURI_CLI_VERSION)..."
$RT build --tag "$BUILDER_IMAGE" \
  --build-arg RUST_TOOLCHAIN="$RUST_TOOLCHAIN" \
  --build-arg TAURI_CLI_VERSION="$TAURI_CLI_VERSION" \
  --file "$SCRIPT_DIR/Dockerfile.builder" "$REPO_ROOT"

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
