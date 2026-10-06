#!/bin/sh
# go-toolchain.sh — the Go toolchain every build in the repository uses,
# printed: the `toolchain` line of apps/launcher/go.mod, without its "go".
#
# actions/setup-go reads that file itself (go-version-file). What cannot, a Go
# image's tag (golang:<toolchain>), asks here, so the line is read in one
# place and one way: scripts/ci/local-build.sh and the go:generate lines of
# packages/sdk-go and apps/launcher.
#
# Each module's go.mod pins the toolchain, and lint:go-toolchain holds them to
# one, so the launcher's is every module's.
#
# With no toolchain line it prints nothing and fails, so a build that cannot
# name its compiler stops. It is plain sh: an image with no bash can run it.
set -eu
cd "$(dirname "$0")/../.."

toolchain=$(sed -n 's/^toolchain go\([0-9][0-9.]*\)$/\1/p' apps/launcher/go.mod)
if [ -z "$toolchain" ]; then
  echo "go-toolchain.sh: apps/launcher/go.mod has no 'toolchain goX.Y.Z' line" >&2
  exit 1
fi
echo "$toolchain"
