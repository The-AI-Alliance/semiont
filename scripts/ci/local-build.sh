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
for arg in "$@"; do
  case "$arg" in
    --nuclear) NUCLEAR=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
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

echo "==> Building and publishing to $REGISTRY..."

VERDACCIO_AUTH=$(echo -n "$VERDACCIO_USER:$VERDACCIO_PASS" | base64)

$RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -w /workspace \
  --add-host=host.docker.internal:host-gateway \
  node:24-alpine \
  sh -c "
    # Create .npmrc for Verdaccio auth
    cat > /tmp/.npmrc <<NPMRC
registry=http://host.docker.internal:4873
//host.docker.internal:4873/:_auth=$VERDACCIO_AUTH
//host.docker.internal:4873/:always-auth=true
NPMRC

    # Build everything
    ./scripts/ci/build.sh

    # Publish with --clean (unpublish existing versions for same-version iteration)
    ./scripts/ci/publish.sh \
      --registry http://host.docker.internal:4873 \
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
