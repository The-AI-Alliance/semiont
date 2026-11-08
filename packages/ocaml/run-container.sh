#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
root=$(git rev-parse --show-toplevel)
common=$(git rev-parse --path-format=absolute --git-common-dir)
python3 check-toolchain.py
base=$(python3 -c 'import json; print(json.load(open("toolchain.json"))["baseImage"])')
node_image="node:$(../typescript/scripts/node-version.sh)-bookworm"
container run --rm --volume "$root:/work" --workdir /work "$node_image" \
  npm run generate:ocaml:check
container build --build-arg "BASE_IMAGE=$base" --tag semiont-ocaml-development --file Dockerfile .
for volume in semiont-ocaml-sdk-build semiont-ocaml-sdk-downloads; do
  if ! container volume inspect "$volume" >/dev/null 2>&1; then
    container volume create "$volume"
  fi
done
container run --rm --memory 4g --volume "$root:/work" \
  --mount "type=bind,source=$common,target=$common,readonly" \
  --env GIT_CONFIG_COUNT=1 --env GIT_CONFIG_KEY_0=safe.directory --env GIT_CONFIG_VALUE_0=/work \
  --mount type=volume,source=semiont-ocaml-sdk-build,target=/work/packages/ocaml/sdk/_build \
  --mount type=volume,source=semiont-ocaml-sdk-downloads,target=/home/opam/.cache/dune \
  --workdir /work/packages/ocaml/sdk semiont-ocaml-development bash -c \
  'dune build @all @opam && python3 test/check-format.py && dune runtest && python3 test/check-installed-api.py && python3 probes/check-interface.py && python3 api.py && python3 probes/check-api-controls.py'
