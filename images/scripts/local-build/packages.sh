#!/usr/bin/env bash
# Sourced by the local build session.

# --- The packages ---
#
# Each language's packages build in one container of its own, in turn, and each
# is recorded as built when its language's build has succeeded. Each container
# states its memory: Apple container's default is 1G, in which cargo compiling
# the workspace's crates thrashes at full CPU and never finishes.

# shown <list>: a comma-separated list as a reader reads one, or "nothing to build".
shown() { [[ -n "$1" ]] && echo "${1//,/, }" || echo "nothing to build"; }

# names_of <dir>...: the names their builds take, comma-separated.
names_of() {
  local dir names=""
  for dir in "$@"; do names="$names,$(plan_field "$dir" 3)"; done
  echo "${names#,}"
}

# The npm packages, with packages/typescript/scripts/build.sh, and the app each image that
# installs from the registry installs (images/<name>, which version.json lists
# under that name): its bundle holds the packages, so it is built whenever its
# image may be. Then all of version.json's published entries go to Verdaccio,
# which this run started empty.
build_npm() {
  local packages names img publish=false then="" done="built"
  packages=$(packages_of typescript)
  names=$(names_of $packages)
  if [[ "$OPERATION" == packages && " $PACKAGES_NAMED " == *" typescript "* ]]; then
    local apps
    apps=$(python3 -c 'import json,pathlib; v=json.load(open("version.json")); print(",".join(pathlib.Path(p["dir"]).name for p in v["packages"].values() if p.get("publish") and p.get("stage")))')
    names="${names:+$names,}$apps"
  fi
  for img in $REGISTRY_IMAGES; do names="${names:+$names,}$img"; done
  [[ -n "$REGISTRY_IMAGES" ]] && publish=true && then=", then publish to Verdaccio" && done="built and published to Verdaccio"
  [[ -z "$names" && "$publish" != true ]] && return 0

  step "npm: $(shown "$names")${then} ${DIM}(in ${NODE_IMAGE})${RESET}"
  if ! run_logged "npm: $done" \
    $RT run --rm \
    -v "$REPO_ROOT":/workspace \
    -v "$NPM_CACHE_DIR":/root/.npm \
    -w /workspace \
    -m 8g \
    -e NODE_OPTIONS="--max-old-space-size=4096" \
    "$NODE_IMAGE" \
    sh -c "
      set -e
      apk add --no-cache bash git > /dev/null
      if [ -n '$names' ]; then
        ./packages/typescript/scripts/build.sh --package '$names'
      fi
    "; then
    fail "The npm packages did not build, or did not publish (packages/typescript/scripts/build.sh or publish.sh says why, above)."
    exit 1
  fi
  [[ "$publish" == true ]] && publish_local_npm
  built $packages
}

# The Rust crates, with one cargo build of them all. The registry cargo
# downloads is this script's, mounted where the image's cargo keeps it (its
# cargo home stays where it is: its cargo is rustup's proxy, which looks for
# rustup there). What it compiles stays in the container, so there is no
# target to keep bounded: a run compiles the crates it builds afresh, in under
# a minute for the workspace's packages.
build_rust() {
  local packages args="" dir
  packages=$(packages_of rust)
  [[ -z "$packages" ]] && return 0
  for dir in $packages; do args="$args -p $(plan_field "$dir" 3)"; done
  step "Rust: $(shown "$(names_of $packages)") ${DIM}(in rust:${RUST_TOOLCHAIN}-bookworm)${RESET}"
  if ! run_logged "Rust: built" \
      $RT run --rm \
      -m 8g \
      -v "$REPO_ROOT":/workspace \
      -v "$CARGO_REGISTRY_DIR":/usr/local/cargo/registry \
      -e CARGO_TARGET_DIR=/target \
      -w /workspace/packages/rust \
      "rust:${RUST_TOOLCHAIN}-bookworm" \
      sh -c 'rustup toolchain install >/dev/null && cargo build --locked "$@"' sh $args; then
    fail "The Rust crates did not build (cargo says why, above)."
    exit 1
  fi
  built $packages
}

