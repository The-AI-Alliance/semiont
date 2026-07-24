#!/usr/bin/env bash
set -euo pipefail

# Build all Semiont packages, publish to a local Verdaccio registry, and build
# the service/frontend container images against it, tagged
# ghcr.io/the-ai-alliance/semiont-<svc>:local (consumed by `semiont start` /
# compose via SEMIONT_VERSION=local; never pushed). Also builds the semiont
# launcher itself (apps/launcher/dist/semiont, a host binary) so one run
# yields everything a fully-local stack needs.
# No npm or Go required on the host — everything runs inside containers.
#
# Each run starts a fresh Verdaccio (no stale state), registers a user,
# acquires an auth token, builds, publishes, and builds the images.

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

# On exit (success or failure), revert the version-stamp that publish.sh writes
# into the bind-mounted source manifests (version.json + every workspace
# package.json) — a local publish should not leave the working tree dirty.
# Guarded: if those files were already modified before the run, leave them
# alone so we never clobber in-progress edits.
restore_manifests() {
  local now_dirty
  now_dirty=$(git -C "$REPO_ROOT" status --porcelain -- version.json ':(glob)packages/*/package.json' ':(glob)apps/*/package.json' 2>/dev/null || true)
  [[ -z "$now_dirty" ]] && return
  if [[ -n "${PRE_DIRTY:-}" ]]; then
    warn "Source manifests were already modified before this run — leaving the working tree as-is (revert the publish stamp yourself: git status)."
    return
  fi
  git -C "$REPO_ROOT" restore -- version.json ':(glob)packages/*/package.json' ':(glob)apps/*/package.json' 2>/dev/null || true
  ok "Reverted the publish version-stamp in the working tree"
}

banner "SEMIONT LOCAL BUILD"
step "Container runtime: ${BOLD}$RT${RESET}"

# --- Parse arguments ---

SKIP_BUILD=false
PACKAGES=""
START_FROM=""
IMAGES="backend worker smelter weaver frontend"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --package) PACKAGES="$2"; shift 2 ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    --image) IMAGES="${2//,/ }"; shift 2 ;;
    -h|--help)
      echo "Usage: local-build.sh [options]"
      echo ""
      echo "Build and publish @semiont/* packages to a local Verdaccio registry,"
      echo "then build the service container images against it, tagged"
      echo "ghcr.io/the-ai-alliance/semiont-<svc>:local (local-only, never pushed),"
      echo "plus the semiont launcher binary (apps/launcher/dist/semiont)."
      echo "No npm or Go required on the host — everything runs inside containers."
      echo ""
      echo "Built images are also loaded into every other responsive container"
      echo "engine on the machine (container/docker/podman), so any KB --runtime"
      echo "can run them. CONTAINER_RUNTIME chooses which engine BUILDS, not"
      echo "which engines can run the result."
      echo ""
      echo "Options:"
      echo "  --package <list>   Comma-separated packages to build (default: all)"
      echo "  --start-from <pkg> Skip packages before this one in the build order"
      echo "  --skip-build       Skip build, publish only (reuse previous artifacts)"
      echo "  --image <list>     Comma-separated images to build (default:"
      echo "                     backend,worker,smelter,weaver,frontend)"
      echo "  -h, --help         Show this help"
      echo ""
      echo "Build order:"
      echo "  http-transport, ontology, core, content, event-sourcing, graph, inference,"
      echo "  jobs, make-meaning, react-ui, backend, frontend, cli"
      exit 0
      ;;
    *) fail "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Map an image name to its Dockerfile (the same production Dockerfiles that
# publish-frontend.yml / publish-service-images.yml build — the only delta for
# a local image is the registry the packages are installed from).
image_dockerfile() {
  case "$1" in
    backend)  echo "apps/backend/Dockerfile" ;;
    worker)   echo "packages/jobs/Dockerfile" ;;
    smelter)  echo "packages/make-meaning/Dockerfile.smelter" ;;
    weaver)   echo "packages/make-meaning/Dockerfile.weaver" ;;
    frontend) echo "apps/frontend/Dockerfile" ;;
    *) return 1 ;;
  esac
}

for img in $IMAGES; do
  if ! image_dockerfile "$img" >/dev/null; then
    fail "Unknown image: $img (expected backend, worker, smelter, weaver, or frontend)"
    exit 1
  fi
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

