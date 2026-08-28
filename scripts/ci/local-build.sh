#!/usr/bin/env bash
set -euo pipefail

# Build all Semiont packages, publish to a local Verdaccio registry, and build
# the service/browser container images against it, tagged
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
#
# Only ever tears down a registry THIS run started. `--images-only` reuses the
# registry a previous run left behind; destroying it because an image build
# failed would take the published packages with it and force a full rebuild
# just to retry the image.
VERDACCIO_OURS=false
verdaccio_cleanup() {
  [[ "$VERDACCIO_OURS" == true ]] || return 0
  if [[ -n "${VERDACCIO_NAME:-}" ]]; then
    $RT stop "$VERDACCIO_NAME" >/dev/null 2>&1 || true
    $RT rm   "$VERDACCIO_NAME" >/dev/null 2>&1 || true
  fi
}
trap verdaccio_cleanup ERR INT TERM

# Everything the publish stamp reaches: the manifests `publish.sh` rewrites, and
# the lockfile an install regenerates *from* those rewritten manifests.
#
# One list, used by the pre-run snapshot, the dirtiness check and the restore.
# It was previously spelled out at all three sites and the lockfile was missing
# from every one of them, so a local build reverted each package.json and left
# package-lock.json holding the stamped versions — silently turning
# `"@semiont/core": "*"` into a concrete pin in the working tree.
STAMPED_PATHS=(
  version.json
  ':(glob)packages/*/package.json'
  ':(glob)apps/*/package.json'
  package-lock.json
)

# On exit (success or failure), revert the version-stamp that publish.sh writes
# into the bind-mounted sources — a local publish should not leave the working
# tree dirty. Guarded: if those files were already modified before the run,
# leave them alone so we never clobber in-progress edits.
restore_manifests() {
  local now_dirty
  now_dirty=$(git -C "$REPO_ROOT" status --porcelain -- "${STAMPED_PATHS[@]}" 2>/dev/null || true)
  [[ -z "$now_dirty" ]] && return
  if [[ -n "${PRE_DIRTY:-}" ]]; then
    warn "Source manifests or the lockfile were already modified before this run — leaving the working tree as-is (revert the publish stamp yourself: git status)."
    return
  fi
  git -C "$REPO_ROOT" restore -- "${STAMPED_PATHS[@]}" 2>/dev/null || true
  ok "Reverted the publish version-stamp in the working tree"
}

banner "SEMIONT LOCAL BUILD"
step "Container runtime: ${BOLD}$RT${RESET}"

# --- Parse arguments ---

SKIP_BUILD=false
IMAGES_ONLY=false
IMAGES_FORCED=false
PACKAGES=""
START_FROM=""
IMAGES="backend worker smelter weaver archivist browser"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --images-only) IMAGES_ONLY=true; shift ;;
    --package) PACKAGES="$2"; shift 2 ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    --image) IMAGES="${2//,/ }"; IMAGES_FORCED=true; shift 2 ;;
    --force-images) IMAGES_FORCED=true; shift ;;
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
      echo "                     backend,worker,smelter,weaver,archivist,browser)."
      echo "                     Named images always build, even when unchanged"
      echo "  --force-images     Build every image even when its Dockerfile and"
      echo "                     package integrities are unchanged (images whose"
      echo "                     inputs the skip check cannot see — a moved base"
      echo "                     tag, bumped third-party deps — need this)"
      echo "  --images-only      Build ONLY container images, against the Verdaccio a"
      echo "                     previous run left running. Skips the npm build+publish,"
      echo "                     the drift gates and the launcher. Pair with --image to"
      echo "                     rebuild one service in ~a minute instead of the lot."
      echo "  -h, --help         Show this help"
      echo ""
      echo "Rebuilding one image after a code change:"
      echo "  ./scripts/ci/local-build.sh                          # full run, leaves Verdaccio up"
      echo "  ./scripts/ci/local-build.sh --images-only --image worker"
      echo ""
      echo "  --images-only reuses the packages already in Verdaccio, so it picks up a"
      echo "  code change ONLY if that package was republished. Change package source"
      echo "  and you want a full run (or --package <pkg>) first."
      echo ""
      echo "Build order:"
      echo "  http-transport, ontology, core, content, event-sourcing, graph, inference,"
      echo "  jobs, make-meaning, react-ui, backend, browser"
      exit 0
      ;;
    *) fail "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Map an image name to its Dockerfile (the same production Dockerfiles that
