#!/usr/bin/env bash
# Sourced by the local build session.

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
GOPROXY_CACHED='file:///go/pkg/mod/cache/download,https://proxy.golang.org,direct'

source "$BUILD_DIR/toolchains.sh"
case "$OPERATION" in
  launcher) load_go_toolchain ;;
  npm-publish-local) load_node_toolchain ;;
  *)
    load_go_toolchain
    load_rust_toolchain
    load_python_toolchain
    load_node_toolchain
    load_jdk_toolchain
    load_swift_toolchain
    load_dotnet_toolchain
    ;;
esac

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
GRADLE_HOME_DIR="$CACHE_ROOT/local-build-gradle"
NUGET_CACHE_DIR="$CACHE_ROOT/nuget"
SWIFTPM_DIR="$CACHE_ROOT/local-build-swiftpm"

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


prepare_caches() {
  if [[ "$OPERATION" == launcher ]]; then
    mkdir -p "$GOCACHE_DIR" "$GOMODCACHE_DIR"
    return
  fi
  mkdir -p "$NPM_CACHE_DIR" "$GOCACHE_DIR" "$GOMODCACHE_DIR" "$UVCACHE_DIR" "$CARGO_REGISTRY_DIR" "$GRADLE_HOME_DIR" "$SWIFTPM_DIR"
}
