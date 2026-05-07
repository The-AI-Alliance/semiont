#!/usr/bin/env bash
set -euo pipefail

# Build all Semiont packages and publish to a local Verdaccio registry.
# No npm required on the host — everything runs inside containers.
#
# Each run starts a fresh Verdaccio (no stale state), registers a user,
# acquires an auth token, builds, and publishes.

echo -e "\033[2m[$(date '+%Y-%m-%d %H:%M:%S')] local-build started\033[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REGISTRY="http://localhost:4873"
# Fixed name so pre-run cleanup can find stale containers from prior runs.
# Parallel runs aren't possible anyway — port 4873 is the bottleneck.
VERDACCIO_NAME="semiont-verdaccio"
VERDACCIO_USER="semiont"
VERDACCIO_PASS="semiont"

# --- Colors ---

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

banner() { echo -e "\n${CYAN}${BOLD}══════════════════════════════════════════════════════════════${RESET}"; echo -e "${CYAN}${BOLD}  $1${RESET}"; echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════════${RESET}\n"; }
step()   { echo -e "${GREEN}▸${RESET} $1"; }
ok()     { echo -e "${GREEN}✓${RESET} $1"; }
warn()   { echo -e "${YELLOW}⚠${RESET} $1"; }
fail()   { echo -e "${RED}✗${RESET} $1"; }

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
  fail "No container runtime found. Install Apple Container, Docker, or Podman."
  exit 1
}

RT=$(detect_runtime)

# --- Failure cleanup trap ---
# On failure, stop and remove the Verdaccio container so the next run starts
# clean. Disabled at the end of the happy path so Verdaccio keeps running for
# later image pulls — the user stops it manually when done.
# (Avoids --rm with -d, which is broken on Apple Container CLI.)
verdaccio_cleanup() {
  if [[ -n "${VERDACCIO_NAME:-}" ]]; then
    $RT stop "$VERDACCIO_NAME" >/dev/null 2>&1 || true
    $RT rm   "$VERDACCIO_NAME" >/dev/null 2>&1 || true
  fi
}
trap verdaccio_cleanup ERR INT TERM

banner "SEMIONT LOCAL BUILD"
step "Container runtime: ${BOLD}$RT${RESET}"

# --- Parse arguments ---

SKIP_BUILD=false
PACKAGES=""
START_FROM=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --package) PACKAGES="$2"; shift 2 ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: local-build.sh [options]"
      echo ""
      echo "Build and publish @semiont/* packages to a local Verdaccio registry,"
      echo "then build the frontend container image."
      echo "No npm required on the host — everything runs inside containers."
      echo ""
      echo "Options:"
      echo "  --package <list>   Comma-separated packages to build (default: all)"
      echo "  --start-from <pkg> Skip packages before this one in the build order"
      echo "  --skip-build       Skip build, publish only (reuse previous artifacts)"
      echo "  -h, --help         Show this help"
      echo ""
      echo "Build order:"
      echo "  api-client, ontology, core, content, event-sourcing, graph, inference,"
      echo "  jobs, make-meaning, react-ui, backend, frontend, cli"
      exit 0
      ;;
    *) fail "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# --- Start fresh Verdaccio ---

banner "LOCAL REGISTRY"

step "Ensuring port 4873 is free..."
# Kill any process holding the port
PID_ON_PORT=$(lsof -ti :4873 2>/dev/null || echo "")
if [[ -n "$PID_ON_PORT" ]]; then
  echo "  Port 4873 held by PID $PID_ON_PORT — killing..."
  kill $PID_ON_PORT 2>/dev/null || true
  for i in $(seq 1 10); do
    if ! lsof -ti :4873 > /dev/null 2>&1; then break; fi
    sleep 0.5
  done
fi
# Remove any leftover Verdaccio container that might be holding the port
$RT stop semiont-verdaccio 2>/dev/null || true
$RT rm   semiont-verdaccio 2>/dev/null || true
if lsof -ti :4873 > /dev/null 2>&1; then
  fail "Port 4873 is still in use after kill"
  lsof -i :4873 2>/dev/null
  exit 1
fi
ok "Port 4873 is free"

step "Starting fresh Verdaccio..."
VERDACCIO_STORAGE=$(mktemp -d)
# Copy config into a temp dir so we can mount the whole directory.
# Apple Container CLI sandboxes single-file bind mounts in a way that
# makes them unreadable inside the container; a directory mount works.
VERDACCIO_CONF=$(mktemp -d)
cp "$SCRIPT_DIR/verdaccio.yaml" "$VERDACCIO_CONF/config.yaml"
echo "  Container name: $VERDACCIO_NAME"
echo "  Storage dir:    $VERDACCIO_STORAGE"
echo "  Config dir:     $VERDACCIO_CONF"