# publish-browser.yml / publish-service-images.yml build — the only delta for
# a local image is the registry the packages are installed from).
image_dockerfile() {
  case "$1" in
    backend)  echo "apps/backend/Dockerfile" ;;
    worker)   echo "packages/jobs/Dockerfile" ;;
    smelter)  echo "packages/make-meaning/Dockerfile.smelter" ;;
    weaver)   echo "packages/make-meaning/Dockerfile.weaver" ;;
    archivist) echo "packages/make-meaning/Dockerfile.archivist" ;;
    browser) echo "apps/browser/Dockerfile" ;;
    *) return 1 ;;
  esac
}

for img in $IMAGES; do
  if ! image_dockerfile "$img" >/dev/null; then
    fail "Unknown image: $img (expected backend, worker, smelter, weaver, archivist, or browser)"
    exit 1
  fi
done

# --- Start fresh Verdaccio ---

banner "LOCAL REGISTRY"

if [[ "$IMAGES_ONLY" == true ]]; then
  # Reuse the registry a previous run left up. VERDACCIO_OURS stays false, so
  # the cleanup trap will not tear down a registry we did not create.
  step "Reusing the running Verdaccio (--images-only)..."
  if ! curl -sf "$REGISTRY/-/ping" > /dev/null 2>&1; then
    fail "No Verdaccio at $REGISTRY — --images-only builds against the registry a previous run left running."
    echo ""
    echo -e "  Run a full build first:  ${BOLD}./scripts/ci/local-build.sh${RESET}"
    echo ""
    exit 1
  fi
  REUSED_COUNT=$(curl -sf "$REGISTRY/-/verdaccio/data/packages" 2>/dev/null | jq 'length' 2>/dev/null || echo 0)
  if [[ "${REUSED_COUNT:-0}" -eq 0 ]]; then
    fail "Verdaccio at $REGISTRY is up but holds no packages — an image build would have nothing to install."
    echo ""
    echo -e "  Run a full build first:  ${BOLD}./scripts/ci/local-build.sh${RESET}"
    echo ""
    exit 1
  fi
  ok "Verdaccio reachable with $REUSED_COUNT packages (reused, not rebuilt)"
else
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
  VERDACCIO_OURS=true

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
fi

# --- Resolve host address ---

