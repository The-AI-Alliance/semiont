#!/usr/bin/env bash
set -euo pipefail

# Build Semiont Desktop packages. All npm commands run inside Apple Container.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TARGET="mac"
if [[ "${1:-}" == "--linux" ]]; then TARGET="linux"; fi
if [[ "${1:-}" == "--mac" ]]; then TARGET="mac"; fi
if [[ $# -gt 1 || ( $# -eq 1 && "${1}" != "--linux" && "${1}" != "--mac" ) ]]; then
  echo "Usage: $0 [--mac|--linux]" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Apple Container is required; run this build script on macOS." >&2
  exit 1
fi

if ! command -v container >/dev/null 2>&1; then
  echo "Apple's 'container' runtime is required to install and build the npm workspace." >&2
  exit 1
fi

NODE_MAJOR="$("$REPO_ROOT/packages/typescript/scripts/node-version.sh")"

# Install and build the workspace in the same Linux container so native Node
# bindings match that build environment. The monorepo workspace supplies every
# @semiont package; no private registry or host npm is involved.
if [[ "$TARGET" == "linux" ]]; then
  # Build an amd64 Debian package in a matching glibc environment. Rosetta
  # translates the container on Apple Silicon; the resulting .deb targets x64.
  NODE_IMAGE="node:${NODE_MAJOR}-bookworm"
  CONTAINER_ARCH=(--arch amd64)
  if [[ "$(uname -m)" == "arm64" ]]; then CONTAINER_ARCH+=(--rosetta); fi
  echo "Building Semiont Desktop Linux x64 .deb in $NODE_IMAGE..."
  container run --rm "${CONTAINER_ARCH[@]}" \
    -v "$REPO_ROOT":/workspace \
    -w /workspace \
    -m 8g \
    -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    "$NODE_IMAGE" \
    sh -lc 'apt-get update -qq && apt-get install -y -qq --no-install-recommends fakeroot && npm ci --no-audit --no-fund && npm run build:packages -- @semiont/react-ui @semiont/sdk && npm run build --workspace=semiont-desktop && cd apps/desktop && node ../../node_modules/electron-builder/cli.js --linux deb --x64'

  echo "Build complete. Installer(s):"
  find "$SCRIPT_DIR/release" -maxdepth 1 -type f -name '*.deb' -print
  exit 0
fi

NODE_IMAGE="node:${NODE_MAJOR}-alpine"
echo "Building Semiont Desktop sources in $NODE_IMAGE..."
container run --rm \
  -v "$REPO_ROOT":/workspace \
  -w /workspace \
  -m 8g \
  -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  "$NODE_IMAGE" \
  sh -c 'npm ci --no-audit --no-fund && npm run build:packages -- @semiont/react-ui @semiont/sdk && npm run build --workspace=semiont-desktop'

# electron-builder invokes hdiutil, so package on the Mac host. Use a temporary
# Node runtime rather than requiring npm or Node to be installed on the host.
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64|aarch64) NODE_ARCH=arm64 ;;
  x86_64) NODE_ARCH=x64 ;;
  *) echo "Unsupported macOS host architecture: $HOST_ARCH" >&2; exit 1 ;;
esac

if [[ -n "${NODE_VERSION:-}" ]]; then
  NODE_DIST="https://nodejs.org/dist/${NODE_VERSION}"
else
  NODE_DIST="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
fi

NODE_TMP="$(mktemp -d)"
trap 'rm -rf "$NODE_TMP"' EXIT

curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$NODE_TMP/SHASUMS256.txt"
NODE_TARBALL="$(grep -oE "node-v[0-9.]+-darwin-${NODE_ARCH}\\.tar\\.gz" "$NODE_TMP/SHASUMS256.txt" | head -n 1)"
if [[ -z "$NODE_TARBALL" ]]; then
  echo "No Node.js darwin-$NODE_ARCH archive found at $NODE_DIST." >&2
  exit 1
fi

EXPECTED_SHA="$(awk -v file="$NODE_TARBALL" '$2 == file { print $1; exit }' "$NODE_TMP/SHASUMS256.txt")"
curl -fsSL "$NODE_DIST/$NODE_TARBALL" -o "$NODE_TMP/$NODE_TARBALL"
ACTUAL_SHA="$(shasum -a 256 "$NODE_TMP/$NODE_TARBALL" | awk '{ print $1 }')"
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  echo "Checksum verification failed for $NODE_TARBALL." >&2
  exit 1
fi

tar xzf "$NODE_TMP/$NODE_TARBALL" -C "$NODE_TMP"
NODE_BIN="$NODE_TMP/${NODE_TARBALL%.tar.gz}/bin/node"

cd "$SCRIPT_DIR"
"$NODE_BIN" "$REPO_ROOT/node_modules/electron-builder/cli.js" --mac dmg --arm64

echo "Build complete. Installer(s):"
find "$SCRIPT_DIR/release" -maxdepth 1 -type f -name '*.dmg' -print
