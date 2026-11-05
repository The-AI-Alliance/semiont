#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ghc_version=$(sed -n 's/^with-compiler: ghc-\([0-9][0-9.]*\)$/\1/p' cabal.project)
cabal_version=$(cat cabal-install.version)
[[ "$ghc_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$cabal_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
case "${1:?expected --ghc or --check}" in
  --ghc) printf '%s\n' "$ghc_version" ;;
  --check)
    test "$(ghc --numeric-version)" = "$ghc_version"
    test "$(cabal --numeric-version)" = "$cabal_version"
    ;;
  *) exit 2 ;;
esac
