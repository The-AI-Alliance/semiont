#!/bin/sh
# The Swift image takes its version from the package's swiftly owner.
set -eu
cd "$(dirname "$0")/../../.."
version=$(sed -n '1s/^\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' packages/swift/sdk/.swift-version)
if [ -z "$version" ]; then
  echo "swift-version.sh: expected a Swift X.Y.Z version" >&2
  exit 1
fi
echo "$version"
