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

node -e "
  const fs = require('fs');
  const version = '$VERSION';

  const versionJson = JSON.parse(fs.readFileSync('version.json', 'utf-8'));
  versionJson.version = version;
  for (const pkg of Object.values(versionJson.packages)) {
    pkg.version = version;
  }
  fs.writeFileSync('version.json', JSON.stringify(versionJson, null, 2) + '\n');
  console.log('  version.json → ' + version);

  // Stamp every package.json that has a corresponding entry in
  // version.json — including non-published ones (test-utils,
  // mcp-server, desktop) so the workspace stays version-coherent.
  // Bump cross-references to other @semiont/* packages too, so
  // published tarballs install against the new version on registries
  // that don't honor workspace ranges.
  for (const pkg of Object.values(versionJson.packages)) {
    const path = pkg.dir + '/package.json';
    const json = JSON.parse(fs.readFileSync(path, 'utf-8'));
    json.version = version;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (!json[section]) continue;
      for (const dep of Object.keys(json[section])) {
        if (dep.startsWith('@semiont/') || dep.startsWith('semiont-')) {
          // Don't touch '*' workspace ranges — npm resolves those at publish time.
          if (json[section][dep] !== '*') {
            json[section][dep] = version;
          }
        }
      }
    }
    fs.writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
    console.log('  ' + json.name + ' → ' + version);
  }
"

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
