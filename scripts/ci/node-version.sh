#!/bin/sh
# node-version.sh — the Node that builds and tests the repository, printed:
# what .node-version holds.
#
# actions/setup-node reads that file itself (node-version-file). What cannot,
# a tooling image's tag (node:<version>-<variant>), asks here, so the file is
# read in one place and one way: scripts/ci/local-build.sh,
# apps/desktop/build.sh and scripts/release/version-bump.sh.
#
# It is not the floor a package asks of whoever installs it: that is
# `engines.node` in each package.json, which lint:node-version holds to one
# value, on the line this file names.
#
# With no version it prints nothing and fails, so a build that cannot name its
# Node stops. It is plain sh: an image with no bash can run it.
set -eu
cd "$(dirname "$0")/../.."

version=$(sed -n '1s/^\([0-9][0-9.]*\)$/\1/p' .node-version)
if [ -z "$version" ]; then
  echo "node-version.sh: .node-version does not hold a version" >&2
  exit 1
fi
echo "$version"
