#!/bin/sh
# rust-toolchain.sh — the Rust toolchain every build in the repository uses,
# printed: the `channel` of rust-toolchain.toml.
#
# rustup reads that file itself. What cannot, a Rust image's tag
# (rust:<channel>-<variant>), asks here, so the file is read in one place and
# one way: scripts/ci/local-build.sh, apps/desktop/build.sh,
# publish-service-images.yml and scripts/container/build-images.js.
#
# With no channel it prints nothing and fails, so a build that cannot name its
# compiler stops. It is plain sh: an image with no bash can run it.
set -eu
cd "$(dirname "$0")/../.."

channel=$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)
if [ -z "$channel" ]; then
  echo "rust-toolchain.sh: rust-toolchain.toml names no channel" >&2
  exit 1
fi
echo "$channel"
