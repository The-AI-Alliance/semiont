#!/usr/bin/env bash
set -euo pipefail

# Build Semiont packages and apps.
#
# Usage:
#   ./scripts/ci/build.sh                        # build everything
#   ./scripts/ci/build.sh --package core,backend  # build only core and backend
#   ./scripts/ci/build.sh --start-from react-ui   # skip packages before react-ui
#
# The list of packages and the build order come from `version.json`
# (the workspace's single source of truth for the package manifest).
# Each entry's `dir` field's basename is the bare name used by the
# `--package` / `--start-from` CLI args.
#
# Library packages (under `packages/`) are built first, in the order
# version.json lists them; apps (`backend`, `frontend`) follow.
# App staging (.npm-stage/) is the publish flow's job — see
# scripts/ci/publish.sh, which runs publish-npm-apps.mjs itself.
#
# Dependencies are always installed. OpenAPI spec is always bundled.

cd "$(git rev-parse --show-toplevel)"

# --- Colors ---

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

banner() { echo -e "\n${CYAN}${BOLD}══════════════════════════════════════════════════════════════${RESET}"; echo -e "${CYAN}${BOLD}  $1${RESET}"; echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════════${RESET}\n"; }
step()   { echo -e "${GREEN}▸${RESET} $1"; }
ok()     { echo -e "${GREEN}✓${RESET} $1"; }

# --- Parse arguments ---

PACKAGES=""
START_FROM=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --package) PACKAGES="$2"; shift 2 ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    *) echo -e "${RED}Unknown argument: $1${RESET}" >&2; exit 1 ;;
  esac
done

# Read package manifest. ALL = bare names (basename of each `dir`) in
# the order version.json lists them, restricted to packages that ship
# to npm. Non-publishable entries (mcp-server, desktop) are
# out of scope for this script — desktop in particular has a Rust/Tauri
# build that doesn't run in the CI node container.
read_manifest() {
  node -e "
    const fs = require('fs');
    const v = JSON.parse(fs.readFileSync('version.json', 'utf-8'));
    for (const [name, pkg] of Object.entries(v.packages)) {
      if (!pkg.publish) continue;
      const pkgJson = JSON.parse(fs.readFileSync(pkg.dir + '/package.json', 'utf-8'));
      if (pkgJson.scripts && pkgJson.scripts.build) {
        const bare = pkg.dir.split('/').pop();
        const kind = pkg.dir.startsWith('packages/') ? 'lib' : 'app';
        console.log(bare + '\t' + name + '\t' + kind);
      }
    }
  "
}

MANIFEST=$(read_manifest)
ALL=($(echo "$MANIFEST" | awk '{print $1}'))

# Resolve which packages to build
if [[ -n "$START_FROM" ]]; then
  TARGETS=()
  FOUND=false
  for pkg in "${ALL[@]}"; do
    if [[ "$pkg" == "$START_FROM" ]]; then
      FOUND=true
    fi
    if [[ "$FOUND" == "true" ]]; then
      TARGETS+=("$pkg")
    fi
  done
  if [[ "$FOUND" != "true" ]]; then
    echo -e "${RED}Unknown package: $START_FROM${RESET}" >&2
    echo "Valid packages: ${ALL[*]}" >&2
    exit 1
  fi
elif [[ -n "$PACKAGES" ]]; then
  IFS=',' read -ra TARGETS <<< "$PACKAGES"
  # Validate, exactly as --start-from above does. Without this an unmatched
  # name — a typo, or the SCOPED form `@semiont/react-ui` when this script
  # wants the bare `react-ui` — silently selects nothing: both build sections
  # run empty, "BUILD COMPLETE ✓" prints, publish pushes the PREVIOUS dist,
  # and the resulting image is stale in a way that only shows up as "my change
  # isn't in there". Measured 2026-08-21: a full 60s cycle produced an image
  # containing none of the intended work.
  UNKNOWN=()
  for t in "${TARGETS[@]}"; do
    MATCHED=false
    for pkg in "${ALL[@]}"; do
      [[ "$t" == "$pkg" ]] && MATCHED=true && break
    done
    [[ "$MATCHED" == "true" ]] || UNKNOWN+=("$t")
  done
  if (( ${#UNKNOWN[@]} > 0 )); then
    echo -e "${RED}Unknown package(s): ${UNKNOWN[*]}${RESET}" >&2
    echo "" >&2
    echo "Valid packages: ${ALL[*]}" >&2
    echo "" >&2
    for u in "${UNKNOWN[@]}"; do
      if [[ "$u" == @semiont/* ]]; then
        echo "  '$u' looks scoped — this flag takes BARE names: '${u#@semiont/}'" >&2
      fi
    done
    echo "" >&2
    echo "  --package builds ONLY what you name (no dependency closure)." >&2
    echo "  To build a package and everything downstream of it, use:" >&2
    echo "    --start-from <name>" >&2
    exit 1
  fi
else
  TARGETS=("${ALL[@]}")
fi

# Announce the selection. An empty or unexpected list is then visible HERE,
# at the top, rather than inferred from two silent section headers later.
echo -e "${BOLD:-}Building ${#TARGETS[@]} package(s):${RESET} ${TARGETS[*]}"

should_build() {
  local name="$1"
  for t in "${TARGETS[@]}"; do
    [[ "$t" == "$name" ]] && return 0
  done
  return 1
}

# --- Install + OpenAPI (always) ---

banner "INSTALL DEPENDENCIES"
npm install --include=optional

banner "BUNDLE OPENAPI SPEC"
npm run openapi:bundle

# --- Library packages ---

banner "BUILD LIBRARY PACKAGES"

# Iterate the manifest in order; build everything tagged `lib`.
while IFS=$'\t' read -r bare name kind; do
  [[ "$kind" == "lib" ]] || continue
  if should_build "$bare"; then
    step "Building $name..."
    npm run build --workspace="$name"
    ok "$name"
  fi
done <<< "$MANIFEST"

# --- Apps ---

banner "BUILD APPS"

while IFS=$'\t' read -r bare name kind; do
  [[ "$kind" == "app" ]] || continue
  if should_build "$bare"; then
    step "Building $name..."
    npm run build --workspace="$name"
    ok "$name"
  fi
done <<< "$MANIFEST"

banner "BUILD COMPLETE ✓"