# The Python packages' distributions: the SDK's with the script CI and
# publish-pypi.yml run, which builds them and checks what a published one must
# pass, and each other's with uv. They are published nowhere: Verdaccio holds
# npm packages alone, and the images that carry them build them from the
# working tree. What is left in each dist/ installs by path.
build_python() {
  local packages dir rc=0
  packages=$(packages_of python)
  [[ -z "$packages" ]] && return 0
  for dir in $packages; do rm -rf "$REPO_ROOT/$dir/dist"; done
  step "Python: $(shown "$(names_of $packages)") ${DIM}(in ${PYTHON_IMAGE})${RESET}"
  # What the builds need and the image lacks leaves with 3: a failed download
  # is not a package that does not build.
  run_logged "Python: built" \
    $RT run --rm \
    -m 8g \
    -v "$REPO_ROOT":/workspace \
    -v "$UVCACHE_DIR":/root/.cache/uv \
    -e UV_LINK_MODE=copy \
    -e UV_PYTHON_DOWNLOADS=never \
    -e PYTHONDONTWRITEBYTECODE=1 \
    -w /workspace \
    "$PYTHON_IMAGE" \
    sh -c 'apk add --no-cache bash jq > /dev/null || exit 3
           pip install --quiet --disable-pip-version-check --root-user-action=ignore uv || exit 3
           for dir in "$@"; do
             if [ "$dir" = packages/python/sdk ]; then bash packages/python/sdk/scripts/build-python-sdk.sh || exit 1
             else uv build --quiet "$dir" || exit 1
             fi
           done' sh $packages \
    || rc=$?
  if [[ "$rc" == 3 ]]; then
    fail "The Python builds could not RUN: bash, jq or uv could not be installed in ${PYTHON_IMAGE} (a failed download is the usual cause; output above)."
    exit 1
  elif [[ "$rc" != 0 ]]; then
    fail "A Python package did not build, or the SDK's distributions did not pass their checks (above). CI's Python jobs and publish-pypi.yml build them the same way."
    exit 1
  fi
  built $packages
}

# The Go modules, each with go build, on the drift gate's caches.
build_go() {
  local packages
  packages=$(packages_of go)
  [[ -z "$packages" ]] && return 0
  step "Go: $(shown "$(names_of $packages)") ${DIM}(in ${GO_IMAGE})${RESET}"
  if ! run_logged "Go: built" \
      $RT run --rm \
      -m 8g \
      -v "$REPO_ROOT":/workspace \
      -v "$GOCACHE_DIR":/root/.cache/go-build \
      -v "$GOMODCACHE_DIR":/go/pkg/mod \
      -e GOPROXY="$GOPROXY_CACHED" \
      -w /workspace \
      "$GO_IMAGE" \
      sh -c 'for dir in "$@"; do (cd "$dir" && go build -buildvcs=false ./...) || exit 1; done' sh $packages; then
    fail "A Go module did not build (go says why, above)."
    exit 1
  fi
  built $packages
}

# The Kotlin packages, each with its Gradle wrapper, which fetches the Gradle
# its wrapper properties name into a home this script keeps.
build_kotlin() {
  local packages
  packages=$(packages_of kotlin)
  [[ -z "$packages" ]] && return 0
  step "Kotlin: $(shown "$(names_of $packages)") ${DIM}(in ${JDK_IMAGE})${RESET}"
  if ! run_logged "Kotlin: built" \
      $RT run --rm \
      -m 8g \
      -v "$REPO_ROOT":/workspace \
      -v "$GRADLE_HOME_DIR":/root/.gradle \
      -w /workspace \
      "$JDK_IMAGE" \
      sh -c 'for dir in "$@"; do (cd "$dir" && ./gradlew --no-daemon --console=plain assemble) || exit 1; done' sh $packages; then
    fail "A Kotlin package did not build (Gradle says why, above)."
    exit 1
  fi
  built $packages
}

build_swift() {
  local packages
  packages=$(packages_of swift)
  [[ -z "$packages" ]] && return 0
  step "Swift: $(shown "$(names_of $packages)")"
  if ! run_logged "Swift: built" $RT run --rm --memory 8g \
    -v "$REPO_ROOT":/workspace -v "$SWIFTPM_DIR":/root/.cache \
    -w /workspace "$SWIFT_IMAGE" \
    sh -c 'for dir in "$@"; do (cd "$dir" && swift build) || exit 1; done' sh $packages; then
    fail "A Swift package did not build."
    exit 1
  fi
  built $packages
}

build_csharp() {
  local packages
  packages=$(packages_of csharp)
  [[ -z "$packages" ]] && return 0
  mkdir -p "$NUGET_CACHE_DIR"
  step "C#: $(shown "$(names_of $packages)") ${DIM}(in ${DOTNET_IMAGE})${RESET}"
  if ! run_logged "C#: built" \
      $RT run --rm -v "$REPO_ROOT":/workspace \
      -v "$NUGET_CACHE_DIR":/root/.nuget/packages -w /workspace \
      "$DOTNET_IMAGE" \
      sh -c 'for dir in "$@"; do (cd "$dir" && dotnet build -p:RestoreLockedMode=true) || exit 1; done' sh $packages; then
    fail "A C# package did not build."
    exit 1
  fi
  built $packages
}