HOST_ADDR=$($RT run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'")
step "Host address from container: ${DIM}$HOST_ADDR${RESET}"

if [[ "$IMAGES_ONLY" != true ]]; then
  # --- Clean staging directory ---

  chmod -R u+rwX .npm-stage 2>/dev/null || true
  rm -rf .npm-stage

  # --- Build + Publish in container ---

  banner "BUILD + PUBLISH"

  # Snapshot dirtiness *before* publish, then arm the revert trap, so the EXIT
  # handler can undo only the publish stamp and not any pre-existing edits. Same
  # path set the restore uses — a file the snapshot ignores is a file the restore
  # would clobber.
  PRE_DIRTY=$(git -C "$REPO_ROOT" status --porcelain -- "${STAMPED_PATHS[@]}" 2>/dev/null || true)
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
      # The body and the NPMRC terminator MUST stay at column 0 — this is
      # `<<NPMRC`, not `<<-NPMRC`, so an indented terminator never closes the
      # heredoc and every command below it silently becomes .npmrc content.
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
fi


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

# --- Skip unchanged images ---
# An image is a function of its Dockerfile and the @semiont/* packages it
# installs. "Unchanged" is decided by package INTEGRITY against the
# freshly-published Verdaccio — versions and mtimes are useless because every
# run republishes (check-semiont-drift.mjs reasons the same way) — plus the
# Dockerfile hash. Third-party deps and the base tag are treated as stable;
# when upstream moves them, --image <name> forces the rebuild (explicit wins,
# and it also refreshes the recorded signature). The @semiont/* set is
# DERIVED from the Dockerfile text, not restated here.
IMAGE_STATE="${XDG_CACHE_HOME:-$HOME/.cache}/semiont/local-build-images.json"
mkdir -p "$(dirname "$IMAGE_STATE")"

# One line capturing everything a rebuild depends on; EMPTY when any
# integrity lookup fails, and an empty signature never skips and never
# records — lookup trouble degrades to building, not to false skips.
image_signature() {
  local df pkg integ sig
  df="$REPO_ROOT/$(image_dockerfile "$1")"
  sig="dockerfile:$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$df")"
  # Install lines only — comments mention packages that are not installed.
  for pkg in $(grep 'npm install' "$df" | grep -ohE '@semiont/[a-z-]+' | sort -u); do
    integ=$(curl -sf --max-time 10 "$REGISTRY/$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1],safe=""))' "$pkg")"       | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["versions"][d["dist-tags"]["latest"]]["dist"]["integrity"])' 2>/dev/null) || integ=""
    [[ -z "$integ" ]] && { echo ""; return; }
    sig="$sig $pkg:$integ"
  done
  echo "$sig"
}

state_get() { python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2],""))
except Exception: print("")' "$IMAGE_STATE" "$1"; }

