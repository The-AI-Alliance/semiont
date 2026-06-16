#!/usr/bin/env bash
set -euo pipefail

# Publish all @semiont/* packages to a registry.
#
# Usage:
#   ./scripts/ci/publish.sh [options]
#
# Options:
#   --registry <url>   Target registry (default: https://registry.npmjs.org)
#   --tag <tag>        Dist tag: latest or dev (default: latest)
#   --version <ver>    Override publish version (default: read from version.json)
#   --clean            Unpublish existing versions before publishing (for Verdaccio)
#   --npmrc <path>     Path to .npmrc for registry auth
#   --dry-run          Stage but do not publish

cd "$(git rev-parse --show-toplevel)"

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

# --- Parse arguments ---

REGISTRY="https://registry.npmjs.org"
TAG="latest"
VERSION=""
CLEAN=false
NPMRC=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --clean) CLEAN=true; shift ;;
    --npmrc) NPMRC="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo -e "${RED}Unknown argument: $1${RESET}" >&2; exit 1 ;;
  esac
done

# --- Determine version ---

if [[ -z "$VERSION" ]]; then
  VERSION=$(node -p "require('./version.json').version")
fi

banner "STAMP VERSIONS"
echo -e "  Version: ${BOLD}$VERSION${RESET}  Tag: ${BOLD}$TAG${RESET}  Registry: ${DIM}$REGISTRY${RESET}"
echo ""

node scripts/ci/stamp-versions.mjs "$VERSION"

# --- Stage app packages ---

banner "STAGE APPS"
node scripts/ci/publish-npm-apps.mjs

# --- Build npmrc args ---

NPMRC_ARGS=()
if [[ -n "$NPMRC" ]]; then
  NPMRC_ARGS=(--userconfig "$NPMRC")
fi

# --- Publish ---

banner "PUBLISH PACKAGES"

publish_pkg() {
  local dir="$1"
  local label="${2:-}"
  local pkg_name pkg_version
  pkg_name=$(node -p "require('./$dir/package.json').name")
  pkg_version=$(node -p "require('./$dir/package.json').version")

  if [[ "$CLEAN" == "true" ]]; then
    echo -e "  ${DIM}unpublish${RESET} $pkg_name@$pkg_version"
    npm unpublish "$pkg_name@$pkg_version" --registry "$REGISTRY" "${NPMRC_ARGS[@]}" --force 2>/dev/null || true
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "  ${YELLOW}dry-run${RESET}  $pkg_name@$pkg_version${label:+ ($label)}"
  else
    (cd "$dir" && npm publish --registry "$REGISTRY" --tag "$TAG" --access public "${NPMRC_ARGS[@]}")
    ok "$pkg_name@$pkg_version${label:+ ($label)}"
  fi
}

# Iterate every publishable package in version.json. Output is two
# tab-separated columns: dir-to-publish-from, label. Apps with a
# `stage` field publish from .npm-stage/<x> rather than apps/<x>.
PUBLISH_LIST=$(node -e "
  const v = JSON.parse(require('fs').readFileSync('version.json', 'utf-8'));
  for (const pkg of Object.values(v.packages)) {
    if (!pkg.publish) continue;
    const dir = pkg.stage || pkg.dir;
    const label = pkg.stage ? 'staged' : '';
    console.log(dir + '\t' + label);
  }
")

while IFS=$'\t' read -r dir label; do
  publish_pkg "$dir" "$label"
done <<< "$PUBLISH_LIST"

banner "PUBLISH COMPLETE ✓"
