#!/usr/bin/env bash
set -euo pipefail

# Build Semiont packages and apps.
#
# Usage:
#   ./scripts/ci/build.sh                        # build everything
#   ./scripts/ci/build.sh --package cli,backend   # build only CLI and backend
#   ./scripts/ci/build.sh --start-from react-ui   # skip packages before react-ui
#
# The list of packages and the build order come from `version.json`
# (the workspace's single source of truth for the package manifest).
# Each entry's `dir` field's basename is the bare name used by the
# `--package` / `--start-from` CLI args.
#
# Library packages (under `packages/`) are built first, in the order
# version.json lists them. Apps (`backend`, `frontend`, `cli`) are
# built after libraries — `cli` last because it bundles the staged
# frontend artifacts.
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
# the order version.json lists them, filtered to those with a build
# script (skips packages that exist only for testing scaffolding).
read_manifest() {
  node -e "
    const fs = require('fs');
    const v = JSON.parse(fs.readFileSync('version.json', 'utf-8'));
    for (const [name, pkg] of Object.entries(v.packages)) {
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
else
  TARGETS=("${ALL[@]}")
fi

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

# Build any non-cli apps first (backend / frontend / desktop).
while IFS=$'\t' read -r bare name kind; do
  [[ "$kind" == "app" && "$bare" != "cli" ]] || continue
  if should_build "$bare"; then
    step "Building $name..."
    npm run build --workspace="$name"
    ok "$name"
  fi
done <<< "$MANIFEST"

# Stage backend + frontend, then build CLI — the CLI bundles
# dist/frontend/ from .npm-stage/frontend, so staging must happen
# between the frontend build and the cli build.
if should_build cli; then
  step "Staging apps for CLI bundling..."
  node scripts/ci/publish-npm-apps.mjs
  ok "Apps staged"

  step "Building CLI..."
  npm run build --workspace=@semiont/cli
  ok "CLI"
fi

banner "BUILD COMPLETE ✓"
