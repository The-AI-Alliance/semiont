#!/usr/bin/env bash
# Build the Python SDK's distributions, and hold them to what a published one
# must be, before anything is uploaded.
#
#   scripts/ci/build-python-sdk.sh
#
# Leaves a source distribution and a wheel in packages/python/sdk/dist, at
# version.json's version. CI runs it on every change, so a release is not the
# first place a packaging break is seen; publish-pypi.yml runs it and uploads
# what it leaves.
#
# The wheel is built from the source distribution, as an installer builds one.
# It is then installed in an environment of its own, and every module of it is
# imported there: a module that needs what the package does not declare fails
# here, not in whoever installs it. An extra's libraries are not among what it
# declares: a module that uses one imports it when it is called, so every module
# imports where the package is installed without its extras, as in a service's
# image.
#
# Each distribution carries the repository's LICENSE and names it in its
# metadata. Hatchling takes a LICENSE beside pyproject.toml, and builds without
# one it does not find, so the file is copied there from the repository's root
# before the build and each distribution is held to carrying it after.
#
# Needs `uv` and `jq`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PACKAGE="$ROOT/packages/python/sdk"

NAME=$(sed -n 's/^name = "\(.*\)"$/\1/p' "$PACKAGE/pyproject.toml")
VERSION=$(jq -r .version "$ROOT/version.json")
if [ -z "$NAME" ] || [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "::error::no name in packages/python/sdk/pyproject.toml, or no version in version.json" >&2
  exit 1
fi

cd "$PACKAGE"
rm -rf dist
cp "$ROOT/LICENSE" LICENSE
uv build --out-dir dist

# Exactly these two, named for the version: what is uploaded is this directory.
SDIST="$NAME-$VERSION.tar.gz"
WHEEL="$NAME-$VERSION-py3-none-any.whl"
built=(dist/*)
if [ "${#built[@]}" -ne 2 ] || [ ! -f "dist/$SDIST" ] || [ ! -f "dist/$WHEEL" ]; then
  echo "::error::expected $WHEEL and $SDIST in dist, and it holds: ${built[*]}" >&2
  exit 1
fi

# The source distribution holds the package, its README, its LICENSE and its
# metadata.
strays=$(tar -tzf "dist/$SDIST" | sed "s#^$NAME-$VERSION/##" | grep -v -e '^$' -e '^src/semiont/' -e '^README\.md$' -e '^LICENSE$' -e '^pyproject\.toml$' -e '^PKG-INFO$' -e '^\.gitignore$' || true)
if [ -n "$strays" ]; then
  echo "::error::the source distribution holds more than the package:" >&2
  echo "$strays" >&2
  exit 1
fi
if ! tar -xzOf "dist/$SDIST" "$NAME-$VERSION/LICENSE" | cmp -s - "$ROOT/LICENSE"; then
  echo "::error::the source distribution does not carry the repository's LICENSE" >&2
  exit 1
fi
pkg_info=$(tar -xzOf "dist/$SDIST" "$NAME-$VERSION/PKG-INFO")
if ! grep -qx 'License-File: LICENSE' <<< "$pkg_info"; then
  echo "::error::the source distribution's metadata does not name its LICENSE (License-File: LICENSE)" >&2
  exit 1
fi

# Installed where nothing of this checkout can be imported in its place.
elsewhere=$(mktemp -d)
trap 'rm -rf "$elsewhere"' EXIT
cd "$elsewhere"
uv run --no-project --isolated --with "$PACKAGE/dist/$WHEEL" python - "$NAME" "$VERSION" "$ROOT" <<'PY'
import importlib
import importlib.metadata
import pkgutil
import sys
from pathlib import Path

name, version, checkout = sys.argv[1:]

installed = importlib.metadata.version(name)
if installed != version:
    sys.exit(f"the wheel installs as {name} {installed}, not {version}")

package = importlib.import_module(name)
if package.__file__ is None or package.__file__.startswith(checkout):
    sys.exit(f"{name} was imported from {package.__file__}, not from the installed wheel")

modules = sorted(module.name for module in pkgutil.walk_packages(package.__path__, f"{name}."))
for module in modules:
    importlib.import_module(module)

files = [str(file) for file in importlib.metadata.files(name) or []]
if f"{name}/py.typed" not in files:
    sys.exit("the wheel does not say it is typed: it holds no py.typed")
strays = sorted({file.split("/")[0] for file in files} - {name, f"{name}-{version}.dist-info"})
if strays:
    sys.exit(f"the wheel holds more than the package: {strays}")

distribution = importlib.metadata.distribution(name)
licence_files = distribution.metadata.get_all("License-File")
if licence_files != ["LICENSE"]:
    sys.exit(f"the wheel's metadata names {licence_files} as its licence files, not LICENSE")
if distribution.read_text("licenses/LICENSE") != Path(checkout, "LICENSE").read_text():
    sys.exit("the wheel does not carry the repository's LICENSE")

print(f"{name} {installed}: {len(modules) + 1} modules, each imported with what the package declares and nothing else")
PY
