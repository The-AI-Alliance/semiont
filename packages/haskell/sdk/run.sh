#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
root=${1:?expected repository root}
bash ../probes/toolchain.sh --check
cabal check
cabal run semiont-codegen -- --check "$root"
cabal build all --enable-tests --enable-coverage -j1
mkdir -p conformance/bin
for role in wire live; do
  name="semiont-haskell-$role-driver"
  cp "$(cabal list-bin "$name")" "conformance/bin/$name.native"
  cp conformance/launch.sh "conformance/bin/$name"
  chmod +x "conformance/bin/$name"
done
python3 api.py --compiler-check
cabal test schema-cases --enable-coverage -j1 --test-show-details=direct --test-options="$root"
python3 test/refusals.py
cabal exec -- hpc-codecov --format=lcov --ignore-dittos -x Main cabal:schema-cases -o coverage.lcov
cabal sdist
