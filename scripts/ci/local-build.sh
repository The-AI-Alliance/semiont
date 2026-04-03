#!/usr/bin/env bash
set -euo pipefail

# Build all Semiont packages and publish to a local Verdaccio registry.
# No npm required on the host — everything runs inside containers.
#
# Usage:
#   ./scripts/ci/local-build.sh              # build + publish to Verdaccio
#   ./scripts/ci/local-build.sh --nuclear    # restart Verdaccio with empty storage first

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REGISTRY="http://localhost:4873"
VERDACCIO_NAME="semiont-verdaccio"
VERDACCIO_USER="semiont"
VERDACCIO_PASS="semiont"

# --- Detect container runtime ---

detect_runtime() {
  if [[ -n "${CONTAINER_RUNTIME:-}" ]]; then
    echo "$CONTAINER_RUNTIME"
    return
  fi
  for rt in container docker podman; do
    if command -v "$rt" >/dev/null 2>&1; then
      echo "$rt"
      return
    fi
  done
  echo "ERROR: No container runtime found. Install Apple Container, Docker, or Podman." >&2
  exit 1
}

RT=$(detect_runtime)
echo "==> Using container runtime: $RT"

# --- Parse arguments ---

NUCLEAR=false
SKIP_BUILD=false
PACKAGES=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --nuclear) NUCLEAR=true; shift ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --package) PACKAGES="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# --- Verdaccio lifecycle ---

verdaccio_running() {
  curl -sf "$REGISTRY/-/ping" > /dev/null 2>&1
}

start_verdaccio() {
  $RT rm -f "$VERDACCIO_NAME" 2>/dev/null || true
  $RT run -d --rm \
    --name "$VERDACCIO_NAME" \
    -p 4873:4873 \
    -v "$SCRIPT_DIR/verdaccio.yaml:/verdaccio/conf/config.yaml:ro" \
    verdaccio/verdaccio

  for i in $(seq 1 30); do
    if verdaccio_running; then
      echo "    Verdaccio ready at $REGISTRY"
      return
    fi
    sleep 0.5
  done
  echo "ERROR: Verdaccio failed to start" >&2
  exit 1
}

if [[ "$NUCLEAR" == "true" ]]; then
  echo "==> Nuclear clean: restarting Verdaccio with empty storage..."
  start_verdaccio
elif verdaccio_running; then
  echo "==> Verdaccio already running at $REGISTRY"
else
  echo "==> Starting Verdaccio..."
  start_verdaccio
fi

# --- Build + Publish in container ---

# --- Resolve host address for the builder container ---
# Docker/Podman support --add-host=host.docker.internal:host-gateway.
# Apple Container doesn't, but the default gateway (ip route) reaches the host.

HOST_ADDR=$($RT run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'")
echo "==> Host address from container: $HOST_ADDR"

echo "==> Building and publishing to $REGISTRY..."

VERDACCIO_AUTH=$(echo -n "$VERDACCIO_USER:$VERDACCIO_PASS" | base64)

$RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -w /workspace \
  -m 8g \
  -e NODE_OPTIONS="--max-old-space-size=4096" \
  node:24-alpine \
  sh -c "
    set -e
    apk add --no-cache bash git > /dev/null

    # Create .npmrc for Verdaccio auth
    cat > /tmp/.npmrc <<NPMRC
registry=http://$HOST_ADDR:4873
//$HOST_ADDR:4873/:_auth=$VERDACCIO_AUTH
//$HOST_ADDR:4873/:always-auth=true
NPMRC

    # Build (unless --skip-build)
    if [ '$SKIP_BUILD' != 'true' ]; then
      BUILD_ARGS=''
      if [ -n '$PACKAGES' ]; then
        BUILD_ARGS='--package $PACKAGES'
      fi
      ./scripts/ci/build.sh \$BUILD_ARGS
    else
      echo '==> Skipping build (--skip-build)'
    fi

    # Publish with --clean (unpublish existing versions for same-version iteration)
    ./scripts/ci/publish.sh \
      --registry http://$HOST_ADDR:4873 \
      --tag latest \
      --clean \
      --npmrc /tmp/.npmrc
  "

echo ""
echo "==> Done. Packages published to $REGISTRY"
echo ""
echo "    Build KB containers against this registry:"
echo "      $RT build --tag semiont-backend \\"
echo "        --build-arg NPM_REGISTRY=$REGISTRY \\"
echo "        --file .semiont/containers/Dockerfile.backend ."
echo ""
echo "    Stop Verdaccio when done:"
echo "      $RT rm -f $VERDACCIO_NAME"
