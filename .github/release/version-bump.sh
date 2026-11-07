#!/usr/bin/env bash
set -euo pipefail

# Version Bump: Update version across all packages, commit, and push
#
# Usage:
#   ./.github/release/version-bump.sh patch
#   ./.github/release/version-bump.sh minor
#   ./.github/release/version-bump.sh major
#   ./.github/release/version-bump.sh        # Interactive prompt

cd "$(git rev-parse --show-toplevel)"

# --- Helpers ---

die() { echo "error: $1" >&2; exit 1; }

# Resolve the container runtime (mirrors images/scripts/container-utils.js):
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
echo "  2. Update all package.json files, the published crates (Cargo.toml, Cargo.lock) and the Haskell SDK's manifest (semiont.cabal)"
echo "  3. Regenerate every package-lock.json (npm, in ${RUNTIME})"
echo "  4. Commit and push to $(git rev-parse --abbrev-ref HEAD)"
echo ""
read -rp "Proceed? (y/N): " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }

# Phase 1: Update versions
echo ""
echo "Bumping ${CURRENT} → ${NEXT}..."

update_version_json "$NEXT"

FILES=(version.json package.json)

for dir in packages/typescript/*/; do
  pkg="${dir}package.json"
  if [[ -f "$pkg" ]]; then
    update_package_json "$pkg" "$NEXT"
    FILES+=("$pkg")
  fi
done

for dir in apps/*/ images/*/; do
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

# The crates published to crates.io move with every package.json.
./packages/rust/scripts/cargo-version.sh "$NEXT"
FILES+=(packages/rust/Cargo.toml packages/rust/Cargo.lock)

# So does the Haskell SDK's manifest, which its codegen writes from the root
# package.json.
./packages/haskell/scripts/cabal-version.sh "$NEXT"
FILES+=(packages/haskell/sdk/semiont.cabal)

# Phase 2: Verify
echo ""
echo "Verifying version sync..."
ERRORS=0
for pkg in packages/typescript/*/package.json apps/*/package.json images/*/package.json; do
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

# Phase 2.5: Regenerate every committed package-lock.json so each matches the new
# versions: an npm project outside the root workspace records the version of
# each bumped package it links, too. npm is the only thing that produces a
# correct lockfileVersion-3 lock (a hand jq-edit desyncs its interlinked version
# records); run it in a Node container, at the version .node-version names,
# because the release host has no Node.
echo ""
NODE_IMAGE="node:$(packages/typescript/scripts/node-version.sh)"
LOCKS=$(git ls-files '*package-lock.json')
for lock in $LOCKS; do
  echo "Regenerating ${lock} (npm in ${RUNTIME})..."
  "$RUNTIME" run --rm -v "$PWD":/work -w "/work/$(dirname "$lock")" "$NODE_IMAGE" \
    npm install --package-lock-only --include=optional
  FILES+=("$lock")
done
LOCK_VERSION=$(jq -r '.packages[""].version' package-lock.json)
[[ "$LOCK_VERSION" == "$NEXT" ]] || die "package-lock.json root is '${LOCK_VERSION}' after regen (expected ${NEXT})"
NAMES=$(jq -c '.packages | keys' version.json)
for lock in $LOCKS; do
  STALE=$(jq -r --arg v "$NEXT" --argjson names "$NAMES" '
    .packages | to_entries[]
    | select((.key | startswith("node_modules/") | not) and (.value.name as $n | $names | index($n)) and .value.version != $v)
    | "\(.key) (\(.value.name)) at \(.value.version)"' "$lock")
  [[ -z "$STALE" ]] || die "${lock} still records, after regen: ${STALE}"
done
echo "  every package-lock.json regenerated; each records ${NEXT} for the packages it links"

# Phase 3: Commit and push
echo ""
COMMIT_MSG="bump version to ${NEXT}

This commit bumps the version after releasing ${CURRENT} as stable.

Version bump type: ${BUMP_TYPE}
- All package.json files updated to ${NEXT}
- The published crates updated to ${NEXT} (Cargo.toml, Cargo.lock)
- The Haskell SDK's manifest updated to ${NEXT} (semiont.cabal)
- Every package-lock.json regenerated to match
- Publish manually via GitHub Actions workflow dispatch"

git add "${FILES[@]}"
git commit --signoff --gpg-sign -m "$COMMIT_MSG"
# -u origin HEAD so the first push of a fresh bump branch sets its upstream
# instead of failing with "has no upstream branch"; a no-op once tracking exists.
git push -u origin HEAD

echo ""
echo "Done. Version bumped from ${CURRENT} to ${NEXT}."
echo ""
echo "Next: open a PR for this branch and merge it, then release from main:"
echo ""
echo "  ./.github/release/preflight.sh                  # is main releasable?"
echo "  gh workflow run release.yml                     # publishes every channel"
echo "  ./.github/release/notes-context.sh              # assemble the post's context"
echo "  ./.github/release/announce.sh ${NEXT} <draft.md> --post"
echo "  ./.github/release/verify-release.sh ${NEXT}"
