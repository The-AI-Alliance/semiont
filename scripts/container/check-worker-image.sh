#!/bin/sh
# check-worker-image.sh <image> [runtime] — what the worker image promises,
# checked against a built image:
#
#   1. No installer and no Node: as its user, nothing on its PATH installs a
#      package (pip, uv) or runs JavaScript (node, npm), and its Python has
#      no pip.
#   2. Every provider's library: every module of the Python packages the
#      image builds from this repository imports there, each inference driver
#      with the library its provider is asked through. The service imports a
#      driver when it makes an agent for that provider, so an image missing a
#      library starts all the same, and fails where that provider is
#      configured.
#   3. Run as the image says, with no document mounted where its CMD tells it
#      to read one, it refuses by name: exit 1, naming the document it cannot
#      read.
#
# Run by local-build.sh after it builds the worker image, and by the image
# publish workflow before it pushes.
set -eu

IMAGE="${1:?usage: check-worker-image.sh <image> [runtime]}"
RT="${2:-docker}"
DOCKERFILE="$(cd "$(dirname "$0")/../.." && pwd)/apps/worker/Dockerfile"
COMMAND=$(sed -n 's/^CMD \[\(.*\)\]$/\1/p' "$DOCKERFILE" | sed 's/", "/ /g; s/"//g')
if [ -z "$COMMAND" ]; then
  echo "✗ $DOCKERFILE declares no exec-form CMD"
  exit 1
fi

# The script runs, and expands, inside the container.
# shellcheck disable=SC2016
found=$("$RT" run --rm --entrypoint /bin/sh "$IMAGE" -c '
  for tool in pip pip3 uv uvx node npm npx; do command -v "$tool"; done
  python -c "import importlib.util, sys; sys.exit(importlib.util.find_spec(\"pip\") is not None)" || echo "pip, as a module of its Python"
  true')
if [ -n "$found" ]; then
  echo "✗ $IMAGE carries an installer or Node:"
  echo "$found"
  exit 1
fi
echo "✓ $IMAGE carries no installer and no Node"

# The packages built from this repository are the ones installed from a
# directory, which each one's own record says. A module named __main__ is a
# program, which importing would run: the refusal below runs the service's.
WALK='
import importlib
import importlib.metadata
import json
import pkgutil
import sys

built_here = set()
for distribution in importlib.metadata.distributions():
    origin = distribution.read_text("direct_url.json")
    if origin is not None and "dir_info" in json.loads(origin):
        built_here.add(distribution.metadata["Name"])
packages = sorted(name for name, owners in importlib.metadata.packages_distributions().items() if built_here & set(owners))
if not packages:
    sys.exit("no package in the image was installed from a directory: the check has lost what it reads")

modules = 0
failed = []
for package in packages:
    names = [package] + [module.name for module in pkgutil.walk_packages(importlib.import_module(package).__path__, package + ".")]
    for name in names:
        if name.rsplit(".", 1)[-1] == "__main__":
            continue
        modules += 1
        try:
            importlib.import_module(name)
        except Exception as error:
            failed.append(f"{name}: {type(error).__name__}: {error}")
if failed:
    sys.exit("\n".join(failed))
print(f"{modules} modules of {len(packages)} packages:", ", ".join(packages))
'
# The image's own shell finds `python`, as it does for the image's command.
# shellcheck disable=SC2016
if ! imported=$("$RT" run --rm --entrypoint /bin/sh -e WALK="$WALK" "$IMAGE" -c 'python -c "$WALK"' 2>&1); then
  echo "✗ $IMAGE does not import every module of the packages built into it:"
  echo "$imported"
  exit 1
fi
echo "✓ $IMAGE imports every module of the packages built into it, each provider's driver with its library: $imported"

# The script runs, and expands, inside the container: the command's output,
# then a last line of its exit status.
# shellcheck disable=SC2016
out=$("$RT" run --rm --entrypoint /bin/sh -e COMMAND="$COMMAND" "$IMAGE" -c '
  # shellcheck disable=SC2086
  /usr/local/bin/boot.sh $COMMAND 2>&1
  printf "\n%d" "$?"')
log=$(echo "$out" | sed '$d')
status=$(echo "$out" | tail -1)
if [ "$status" != 1 ]; then
  echo "✗ $IMAGE with no document exited $status, not 1:"
  echo "$log"
  exit 1
fi
if ! echo "$log" | grep -qF "Cannot read the worker's configuration document"; then
  echo "✗ $IMAGE with no document did not refuse by name:"
  echo "$log"
  exit 1
fi
echo "✓ $IMAGE with no document refuses by name: $(echo "$log" | head -1)"
