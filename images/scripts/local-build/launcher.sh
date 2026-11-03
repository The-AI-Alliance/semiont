#!/usr/bin/env bash
# Sourced by the local build session.

# --- Build the launcher (host binary) ---
#
# The semiont launcher is a static Go binary that runs on the HOST and drives
# the :local images a KB's stack documents name. Built inside
# $GO_IMAGE (derived from apps/launcher/go.mod) targeting the host platform — no
# Go toolchain on the host, the same philosophy as the npm builds above. It
# shares the drift gate's Go caches.

banner "LAUNCHER"

case "$(uname -s)" in
  Darwin) LAUNCHER_GOOS=darwin ;;
  Linux)  LAUNCHER_GOOS=linux ;;
  *)      fail "Unsupported launcher host OS: $(uname -s)"; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) LAUNCHER_GOARCH=arm64 ;;
  x86_64|amd64)  LAUNCHER_GOARCH=amd64 ;;
  *)             fail "Unsupported launcher host architecture: $(uname -m)"; exit 1 ;;
esac

# -buildvcs=false: Go would run git to stamp the commit into the binary, which
# nothing reads (the version comes from -ldflags in a release build), and git
# refuses a checkout owned by another user, as a root container on Linux sees it.
step "Building the semiont launcher (${LAUNCHER_GOOS}/${LAUNCHER_GOARCH}) in ${GO_IMAGE}..."
if ! run_logged "apps/launcher/dist/semiont built" \
  $RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -v "$GOCACHE_DIR":/root/.cache/go-build \
  -v "$GOMODCACHE_DIR":/go/pkg/mod \
  -w /workspace/apps/launcher \
  -e GOPROXY="$GOPROXY_CACHED" \
  -e GOOS="$LAUNCHER_GOOS" -e GOARCH="$LAUNCHER_GOARCH" -e CGO_ENABLED=0 \
  "$GO_IMAGE" \
  go build -buildvcs=false -o dist/semiont .; then
  fail "The launcher did not build (go says why, above)."
  exit 1
fi
