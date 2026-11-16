#!/usr/bin/env bash
set -euo pipefail

# Version Bump: Update version across all packages, commit, and push
#
# Usage:
#   ./scripts/release/version-bump.sh patch
#   ./scripts/release/version-bump.sh minor
#   ./scripts/release/version-bump.sh major
#   ./scripts/release/version-bump.sh        # Interactive prompt

cd "$(git rev-parse --show-toplevel)"

# --- Helpers ---

die() { echo "error: $1" >&2; exit 1; }

# Resolve the container runtime (mirrors scripts/container/container-utils.js):
# honor $CONTAINER_RUNTIME, else the first of container/docker/podman present.
resolve_container_runtime() {
  if [[ -n "${CONTAINER_RUNTIME:-}" ]]; then echo "$CONTAINER_RUNTIME"; return; fi
  local rt
  for rt in container docker podman; do
    command -v "$rt" >/dev/null 2>&1 && { echo "$rt"; return; }
  done
  die "no container runtime found (Apple Container, Docker, or Podman) — needed to regenerate package-lock.json"
}

check_deps() {
  command -v jq >/dev/null 2>&1 || die "jq is required (brew install jq)"
  command -v git >/dev/null 2>&1 || die "git is required"
}

current_version() {
  jq -r .version version.json
}

validate_version() {
  local version=$1
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    die "version '${version}' is not valid semver (expected X.Y.Z)"
  fi
}

bump_version() {
  local version=$1 type=$2
  local major minor patch
  IFS='.' read -r major minor patch <<< "$version"
  # Force base-10 to avoid octal interpretation
  major=$((10#$major))
  minor=$((10#$minor))
  patch=$((10#$patch))
  case "$type" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "${major}.$((minor + 1)).0" ;;
    patch) echo "${major}.${minor}.$((patch + 1))" ;;
    *) die "invalid bump type: $type" ;;
  esac
}

ask_bump_type() {
  echo ""
  echo "What type of version bump for the next development cycle?"
  echo "  1) patch (${1} → $(bump_version "$1" patch)) - Bug fixes and minor updates"
  echo "  2) minor (${1} → $(bump_version "$1" minor)) - New features, backward compatible"
  echo "  3) major (${1} → $(bump_version "$1" major)) - Breaking changes"
  echo ""
  read -rp "Enter choice (1/2/3 or patch/minor/major): " choice
  case "$choice" in
    1|patch) echo "patch" ;;
    2|minor) echo "minor" ;;
    3|major) echo "major" ;;
    *) echo "patch"; echo "Invalid choice. Defaulting to patch." >&2 ;;
  esac
}

update_version_json() {
  local version=$1
  # Each entry in `.packages` is `{ dir, version, publish, stage? }`.
  # Bump the top-level version + the `version` field on every entry,
  # leaving dir/publish/stage untouched.
  jq --arg v "$version" '
    .version = $v |
    .packages |= with_entries(.value.version = $v)
  ' version.json > version.json.tmp && mv version.json.tmp version.json
}

update_package_json() {
  local file=$1 version=$2
  jq --arg v "$version" '.version = $v' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
}

# --- Main ---

check_deps
RUNTIME=$(resolve_container_runtime)

CURRENT=$(current_version)
validate_version "$CURRENT"
echo ""
echo "Current version (just released as stable): ${CURRENT}"

# Get bump type from argument or prompt
BUMP_TYPE="${1:-}"
if [[ -z "$BUMP_TYPE" ]]; then
  BUMP_TYPE=$(ask_bump_type "$CURRENT")
fi

NEXT=$(bump_version "$CURRENT" "$BUMP_TYPE")

echo ""
echo "This will:"
echo "  1. Bump version from ${CURRENT} to ${NEXT} (${BUMP_TYPE})"
echo "  2. Update all package.json files"
echo "  3. Regenerate package-lock.json (npm, in ${RUNTIME})"
echo "  4. Commit and push to main"
echo ""
read -rp "Proceed? (y/N): " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }

# Phase 1: Update versions
echo ""
echo "Bumping ${CURRENT} → ${NEXT}..."

update_version_json "$NEXT"

FILES=(version.json package.json)

for dir in packages/*/; do
  pkg="${dir}package.json"
  if [[ -f "$pkg" ]]; then
    update_package_json "$pkg" "$NEXT"
    FILES+=("$pkg")
  fi
done

for dir in apps/*/; do
  pkg="${dir}package.json"
  if [[ -f "$pkg" ]]; then
    update_package_json "$pkg" "$NEXT"
    FILES+=("$pkg")
  fi
  publish="${dir}package.publish.json"
  if [[ -f "$publish" ]]; then
    update_package_json "$publish" "$NEXT"
    FILES+=("$publish")
  fi
done

# Update root package.json
update_package_json package.json "$NEXT"

# Phase 2: Verify
echo ""
echo "Verifying version sync..."
ERRORS=0
for pkg in packages/*/package.json apps/*/package.json; do
  [[ -f "$pkg" ]] || continue
  PKG_VERSION=$(jq -r .version "$pkg")
  if [[ "$PKG_VERSION" != "$NEXT" ]]; then
    echo "  MISMATCH: $pkg has $PKG_VERSION (expected $NEXT)"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ "$ERRORS" -gt 0 ]]; then
  die "$ERRORS package(s) have mismatched versions"
fi
echo "  All packages at ${NEXT}"

# Phase 2.5: Regenerate package-lock.json so the committed lock matches the new
# versions. npm is the only thing that produces a correct lockfileVersion-3 lock
# (a hand jq-edit desyncs its interlinked version records); run it in a node:24
# container because the release host has no Node.
echo ""
echo "Regenerating package-lock.json (npm in ${RUNTIME})..."
"$RUNTIME" run --rm -v "$PWD":/work -w /work node:24 \
  npm install --package-lock-only --include=optional
LOCK_VERSION=$(jq -r '.packages[""].version' package-lock.json)
[[ "$LOCK_VERSION" == "$NEXT" ]] || die "package-lock.json root is '${LOCK_VERSION}' after regen (expected ${NEXT})"
FILES+=(package-lock.json)
echo "  package-lock.json regenerated at ${NEXT}"

# Phase 3: Commit and push
echo ""
COMMIT_MSG="bump version to ${NEXT}

This commit bumps the version after releasing ${CURRENT} as stable.

Version bump type: ${BUMP_TYPE}
- All package.json files updated to ${NEXT}
- package-lock.json regenerated to match
- Publish manually via GitHub Actions workflow dispatch"

git add "${FILES[@]}"
git commit --signoff --gpg-sign -m "$COMMIT_MSG"
git push

echo ""
echo "Done. Version bumped from ${CURRENT} to ${NEXT}."
echo ""
echo "To publish, trigger the Release workflow:"
echo "  gh workflow run release.yml"
echo "  or: Actions > Release > Run workflow"
