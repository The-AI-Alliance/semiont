#!/usr/bin/env bash
# Sourced by the local build session.

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
  [[ -f "$df" ]] || continue
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
    --image) if [[ -n "$2" ]]; then IMAGES="${2//,/ }"; IMAGES_NAMED=true; fi; shift 2 ;;
    --force) FORCE=true; shift ;;
    --no-fanout) FANOUT=false; shift ;;
    --layer-cache) LAYER_CACHE="$2"; shift 2 ;;
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

[[ "$OPERATION" == packages ]] && PACKAGES_ONLY=true
[[ "$OPERATION" == images-only ]] && IMAGES_ONLY=true
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
