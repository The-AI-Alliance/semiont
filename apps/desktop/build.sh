#!/usr/bin/env bash
set -euo pipefail

# Build Semiont Desktop installers with containerized npm and OS-specific packaging.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

HOST_OS=$(uname -s)
case "${1:-desktop}" in
  desktop)
    case "$HOST_OS" in
      Darwin) TARGET=mac ;;
      Linux) TARGET=linux ;;
      *) echo "Unsupported desktop host OS: $HOST_OS" >&2; exit 1 ;;
    esac ;;
  desktop-macos) TARGET=mac ;;
  desktop-linux) TARGET=linux ;;
  *) echo "Usage: $0 [desktop|desktop-macos|desktop-linux]" >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo "Specify one desktop target" >&2; exit 2; }
if [[ "$TARGET" == mac && "$HOST_OS" != Darwin ]]; then
  echo "macOS installer packaging requires a macOS host (hdiutil)." >&2
  exit 1
fi
RT="${CONTAINER_RUNTIME:-}"
if [[ -z "$RT" ]]; then
  for candidate in container docker podman; do
    if command -v "$candidate" >/dev/null 2>&1; then RT="$candidate"; break; fi
  done
fi
[[ -n "$RT" ]] || { echo "A container runtime is required" >&2; exit 1; }

NODE_MAJOR="$("$REPO_ROOT/packages/typescript/scripts/node-version.sh")"

# Install and build the workspace in the same Linux container so native Node
# bindings match that build environment. The monorepo workspace supplies every
# @semiont package; no private registry or host npm is involved.
if [[ "$TARGET" == "linux" ]]; then
  # Build an amd64 Debian package in a matching glibc environment. Rosetta
  # translates the container on Apple Silicon; the resulting .deb targets x64.
  NODE_IMAGE="node:${NODE_MAJOR}-bookworm"
  if [[ "$RT" == container ]]; then
    CONTAINER_ARCH=(--arch amd64)
    if [[ "$HOST_OS" == Darwin && "$(uname -m)" == arm64 ]]; then CONTAINER_ARCH+=(--rosetta); fi
  else
    CONTAINER_ARCH=(--platform linux/amd64)
  fi
  echo "Building Semiont Desktop Linux x64 .deb in $NODE_IMAGE..."
  "$RT" run --rm "${CONTAINER_ARCH[@]}" \
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
"$RT" run --rm \
  -v "$REPO_ROOT":/workspace \
  -w /workspace \
  -m 8g \
  -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  "$NODE_IMAGE" \
  sh -c 'npm ci --no-audit --no-fund && npm run build:packages -- @semiont/react-ui @semiont/sdk && npm run build --workspace=semiont-desktop && cd apps/desktop && node ../../node_modules/electron-builder/cli.js --mac dir --arm64'

# App assembly runs in the Node container. The host only creates the native disk image.
APP_DIR="$SCRIPT_DIR/release/mac-arm64"
APP=$(find "$APP_DIR" -maxdepth 1 -name '*.app' -print -quit)
[[ -n "$APP" ]] || { echo "No macOS app assembled under $APP_DIR" >&2; exit 1; }
APP_NAME=$(basename "$APP" .app)
VERSION=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")
DMG="$SCRIPT_DIR/release/$APP_NAME-$VERSION-arm64.dmg"
if [[ -L "$APP_DIR/Applications" ]]; then
  [[ "$(readlink "$APP_DIR/Applications")" == /Applications ]] || { echo "Unexpected Applications link" >&2; exit 1; }
elif [[ -e "$APP_DIR/Applications" ]]; then
  echo "The Applications shortcut path is already occupied" >&2; exit 1
else
  ln -s /Applications "$APP_DIR/Applications"
fi
hdiutil create -volname "$APP_NAME" -srcfolder "$APP_DIR" -ov -format UDZO "$DMG"
echo "Build complete. Installer(s):"
printf '%s\n' "$DMG"
