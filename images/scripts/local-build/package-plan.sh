#!/usr/bin/env bash
# Sourced by the local build session.

# --- The packages, and which of them build ---
#
# images/scripts/package-signatures.py finds them, packages/<language>/<name>, and
# signs each with everything its build reads, its dependencies' signatures
# among it. It runs on the Python floor, which reads TOML; the files it signs
# are git's list from the host, since git refuses a checkout another user owns,
# as a root container sees one. A package builds when it is named, when --force
# is given, when its signature is not the one recorded when it last built, or
# when the output its build leaves is gone.
BUILD_PACKAGES=""
PACKAGE_REASONS=""
if [[ "$IMAGES_ONLY" != true ]]; then
  if ! PACKAGE_PLAN=$(git -C "$REPO_ROOT" ls-files -z --cached --others --exclude-standard \
      | $RT run --rm -i -v "$REPO_ROOT":/workspace -w /workspace "$PYTHON_IMAGE" \
          python3 images/scripts/package-signatures.py "$NODE_IMAGE" "rust:$RUST_TOOLCHAIN" "$PYTHON_IMAGE" "$GO_IMAGE" "$JDK_IMAGE" "$SWIFT_IMAGE" "$DOTNET_IMAGE"); then
    fail "Could not read what the packages are built from (images/scripts/package-signatures.py, above)."
    exit 1
  fi
  ALL_PACKAGES=$(echo "$PACKAGE_PLAN" | cut -f1 | sed 's#^packages/##' | tr '\n' ' ')
  LANGUAGES=$(echo "$PACKAGE_PLAN" | cut -f2 | sort -u | tr '\n' ' ')
  # A named package is <language>/<name>, or a language for all of its own.
  SELECTED=""
  for named in $PACKAGES_NAMED; do
    matched=$(echo "$PACKAGE_PLAN" | awk -F'\t' -v n="packages/$named" '$1 == n || index($1, n "/") == 1 { print $1 }')
    if [[ -z "$matched" ]]; then
      fail "Unknown package: $named (expected one of: ${ALL_PACKAGES% }, or a language: ${LANGUAGES% })"
      exit 1
    fi
    SELECTED="$SELECTED $matched"
  done
  while IFS=$'\t' read -r dir language name signature output; do
    if [[ -n "$PACKAGES_NAMED" ]] && ! [[ " $(echo $SELECTED) " == *" $dir "* ]]; then
      continue
    fi
    reason=""
    if [[ "$FORCE" == true ]]; then reason="forced"
    elif [[ -n "$PACKAGES_NAMED" ]]; then reason="explicitly selected"
    elif [[ -n "$output" && ! -e "$REPO_ROOT/$output" ]]; then reason="missing output: $output"
    elif [[ "$(state_get "$dir")" != "$signature" ]]; then reason="new or changed inputs"
    fi
    if [[ -n "$reason" ]]; then
      BUILD_PACKAGES="$BUILD_PACKAGES $dir"
      PACKAGE_REASONS+="$dir"$'\t'"$reason"$'\n'
    else
      summarize "$dir" "unchanged"
    fi
  done <<< "$PACKAGE_PLAN"
fi

# plan_field <dir> <n>: the nth field of the package's line in the plan
# (2 its language, 3 the name its build takes, 4 its signature).
plan_field() { echo "$PACKAGE_PLAN" | awk -F'\t' -v d="$1" -v n="$2" '$1 == d { print $n }'; }
# packages_of <language>: the packages of that language this run builds.
packages_of() {
  local dir
  for dir in $BUILD_PACKAGES; do
    [[ "$(plan_field "$dir" 2)" == "$1" ]] && echo "$dir"
  done
  return 0
}
# built <dir>...: record each as built from what it was built from.
built() {
  local dir
  for dir in "$@"; do
    state_put "$dir" "$(plan_field "$dir" 4)"
    summarize "$dir" "built"
  done
}
