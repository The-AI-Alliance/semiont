#!/usr/bin/env bash
# cargo-version.sh <version> — put the crates published to crates.io at
# <version>, everywhere cargo reads it:
#
#   Cargo.toml   [workspace.package] version, which each published crate takes
#                (`version.workspace = true`), and the version beside each
#                path of [workspace.dependencies] that names one of them
#   Cargo.lock   each published crate's own entry
#
# Which crates are published is read from the workspace's manifests, never
# listed here. version-bump.sh and `npm run version:sync` both run this, so
# the crates move with version.json as every package.json does; CI fails a
# published crate at any other version.
set -euo pipefail
cd "$(dirname "$0")/../.."
trap 'rm -f Cargo.toml.tmp Cargo.lock.tmp' EXIT

version=${1:-}
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: cargo-version.sh <X.Y.Z>" >&2
  exit 2
fi

published=""
while IFS= read -r crate; do
  published="$published $crate"
done < <(scripts/release/published-crates.sh)
if [[ -z "$published" ]]; then
  echo "cargo-version.sh: no member of the workspace takes the workspace's version" >&2
  exit 1
fi

awk -v v="$version" '
  /^\[/ { section = $0 }
  section == "[workspace.package]" && /^version = / { $0 = "version = \"" v "\""; package++ }
  section == "[workspace.dependencies]" && /path = / && /version = "/ { sub(/version = "[^"]*"/, "version = \"" v "\""); paths++ }
  { print }
  END { if (package != 1 || paths == 0) { print "cargo-version.sh: Cargo.toml has no [workspace.package] version, or no path beside a version" > "/dev/stderr"; exit 1 } }
' Cargo.toml > Cargo.toml.tmp
mv Cargo.toml.tmp Cargo.toml

awk -v v="$version" -v published="$published " '
  /^name = / { name = $3; gsub(/"/, "", name); ours = index(published, " " name " ") > 0 }
  ours && /^version = / { $0 = "version = \"" v "\""; ours = 0; entries++ }
  { print }
  END { if (entries != split(published, _, " ")) { print "cargo-version.sh: Cargo.lock does not hold an entry for each of:" published > "/dev/stderr"; exit 1 } }
' Cargo.lock > Cargo.lock.tmp
mv Cargo.lock.tmp Cargo.lock

echo "  Cargo.toml, Cargo.lock:$published -> $version"
