#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/images"
BUILD_DIR="$SCRIPT_DIR/scripts/local-build"
cd "$REPO_ROOT"
OPERATION="${1:?A build operation is required}"
shift
case "$OPERATION" in
  local-build|packages|images-only|launcher|npm-publish-local|plan) ;;
  *) echo "Unknown build operation: $OPERATION" >&2; exit 2 ;;
esac
source "$BUILD_DIR/common.sh"
source "$BUILD_DIR/selection.sh"

VERDACCIO_NAME=semiont-verdaccio
VERDACCIO_USER=semiont
VERDACCIO_PASS=semiont
REGISTRY=http://localhost:4873
VERDACCIO_OURS=false
SESSION_SUCCEEDED=false
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [[ "$SESSION_SUCCEEDED" != true ]]; then
    if declare -F stop_builds >/dev/null; then stop_builds; fi
    if [[ "$VERDACCIO_OURS" == true ]]; then
      "$RT" stop "$VERDACCIO_NAME" >/dev/null 2>&1 || true
      "$RT" rm "$VERDACCIO_NAME" >/dev/null 2>&1 || true
    fi
  fi
  stop_python_tools
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$OPERATION" == plan ]]; then
  start_python_tools
  source "$BUILD_DIR/package-plan.sh"
  print_summary
  printf "%s" "$PACKAGE_REASONS"
  source "$BUILD_DIR/image-plan.sh"
  for image in $IMAGES; do
    decide_image "$image"
    echo "  images/$image: $IMAGE_ACTION ($IMAGE_REASON)"
    if [[ " $REGISTRY_IMAGES " == *" $image "* && "$FORCE" != true && "$IMAGES_NAMED" != true ]]; then
      echo "    npm integrity is the current registry snapshot; fresh publication is rechecked before building."
    fi
  done
  [[ -n "$REGISTRY_IMAGES" ]] && echo "  registry: fresh local npm publication required for $REGISTRY_IMAGES"
  echo "  launcher: build for the host"
  SESSION_SUCCEEDED=true
  exit 0
fi
prepare_caches
if [[ "$OPERATION" == launcher ]]; then
  source "$BUILD_DIR/launcher.sh"
  SESSION_SUCCEEDED=true
  exit 0
fi
start_python_tools
source "$BUILD_DIR/publication.sh"
if [[ "$OPERATION" == npm-publish-local ]]; then
  verify_local_npm
  source "$BUILD_DIR/registry.sh"
  publish_local_npm
  echo "Local npm packages are available at $REGISTRY; stop with: $RT stop $VERDACCIO_NAME"
  SESSION_SUCCEEDED=true
  exit 0
fi
source "$BUILD_DIR/package-plan.sh"
source "$BUILD_DIR/packages.sh"
if [[ "$OPERATION" == local-build ]]; then source "$BUILD_DIR/checks.sh"; fi
if [[ "$OPERATION" != packages ]]; then source "$BUILD_DIR/registry.sh"; fi
if [[ "$IMAGES_ONLY" != true ]]; then
  banner PACKAGES
  build_npm
  build_rust
  build_python
  build_go
  build_kotlin
  build_csharp
  build_swift
fi
if [[ "$OPERATION" == packages ]]; then
  print_summary
  SESSION_SUCCEEDED=true
  exit 0
fi
source "$BUILD_DIR/images.sh"
source "$BUILD_DIR/launcher.sh"
source "$BUILD_DIR/cache-maintenance.sh"
source "$BUILD_DIR/summary.sh"
SESSION_SUCCEEDED=true
