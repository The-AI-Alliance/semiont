#!/usr/bin/env bash
set -euo pipefail

# Build Semiont's packages and images, as one run treats both.
#
# The packages are the directories packages/<language>/<name>, and each is built
# in its language's container: the npm packages with scripts/ci/build.sh, the
# Rust crates with cargo, the Python packages' distributions with uv (the SDK's
# with the script a release runs), and the Go modules with go build. The images
# are images/<name>/Dockerfile, built and tagged
# ghcr.io/the-ai-alliance/semiont-<name>:local (run by `semiont start` where a
# KB's stack documents name them; never pushed). Either kind is skipped when
# nothing it is built from has changed since it was last built here, and
# --package and --image name what to build. It also builds the semiont launcher
# (apps/launcher/dist/semiont, a host binary), so one run yields everything a
# fully-local stack needs. No npm, Go, Rust or Python is needed on the host.
#
# An image that installs @semiont/* packages from a registry (the Browser's)
# installs them from a fresh Verdaccio this run starts and publishes the npm
# packages to; no other image needs one, and a run that builds none starts none.

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

# --- Go toolchain (derived, not restated) ---
#
# The Go version is a fact apps/launcher/go.mod owns. Every workflow derives
# it (actions/setup-go's go-version-file), and so does this script: go.mod pins
# the PATCH so the scan and the build agree on one compiler, and a local build
# silently using a different one defeats exactly that.
#
# No fallback. A missing toolchain line fails here rather than quietly selecting
# some other compiler.
if ! GO_TOOLCHAIN="$("$REPO_ROOT/scripts/ci/go-toolchain.sh")"; then
  fail "No 'toolchain goX.Y.Z' line in apps/launcher/go.mod — cannot choose a Go image."
  exit 1
fi
GO_IMAGE="golang:${GO_TOOLCHAIN}"

# --- Rust toolchain (derived, not restated) ---
#
# The gateway image compiles its binary with the toolchain
# rust-toolchain.toml pins, passed to its Dockerfile as
# RUST_TOOLCHAIN. No fallback, as for Go.
if ! RUST_TOOLCHAIN="$("$REPO_ROOT/scripts/ci/rust-toolchain.sh")"; then
  fail "No channel in packages/rust/rust-toolchain.toml — cannot choose a Rust image."
  exit 1
fi

# --- Python toolchain (derived, not restated) ---
#
# The oldest Python the SDK supports is a fact packages/python/sdk/pyproject.toml
# owns (requires-python), and the SDK's generator runs on that one, here as in
# CI. No fallback, as for Go.
if ! PYTHON_FLOOR="$("$REPO_ROOT/scripts/ci/python-floor.sh")"; then
  fail "No 'requires-python = \">=X.Y\"' line in packages/python/sdk/pyproject.toml — cannot choose a Python image."
  exit 1
fi
PYTHON_IMAGE="python:${PYTHON_FLOOR}-alpine"

# --- Node toolchain (derived, not restated) ---
#
# The Node that builds and tests the repository is a fact .node-version owns.
# Every workflow derives it (actions/setup-node's node-version-file), and so
# does this script, for the image the packages are built and published in.
# No fallback, as for Go.
if ! NODE_VERSION="$("$REPO_ROOT/scripts/ci/node-version.sh")"; then
  fail "No version in .node-version — cannot choose a Node image."
  exit 1
fi
NODE_IMAGE="node:${NODE_VERSION}-alpine"