state_put() { python3 -c 'import json,sys
p=sys.argv[1]
try: d=json.load(open(p))
except Exception: d={}
d[sys.argv[2]]=sys.argv[3]
json.dump(d,open(p,"w"),indent=1)' "$IMAGE_STATE" "$1" "$2"; }

BUILD_IMGS=()
BUILD_SIGS=()
SKIPPED=""
for img in $IMAGES; do
  TAG="ghcr.io/the-ai-alliance/semiont-${img}:local"
  SIG=$(image_signature "$img")
  if [[ "$IMAGES_FORCED" != true && -n "$SIG" && "$(state_get "$img")" == "$SIG" ]] \
     && $RT image inspect "$TAG" >/dev/null 2>&1; then
    ok "$TAG unchanged (Dockerfile + package integrities) — skipped"
    SKIPPED="$SKIPPED $img"
  else
    BUILD_IMGS+=("$img")
    BUILD_SIGS+=("$SIG")
  fi
done
if [[ ${#BUILD_IMGS[@]} -eq 0 ]]; then
  ok "All images unchanged — nothing to build"
fi

# Three builds at a time: ~30s of EVERY build is fixed buildkit-shim latency
# (10s "transferring" round-trips for byte-sized payloads), which overlapping
# absorbs. Three, not six: the builder VM has 2G, and the default image order
# splits the two npm-heavy builds (backend, browser) across batches. Build
# output goes to a per-image log; a failure tails it and stops the run.
# Fan-out happens after all builds, keeping the builder VM to itself.
i=0
while [ $i -lt ${#BUILD_IMGS[@]} ]; do
  PIDS=(); TAGS=(); LOGS=(); IMGS=()
  for j in 0 1 2; do
    idx=$((i + j))
    [ $idx -ge ${#BUILD_IMGS[@]} ] && break
    img=${BUILD_IMGS[$idx]}
    DF=$(image_dockerfile "$img")
    TAG="ghcr.io/the-ai-alliance/semiont-${img}:local"
    LOG=$(mktemp "${TMPDIR:-/tmp}/semiont-build-${img}.XXXXXX")
    step "Building ${TAG} from ${DF}... ${DIM}(log: $LOG)${RESET}"
    $RT build --no-cache --tag "$TAG" \
      --build-arg NPM_REGISTRY="$BUILD_REGISTRY" \
      --file "$REPO_ROOT/$DF" \
      "$REPO_ROOT" > "$LOG" 2>&1 &
    PIDS+=($!)
    TAGS+=("$TAG")
    LOGS+=("$LOG")
    IMGS+=("$idx")
  done
  for j in "${!PIDS[@]}"; do
    st=0
    wait "${PIDS[$j]}" || st=$?
    if [ "$st" -ne 0 ]; then
      fail "${TAGS[$j]} build failed (exit $st) — last 40 lines of ${LOGS[$j]}:"
      tail -40 "${LOGS[$j]}"
      exit 1
    fi
    ok "${TAGS[$j]} built"
    rm -f "${LOGS[$j]}"
    idx=${IMGS[$j]}
    if [[ -n "${BUILD_SIGS[$idx]}" ]]; then
      state_put "${BUILD_IMGS[$idx]}" "${BUILD_SIGS[$idx]}"
    fi
  done
  i=$((i + 3))
done

# Fan-out covers skipped images too: it heals the case where another runtime
# was down when the image was last built.
for img in $IMAGES; do
  fanout_image "ghcr.io/the-ai-alliance/semiont-${img}:local"
done

if [[ "$IMAGES_ONLY" == true ]]; then
  # Deliberately stops here. The drift gates and the launcher are unrelated to
  # image contents, and paying for them would undo the point of the flag — a
  # one-image rebuild should cost about a minute.
  banner "IMAGES DONE ✓"
  echo -e "${BOLD}Rebuilt:${RESET}${IMAGES// / }"
  echo ""
  echo -e "  Restart the affected service(s) to pick them up, e.g."
  echo -e "    ${BOLD}SEMIONT_VERSION=local <your-kb>/semiont restart${RESET}"
  echo ""
  echo -e "${DIM}Skipped (use a full run for these): npm build+publish, bus/sdk-go drift gates, launcher.${RESET}"
  echo ""
  echo -e "\033[2m[$(date '+%Y-%m-%d %H:%M:%S')] local-build finished (--images-only)\033[0m"
  exit 0
fi


# --- bus registry drift gate ---
#
# specs/src/bus/registry.json is the AUTHORITY for the event bus: channels,
# payload shapes, and the request/reply operations. BOTH languages are
# generated from it — packages/core/src/bus-protocol.ts + bus-operations.ts
# (TypeScript) and packages/sdk-go/bus/*_gen.go — so an edit to one language's
# generated file, or a registry change without regeneration, is drift that
# would let the two sides disagree at runtime. Each generator's --check diffs
# without writing.

banner "BUS REGISTRY DRIFT GATE"

step "Checking generated bus files against specs/src/bus/registry.json..."
if $RT run --rm -v "$REPO_ROOT":/workspace -w /workspace node:24-alpine \
  sh -c 'node scripts/bus/generate-ts.mjs --check && node scripts/bus/generate-go.mjs --check'; then
  ok "bus registry and both generated languages agree"
else
  fail "Generated bus files are STALE (or were hand-edited) — they must match specs/src/bus/registry.json."
  echo ""
  echo -e "  Regenerate both languages and commit:"
  echo ""
  echo -e "    ${BOLD}node scripts/bus/generate-ts.mjs${RESET}   (packages/core/src/bus-protocol.ts, bus-operations.ts)"
  echo -e "    ${BOLD}node scripts/bus/generate-go.mjs${RESET}   (packages/sdk-go/bus/*_gen.go)"
  echo ""
  echo -e "  Channels and operations are edited in ${BOLD}specs/src/bus/registry.json${RESET}, never in the generated files."
  echo ""
  exit 1
fi

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
# The MODULE cache is persisted too, not just the build cache. Without it every
# run re-downloads the whole oapi-codegen tree (~100 MB, 21 modules), which is
# why a DNS blip could take this gate down. (/tmp, not $TMPDIR: Apple Container
# cannot sustain mounts from /var/folders. Go writes the module cache
# read-only, so `chmod -R u+w` before removing it by hand.)
GOMODCACHE_DIR=/tmp/semiont-gomodcache
mkdir -p "$GOCACHE_DIR" "$GOMODCACHE_DIR"
# Caching alone is not enough: `go run <pkg>@<version>` resolves the version
# against the proxy on EVERY run — including a deprecation lookup — so a
# populated cache still needed the network. Pointing GOPROXY at the cache's own
# download dir (a valid module proxy) serves the pinned generator locally and
# falls through to the network only on a miss. Measured both ways: warm cache
# succeeds with the network proxies removed entirely; a cold cache still
# populates through the fallback.
GOPROXY_CACHED='file:///go/pkg/mod/cache/download,https://proxy.golang.org,direct'

# Generation and comparison report SEPARATELY. Collapsing them into one `&&`
# made every generator failure — a DNS blip fetching oapi-codegen, an
# unreadable spec, a container that never started — print "the OpenAPI spec
# changed without regenerating the Go client": a specific cause the gate had
# not established, and one that sends the reader to regenerate a file that was
# never stale. Ignorance is not a finding.
DRIFT_RC=0
# Output is tee'd, not just streamed: the exit-3 handler below reads it to tell a
# CORRUPT MODULE CACHE from a network failure, and the two have opposite remedies.
# `set -o pipefail` (line 2) is what makes `$?` the container's code rather than
# tee's — without it this silently reports success on every failure.
DRIFT_LOG=$(mktemp "${TMPDIR:-/tmp}/semiont-drift.XXXXXX")
$RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -v "$GOCACHE_DIR":/root/.cache/go-build \
  -v "$GOMODCACHE_DIR":/go/pkg/mod \
  -e GOPROXY="$GOPROXY_CACHED" \
  -w /workspace \
  golang:1.25 \
  sh -c 'go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.6.0 \
           -generate types,client,skip-prune -package semiont \
           -o /tmp/client_gen.check.go specs/openapi.json || exit 3
         diff -q /tmp/client_gen.check.go packages/sdk-go/client_gen.go >/dev/null || exit 4' \
  2>&1 | tee "$DRIFT_LOG" \
  || DRIFT_RC=$?

case "$DRIFT_RC" in
  0)
    ok "packages/sdk-go matches the spec"
    rm -f "$DRIFT_LOG"
    ;;
  4)
    fail "packages/sdk-go/client_gen.go is STALE — the OpenAPI spec changed without regenerating the Go client."
    echo ""
    echo -e "  Regenerate and commit it:"
    echo ""
    echo -e "    ${BOLD}cd packages/sdk-go && go generate ./...${RESET}"
    echo -e "    ${BOLD}git add packages/sdk-go/client_gen.go${RESET}   (then commit)"
    echo ""
    exit 1
    ;;
  *)
    fail "The sdk-go drift gate could not RUN (the generator exited $DRIFT_RC; its output is above)."
    echo ""
    echo -e "  This says nothing about whether the Go client is stale — the check never got"
    echo -e "  far enough to compare."
    echo ""
    # Two causes, opposite remedies. Telling someone to wait for the network when
    # the module cache is corrupt makes them wait for a network that is already
    # working, and the next run fails identically.
    #
    # The cache holds `cache/download` (module ZIPs — a valid proxy, and what
    # GOPROXY_CACHED points at) beside the EXTRACTED trees. A run killed
    # mid-extraction leaves a partial tree that no amount of network fixes; Go
    # re-extracts from the downloads offline once the bad tree is gone.
    # `cannot embed` / `no embeddable files` is the shape a TRUNCATED extraction
    # produces, and it was missing here until it cost a diagnosis (2026-08-24).
    # Go has two embed failures and they read nothing alike: a pattern matching
    # nothing says "no matching files found", while a directory that survived
    # with its subdirectories but none of its files says "cannot embed directory
    # X: contains no embeddable files". The second is precisely the corrupt-cache
    # signature — the tree is THERE, so Go trusts it and never re-extracts, and
    # every retry fails identically. Matching only the first sent the reader to
    # the network branch below to wait out a network that was already working.
    if grep -qiE 'no such file or directory|no matching files found|cannot embed|no embeddable files|pattern .*: .*matching|cannot find package' "$DRIFT_LOG"; then
      echo -e "  ${BOLD}Cause: a corrupt Go module cache, not the network.${RESET} A previous run was"
      echo -e "  interrupted mid-extraction and left a partial module tree."
      echo ""
      echo -e "  Purge the EXTRACTED trees and keep the downloads (no re-fetch, works offline):"
      echo ""
      echo -e "    ${BOLD}chmod -R u+w $GOMODCACHE_DIR${RESET}"
      echo -e "    ${BOLD}find $GOMODCACHE_DIR -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} +${RESET}"
      echo ""
      # Everything else in this repo runs in a container, so the reflex is to run
      # this there too. It fails: rm returns "Permission denied" on the virtiofs
      # mount even as root, and the tree survives looking untouched.
      echo -e "  ${DIM}Run those on the HOST, not in a container — rm fails with Permission${RESET}"
      echo -e "  ${DIM}denied through the mount, even as root, and leaves the cache corrupt.${RESET}"
      echo ""
      echo -e "  ${DIM}Do NOT use \`go clean -modcache\` — it deletes cache/download too, costing a${RESET}"
      echo -e "  ${DIM}~100 MB re-fetch of the 21-module oapi-codegen tree and reintroducing the${RESET}"
      echo -e "  ${DIM}network dependency GOPROXY_CACHED exists to remove.${RESET}"
      echo ""
      # GOPROXY_CACHED is itself a file:// proxy, so a COLD cache with the network
      # also down produces this same wording. The purge is safe either way (Go
      # re-extracts from the downloads), but it will not help that case.
      echo -e "  ${DIM}If the purge changes nothing, the cache was cold rather than corrupt —${RESET}"
      echo -e "  ${DIM}the file:// proxy reports the same error for a missing module. Treat it${RESET}"
      echo -e "  ${DIM}as the network case below.${RESET}"
    else
      echo -e "  A failed module fetch (${BOLD}proxy.golang.org${RESET}) is the usual cause; retry once the"
      echo -e "  network is back, and the pinned generator will be cached in"
      echo -e "  ${BOLD}${GOMODCACHE_DIR}${RESET} for subsequent offline runs."
    fi
    echo ""
    echo -e "  ${DIM}Generator output kept at: $DRIFT_LOG${RESET}"
    echo ""
    exit 1
    ;;
esac

step "Checking the generated Go client covers every schema..."
if ! $RT run --rm -v "$REPO_ROOT":/workspace -w /workspace node:24-alpine \
  node scripts/ci/check-go-schema-coverage.mjs; then
  fail "The generated Go client is missing schemas (see above)."
  echo ""
  echo -e "    ${BOLD}cd packages/sdk-go && go generate ./...${RESET}"
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

mkdir -p "$GOCACHE_DIR" "$GOMODCACHE_DIR"
step "Building the semiont launcher (${LAUNCHER_GOOS}/${LAUNCHER_GOARCH}) in golang:1.25..."
$RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -v "$GOCACHE_DIR":/root/.cache/go-build \
  -v "$GOMODCACHE_DIR":/go/pkg/mod \
  -w /workspace/apps/launcher \
  -e GOPROXY="$GOPROXY_CACHED" \
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
echo -e "    ${BOLD}echo password | $REPO_ROOT/apps/launcher/dist/semiont useradd --email admin@example.com --admin${RESET}"
echo ""
echo -e "  (semiont start skips the registry pull for ${DIM}local${RESET} and runs these images.)"
echo ""

echo -e "${BOLD}Or run a single image, e.g. the browser:${RESET}"
echo -e "  $RT run --publish 3000:3000 -it ghcr.io/the-ai-alliance/semiont-browser:local"
echo ""

echo -e "${DIM}Stop Verdaccio when done:${RESET}  $RT stop $VERDACCIO_NAME"
echo ""
echo -e "\033[2m[$(date '+%Y-%m-%d %H:%M:%S')] local-build finished\033[0m"
