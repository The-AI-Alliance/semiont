#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
engine=${1:-container}
case "$engine" in container|docker) ;; *) printf 'expected container or docker\n' >&2; exit 2 ;; esac
root=$(git rev-parse --show-toplevel)
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/semiont/haskell-cabal"
mkdir -p "$cache_dir"
"$engine" build --build-arg "GHC_VERSION=$(bash toolchain.sh --ghc)" \
  --tag semiont-haskell-p0 --file Containerfile .
"$engine" run --rm --memory 4g \
  --volume "$root:/work" --volume "$cache_dir:/root/.cabal" \
  --workdir /work/packages/haskell/probes semiont-haskell-p0 bash run.sh