# --- What is kept between runs ---
#
# In the user's cache directory: macOS deletes files in /tmp that go unread
# for three days, and Apple Container cannot sustain mounts from $TMPDIR.
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/semiont"
NPM_CACHE_DIR="$CACHE_ROOT/local-build-npm"
GOCACHE_DIR="$CACHE_ROOT/local-build-gocache"
GOMODCACHE_DIR="$CACHE_ROOT/local-build-gomodcache"
UVCACHE_DIR="$CACHE_ROOT/local-build-uv"
CARGO_REGISTRY_DIR="$CACHE_ROOT/local-build-cargo"
# What each package and image was last built from, keyed by its directory.
STATE="$CACHE_ROOT/local-build-state.json"
state_get() { python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2],""))
except Exception: print("")' "$STATE" "$1"; }
state_put() { python3 -c 'import json,sys
p=sys.argv[1]
try: d=json.load(open(p))
except Exception: d={}
d[sys.argv[2]]=sys.argv[3]
json.dump(d,open(p,"w"),indent=1,sort_keys=True)' "$STATE" "$1" "$2"; }
mkdir -p "$NPM_CACHE_DIR" "$GOCACHE_DIR" "$GOMODCACHE_DIR" "$UVCACHE_DIR" "$CARGO_REGISTRY_DIR"

# --- What a step says ---
#
# A step says one line: what it did, and how long it took. What the tools it
# runs print goes to a log of its own, which a failure shows the end of and a
# success deletes, as each image's build does. TMPDIR ends in a slash on
# macOS; joining with another one yields `T//path`.
TMP_DIR="${TMPDIR:-/tmp}"; TMP_DIR="${TMP_DIR%/}"

# run_logged <what> <command>...: runs the command into its log, and says
# `what` when it succeeds. When it fails, it shows the last 40 lines of the log
# and where the whole of it is, and returns the command's status for the caller
# to say what went wrong.
run_logged() {
  local what="$1" log rc=0 started
  shift
  log=$(mktemp "$TMP_DIR/semiont-local-build.XXXXXX")
  started=$(date +%s)
  "$@" > "$log" 2>&1 || rc=$?
  if [[ "$rc" == 0 ]]; then
    ok "$what ${DIM}($(( $(date +%s) - started ))s)${RESET}"
    rm -f "$log"
  else
    echo -e "${DIM}  exit $rc; the last 40 lines of $log:${RESET}"
    tail -40 "$log" | sed 's/^/    /'
  fi
  return "$rc"
}

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
# The lockfile belongs in it: a restore without it reverts each package.json
# and leaves package-lock.json holding the stamped versions — silently turning
# `"@semiont/core": "*"` into a concrete pin in the working tree.
STAMPED_PATHS=(
  version.json
  ':(glob)packages/typescript/*/package.json'
  ':(glob)apps/*/package.json'
  ':(glob)images/*/package.json'
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

IMAGES_ONLY=false
PACKAGES_ONLY=false
FORCE=false
FANOUT=true
LAYER_CACHE=""
PACKAGES_NAMED=""
# The images are images/*/Dockerfile. They build in the order the shared Rust
# builder stage wants: one Rust image first, compiling the workspace while the
# others build beside it, and the other Rust images last, so they reuse its
# stage instead of compiling from cold.
FIRST_RUST="" LATER_RUST="" OTHER_IMAGES=""
for df in "$REPO_ROOT"/images/*/Dockerfile; do
  img=$(basename "$(dirname "$df")")
  if ! grep -q '^FROM rust:' "$df"; then OTHER_IMAGES+=" $img"
  elif [[ -z "$FIRST_RUST" ]]; then FIRST_RUST="$img"
  else LATER_RUST+=" $img"
  fi
done
ALL_IMAGES="$FIRST_RUST$OTHER_IMAGES$LATER_RUST"
IMAGES="$ALL_IMAGES"
IMAGES_NAMED=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --package) PACKAGES_NAMED="${2//,/ }"; shift 2 ;;
    --image) IMAGES="${2//,/ }"; IMAGES_NAMED=true; shift 2 ;;
    --force) FORCE=true; shift ;;
    --packages-only) PACKAGES_ONLY=true; shift ;;
    --images-only) IMAGES_ONLY=true; shift ;;
    --no-fanout) FANOUT=false; shift ;;
    --layer-cache) LAYER_CACHE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: local-build.sh [options]"
      echo ""
      echo "Build Semiont's packages, each in its language's container, and its"
      echo "container images, tagged ghcr.io/the-ai-alliance/semiont-<name>:local"
      echo "(local-only, never pushed), plus the semiont launcher binary"
      echo "(apps/launcher/dist/semiont). No npm, Go, Rust or Python is needed on"
      echo "the host: everything runs inside containers."
      echo ""
      echo "A package or an image is skipped when nothing it is built from has changed"
      echo "since it was last built here. The packages are packages/<language>/<name>"
      echo "(an unknown --package is refused with the list); the images are images/<name>:"
      echo "  ${ALL_IMAGES// /, }"
      echo ""
      echo "Built images are also loaded into every other responsive container"
      echo "engine on the machine (container/docker/podman), so any KB --runtime"
      echo "can run them. CONTAINER_RUNTIME chooses which engine BUILDS, not"
      echo "which engines can run the result."
      echo ""
      echo "Options:"
      echo "  --package <list>    Comma-separated packages to build, each <language>/<name>,"
      echo "                      or a language for all of its packages. Named packages"
      echo "                      always build (default: every package, unless unchanged)"
      echo "  --image <list>      Comma-separated images to build. Named images always"
      echo "                      build (default: every image, unless unchanged)"
      echo "  --force             Build every package and image selected, changed or not"
      echo "                      (an image's inputs the check cannot see, such as a moved"
      echo "                      base tag or bumped third-party deps, need this)"
      echo "  --packages-only     Build packages only: no images, and no registry"
      echo "  --images-only       Build images only, against the Verdaccio a previous run"
      echo "                      left running when one installs from it. Skips the"
      echo "                      packages, the drift and lockfile gates and the launcher:"
      echo "                      pair with --image to rebuild one in about a minute"
      echo "  --no-fanout         Leave the images in the building engine's store only"
      echo "                      (a machine that runs them with that engine alone,"
      echo "                      such as a CI runner, has no use for the copies)"
      echo "  --layer-cache <dir> docker only: build the Rust images on a docker-container"
      echo "                      builder that reads their layers from <dir> and writes"
      echo "                      them back, so a run whose Rust is unchanged compiles"
      echo "                      nothing. For a runner that keeps <dir> between runs; a"
      echo "                      laptop's engine keeps its own layers and has no use for it"
      echo "  -h, --help          Show this help"
      echo ""
      echo "Examples:"
      echo "  ./scripts/ci/local-build.sh                                 # what changed, then the images"
      echo "  ./scripts/ci/local-build.sh --packages-only --package rust  # the Rust crates, nothing else"
      echo "  ./scripts/ci/local-build.sh --package typescript/react-ui --image browser"
      echo "  ./scripts/ci/local-build.sh --images-only --image worker    # one image, from the working tree"
      echo ""
      echo "  --images-only reuses the packages already in Verdaccio, so the Browser's"
      echo "  image picks up a package's change only if a run published it. The other"
      echo "  images are built from the working tree every time."
      exit 0
      ;;
    *) fail "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Map an image name to its Dockerfile (the same production Dockerfiles that
# publish-browser.yml / publish-service-images.yml build — the only delta for
# a local image is the registry the packages are installed from). Fails for a
# name that is not an image.
image_dockerfile() {
  [[ -f "$REPO_ROOT/images/$1/Dockerfile" ]] && echo "images/$1/Dockerfile"
}

for img in $IMAGES; do
  if ! image_dockerfile "$img" >/dev/null; then
    fail "Unknown image: $img (expected one of: ${ALL_IMAGES// /, })"
    exit 1
  fi
done

if [[ "$IMAGES_ONLY" == true && "$PACKAGES_ONLY" == true ]]; then
  fail "--images-only and --packages-only together build nothing"
  exit 1
fi
[[ "$PACKAGES_ONLY" == true ]] && IMAGES=""

# The images that install @semiont/* packages from a registry, read from their
# install lines as image_signature reads them. Only these need this run's
# Verdaccio, and the npm packages published to it.
REGISTRY_IMAGES=""
for img in $IMAGES; do
  if grep 'npm install' "$REPO_ROOT/$(image_dockerfile "$img")" | grep -q '@semiont/'; then
    REGISTRY_IMAGES="$REGISTRY_IMAGES $img"
  fi
done

# What one line of the summary at the end says of each package and image.
SUMMARY=()
summarize() { SUMMARY+=("$(printf '%-36s %s' "$1" "$2")"); }
print_summary() {
  local line
  echo -e "${BOLD}What this run built, and what it found unchanged since it last built it:${RESET}"
  for line in ${SUMMARY[@]+"${SUMMARY[@]}"}; do echo "  $line"; done
  echo ""
}

# --- The packages, and which of them build ---
#
# scripts/ci/package-signatures.py finds them, packages/<language>/<name>, and
# signs each with everything its build reads, its dependencies' signatures
# among it. It runs on the Python floor, which reads TOML; the files it signs
# are git's list from the host, since git refuses a checkout another user owns,
# as a root container sees one. A package builds when it is named, when --force
# is given, when its signature is not the one recorded when it last built, or
# when the output its build leaves is gone.
BUILD_PACKAGES=""
if [[ "$IMAGES_ONLY" != true ]]; then
  if ! PACKAGE_PLAN=$(git -C "$REPO_ROOT" ls-files -z --cached --others --exclude-standard \
      | $RT run --rm -i -v "$REPO_ROOT":/workspace -w /workspace "$PYTHON_IMAGE" \
          python3 scripts/ci/package-signatures.py "$NODE_IMAGE" "rust:$RUST_TOOLCHAIN" "$PYTHON_IMAGE" "$GO_IMAGE"); then
    fail "Could not read what the packages are built from (scripts/ci/package-signatures.py, above)."
    exit 1
  fi
  ALL_PACKAGES=$(echo "$PACKAGE_PLAN" | cut -f1 | sed 's#^packages/##' | tr '\n' ' ')
  LANGUAGES=$(echo "$PACKAGE_PLAN" | cut -f2 | sort -u | tr '\n' ' ')
  # A named package is <language>/<name>, or a language for all of its own.
  SELECTED=""
  for named in $PACKAGES_NAMED; do
    matched=$(echo "$PACKAGE_PLAN" | awk -F'\t' -v n="packages/$named" '$1 == n || index($1, n "/") == 1 { print $1 }')
    if [[ -z "$matched" ]]; then
      fail "Unknown package: $named (expected one of: ${ALL_PACKAGES% }, or a language: ${LANGUAGES% })"
      exit 1
    fi
    SELECTED="$SELECTED $matched"
  done
  while IFS=$'\t' read -r dir language name signature output; do
    if [[ -n "$PACKAGES_NAMED" ]] && ! [[ " $(echo $SELECTED) " == *" $dir "* ]]; then
      continue
    fi
    if [[ "$FORCE" == true || -n "$PACKAGES_NAMED" || "$(state_get "$dir")" != "$signature" ]] \
       || [[ -n "$output" && ! -e "$REPO_ROOT/$output" ]]; then
      BUILD_PACKAGES="$BUILD_PACKAGES $dir"
    else
      summarize "$dir" "unchanged"
    fi
  done <<< "$PACKAGE_PLAN"
fi

# plan_field <dir> <n>: the nth field of the package's line in the plan
# (2 its language, 3 the name its build takes, 4 its signature).
plan_field() { echo "$PACKAGE_PLAN" | awk -F'\t' -v d="$1" -v n="$2" '$1 == d { print $n }'; }
# packages_of <language>: the packages of that language this run builds.
packages_of() {
  local dir
  for dir in $BUILD_PACKAGES; do
    [[ "$(plan_field "$dir" 2)" == "$1" ]] && echo "$dir"
  done
  return 0
}
# built <dir>...: record each as built from what it was built from.
built() {
  local dir
  for dir in "$@"; do
    state_put "$dir" "$(plan_field "$dir" 4)"
    summarize "$dir" "built"
  done
}

# --- Drift gates (FIRST: they are the most common failure, and they need only
# the repo plus a container — failing here costs seconds, not the ten minutes
# of package and image builds that follow) ---

if [[ "$IMAGES_ONLY" != true ]]; then

# --- bus registry drift gate ---
#
# specs/src/bus/registry.json is the AUTHORITY for the event bus: channels,
# payload shapes, and the request/reply operations. BOTH languages are
# generated from it — packages/typescript/core/src/bus-protocol.ts + bus-operations.ts
# (TypeScript) and packages/go/sdk/bus/*_gen.go — so an edit to one language's
# generated file, or a registry change without regeneration, is drift that
# would let the two sides disagree at runtime. Each generator's --check diffs
# without writing. The generators of this gate and of the Python and Go gates
# below are listed once, in package.json's generate:<list>:check, which CI
# runs too.

banner "DRIFT AND LOCKFILE GATES"

if ! run_logged "the bus registry and both generated languages agree" \
    $RT run --rm -v "$REPO_ROOT":/workspace -w /workspace "$NODE_IMAGE" \
    npm run generate:bus:check; then
  fail "Generated bus files are STALE (or were hand-edited) — they must match specs/src/bus/registry.json."
  echo ""
  echo -e "  Regenerate both languages and commit:"
  echo ""
  echo -e "    ${BOLD}npm run generate:bus${RESET}   (packages/typescript/core/src/bus-protocol.ts, bus-operations.ts; packages/go/sdk/bus/*_gen.go)"
  echo ""
  echo -e "  Channels and operations are edited in ${BOLD}specs/src/bus/registry.json${RESET}, never in the generated files."
  echo ""
  exit 1
fi

# --- the bundled spec ---
#
# The two gates below both read it.

# specs/openapi.json is a BUILD ARTIFACT bundled from specs/src/. With the
# gates running before the package builds, the copy a prior build left may be
# stale or absent — bundle fresh first. Version pinned to the repo's
# devDependency, same as CI.
if ! run_logged "specs/src bundled into specs/openapi.json" \
    $RT run --rm -v "$REPO_ROOT":/workspace -v "$NPM_CACHE_DIR":/root/.npm -w /workspace "$NODE_IMAGE" \
    npx --yes @redocly/cli@2.34.0 bundle specs/src/openapi.json -o specs/openapi.json; then
  fail "Could not bundle the OpenAPI spec (redocly says why, above)."
  exit 1
fi

# --- Python SDK drift gate ---
#
# The Python SDK has no build: what it holds of specs/src is generated and
# COMMITTED (packages/python/sdk/src/semiont), so a spec change can leave it
# stale. Node generators write the tables and the bus vocabulary; the models
# (types.py) are written by a Python tool pinned in the package's lockfile.

if ! run_logged "the Python SDK's generated tables match specs/src" \
    $RT run --rm -v "$REPO_ROOT":/workspace -w /workspace "$NODE_IMAGE" \
    npm run generate:python:check; then
  fail "The Python SDK's generated tables are STALE (or were hand-edited) — they must match specs/src."
  echo ""
  echo -e "  Regenerate and commit:"
  echo ""
  echo -e "    ${BOLD}npm run generate:python${RESET}   (packages/python/sdk/src/semiont)"
  echo ""
  exit 1
fi

# The environment is made INSIDE the container (/venv) from the package's
# lockfile, and Python is told to write no bytecode: nothing lands in the
# working tree. Only uv's download cache is kept between runs.
#
# Making the environment and comparing report SEPARATELY, as for Go: a failed
# download is not a stale file.
MODELS_LOG=$(mktemp "$TMP_DIR/semiont-python-models.XXXXXX")
MODELS_RC=0
$RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -v "$UVCACHE_DIR":/root/.cache/uv \
  -e UV_PROJECT_ENVIRONMENT=/venv \
  -e UV_LINK_MODE=copy \
  -e UV_PYTHON_DOWNLOADS=never \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -w /workspace \
  "$PYTHON_IMAGE" \
  sh -c 'pip install --quiet --disable-pip-version-check --root-user-action=ignore uv || exit 3
         uv sync --quiet --locked --project packages/python/sdk || exit 3
         uv run --no-sync --project packages/python/sdk python packages/python/sdk/scripts/generate_models.py --check || exit 4' \
  > "$MODELS_LOG" 2>&1 \
  || MODELS_RC=$?

# The generator says DRIFT (or "new") when it compared and found a difference.
# Leaving with 4 without saying so, it never got that far.
if [[ "$MODELS_RC" == 0 ]]; then
  ok "the Python SDK's models match the spec"
  rm -f "$MODELS_LOG"
elif [[ "$MODELS_RC" == 4 ]] && grep -qE '^(DRIFT|new) ' "$MODELS_LOG"; then
  grep -E '^(DRIFT|new) ' "$MODELS_LOG" | sed 's/^/    /'
  fail "packages/python/sdk/src/semiont/types.py is STALE (or was hand-edited) — it must match the OpenAPI spec."
  echo ""
  echo -e "  Regenerate and commit it:"
  echo ""
  echo -e "    ${BOLD}uv run --project packages/python/sdk python packages/python/sdk/scripts/generate_models.py${RESET}"
  echo ""
  exit 1
else
  tail -40 "$MODELS_LOG" | sed 's/^/    /'
  fail "The Python SDK's models gate could not RUN (exit $MODELS_RC; its output is above)."
  echo ""
  echo -e "  This says nothing about whether the models are stale — the check never got"
  echo -e "  far enough to compare."
  echo ""
  if [[ "$MODELS_RC" == 4 ]]; then
    echo -e "  The generator refused the spec or failed. Its message names what it met."
  else
    echo -e "  The locked environment could not be made in ${BOLD}${PYTHON_IMAGE}${RESET}: a failed download"
    echo -e "  (${BOLD}pypi.org${RESET}) is the usual cause, or ${BOLD}packages/python/sdk/uv.lock${RESET} no longer"
    echo -e "  agreeing with its pyproject.toml."
  fi
  echo ""
  echo -e "  ${DIM}Output kept at: $MODELS_LOG${RESET}"
  echo ""
  exit 1
fi

# --- Python lockfile gate ---
#
# The inference drivers (packages/python/inference), the graph stores
# (packages/python/graph), the vector stores (packages/python/vectors), the
# service package (packages/python/service) and every Python image under
# images/ are Python projects with a
# lockfile each and nothing generated from specs/src, so what can go stale in
# them is the lockfile: a manifest changed without `uv lock`, in the project
# or in a package of the repository it takes. CI's job for each refuses that first
# (`uv sync --locked`), and so does a service image's build, minutes into a
# run. This refuses it here, for each, in seconds: `uv lock --check` makes no
# environment and writes nothing, and the one a working tree may hold from a
# run on the host is not looked at.

PYTHON_PROJECTS="packages/python/inference packages/python/graph packages/python/vectors packages/python/service"
for pyproject in "$REPO_ROOT"/images/*/pyproject.toml; do
  PYTHON_PROJECTS+=" images/$(basename "$(dirname "$pyproject")")"
done

for PYTHON_PROJECT in $PYTHON_PROJECTS; do
  LOCK_LOG=$(mktemp "$TMP_DIR/semiont-lock.XXXXXX")
  # Installing uv and checking report SEPARATELY, as above: a failed download
  # is not a stale lockfile.
  LOCK_RC=0
  $RT run --rm \
    -v "$REPO_ROOT":/workspace \
    -v "$UVCACHE_DIR":/root/.cache/uv \
    -e UV_PROJECT_ENVIRONMENT=/venv \
    -e UV_PYTHON_DOWNLOADS=never \
    -e PYTHONDONTWRITEBYTECODE=1 \
    -w /workspace \
    "$PYTHON_IMAGE" \
    sh -c 'pip install --quiet --disable-pip-version-check --root-user-action=ignore uv || exit 3
           uv lock --check --project "$1" || exit 4' sh "$PYTHON_PROJECT" \
    > "$LOCK_LOG" 2>&1 \
    || LOCK_RC=$?
  if [[ "$LOCK_RC" == 0 ]]; then
    rm -f "$LOCK_LOG"
  elif [[ "$LOCK_RC" == 4 ]]; then
    tail -40 "$LOCK_LOG" | sed 's/^/    /'
    fail "${PYTHON_PROJECT}/uv.lock does not agree with its manifests (uv says how, above)."
    echo ""
    echo -e "  Lock it again and commit the lockfile:"
    echo ""
    echo -e "    ${BOLD}cd ${PYTHON_PROJECT} && uv lock${RESET}"
    echo ""
    echo -e "  A project takes the SDK from this repository, and a service the package it"
    echo -e "  runs on too (the worker the inference drivers, the weaver the graph stores,"
    echo -e "  the smelter the vector stores, the librarian all three, and every service the"
    echo -e "  service package), so a change to one of their manifests is a change to its"
    echo -e "  lockfile."
    echo ""
    exit 1
  else
    tail -40 "$LOCK_LOG" | sed 's/^/    /'
    fail "The lockfile gate could not RUN for ${PYTHON_PROJECT} (exit $LOCK_RC; its output is above)."
    echo ""
    echo -e "  This says nothing about whether the lockfile is stale: ${BOLD}uv${RESET} could not be"
    echo -e "  installed in ${BOLD}${PYTHON_IMAGE}${RESET}. A failed download is the usual cause."
    echo ""
    exit 1
  fi
done
ok "the lockfiles of the $(echo $PYTHON_PROJECTS | wc -w | tr -d ' ') Python projects agree with their manifests"

# --- sdk-go drift gate ---
#
# packages/go/sdk/api/client_gen.go is GENERATED from specs/openapi.json and
# COMMITTED (see packages/go/sdk/README.md). Nothing regenerates it
# automatically, so a spec change can leave it stale. This gate regenerates
# to a scratch path inside the container (never the working tree — builds
# don't mutate source) and diffs: byte-identical or fail. Deterministic
# because the generator version is pinned.

if ! run_logged "the Go SDK's generated tables match specs/src" \
    $RT run --rm -v "$REPO_ROOT":/workspace -w /workspace "$NODE_IMAGE" \
    npm run generate:go:check; then
  fail "The Go SDK's generated tables are STALE (or were hand-edited) — they must match specs/src."
  echo ""
  echo -e "  Regenerate and commit:"
  echo ""
  echo -e "    ${BOLD}npm run generate:go${RESET}   (packages/go/sdk)"
  echo ""
  exit 1
fi

# Both Go caches are this script's own, not shared with other container
# consumers. Concurrent container VMs extracting into one shared module cache
# corrupt it — Go's cache locking is flock, which does not hold across VM
# boundaries over virtiofs — and a truncated extraction is trusted
# forever ("cannot embed directory ... contains no embeddable files").
# This script cannot run concurrently with itself (port 4873), so a private
# cache is effectively serial.
#
# The MODULE cache is persisted too, not just the build cache. Without it every
# run re-downloads the whole oapi-codegen tree (~100 MB, 21 modules), which
# lets a DNS blip take this gate down. (Go writes the module cache read-only,
# so `chmod -R u+w` before removing it by hand.)
# Caching alone is not enough: `go run <pkg>@<version>` resolves the version
# against the proxy on EVERY run — including a deprecation lookup — so a
# populated cache alone needs the network. Pointing GOPROXY at the cache's own
# download dir (a valid module proxy) serves the pinned generator locally and
# falls through to the network only on a miss: a warm cache succeeds with the
# network proxies removed entirely, and a cold cache populates through the
# fallback.
GOPROXY_CACHED='file:///go/pkg/mod/cache/download,https://proxy.golang.org,direct'

# Generation and comparison report SEPARATELY. Collapsing them into one `&&`
# makes every generator failure — a DNS blip fetching oapi-codegen, an
# unreadable spec, a container that never started — print "the OpenAPI spec
# changed without regenerating the Go client": a specific cause the gate has
# not established, and one that sends the reader to regenerate a file that was
# never stale. Ignorance is not a finding.
# The corrupt-cache signature, in ONE place: the retry below and the diagnosis
# further down must agree about what a poisoned extraction looks like, or the
# run either retries a failure it cannot fix or prints a remedy it already
# applied. `cannot embed` / `no embeddable files` is the shape a TRUNCATED
# extraction produces — the tree is THERE, so Go trusts it and never
# re-extracts, and every retry fails identically until it is removed.
CORRUPT_CACHE_RE='no such file or directory|no matching files found|cannot embed|no embeddable files|pattern .*: .*matching|cannot find package'

# Output is tee'd, not just streamed: the exit-3 handler below reads it to tell a
# CORRUPT MODULE CACHE from a network failure, and the two have opposite remedies.
# `set -o pipefail` (line 2) is what makes `$?` the container's code rather than
# tee's — without it this silently reports success on every failure.
DRIFT_LOG=$(mktemp "$TMP_DIR/semiont-drift.XXXXXX")

run_drift_check() {
  DRIFT_RC=0
  $RT run --rm \
    -v "$REPO_ROOT":/workspace \
    -v "$GOCACHE_DIR":/root/.cache/go-build \
    -v "$GOMODCACHE_DIR":/go/pkg/mod \
    -e GOPROXY="$GOPROXY_CACHED" \
    -w /workspace \
    "$GO_IMAGE" \
    sh -c 'go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.6.0 \
             -config packages/go/sdk/oapi-codegen.yaml \
             -o /tmp/client_gen.check.go specs/openapi.json || exit 3
           diff -q /tmp/client_gen.check.go packages/go/sdk/api/client_gen.go >/dev/null || exit 4' \
    > "$DRIFT_LOG" 2>&1 \
    || DRIFT_RC=$?
}

# Purge the EXTRACTED module trees, keeping cache/download — the downloads are a
# content-addressed store and a valid proxy (GOPROXY_CACHED points at it), so Go
# re-extracts from them offline. On the HOST: rm through the mount fails with
# Permission denied even as root. Go writes the cache read-only, hence the chmod.
purge_modcache_extractions() {
  chmod -R u+w "$GOMODCACHE_DIR" 2>/dev/null || true
  find "$GOMODCACHE_DIR" -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} + 2>/dev/null || true
}

run_drift_check

# Self-heal, once: a message telling someone to run two commands the
# script can run itself is a manual step pretending to be a diagnosis. Retried
# ONLY on the corrupt-cache signature and ONLY when the generator failed to run
# (3): a STALE client (4) is a real verdict about the spec, and re-running it on
# a fresh cache would just burn a download to reach the same answer.
if [[ "$DRIFT_RC" == 3 ]] && grep -qiE "$CORRUPT_CACHE_RE" "$DRIFT_LOG"; then
  warn "The Go module cache is corrupt (a partial extraction). Purging the extracted trees — the downloads are kept — and retrying once."
  purge_modcache_extractions
  run_drift_check
  if [[ "$DRIFT_RC" == 0 ]]; then
    ok "Recovered after purging the module cache"
  fi
fi

case "$DRIFT_RC" in
  0)
    ok "packages/go/sdk/api/client_gen.go matches specs/openapi.json"
    rm -f "$DRIFT_LOG"
    ;;
  4)
    fail "packages/go/sdk/api/client_gen.go is STALE — the OpenAPI spec changed without regenerating the Go client."
    echo ""
    echo -e "  Regenerate and commit it:"
    echo ""
    echo -e "    ${BOLD}cd packages/go/sdk && go generate ./...${RESET}"
    echo -e "    ${BOLD}git add packages/go/sdk/api/client_gen.go${RESET}   (then commit)"
    echo ""
    exit 1
    ;;
  *)
    tail -40 "$DRIFT_LOG" | sed 's/^/    /'
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
    # produces.
    # Go has two embed failures and they read nothing alike: a pattern matching
    # nothing says "no matching files found", while a directory that survived
    # with its subdirectories but none of its files says "cannot embed directory
    # X: contains no embeddable files". The second is precisely the corrupt-cache
    # signature — the tree is THERE, so Go trusts it and never re-extracts, and
    # every retry fails identically. Matching only the first would send the
    # reader to the network branch below to wait out a network that is working.
    if grep -qiE "$CORRUPT_CACHE_RE" "$DRIFT_LOG"; then
      echo -e "  ${BOLD}Cause: a corrupt Go module cache, not the network.${RESET} A previous run was"
      echo -e "  interrupted mid-extraction and left a partial module tree."
      echo ""
      echo -e "  ${BOLD}This run already purged the extracted trees and retried once${RESET}, so the"
      echo -e "  cache was not merely poisoned — it is cold, or the purge could not remove it."
      echo ""
      echo -e "  Purge by hand and see whether the error changes:"
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

