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
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# --- Determine version ---

if [[ -z "$VERSION" ]]; then
  VERSION=$(node -p "require('./version.json').version")
fi
echo "==> Publishing version: $VERSION (tag: $TAG, registry: $REGISTRY)"

# --- Stamp version into all package.json files ---

echo "==> Stamping version $VERSION..."
node -e "
  const fs = require('fs');
  const version = '$VERSION';

  const versionJson = JSON.parse(fs.readFileSync('version.json', 'utf-8'));
  versionJson.version = version;
  for (const pkg of Object.keys(versionJson.packages)) {
    versionJson.packages[pkg] = version;
  }
  fs.writeFileSync('version.json', JSON.stringify(versionJson, null, 2) + '\n');
  console.log('  version.json → ' + version);

  const packages = [
    'packages/api-client',
    'packages/ontology',
    'packages/core',
    'packages/content',
    'packages/event-sourcing',
    'packages/graph',
    'packages/inference',
    'packages/jobs',
    'packages/make-meaning',
    'packages/react-ui',
  ];

  for (const dir of packages) {
    const path = dir + '/package.json';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf-8'));
    pkg.version = version;
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
    console.log('  ' + pkg.name + ' → ' + version);
  }

  const cliPath = 'apps/cli/package.json';
  const cli = JSON.parse(fs.readFileSync(cliPath, 'utf-8'));
  cli.version = version;
  for (const dep of Object.keys(cli.dependencies || {})) {
    if (dep.startsWith('@semiont/')) {
      cli.dependencies[dep] = version;
    }
  }
  fs.writeFileSync(cliPath, JSON.stringify(cli, null, 2) + '\n');
  console.log('  ' + cli.name + ' → ' + version + ' (with dependencies)');
"

# --- Stage app packages ---

echo "==> Staging backend and frontend..."
node scripts/ci/publish-npm-apps.mjs

# --- Build npmrc args ---

NPMRC_ARGS=()
if [[ -n "$NPMRC" ]]; then
  NPMRC_ARGS=(--userconfig "$NPMRC")
fi

# --- Publish ---

publish_pkg() {
  local dir="$1"
  local label="${2:-}"
  local pkg_name pkg_version
  pkg_name=$(node -p "require('./$dir/package.json').name")
  pkg_version=$(node -p "require('./$dir/package.json').version")

  if [[ "$CLEAN" == "true" ]]; then
    echo "  Unpublishing $pkg_name@$pkg_version..."
    npm unpublish "$pkg_name@$pkg_version" --registry "$REGISTRY" "${NPMRC_ARGS[@]}" --force 2>/dev/null || true
  fi

  echo "  Publishing $pkg_name@$pkg_version${label:+ ($label)}..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY RUN] Would publish $pkg_name@$pkg_version"
  else
    (cd "$dir" && npm publish --registry "$REGISTRY" --tag "$TAG" --access public "${NPMRC_ARGS[@]}")
  fi
}

echo "==> Publishing packages to $REGISTRY..."

# Library packages and CLI
for dir in \
  packages/core \
  packages/event-sourcing \
  packages/content \
  packages/graph \
  packages/inference \
  packages/jobs \
  packages/make-meaning \
  packages/api-client \
  packages/ontology \
  packages/react-ui \
  packages/mcp-server \
  packages/test-utils \
  apps/cli
do
  publish_pkg "$dir"
done

# Staged app packages
for dir in .npm-stage/backend .npm-stage/frontend; do
  publish_pkg "$dir" "staged"
done

echo "==> Publish complete."