# Snapshot manifest dirtiness *before* publish, then arm the revert trap, so the
# EXIT handler can undo only the publish stamp and not any pre-existing edits.
PRE_DIRTY=$(git -C "$REPO_ROOT" status --porcelain -- version.json ':(glob)packages/*/package.json' ':(glob)apps/*/package.json' 2>/dev/null || true)
trap restore_manifests EXIT

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

# --- Build container images ---
#
# Same production Dockerfiles as the publish workflows, installed from the
# local Verdaccio, tagged ghcr.io/the-ai-alliance/semiont-<svc>:local. The
# :local tag is what `semiont start` / compose consume via
# SEMIONT_VERSION=local (it skips the registry pull), and it is never pushed.
#
# --no-cache is required for correctness, not caution: iterating republishes
# the SAME version to Verdaccio, so the `npm install` RUN line is byte-identical
# and a cached layer would silently reuse the stale packages.

banner "CONTAINER IMAGES"

# --- Image fan-out targets (see .plans/LOCAL-BUILD-IMAGE-FANOUT.md) ---
#
# The :local images land in $RT's image store, invisible to every other
# engine — a KB started with a different --runtime then fails with
# "semiont-<svc>:local: not found". Build once under $RT, then load each
# built image into every OTHER responsive runtime. A fan-out failure is a
# warning, not a build failure (the primary store is intact).
#
# File-based transfer only: P0 measured that `container image save` cannot
# stream (`-o -` writes a literal file named "-"; /dev/stdout truncates the
# archive), so pipe-less save→load via a temp file is the portable shape.
# An installed-but-unresponsive engine (e.g. Docker Desktop not running)
# warns once here and is skipped; an absent engine is silently ignored.
FANOUT_RTS=""
for rt in container docker podman; do
  [[ "$rt" == "$RT" ]] && continue
  command -v "$rt" >/dev/null 2>&1 || continue
  if "$rt" image list >/dev/null 2>&1; then
    FANOUT_RTS="$FANOUT_RTS $rt"
  else
    warn "$rt is installed but not responding — :local images will NOT be visible to it (start it and re-load manually: $RT image save <tag> -o /tmp/img.tar && $rt image load -i /tmp/img.tar)"
  fi
done
FANOUT_FAILURES=""
[[ -n "$FANOUT_RTS" ]] && step "Fan-out: images will also be loaded into${BOLD}$FANOUT_RTS${RESET}"

fanout_image() {
  local tag="$1" rt tmp
  for rt in $FANOUT_RTS; do
    tmp=$(mktemp "${TMPDIR:-/tmp}/semiont-fanout.XXXXXX")
    if $RT image save "$tag" -o "$tmp" && "$rt" image load -i "$tmp" >/dev/null 2>&1; then
      ok "$tag → $rt image store"
    else
      warn "Fan-out of $tag to $rt failed (build unaffected; manual: $RT image save $tag -o /tmp/img.tar && $rt image load -i /tmp/img.tar)"
      FANOUT_FAILURES="$FANOUT_FAILURES $rt:$tag"
    fi
    rm -f "$tmp"
  done
}

for img in $IMAGES; do
  DF=$(image_dockerfile "$img")
  TAG="ghcr.io/the-ai-alliance/semiont-${img}:local"
  step "Building ${TAG} from ${DF}..."
  $RT build --no-cache --tag "$TAG" \
    --build-arg NPM_REGISTRY="$BUILD_REGISTRY" \
    --file "$REPO_ROOT/$DF" \
    "$REPO_ROOT"
  ok "$TAG built"
  fanout_image "$TAG"
done

# --- sdk-go drift gate ---
#
# packages/sdk-go/client_gen.go is GENERATED from specs/openapi.json and
# COMMITTED (see packages/sdk-go/README.md). Nothing regenerates it
# automatically, so a spec change can leave it stale. This gate regenerates
# to a scratch path inside the container (never the working tree — builds
# don't mutate source) and diffs: byte-identical or fail. Deterministic
# because the generator version is pinned.

banner "SDK-GO DRIFT GATE"