if ! run_logged "the generated Go client covers every schema" \
    $RT run --rm -v "$REPO_ROOT":/workspace -w /workspace "$NODE_IMAGE" \
    node scripts/ci/check-go-schema-coverage.mjs; then
  fail "The generated Go client is missing schemas (see above)."
  echo ""
  echo -e "    ${BOLD}cd packages/go/sdk && go generate ./...${RESET}"
  echo ""
  exit 1
fi

fi

# --- The registry, for the images that install from one ---

if [[ -n "$REGISTRY_IMAGES" ]]; then

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
  $RT stop semiont-verdaccio >/dev/null 2>&1 || true
  $RT rm   semiont-verdaccio >/dev/null 2>&1 || true
  if lsof -ti :4873 > /dev/null 2>&1; then
    fail "Port 4873 is still in use after kill"
    lsof -i :4873 2>/dev/null
    exit 1
  fi
  ok "Port 4873 is free"

  VERDACCIO_STORAGE=$(mktemp -d)
  # Copy config into a temp dir so we can mount the whole directory.
  # Apple Container CLI sandboxes single-file bind mounts in a way that
  # makes them unreadable inside the container; a directory mount works.
  VERDACCIO_CONF=$(mktemp -d)
  cp "$SCRIPT_DIR/verdaccio.yaml" "$VERDACCIO_CONF/config.yaml"
  # The verdaccio image runs as its own user (uid 10001), and mktemp makes both
  # dirs 0700 for the user running this script. Where a runtime enforces
  # ownership on bind mounts — docker and podman on Linux — the registry can
  # then neither read its config nor write its storage ("config file does not
  # exist or not reachable"). Apple container's shares do not enforce it.
  chmod 0755 "$VERDACCIO_CONF"
  chmod 0777 "$VERDACCIO_STORAGE"

  # Note: intentionally no --rm — Apple Container CLI v0.11 silently drops
  # detached containers that use --rm, making logs unreachable on failure.
  # The EXIT trap above handles cleanup instead.
  # --memory is EXPLICIT for the same reason the launcher sets it on every
  # service: the silent default is the worst value. Apple container gives 1G,
  # and three concurrent image builds pulling tarballs through this registry
  # while it proxies large packages from upstream kill it there: builds die
  # with ECONNRESET, and verdaccio's log just stops mid-fetch with no shutdown
  # line.
  $RT run -d \
    --name "$VERDACCIO_NAME" \
    --memory 4G \
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

  # Register user and get auth token
  VERDACCIO_TOKEN=""
  for i in $(seq 1 10); do
    RESPONSE=$(curl -s -X PUT "$REGISTRY/-/user/org.couchdb.user:$VERDACCIO_USER" \
      -H 'Content-Type: application/json' \
      -d "{\"name\":\"$VERDACCIO_USER\",\"password\":\"$VERDACCIO_PASS\"}" 2>/dev/null || echo "")
    VERDACCIO_TOKEN=$(echo "$RESPONSE" | grep -o '"token": *"[^"]*"' | cut -d'"' -f4 || echo "")
    if [[ -n "$VERDACCIO_TOKEN" ]]; then
      break
    fi
    sleep 1
  done

  if [[ -z "$VERDACCIO_TOKEN" ]]; then
    fail "Failed to get auth token from fresh Verdaccio (its storage is $VERDACCIO_STORAGE)"
    echo "  Storage dir contents: $(ls -la "$VERDACCIO_STORAGE" 2>/dev/null)"
    echo "  htpasswd: $(cat "$VERDACCIO_STORAGE/htpasswd" 2>/dev/null || echo '(not found)')"
    exit 1
  fi
  ok "Auth token acquired"
