#!/usr/bin/env bash
# cabal-version.sh <version> — put the Haskell SDK's manifest, sdk/semiont.cabal,
# at <version>.
#
# The SDK's codegen writes semiont.cabal from semiont.cabal.in, with
# @VERSION@ as the root package.json's version, and the manifest is committed
# because the codegen is an executable of the package it describes. A bump
# rewrites only the version line, as the codegen would, without building the
# Haskell toolchain's image; `semiont-codegen --check` in CI's Haskell job
# fails if the two ever disagree. version-bump.sh and `npm run version:sync`
# both run this.
set -euo pipefail
cd "$(dirname "$0")/../../.."
manifest=packages/haskell/sdk/semiont.cabal
trap 'rm -f "$manifest.tmp"' EXIT

version=${1:-}
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: cabal-version.sh <X.Y.Z>" >&2
  exit 2
fi

awk -v v="$version" '
  /^version: / { $0 = "version: " v; lines++ }
  { print }
  END { if (lines != 1) { print "cabal-version.sh: semiont.cabal has " lines + 0 " top-level version lines, not one" > "/dev/stderr"; exit 1 } }
' "$manifest" > "$manifest.tmp"
mv "$manifest.tmp" "$manifest"

echo "  $manifest -> $version"
