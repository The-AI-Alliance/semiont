#!/usr/bin/env bash
# published-crates.sh — the crates published to crates.io, one name a line:
# the members of the Cargo workspace whose manifest takes the workspace's
# version (`version.workspace = true`).
#
# cargo-version.sh writes these crates' version and verify-release.sh looks
# for them on crates.io, so both read this one answer.
set -euo pipefail
cd "$(dirname "$0")/../.."

while IFS= read -r member; do
  manifest="$member/Cargo.toml"
  if grep -q '^version\.workspace = true$' "$manifest"; then
    awk -F'"' '/^name = / { print $2; exit }' "$manifest"
  fi
done < <(awk '/^members = \[/ { listed = 1; next } listed && /^\]/ { exit } listed { gsub(/[", ]/, ""); print }' Cargo.toml)