fi

# --- Resolve host address ---

HOST_ADDR=$($RT run --rm "$NODE_IMAGE" sh -c "ip route | awk '/default/{print \$3}'")
step "Host address from container: ${DIM}$HOST_ADDR${RESET}"
BUILD_REGISTRY="http://$HOST_ADDR:4873"

fi

# --- The packages ---
#
# Each language's packages build in one container of its own, in turn, and each
# is recorded as built when its language's build has succeeded. Each container
# states its memory: Apple container's default is 1G, in which cargo compiling
# the workspace's crates thrashes at full CPU and never finishes.

# shown <list>: a comma-separated list as a reader reads one, or "nothing to build".
shown() { [[ -n "$1" ]] && echo "${1//,/, }" || echo "nothing to build"; }

# names_of <dir>...: the names their builds take, comma-separated.
names_of() {
  local dir names=""
  for dir in "$@"; do names="$names,$(plan_field "$dir" 3)"; done
  echo "${names#,}"
}

# The npm packages, with scripts/ci/build.sh, and the app each image that
# installs from the registry installs (images/<name>, which version.json lists
# under that name): its bundle holds the packages, so it is built whenever its
# image may be. Then all of version.json's published entries go to Verdaccio,
# which this run started empty.
build_npm() {
  local packages names img publish=false then="" done="built"
  packages=$(packages_of typescript)
  names=$(names_of $packages)
  for img in $REGISTRY_IMAGES; do names="${names:+$names,}$img"; done
  [[ -n "$REGISTRY_IMAGES" ]] && publish=true && then=", then publish to Verdaccio" && done="built and published to Verdaccio"
  [[ -z "$names" && "$publish" != true ]] && return 0

  if [[ "$publish" == true ]]; then
    chmod -R u+rwX .npm-stage 2>/dev/null || true
    rm -rf .npm-stage
    # Snapshot dirtiness *before* publish, then arm the revert trap, so the EXIT
    # handler can undo only the publish stamp and not any pre-existing edits. Same
    # path set the restore uses — a file the snapshot ignores is a file the restore
    # would clobber.
    PRE_DIRTY=$(git -C "$REPO_ROOT" status --porcelain -- "${STAMPED_PATHS[@]}" 2>/dev/null || true)
    trap restore_manifests EXIT
  fi

  step "npm: $(shown "$names")${then} ${DIM}(in ${NODE_IMAGE})${RESET}"
  if ! run_logged "npm: $done" \
    $RT run --rm \
    -v "$REPO_ROOT":/workspace \
    -v "$NPM_CACHE_DIR":/root/.npm \
    -w /workspace \
    -m 8g \
    -e NODE_OPTIONS="--max-old-space-size=4096" \
    "$NODE_IMAGE" \
    sh -c "
      set -e
      apk add --no-cache bash git > /dev/null
      if [ -n '$names' ]; then
        ./scripts/ci/build.sh --package '$names'
      fi
      if [ '$publish' = true ]; then
        # Create .npmrc for Verdaccio auth
        # The body and the NPMRC terminator MUST stay at column 0 — this is
        # <<NPMRC, not <<-NPMRC, so an indented terminator never closes the
        # heredoc and every command below it silently becomes .npmrc content.
        # No backticks in these comments: this whole script is a double-quoted
        # string, so the host shell runs anything in backticks.
        cat > /tmp/.npmrc <<NPMRC
registry=http://${HOST_ADDR:-}:4873
//${HOST_ADDR:-}:4873/:_authToken=${VERDACCIO_TOKEN:-}
NPMRC
        ./scripts/ci/publish.sh \
          --registry http://${HOST_ADDR:-}:4873 \
          --tag latest \
          --clean \
          --npmrc /tmp/.npmrc
      fi
    "; then
    fail "The npm packages did not build, or did not publish (scripts/ci/build.sh or publish.sh says why, above)."
    exit 1
  fi
  built $packages
}

