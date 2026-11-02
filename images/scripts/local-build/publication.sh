#!/usr/bin/env bash
# Local publication runs the release packer against an isolated copy of its inputs.
verify_local_npm() {
  "$RT" run --rm -v "$REPO_ROOT":/workspace -w /workspace "$NODE_IMAGE" \
    node packages/typescript/scripts/stage-local-publish.mjs verify
}

publish_local_npm() {
  "$RT" run --rm -v "$REPO_ROOT":/workspace -w /workspace "$NODE_IMAGE" \
    sh -c '
      set -e
      apk add --no-cache bash > /dev/null
      stage=$(mktemp -d)
      node packages/typescript/scripts/stage-local-publish.mjs stage "$stage"
      printf "registry=http://%s:4873\n//%s:4873/:_authToken=%s\n" "$1" "$1" "$2" >/tmp/local.npmrc
      bash "$stage/packages/typescript/scripts/publish.sh" --registry "http://$1:4873" --tag latest --clean --npmrc /tmp/local.npmrc
    ' sh "$HOST_ADDR" "$VERDACCIO_TOKEN"
}
