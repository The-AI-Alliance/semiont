#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
bash toolchain.sh --check
cabal check
if ! test -s /root/.cabal/packages/hackage.haskell.org/01-index.tar; then
  cabal update
fi
cabal build all
python3 run.py "$(cabal list-bin exe:semiont-probes)"
cabal sdist