# The Rust crates, with one cargo build of them all. The registry cargo
# downloads is this script's, mounted where the image's cargo keeps it (its
# cargo home stays where it is: its cargo is rustup's proxy, which looks for
# rustup there). What it compiles stays in the container, so there is no
# target to keep bounded: a run compiles the crates it builds afresh, in under
# a minute for the workspace's packages.
build_rust() {
  local packages args="" dir
  packages=$(packages_of rust)
  [[ -z "$packages" ]] && return 0
  for dir in $packages; do args="$args -p $(plan_field "$dir" 3)"; done
  step "Rust: $(shown "$(names_of $packages)") ${DIM}(in rust:${RUST_TOOLCHAIN}-bookworm)${RESET}"
  if ! run_logged "Rust: built" \
      $RT run --rm \
      -m 8g \
      -v "$REPO_ROOT":/workspace \
      -v "$CARGO_REGISTRY_DIR":/usr/local/cargo/registry \
      -e CARGO_TARGET_DIR=/target \
      -w /workspace/packages/rust \
      "rust:${RUST_TOOLCHAIN}-bookworm" \
      sh -c 'rustup toolchain install >/dev/null && cargo build --locked "$@"' sh $args; then
    fail "The Rust crates did not build (cargo says why, above)."
    exit 1
  fi
  built $packages
}

# The Python packages' distributions: the SDK's with the script CI and
# publish-pypi.yml run, which builds them and checks what a published one must
# pass, and each other's with uv. They are published nowhere: Verdaccio holds
# npm packages alone, and the images that carry them build them from the
# working tree. What is left in each dist/ installs by path.
build_python() {
  local packages dir rc=0
  packages=$(packages_of python)
  [[ -z "$packages" ]] && return 0
  for dir in $packages; do rm -rf "$REPO_ROOT/$dir/dist"; done
  step "Python: $(shown "$(names_of $packages)") ${DIM}(in ${PYTHON_IMAGE})${RESET}"
  # What the builds need and the image lacks leaves with 3: a failed download
  # is not a package that does not build.
  run_logged "Python: built" \
    $RT run --rm \
    -m 8g \
    -v "$REPO_ROOT":/workspace \
    -v "$UVCACHE_DIR":/root/.cache/uv \
    -e UV_LINK_MODE=copy \
    -e UV_PYTHON_DOWNLOADS=never \
    -e PYTHONDONTWRITEBYTECODE=1 \
    -w /workspace \
    "$PYTHON_IMAGE" \
    sh -c 'apk add --no-cache bash jq > /dev/null || exit 3
           pip install --quiet --disable-pip-version-check --root-user-action=ignore uv || exit 3
           for dir in "$@"; do
             if [ "$dir" = packages/python/sdk ]; then bash scripts/ci/build-python-sdk.sh || exit 1
             else uv build --quiet "$dir" || exit 1
             fi
           done' sh $packages \
    || rc=$?
  if [[ "$rc" == 3 ]]; then
    fail "The Python builds could not RUN: bash, jq or uv could not be installed in ${PYTHON_IMAGE} (a failed download is the usual cause; output above)."
    exit 1
  elif [[ "$rc" != 0 ]]; then
    fail "A Python package did not build, or the SDK's distributions did not pass their checks (above). CI's Python jobs and publish-pypi.yml build them the same way."
    exit 1
  fi
  built $packages
}

# The Go modules, each with go build, on the drift gate's caches.
build_go() {
  local packages
  packages=$(packages_of go)
  [[ -z "$packages" ]] && return 0
  step "Go: $(shown "$(names_of $packages)") ${DIM}(in ${GO_IMAGE})${RESET}"
  if ! run_logged "Go: built" \
      $RT run --rm \
      -m 8g \
      -v "$REPO_ROOT":/workspace \
      -v "$GOCACHE_DIR":/root/.cache/go-build \
      -v "$GOMODCACHE_DIR":/go/pkg/mod \
      -e GOPROXY="$GOPROXY_CACHED" \
      -w /workspace \
      "$GO_IMAGE" \
      sh -c 'for dir in "$@"; do (cd "$dir" && go build -buildvcs=false ./...) || exit 1; done' sh $packages; then
    fail "A Go module did not build (go says why, above)."
    exit 1
  fi
  built $packages
}

if [[ "$IMAGES_ONLY" != true ]]; then
  banner "PACKAGES"
  [[ -z "$BUILD_PACKAGES" ]] && ok "Every selected package is unchanged since it was last built here"
  build_npm
  build_rust
  build_python
  build_go
fi

[[ -n "$REGISTRY_IMAGES" ]] && "$SCRIPT_DIR/verdaccio-ls.sh" "$REGISTRY"