step "Checking packages/sdk-go/client_gen.go against specs/openapi.json..."
GOCACHE_DIR=/tmp/semiont-gocache
mkdir -p "$GOCACHE_DIR"
if $RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -v "$GOCACHE_DIR":/root/.cache/go-build \
  -w /workspace \
  golang:1.25 \
  sh -c 'go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.6.0 \
           -generate types,client -package semiont \
           -o /tmp/client_gen.check.go specs/openapi.json \
         && diff -q /tmp/client_gen.check.go packages/sdk-go/client_gen.go >/dev/null'; then
  ok "packages/sdk-go matches the spec"
else
  fail "packages/sdk-go/client_gen.go is STALE — the OpenAPI spec changed without regenerating the Go client."
  echo ""
  echo -e "  Regenerate and commit it:"
  echo ""
  echo -e "    ${BOLD}cd packages/sdk-go && go generate ./...${RESET}"
  echo -e "    ${BOLD}git add packages/sdk-go/client_gen.go${RESET}   (then commit)"
  echo ""
  exit 1
fi

# --- Build the launcher (host binary) ---
#
# The semiont launcher is a static Go binary that runs on the HOST and drives
# the :local images (SEMIONT_VERSION=local semiont start). Built inside
# golang:1.25 targeting the host platform — no Go toolchain on the host, the
# same philosophy as the npm builds above. The Go build cache persists under
# /tmp/semiont-gocache (/tmp, not $TMPDIR — Apple Container cannot sustain
# mounts from /var/folders).

banner "LAUNCHER"

case "$(uname -s)" in
  Darwin) LAUNCHER_GOOS=darwin ;;
  Linux)  LAUNCHER_GOOS=linux ;;
  *)      LAUNCHER_GOOS=linux; warn "Unrecognized host OS $(uname -s) — building a linux launcher" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) LAUNCHER_GOARCH=arm64 ;;
  x86_64|amd64)  LAUNCHER_GOARCH=amd64 ;;
  *)             LAUNCHER_GOARCH=amd64; warn "Unrecognized host arch $(uname -m) — building amd64" ;;
esac

GOCACHE_DIR=/tmp/semiont-gocache
mkdir -p "$GOCACHE_DIR"
step "Building the semiont launcher (${LAUNCHER_GOOS}/${LAUNCHER_GOARCH}) in golang:1.25..."
$RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -v "$GOCACHE_DIR":/root/.cache/go-build \
  -w /workspace/apps/launcher \
  -e GOOS="$LAUNCHER_GOOS" -e GOARCH="$LAUNCHER_GOARCH" -e CGO_ENABLED=0 \
  golang:1.25 \
  go build -o dist/semiont .
ok "apps/launcher/dist/semiont built"

banner "DONE ✓"

if [[ -n "$FANOUT_FAILURES" ]]; then
  echo -e "${BOLD}Images tagged :local are in the ${RT} image store${RESET} (fan-out partially failed:${FANOUT_FAILURES// / })"
  echo ""
elif [[ -n "$FANOUT_RTS" ]]; then
  echo -e "${BOLD}Images tagged :local are in every local image store:${RESET} $RT${FANOUT_RTS}"
  echo ""
else
  echo -e "${BOLD}Images tagged :local are in the ${RT} image store${RESET} (no other engines detected)"
  echo ""
fi

echo -e "${BOLD}Run the full stack from your KB against these images:${RESET}"
echo ""
echo -e "    ${BOLD}cd /path/to/your-kb${RESET}"
echo -e "    ${BOLD}SEMIONT_VERSION=local $REPO_ROOT/apps/launcher/dist/semiont start${RESET}"
echo -e "    ${BOLD}$REPO_ROOT/apps/launcher/dist/semiont useradd --email admin@example.com --password password --admin${RESET}"
echo ""
echo -e "  (semiont start skips the registry pull for ${DIM}local${RESET} and runs these images.)"
echo ""

echo -e "${BOLD}Or run a single image, e.g. the frontend:${RESET}"
echo -e "  $RT run --publish 3000:3000 -it ghcr.io/the-ai-alliance/semiont-frontend:local"
echo ""

echo -e "${DIM}Stop Verdaccio when done:${RESET}  $RT stop $VERDACCIO_NAME"
echo ""
echo -e "\033[2m[$(date '+%Y-%m-%d %H:%M:%S')] local-build finished\033[0m"
