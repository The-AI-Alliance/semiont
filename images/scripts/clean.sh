#!/usr/bin/env bash
# make clean: removes what the Make operations build into the working tree, so the next
# build builds it again. It keeps installs (node_modules, .venv), generated sources (make
# generate owns them), the caches under ~/.cache/semiont, and the container runtime's images
# (FORCE=1 rebuilds those). It removes nothing git tracks or does not ignore.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
shopt -s nullglob

ROSTER=(
  # packages/typescript/scripts/build.sh; core's build removes its dist-types unless it fails
  packages/typescript/*/dist
  packages/typescript/core/dist-types
  # packages/typescript/scripts/publish.sh: the root LICENSE in each package, and its staging
  packages/typescript/*/LICENSE
  .npm-stage
  # uv build, and packages/python/sdk/scripts/build-python-sdk.sh with its LICENSE
  packages/python/*/dist
  packages/python/sdk/LICENSE
  # gradlew assemble
  packages/kotlin/*/build
  packages/kotlin/*/.gradle
  packages/kotlin/*/.kotlin
  # dotnet build, in each project of a solution
  packages/csharp/*/*/*/bin
  packages/csharp/*/*/*/obj
  # swift build
  packages/swift/*/.build
  # the browser app's build, with the translations and assets it copies in first
  images/browser/dist
  images/browser/public
  images/browser/messages
  # make launcher
  apps/launcher/dist
  # apps/desktop/build.sh
  apps/desktop/.build
  apps/desktop/release
)
OUTPUTS=()
for path in "${ROSTER[@]}"; do
  if [[ -e "$path" || -L "$path" ]]; then OUTPUTS+=("$path"); fi
done

if [[ ${#OUTPUTS[@]} -eq 0 ]]; then
  echo "Nothing to clean."
  exit 0
fi

tracked=$(git --literal-pathspecs ls-files -- "${OUTPUTS[@]}")
if [[ -n "$tracked" ]]; then
  echo "make clean removes only build output, and git tracks these:" >&2
  echo "$tracked" | sed 's/^/  /' >&2
  exit 1
fi
unignored=""
for path in "${OUTPUTS[@]}"; do
  git check-ignore -q -- "$path" || unignored+="  $path"$'\n'
done
if [[ -n "$unignored" ]]; then
  echo "make clean removes only build output, and git does not ignore these:" >&2
  printf '%s' "$unignored" >&2
  exit 1
fi

for path in "${OUTPUTS[@]}"; do
  rm -rf -- "$path"
  echo "Removed $path"
done
