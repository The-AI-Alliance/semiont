#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
bash toolchain.sh --check
cabal check
if ! test -s /root/.cabal/packages/hackage.haskell.org/01-index.tar; then
  cabal update
fi
cabal build exe:semiont-probes -j1 --ghc-options="-fhpc -hpcdir .hpc"
python3 run.py "$(cabal list-bin exe:semiont-probes)"
cabal exec -- hpc-codecov --ignore-dittos --mix=.hpc semiont-probes.tix -o coverage.json
cabal sdist
