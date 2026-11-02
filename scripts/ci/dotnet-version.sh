#!/bin/sh
# global.json owns the SDK version. --image-tag removes only the build stamp
# after a prerelease's numbered channel: rc.3.26522.148 becomes rc.3.
set -eu
cd "$(dirname "$0")/../.."
version=$(sed -n 's/^    "version": "\([^"]*\)",$/\1/p' packages/csharp/sdk/global.json)
if ! printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-(preview|rc)\.[0-9]+\.[0-9]+\.[0-9]+)?$'; then
  echo 'dotnet-version.sh: global.json does not state a supported SDK version' >&2
  exit 1
fi
case "${1-}" in
  '') printf '%s\n' "$version" ;;
  --image-tag) printf '%s\n' "$version" | sed -E 's/(-(preview|rc)\.[0-9]+)\.[0-9]+\.[0-9]+$/\1/' ;;
  *) echo 'usage: dotnet-version.sh [--image-tag]' >&2; exit 1 ;;
esac