if [[ "$PACKAGES_ONLY" != true ]]; then

# --- Build container images ---
#
# Same production Dockerfiles as the publish workflows, tagged
# ghcr.io/the-ai-alliance/semiont-<svc>:local. The Node image, the Browser's,
# installs from the local Verdaccio; the gateway, the dispatcher, the
# archivist, the worker, the smelter, the weaver and the librarian are built
# from the working tree. The
# :local tag is what `semiont start` runs where a KB's stack documents name it
# (it pulls no image tagged :local), and it is never pushed.
#
# For a Node image --no-cache is required for correctness, not caution: iterating republishes
# the SAME version to Verdaccio, so the `npm install` RUN line is byte-identical
# and a cached layer would silently reuse the stale packages.

banner "CONTAINER IMAGES"

# --- Image fan-out targets ---
#
# The :local images land in $RT's image store, invisible to every other
# engine — a KB started with a different --runtime then fails with
# "semiont-<svc>:local: not found". Build once under $RT, then load each
# built image into every OTHER responsive runtime. A fan-out failure is a
# warning, not a build failure (the primary store is intact).
#
# File-based transfer only: `container image save` cannot stream (`-o -`
# writes a literal file named "-"; /dev/stdout truncates the archive), so
# pipe-less save→load via a temp file is the portable shape.
# An installed-but-unresponsive engine (e.g. Docker Desktop not running)
# warns once here and is skipped; an absent engine is silently ignored.
FANOUT_RTS=""
for rt in container docker podman; do
  [[ "$FANOUT" == true ]] || break
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


# Copies every :local image into each OTHER responsive runtime. Loops runtime
# OUTSIDE image so the happy path is one line per destination rather than one
# per image — a per-image ✓ says the same thing seven times. Failures stay
# per-image, because that is when you need to know WHICH.
#
# `image save` prints the tag it wrote; without the redirect that echo lands
# between the log lines and reads like stray output.
fanout_all() {
  local rt tmp tag img n
  for rt in $FANOUT_RTS; do
    n=0
    for img in $IMAGES; do
      tag="ghcr.io/the-ai-alliance/semiont-${img}:local"
      tmp=$(mktemp "$TMP_DIR/semiont-fanout.XXXXXX")
      if $RT image save "$tag" -o "$tmp" >/dev/null 2>&1 && "$rt" image load -i "$tmp" >/dev/null 2>&1; then
        n=$((n + 1))
      else
        warn "Fan-out of $tag to $rt failed (build unaffected; manual: $RT image save $tag -o /tmp/img.tar && $rt image load -i /tmp/img.tar)"
        FANOUT_FAILURES="$FANOUT_FAILURES $rt:$tag"
      fi
      rm -f "$tmp"
    done
    if [ "$n" -gt 0 ]; then
      ok "$n image(s) → $rt image store"
    fi
  done
}

# --- Skip unchanged images ---
# An image is a function of its Dockerfile, the files it COPYs from the
# repository (the gateway's crate and the spec, a Python service's projects
# and their lockfile, the shared supervisor, the
# NOTICE), and the @semiont/* packages it installs — DIRECTLY OR TRANSITIVELY. "Unchanged" is decided by package
# INTEGRITY against the freshly-published Verdaccio — versions and mtimes are
# useless because every run republishes (check-semiont-drift.mjs reasons the
# same way) — plus the Dockerfile hash. Third-party deps and the base tag are
# treated as stable; when upstream moves them, --image <name> forces the
# rebuild (explicit wins, and it also refreshes the recorded signature). The
# @semiont/* set is DERIVED from the Dockerfile text, not restated here.
#
# The closure is the whole point. An image that installs ONE package (the
# Browser's, `npm install @semiont/browser`) inherits whatever @semiont/*
# packages that one depends on, all pinned "*" so they resolve to latest at
# install time. Signing only the named package would let a fix landing in a
# package it depends on leave the named one byte-identical, the signature
# match, and the image skip — while a rebuild would pick the fix up: correct
# about the package it watches and wrong about the image it produces.

# One line capturing everything a rebuild depends on; EMPTY when any
# integrity lookup fails, and an empty signature never skips and never
# records — lookup trouble degrades to building, not to false skips.
image_signature() {
  local df
  df="$REPO_ROOT/$(image_dockerfile "$1")"
  # Install lines only — comments mention packages that are not installed.
  # Those seed a walk over each package's @semiont/* dependencies, because the
  # install line names the root of a tree, not the tree. A Dockerfile built
  # from the working tree installs none, and under pipefail an empty grep ends
  # the run.
  { grep 'npm install' "$df" | grep -ohE '@semiont/[a-z-]+' || true; } | sort -u \
    | REGISTRY="$REGISTRY" DOCKERFILE="$df" REPO_ROOT="$REPO_ROOT" python3 -c '
import hashlib, json, os, sys, urllib.parse, urllib.request

registry = os.environ["REGISTRY"].rstrip("/")

def packument(name):
    url = registry + "/" + urllib.parse.quote(name, safe="")
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.load(response)

integrity = {}
pending = [line.strip() for line in sys.stdin if line.strip()]
try:
    while pending:
        name = pending.pop()
        if name in integrity:
            continue
        latest = packument(name)
        version = latest["versions"][latest["dist-tags"]["latest"]]
        integrity[name] = version["dist"]["integrity"]
        for dep in version.get("dependencies", {}):
            if dep.startswith("@semiont/") and dep not in integrity:
                pending.append(dep)
except Exception:
    # Lookup trouble degrades to building, never to a false skip.
    print("")
    sys.exit(0)

dockerfile = open(os.environ["DOCKERFILE"], "rb").read()
digest = hashlib.sha256(dockerfile).hexdigest()

# What the Dockerfile COPYs from the build context (not from another stage),
# every file under each source, in order: a changed crate, spec or supervisor
# is a changed image.
root = os.environ["REPO_ROOT"]
sources = hashlib.sha256()
text = dockerfile.decode().replace("\\\n", " ")
for line in text.splitlines():
    words = line.split()
    if not words or words[0].upper() != "COPY" or any(w.startswith("--from") for w in words):
        continue
    for source in [w for w in words[1:-1] if not w.startswith("--")]:
        path = os.path.join(root, source)
        files = [path] if os.path.isfile(path) else sorted(
            os.path.join(d, f) for d, _, fs in os.walk(path) for f in fs)
        for f in files:
            sources.update(os.path.relpath(f, root).encode())
            sources.update(open(f, "rb").read())

# Sorted: the walk order is not stable, and an unstable signature would rebuild
# everything forever while looking like a cache.
parts = ["dockerfile:" + digest, "sources:" + sources.hexdigest()] + [n + ":" + integrity[n] for n in sorted(integrity)]
print(" ".join(parts))
'
}

BUILD_IMGS=()
BUILD_SIGS=()
for img in $IMAGES; do
  TAG="ghcr.io/the-ai-alliance/semiont-${img}:local"
  SIG=$(image_signature "$img")
  if [[ "$FORCE" != true && "$IMAGES_NAMED" != true && -n "$SIG" && "$(state_get "images/$img")" == "$SIG" ]] \
     && $RT image inspect "$TAG" >/dev/null 2>&1; then
    summarize "images/$img" "unchanged"
  else
    BUILD_IMGS+=("$img")
    BUILD_SIGS+=("$SIG")
  fi
done
# --- The image each build replaces ---
#
# :local is a mutable tag: a rebuilt image takes it from the one before, which
# stays in the store with nothing naming it, so every run would add a layer set
# to every store it reaches. Before a build, the image the tag names is tagged
# :local-previous, in the building engine and in each one the images are loaded
# into, and that tag is deleted once the new image is built, keeps its promises
# and is loaded everywhere. The engine then reclaims what no tag and no
# container names, and refuses (a warning here) an image a container still
# uses. A run that fails keeps the old image under both tags, and the next run
# replaces the second.
keep_previous() {  # <runtime> <image>
  local tag="ghcr.io/the-ai-alliance/semiont-$2:local"
  if "$1" image inspect "$tag" >/dev/null 2>&1; then
    "$1" image tag "$tag" "$tag-previous" >/dev/null 2>&1 || warn "could not keep $tag in $1 as $tag-previous"
  fi
}
drop_previous() {  # <runtime> <image>
  local previous="ghcr.io/the-ai-alliance/semiont-$2:local-previous"
  "$1" image inspect "$previous" >/dev/null 2>&1 || return 0
  "$1" image rm "$previous" >/dev/null 2>&1 \
    || warn "$1 keeps the image $previous replaced (a container uses it, or the engine refused: $1 image rm $previous)"
}
for img in ${BUILD_IMGS[@]+"${BUILD_IMGS[@]}"}; do
  for rt in $RT $FANOUT_RTS; do keep_previous "$rt" "$img"; done
done