# Note: intentionally no --rm — Apple Container CLI v0.11 silently drops
# detached containers that use --rm, making logs unreachable on failure.
# The EXIT trap above handles cleanup instead.
$RT run -d \
  --name "$VERDACCIO_NAME" \
  -p 4873:4873 \
  -v "$VERDACCIO_CONF:/verdaccio/conf" \
  -v "$VERDACCIO_STORAGE:/verdaccio/storage" \
  verdaccio/verdaccio > /dev/null

# Wait for Verdaccio to be ready
for i in $(seq 1 30); do
  if curl -sf "$REGISTRY/-/ping" > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if ! curl -sf "$REGISTRY/-/ping" > /dev/null 2>&1; then
  fail "Verdaccio failed to start"
  echo "  Container logs:"
  $RT logs "$VERDACCIO_NAME" 2>&1 | tail -20
  exit 1
fi
ok "Verdaccio running at $REGISTRY"

# Verify storage is empty (htpasswd should not exist)
echo "  Checking storage dir contents: $(ls "$VERDACCIO_STORAGE" 2>/dev/null || echo '(empty)')"

# Register user and get auth token
step "Registering user..."
VERDACCIO_TOKEN=""
for i in $(seq 1 10); do
  RESPONSE=$(curl -s -X PUT "$REGISTRY/-/user/org.couchdb.user:$VERDACCIO_USER" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$VERDACCIO_USER\",\"password\":\"$VERDACCIO_PASS\"}" 2>/dev/null || echo "")
  echo "  Attempt $i: $RESPONSE"
  VERDACCIO_TOKEN=$(echo "$RESPONSE" | grep -o '"token": *"[^"]*"' | cut -d'"' -f4 || echo "")
  if [[ -n "$VERDACCIO_TOKEN" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$VERDACCIO_TOKEN" ]]; then
  fail "Failed to get auth token from fresh Verdaccio"
  echo "  Storage dir contents: $(ls -la "$VERDACCIO_STORAGE" 2>/dev/null)"
  echo "  htpasswd: $(cat "$VERDACCIO_STORAGE/htpasswd" 2>/dev/null || echo '(not found)')"
  exit 1
fi
ok "Auth token acquired"

# --- Resolve host address ---

HOST_ADDR=$($RT run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'")
step "Host address from container: ${DIM}$HOST_ADDR${RESET}"

# --- Clean staging directory ---

chmod -R u+rwX .npm-stage 2>/dev/null || true
rm -rf .npm-stage

# --- Build + Publish in container ---

banner "BUILD + PUBLISH"

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
//$HOST_ADDR:4873/:_authToken=$VERDACCIO_TOKEN
NPMRC

    # Build (unless --skip-build)
    if [ '$SKIP_BUILD' != 'true' ]; then
      BUILD_ARGS=''
      if [ -n '$PACKAGES' ]; then
        BUILD_ARGS='--package $PACKAGES'
      elif [ -n '$START_FROM' ]; then
        BUILD_ARGS='--start-from $START_FROM'
      fi
      ./scripts/ci/build.sh \$BUILD_ARGS
    else
      echo -e '\n\033[0;33m⚠\033[0m Skipping build (--skip-build)\n'
    fi

    # Publish
    ./scripts/ci/publish.sh \
      --registry http://$HOST_ADDR:4873 \
      --tag latest \
      --clean \
      --npmrc /tmp/.npmrc
  "

BUILD_REGISTRY="http://$HOST_ADDR:4873"

"$SCRIPT_DIR/verdaccio-ls.sh" "$REGISTRY"

# --- Build frontend container image ---

banner "FRONTEND IMAGE"

step "Building semiont-frontend image from apps/frontend/Dockerfile..."
$RT build --no-cache --tag semiont-frontend \
  --build-arg NPM_REGISTRY=$BUILD_REGISTRY \
  --file "$REPO_ROOT/apps/frontend/Dockerfile" \
  "$REPO_ROOT"

ok "semiont-frontend image built"

banner "DONE ✓"

echo -e "${BOLD}Frontend:${RESET}"
echo -e "  $RT run --publish 3000:3000 -it semiont-frontend"
echo ""

echo -e "${BOLD}Backend (from your KB project directory):${RESET}"
echo ""
echo -e "  The KB's ${DIM}.semiont/scripts/start.sh${RESET} spins up Neo4j, Qdrant, Ollama,"
echo -e "  PostgreSQL, and the Semiont API — all wired together. Point it at"
echo -e "  your local Verdaccio so it builds the backend from your freshly"
echo -e "  published ${DIM}@semiont/*${RESET} packages instead of npmjs:"
echo ""
echo -e "    ${BOLD}cd /path/to/your-kb${RESET}"
echo -e "    ${BOLD}NPM_REGISTRY=$BUILD_REGISTRY ./.semiont/scripts/start.sh${RESET} \\"
echo -e "    ${BOLD}  --email admin@example.com --password password${RESET}"
echo ""

echo -e "${DIM}Stop Verdaccio when done:${RESET}  $RT stop $VERDACCIO_NAME"
echo ""
echo -e "\033[2m[$(date '+%Y-%m-%d %H:%M:%S')] local-build finished\033[0m"
