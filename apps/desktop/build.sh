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
source "$REPO_ROOT/images/scripts/container-runtime.sh"
RT=$(detect_container_runtime)

# Successful npm and packaging commands are very chatty. Keep one temporary log
# so normal builds show only the stage and artifact, while failures retain the
# complete diagnostics that would otherwise be hidden.
BUILD_LOG="$(mktemp -t semiont-desktop-build.XXXXXX)"
SOURCE_ARCHIVE="$(mktemp -t semiont-desktop-source.XXXXXX)"
DMG_WORK_DIR=""
MOUNT_POINT=""
cleanup() {
  if [[ -n "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
  fi
  [[ -z "$DMG_WORK_DIR" ]] || rm -rf "$DMG_WORK_DIR"
  rm -f "$BUILD_LOG" "$SOURCE_ARCHIVE"
}
trap cleanup EXIT

run_logged() {
  : > "$BUILD_LOG"
  local status=0
  "$@" >"$BUILD_LOG" 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then
    cat "$BUILD_LOG" >&2
  fi
  return "$status"
}

NODE_MAJOR="$("$REPO_ROOT/packages/typescript/scripts/node-version.sh")"
GO_TOOLCHAIN="$("$REPO_ROOT/packages/go/scripts/go-toolchain.sh")"
GO_IMAGE="golang:${GO_TOOLCHAIN}"

if [[ "$TARGET" == linux ]]; then
  NODE_IMAGE="node:${NODE_MAJOR}-bookworm"
  LAUNCHER_GOOS=linux
  LAUNCHER_GOARCH=amd64
else
  NODE_IMAGE="node:${NODE_MAJOR}-alpine"
  LAUNCHER_GOOS=darwin
  LAUNCHER_GOARCH=arm64
fi

APP_VERSION="$("$RT" run --rm \
  -v "$REPO_ROOT":/workspace \
  -w /workspace \
  "$NODE_IMAGE" \
  node -p 'JSON.parse(require("node:fs").readFileSync("apps/desktop/package.json", "utf8")).version')"
LAUNCHER_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
LAUNCHER_BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LAUNCHER_LDFLAGS="-s -w -X github.com/The-AI-Alliance/semiont/packages/go/launcher.BuildVersion=${APP_VERSION} -X github.com/The-AI-Alliance/semiont/packages/go/launcher.BuildCommit=${LAUNCHER_COMMIT} -X github.com/The-AI-Alliance/semiont/packages/go/launcher.BuildDate=${LAUNCHER_BUILD_DATE}"
LAUNCHER_BIN="$SCRIPT_DIR/.build/launcher/semiont"
mkdir -p "$(dirname "$LAUNCHER_BIN")"

echo "Building launcher sidecar (${LAUNCHER_GOOS}/${LAUNCHER_GOARCH}) in $GO_IMAGE..."
run_logged "$RT" run --rm \
  -v "$REPO_ROOT":/workspace \
  -w /workspace/apps/launcher \
  -e GOOS="$LAUNCHER_GOOS" \
  -e GOARCH="$LAUNCHER_GOARCH" \
  -e CGO_ENABLED=0 \
  -e LAUNCHER_LDFLAGS="$LAUNCHER_LDFLAGS" \
  "$GO_IMAGE" \
  sh -c 'go build -buildvcs=false -trimpath -ldflags "$LAUNCHER_LDFLAGS" -o /workspace/apps/desktop/.build/launcher/semiont . && chmod 755 /workspace/apps/desktop/.build/launcher/semiont && test -x /workspace/apps/desktop/.build/launcher/semiont'

# Snapshot source, including uncommitted files, without sharing dependency or build
# directories with other commands running in the checkout.
git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard -z |
  tar -c -f "$SOURCE_ARCHIVE" -C "$REPO_ROOT" --null -T -
if [[ -x "$LAUNCHER_BIN" ]]; then
  tar -r -f "$SOURCE_ARCHIVE" -C "$REPO_ROOT" apps/desktop/.build/launcher/semiont
fi
mkdir -p "$SCRIPT_DIR/release"

if [[ "$TARGET" == "linux" ]]; then
  # Build an amd64 Debian package in a matching glibc environment. Rosetta
  # translates the container on Apple Silicon; the resulting .deb targets x64.
  if [[ "$RT" == container ]]; then
    CONTAINER_ARCH=(--arch amd64)
    if [[ "$HOST_OS" == Darwin && "$(uname -m)" == arm64 ]]; then CONTAINER_ARCH+=(--rosetta); fi
  else
    CONTAINER_ARCH=(--platform linux/amd64)
  fi
  echo "Building Semiont Desktop Linux x64 .deb in $NODE_IMAGE..."
  run_logged "$RT" run --rm "${CONTAINER_ARCH[@]}" \
    -v "$SOURCE_ARCHIVE":/source.tar:ro \
    -v "$SCRIPT_DIR/release":/output \
    -m 8g \
    -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    -e SEMIONT_BUILD_VERSION="$APP_VERSION" \
    -e SEMIONT_BUILD_COMMIT="$LAUNCHER_COMMIT" \
    -e SEMIONT_BUILD_DATE="$LAUNCHER_BUILD_DATE" \
    "$NODE_IMAGE" \
    sh -lc 'mkdir /workspace && tar -xf /source.tar -C /workspace && cd /workspace && apt-get update -qq && apt-get install -y -qq --no-install-recommends fakeroot && npm ci --no-audit --no-fund && npm run build:packages -- @semiont/react-ui @semiont/sdk && npm run build --workspace=semiont-desktop && cd apps/desktop && node ../../node_modules/electron-builder/cli.js --linux deb --x64 && test -x release/linux-unpacked/resources/launcher/semiont && deb=$(find release -maxdepth 1 -name "*.deb" -print -quit) && test -n "$deb" && dpkg-deb --contents "$deb" | grep -F "resources/launcher/semiont" && rm -rf /output/linux-unpacked && cp -a release/. /output/'

  echo "Build complete. Installer(s):"
  find "$SCRIPT_DIR/release" -maxdepth 1 -type f -name '*.deb' -print
  exit 0
fi

echo "Building Semiont Desktop sources in $NODE_IMAGE..."
run_logged "$RT" run --rm \
  -v "$SOURCE_ARCHIVE":/source.tar:ro \
  -v "$SCRIPT_DIR/release":/output \
  -m 8g \
  -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  -e SEMIONT_BUILD_VERSION="$APP_VERSION" \
  -e SEMIONT_BUILD_COMMIT="$LAUNCHER_COMMIT" \
  -e SEMIONT_BUILD_DATE="$LAUNCHER_BUILD_DATE" \
  "$NODE_IMAGE" \
  sh -c 'mkdir /workspace && tar -xf /source.tar -C /workspace && cd /workspace && npm ci --no-audit --no-fund && npm run build:packages -- @semiont/react-ui @semiont/sdk && npm run build --workspace=semiont-desktop && cd apps/desktop && node ../../node_modules/electron-builder/cli.js --mac dir --arm64 && rm -rf /output/mac-arm64 && cp -a release/. /output/'

# App assembly runs in the Node container. The host only creates the native disk image.
APP_DIR="$SCRIPT_DIR/release/mac-arm64"
APP=$(find "$APP_DIR" -maxdepth 1 -name '*.app' -print -quit)
[[ -n "$APP" ]] || { echo "No macOS app assembled under $APP_DIR" >&2; exit 1; }
[[ -x "$APP/Contents/Resources/launcher/semiont" ]] || {
  echo "Launcher sidecar is missing from $APP/Contents/Resources/launcher/semiont" >&2
  exit 1
}
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
mkdir -p "$APP_DIR/.background"
cp "$SCRIPT_DIR/assets/dmg-background.tiff" "$APP_DIR/.background/background.tiff"

DMG_WORK_DIR="$(mktemp -d -t semiont-desktop-dmg.XXXXXX)"
RW_DMG="$DMG_WORK_DIR/installer-rw.dmg"
MOUNT_POINT="/Volumes/$APP_NAME"
[[ ! -e "$MOUNT_POINT" ]] || {
  echo "A volume named '$APP_NAME' is already mounted. Eject it before building the DMG." >&2
  MOUNT_POINT=""
  exit 1
}
echo "Creating macOS disk image..."
run_logged hdiutil create -volname "$APP_NAME" -srcfolder "$APP_DIR" -fs HFS+ -ov -format UDRW "$RW_DMG"
run_logged hdiutil attach "$RW_DMG" -readwrite -noverify
sleep 5
osascript - "$APP_NAME.app" "$MOUNT_POINT" "$APP_NAME" <<'APPLESCRIPT'
on run argv
  set appName to item 1 of argv
  set mountPath to item 2 of argv
  set volumeName to item 3 of argv
  set backgroundFile to POSIX file (mountPath & "/.background/background.tiff") as alias
  tell application "Finder"
    tell disk volumeName
      open
      delay 1
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set bounds of container window to {120, 100, 880, 682}
      set viewOptions to icon view options of container window
      set arrangement of viewOptions to not arranged
      set icon size of viewOptions to 96
      set text size of viewOptions to 13
      set background picture of viewOptions to backgroundFile
      set position of item appName of container window to {190, 300}
      set position of item "Applications" of container window to {570, 300}
      close container window
      open
      update without registering applications
      delay 5
      close container window
    end tell
  end tell
end run
APPLESCRIPT
sleep 3
hdiutil detach "$MOUNT_POINT" -quiet
MOUNT_POINT=""
run_logged hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -ov -o "$DMG"
echo "Build complete. Installer(s):"
printf '%s\n' "$DMG"