if [[ ${#BUILD_IMGS[@]} -eq 0 ]]; then
  ok "All images unchanged — nothing to build"
else
  # The per-build log path is ~90 characters of noise on a "Building" line on
  # the happy path; a failure tails its own log, and this glob is how you
  # watch one live.
  step "Building ${#BUILD_IMGS[@]} image(s), 3 at a time ${DIM}(logs: $TMP_DIR/semiont-build-*)${RESET}"
  # `container build` creates the singleton `buildkit` builder LAZILY, so three
  # builds launched together race to create it and two die with "container
  # already exists: buildkit". It only bites when the builder is absent — i.e.
  # straight after a prune, which is exactly when a full rebuild is run.
  # Create it once, serially, before the batch.
  if [[ "$RT" == "container" ]] && ! $RT ls -a 2>/dev/null | grep -qE "^buildkit[[:space:]]"; then
    step "Starting the buildkit builder ${DIM}(absent — parallel builds would race to create it)${RESET}"
    $RT builder start >/dev/null 2>&1 || warn "could not pre-start the buildkit builder — builds may race"
  fi
fi

# --layer-cache: the Rust images' layers come from, and go back to, a directory
# a CI runner keeps between runs. docker's default builder exports no cache
# but the inline kind, so a docker-container builder does the three builds,
# and --load puts each image in docker's store where the stack boots it. All
# three read the cache; none writes it. The write is one more build of the
# gateway's Dockerfile after the batch and the Rust images' timed checks,
# wholly from the builder's own cache, that outputs nothing but the layers:
# nothing builds while those checks time a start. The three share one builder stage,
# which lint:rust-images holds to the same text and BuildKit compiles once.
# The new cache is written beside the old and swapped in, so the directory
# holds one run's layers and does not grow.
if [[ -n "$LAYER_CACHE" ]]; then
  if [[ "$RT" != "docker" ]]; then
    fail "--layer-cache needs docker (the engine is $RT)"
    exit 1
  fi
  if ! docker buildx inspect semiont-layer-cache >/dev/null 2>&1; then
    step "Creating the docker-container builder that reads and writes the layer cache"
    docker buildx create --name semiont-layer-cache --driver docker-container >/dev/null
  fi
fi
# Up to three builds at a time, and the next one starts as soon as any
# finishes: ~30s of EVERY build is fixed buildkit-shim latency (10s
# "transferring" round-trips for byte-sized payloads), which overlapping
# absorbs, and the npm and Python images build while the Rust one compiles. Three, not
# six: the builder VM has 2G. The one heavy build is the Rust builder stage,
# which the gateway, dispatcher and archivist images share, so it compiles once
# however they overlap. Build output goes to a per-image log; a failure tails it and
# stops the run.
# Fan-out happens after all builds, keeping the builder VM to itself.
PIDS=(); TAGS=(); LOGS=(); IMGS=(); STARTS=(); NAMES=(); DONE=(); TIMED=()
next=0
running=0
# Stop the builds still running rather than leaving them to grind against
# whatever broke; their logs stay on disk.
stop_builds() {
  local k
  for k in "${!PIDS[@]}"; do
    [ "${DONE[$k]}" -eq 0 ] && kill "${PIDS[$k]}" 2>/dev/null || true
  done
}
# image_promises <name> <tag>: what the built image of <name> promises. The
# Rust images carry no source and start (or refuse) quickly, and a Python
# service's image carries every library it can be configured for and refuses
# by name, and the smelter's reads a scanned page with no network, or they are
# not built.
image_promises() {
  case "$1" in
    gateway)              "$REPO_ROOT/scripts/container/check-gateway-image.sh" "$2" "$RT" ;;
    dispatcher|archivist) "$REPO_ROOT/scripts/container/check-document-image.sh" "$1" "$2" "$RT" ;;
    worker|smelter|weaver|librarian) "$REPO_ROOT/scripts/container/check-python-image.sh" "$1" "$2" "$RT" ;;
    *)                    true ;;
  esac
}
# image_kept <index>: a build whose image keeps its promises is recorded as
# built, so an unchanged image is not built again.
image_kept() {
  local idx=${IMGS[$1]}
  if [[ -n "${BUILD_SIGS[$idx]}" ]]; then
    state_put "images/${BUILD_IMGS[$idx]}" "${BUILD_SIGS[$idx]}"
  fi
  summarize "images/${BUILD_IMGS[$idx]}" "built"
}
# A cold npm install inside these builds runs for MINUTES with nothing on
# stdout, and --no-cache means every run pays it. That silence reads as a
# hang. Name what is still in flight every 30s so a
# slow build is distinguishable from a stopped one without going to `ps`.
beat=$(date +%s)
while [ $next -lt ${#BUILD_IMGS[@]} ] || [ $running -gt 0 ]; do
  while [ $running -lt 3 ] && [ $next -lt ${#BUILD_IMGS[@]} ]; do
    img=${BUILD_IMGS[$next]}
    DF=$(image_dockerfile "$img")
    TAG="ghcr.io/the-ai-alliance/semiont-${img}:local"
    LOG=$(mktemp "$TMP_DIR/semiont-build-${img}.XXXXXX")
    step "Building ${TAG} from ${DF}..."
    # The gateway, the dispatcher and the archivist compile from the repository
    # with the pinned toolchain, and the worker, the smelter, the weaver and the
    # librarian are installed from it on the Python floor, with what their
    # lockfiles pin. Their
    # layers are keyed by what they copy, so a cached one is never stale.
    # The Browser's image installs from Verdaccio, where --no-cache is what keeps
    # a republished same-version package from being reused stale (above).
    BUILD_CMD=("$RT" build)
    case "$img" in
      gateway|dispatcher|archivist)
        BUILD_FLAGS=(--build-arg "RUST_TOOLCHAIN=$RUST_TOOLCHAIN")
        if [[ -n "$LAYER_CACHE" ]]; then
          BUILD_CMD=(docker buildx build --builder semiont-layer-cache --load)
          [[ -d "$LAYER_CACHE" ]] && BUILD_FLAGS+=(--cache-from "type=local,src=$LAYER_CACHE")
        fi ;;
      worker|smelter|weaver|librarian) BUILD_FLAGS=(--build-arg "PYTHON_FLOOR=$PYTHON_FLOOR") ;;
      *)                            BUILD_FLAGS=(--no-cache --build-arg "NPM_REGISTRY=$BUILD_REGISTRY") ;;
    esac
    "${BUILD_CMD[@]}" "${BUILD_FLAGS[@]}" --tag "$TAG" \
      --file "$REPO_ROOT/$DF" \
      "$REPO_ROOT" > "$LOG" 2>&1 &
    PIDS+=($!)
    TAGS+=("$TAG")
    NAMES+=("$img")
    LOGS+=("$LOG")
    IMGS+=("$next")
    STARTS+=("$(date +%s)")
    DONE+=(0)
    running=$((running + 1))
    next=$((next + 1))
  done
  # Reap in COMPLETION order, not start order. Waiting on the first build
  # first means a hung build hides the others: two builds fail in seconds
  # against a dead registry, a third hangs on npm's retry backoff, and the run
  # looks stuck for minutes with the real errors already on disk.
  # bash 3.2 has no `wait -n`, so poll with kill -0 and reap whoever finishes.
  for j in "${!PIDS[@]}"; do
    [ "${DONE[$j]}" -eq 1 ] && continue
    kill -0 "${PIDS[$j]}" 2>/dev/null && continue
    DONE[$j]=1
    running=$((running - 1))
    st=0
    wait "${PIDS[$j]}" || st=$?
    if [ "$st" -ne 0 ]; then
      fail "${TAGS[$j]} build failed (exit $st) — last 40 lines of ${LOGS[$j]}:"
      tail -40 "${LOGS[$j]}"
      stop_builds
      exit 1
    fi
    ok "${TAGS[$j]} built ${DIM}($(( $(date +%s) - ${STARTS[$j]} ))s)${RESET}"
    beat=$(date +%s)
    rm -f "${LOGS[$j]}"
    # The Rust images' checks time a start on this machine: they wait for the
    # batch (below).
    case "${NAMES[$j]}" in
      gateway|dispatcher|archivist)
        TIMED+=("$j")
        continue ;;
    esac
    if ! image_promises "${NAMES[$j]}" "${TAGS[$j]}"; then
      fail "${TAGS[$j]} does not keep the ${NAMES[$j]} image's promises (above)"
      stop_builds
      exit 1
    fi
    image_kept "$j"
  done
  if [ "$running" -gt 0 ]; then
    now=$(date +%s)
    if [ $((now - beat)) -ge 30 ]; then
      inflight=""
      for k in "${!PIDS[@]}"; do
        if [ "${DONE[$k]}" -eq 0 ]; then
          inflight="$inflight ${NAMES[$k]} ($((now - ${STARTS[$k]}))s)"
        fi
      done
      echo -e "${DIM}  still building:${inflight}${RESET}"
      beat=$now
    fi
    sleep 1
  fi
done

