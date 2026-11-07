#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
root=$(git rev-parse --show-toplevel)
python3 check-toolchain.py
base=$(python3 -c 'import json; print(json.load(open("toolchain.json"))["baseImage"])')
node_image="node:$(../typescript/scripts/node-version.sh)-bookworm"
container run --rm --volume "$root:/work" --workdir /work "$node_image" \
  node packages/codegen/ocaml/generate-identifiers.mjs --check
container build --build-arg "BASE_IMAGE=$base" --tag semiont-ocaml-development --file Dockerfile .
for volume in semiont-ocaml-sdk-build semiont-ocaml-sdk-downloads; do
  if ! container volume inspect "$volume" >/dev/null 2>&1; then
    container volume create "$volume"
  fi
done
container run --rm --memory 4g --volume "$root:/work" \
  --mount type=volume,source=semiont-ocaml-sdk-build,target=/work/packages/ocaml/sdk/_build \
  --mount type=volume,source=semiont-ocaml-sdk-downloads,target=/home/opam/.cache/dune \
  --workdir /work/packages/ocaml/sdk semiont-ocaml-development bash -c \
  'dune build @all && dune runtest && python3 test/check-installed-api.py'
