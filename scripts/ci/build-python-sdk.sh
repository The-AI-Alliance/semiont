#!/usr/bin/env bash
# Build the Python SDK's distributions, and hold them to what a published one
# must be, before anything is uploaded.
#
#   scripts/ci/build-python-sdk.sh
#
# Leaves a source distribution and a wheel in packages/sdk-python/dist, at
# version.json's version. CI runs it on every change, so a release is not the
# first place a packaging break is seen; publish-pypi.yml runs it and uploads
# what it leaves.
#
# The wheel is built from the source distribution, as an installer builds one.
# It is then installed in an environment of its own, and every module of it is
# imported there: a module that needs what the package does not declare fails
# here, not in whoever installs it. A module that needs what an extra declares
# is named below with its extra: it must fail to import without the extra, and
# is imported again with the extra installed, so an entry cannot outlive the
# need it records.
#
# Needs `uv` and `jq`.

set -euo pipefail

# Each module that needs an extra, as `<module>=<extra>`.
EXTRA_MODULES=("semiont.testing.axioms=axioms")

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PACKAGE="$ROOT/packages/sdk-python"

NAME=$(sed -n 's/^name = "\(.*\)"$/\1/p' "$PACKAGE/pyproject.toml")
VERSION=$(jq -r .version "$ROOT/version.json")
if [ -z "$NAME" ] || [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "::error::no name in packages/sdk-python/pyproject.toml, or no version in version.json" >&2
  exit 1
fi

cd "$PACKAGE"
rm -rf dist
uv build --out-dir dist

# Exactly these two, named for the version: what is uploaded is this directory.
SDIST="$NAME-$VERSION.tar.gz"
WHEEL="$NAME-$VERSION-py3-none-any.whl"
built=(dist/*)
if [ "${#built[@]}" -ne 2 ] || [ ! -f "dist/$SDIST" ] || [ ! -f "dist/$WHEEL" ]; then
  echo "::error::expected $WHEEL and $SDIST in dist, and it holds: ${built[*]}" >&2
  exit 1
fi

# The source distribution holds the package, its README and its metadata.
strays=$(tar -tzf "dist/$SDIST" | sed "s#^$NAME-$VERSION/##" | grep -v -e '^$' -e '^src/semiont/' -e '^README\.md$' -e '^pyproject\.toml$' -e '^PKG-INFO$' -e '^\.gitignore$' || true)
if [ -n "$strays" ]; then
  echo "::error::the source distribution holds more than the package:" >&2
  echo "$strays" >&2
  exit 1
fi

# Installed where nothing of this checkout can be imported in its place.
elsewhere=$(mktemp -d)
trap 'rm -rf "$elsewhere"' EXIT
cd "$elsewhere"
uv run --no-project --isolated --with "$PACKAGE/dist/$WHEEL" python - "$NAME" "$VERSION" "$ROOT" "${EXTRA_MODULES[@]}" <<'PY'
import importlib
import importlib.metadata
import pkgutil
import sys

name, version, checkout, *needing = sys.argv[1:]
extras = dict(entry.split("=") for entry in needing)

installed = importlib.metadata.version(name)
if installed != version:
    sys.exit(f"the wheel installs as {name} {installed}, not {version}")

package = importlib.import_module(name)
if package.__file__ is None or package.__file__.startswith(checkout):
    sys.exit(f"{name} was imported from {package.__file__}, not from the installed wheel")

modules = sorted(module.name for module in pkgutil.walk_packages(package.__path__, f"{name}."))
for module in modules:
    if module not in extras:
        importlib.import_module(module)
        continue
    try:
        importlib.import_module(module)
    except ModuleNotFoundError:
        continue
    sys.exit(f"{module} imports without the extra {extras[module]}: take it out of EXTRA_MODULES")
missing = sorted(set(extras) - set(modules))
if missing:
    sys.exit(f"EXTRA_MODULES names modules the wheel does not hold: {missing}")

files = [str(file) for file in importlib.metadata.files(name) or []]
if f"{name}/py.typed" not in files:
    sys.exit("the wheel does not say it is typed: it holds no py.typed")
strays = sorted({file.split("/")[0] for file in files} - {name, f"{name}-{version}.dist-info"})
if strays:
    sys.exit(f"the wheel holds more than the package: {strays}")

print(f"{name} {installed}: {len(modules) + 1} modules, each imported with what the package declares and nothing else, {len(extras)} of them only with an extra")
PY

for entry in "${EXTRA_MODULES[@]}"; do
  module=${entry%%=*}
  extra=${entry#*=}
  uv run --no-project --isolated --with "$NAME[$extra] @ file://$PACKAGE/dist/$WHEEL" python -c 'import importlib, sys; importlib.import_module(sys.argv[1])' "$module"
  echo "$module imports with the extra $extra"
done