# The Rust images' checks bound how soon each starts, or refuses, timed on
# this machine (START_BOUND_MS in check-gateway-image.sh), so they run once
# nothing else builds. A gateway image from the layer cache is built in
# seconds; checked then, beside the Python images still building, its 100 ms
# start measured 330 ms.
for j in ${TIMED[@]+"${TIMED[@]}"}; do
  if ! image_promises "${NAMES[$j]}" "${TAGS[$j]}"; then
    fail "${TAGS[$j]} does not keep the ${NAMES[$j]} image's promises (above)"
    exit 1
  fi
  image_kept "$j"
done

# This run's layers are written now, after the batch and its checks, and
# replace the last run's: see --layer-cache above.
if [[ -n "$LAYER_CACHE" ]]; then
  step "Writing the Rust images' layers for the next run"
  EXPORT_FLAGS=(--build-arg "RUST_TOOLCHAIN=$RUST_TOOLCHAIN")
  [[ -d "$LAYER_CACHE" ]] && EXPORT_FLAGS+=(--cache-from "type=local,src=$LAYER_CACHE")
  LOG=$(mktemp "$TMP_DIR/semiont-layer-cache.XXXXXX")
  if ! docker buildx build --builder semiont-layer-cache "${EXPORT_FLAGS[@]}" \
      --cache-to "type=local,dest=$LAYER_CACHE.next,mode=max" --output type=cacheonly \
      --file "$REPO_ROOT/images/gateway/Dockerfile" "$REPO_ROOT" > "$LOG" 2>&1; then
    fail "writing the layer cache failed — last 40 lines of $LOG:"
    tail -40 "$LOG"
    exit 1
  fi
  rm -f "$LOG"
  rm -rf "$LAYER_CACHE"
  mv "$LAYER_CACHE.next" "$LAYER_CACHE"
  ok "The Rust images' layers are kept in $LAYER_CACHE for the next run"
fi

# Fan-out covers skipped images too: it heals the case where another runtime
# was down when the image was last built.
fanout_all

for img in ${BUILD_IMGS[@]+"${BUILD_IMGS[@]}"}; do
  for rt in $RT $FANOUT_RTS; do drop_previous "$rt" "$img"; done
done

# --- Image-store accounting ---
#
# What each store holds after the run. The image a build replaced is deleted
# above; what is left is every image the store holds, this script's and
# others'. Neither engine volunteers the number, so it is reported here.
# Reporting only; a failure here must never fail a build that already
# succeeded.
store_report() {
  local rt="$1" line
  case "$rt" in
    docker|podman)
      # The engine's own accounting, including what a prune would reclaim.
      line=$("$rt" system df 2>/dev/null | awk '/^Images/{print $4" in "$2" images, "$5" reclaimable"}') || line=""
      ;;
    container)
      # Apple container has no `system df`; sum the per-image sizes it reports
      # as human strings ("56.3 MB"). Decimal units, as the engine prints them.
      line=$(container image list --format json 2>/dev/null | python3 -c '
import sys, json
units = {"B": 1, "KB": 1e3, "kB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}
try:
    imgs = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
total = 0.0
for i in imgs:
    p = str(i.get("fullSize", "")).split()
    if len(p) == 2 and p[1] in units:
        try:
            total += float(p[0]) * units[p[1]]
        except ValueError:
            pass
print(f"{total/1e9:.1f}GB in {len(imgs)} images")
' 2>/dev/null) || line=""
      ;;
  esac
  [[ -z "$line" ]] && return 0
  echo -e "  ${BOLD}${rt}${RESET}: ${line}"
  echo -e "      ${DIM}prune unused: ${rt} image prune -a${RESET}"
}

echo ""
step "Image stores after fan-out"
for rt in $RT $FANOUT_RTS; do
  store_report "$rt"
done

if [[ "$IMAGES_ONLY" == true ]]; then
  # Deliberately stops here. The drift gates and the launcher are unrelated to
  # image contents, and paying for them would undo the point of the flag — a
  # one-image rebuild should cost about a minute.
  banner "IMAGES DONE ✓"
  print_summary
  echo -e "  Restart the affected service(s) to pick them up, e.g."
  echo -e "    ${BOLD}semiont restart${RESET}  (in a KB whose .semiont/stack documents name the :local images)"
  echo ""
  echo -e "${DIM}Skipped (use a full run for these): the packages, the drift and lockfile gates, the launcher.${RESET}"
  echo ""
  echo -e "\033[2m[$(date '+%Y-%m-%d %H:%M:%S')] local-build finished (--images-only)\033[0m"
  exit 0
fi


fi

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
  *)      LAUNCHER_GOOS=linux; warn "Unrecognized host OS $(uname -s) — building a linux launcher" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) LAUNCHER_GOARCH=arm64 ;;
  x86_64|amd64)  LAUNCHER_GOARCH=amd64 ;;
  *)             LAUNCHER_GOARCH=amd64; warn "Unrecognized host arch $(uname -m) — building amd64" ;;
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

# --- What is kept between runs, kept bounded ---
#
# Each tool keeps what it downloads and compiles, and none of them forgets a
# version it no longer needs: npm's and uv's caches, Go's module cache, and
# cargo's registry each hold every version a run ever fetched, and Go trims its
# build cache only as it runs. So each directory is held to one size: one over it is
# emptied, and the next run fetches or compiles what it needs again.
CACHE_LIMIT_KB=$((8 * 1024 * 1024))
banner "CACHES"
for cache in "$NPM_CACHE_DIR" "$GOCACHE_DIR" "$GOMODCACHE_DIR" "$UVCACHE_DIR" "$CARGO_REGISTRY_DIR"; do
  used=$(du -sk "$cache" 2>/dev/null | cut -f1)
  if [[ "${used:-0}" -gt "$CACHE_LIMIT_KB" ]]; then
    # Go writes its module cache read-only.
    chmod -R u+w "$cache" 2>/dev/null || true
    find "$cache" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
    warn "${cache/#$HOME/~} held $((used / 1024)) MB, over $((CACHE_LIMIT_KB / 1024)) MB: emptied"
  else
    echo -e "  ${DIM}${cache/#$HOME/~}: $((${used:-0} / 1024)) MB${RESET}"
  fi
done

banner "DONE ✓"
print_summary

if [[ "$PACKAGES_ONLY" != true ]]; then
  if [[ -n "$FANOUT_FAILURES" ]]; then
    echo -e "${BOLD}Images tagged :local are in the ${RT} image store${RESET} (fan-out partially failed:${FANOUT_FAILURES// / })"
  elif [[ -n "$FANOUT_RTS" ]]; then
    echo -e "${BOLD}Images tagged :local are in every local image store:${RESET} $RT${FANOUT_RTS}"
  elif [[ "$FANOUT" != true ]]; then
    echo -e "${BOLD}Images tagged :local are in the ${RT} image store${RESET} (--no-fanout)"
  else
    echo -e "${BOLD}Images tagged :local are in the ${RT} image store${RESET} (no other engines detected)"
  fi
  echo ""

  echo -e "${BOLD}Run the full stack from your KB against these images:${RESET}"
  echo ""
  echo -e "    ${BOLD}cd /path/to/your-kb${RESET}"
  echo -e "    (name the ${DIM}:local${RESET} images in .semiont/stack/*.yaml, e.g. ghcr.io/the-ai-alliance/semiont-gateway:local,"
  echo -e "     and the Browser's in its own document:)"
  echo -e "    ${BOLD}perl -pi -e 's#(semiont-browser):\\S+#\$1:local#' \"\$($REPO_ROOT/apps/launcher/dist/semiont settings browser --path)\"${RESET}"
  echo -e "    ${BOLD}$REPO_ROOT/apps/launcher/dist/semiont start${RESET}"
  echo -e "    ${BOLD}echo password | $REPO_ROOT/apps/launcher/dist/semiont useradd --email admin@example.com${RESET}"
  echo ""
  echo -e "  (semiont start pulls no image tagged ${DIM}:local${RESET}; it runs these.)"
  echo ""

  echo -e "${BOLD}Or run a single image, e.g. the browser:${RESET}"
  echo -e "  $RT run --publish 3000:3000 -it ghcr.io/the-ai-alliance/semiont-browser:local"
  echo ""
fi

PYTHON_SDK_WHEELS=("$REPO_ROOT"/packages/python/sdk/dist/*.whl)
if [[ -e "${PYTHON_SDK_WHEELS[0]}" ]]; then
  echo -e "${BOLD}The Python SDK is built, and published nowhere. Install it by path:${RESET}"
  echo -e "  pip install ${PYTHON_SDK_WHEELS[0]}"
  echo ""
fi

if [[ "$VERDACCIO_OURS" == true ]]; then
  echo -e "${DIM}Stop Verdaccio when done:${RESET}  $RT stop $VERDACCIO_NAME"
  echo ""
fi
echo -e "\033[2m[$(date '+%Y-%m-%d %H:%M:%S')] local-build finished\033[0m"
