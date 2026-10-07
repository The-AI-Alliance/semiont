#!/bin/sh
# python-floor.sh — the oldest Python the SDK supports, printed: the X.Y of
# `requires-python = ">=X.Y"` in packages/sdk-python/pyproject.toml.
#
# An installer reads that line itself, and so does ruff. What cannot asks
# here, so the line is read in one place and one way: scripts/ci/local-build.sh
# (its Python image is python:<floor>-alpine), the SDK's model generator (the
# Python its classes are written for), and lint:python-version, which holds
# every restatement of the floor to it.
#
# With no floor it prints nothing and fails, so a build that cannot name its
# Python stops. It is plain sh: an image with no bash can run it.
set -eu
cd "$(dirname "$0")/../.."

floor=$(sed -n 's/^requires-python = ">=\([0-9][0-9.]*\)"$/\1/p' packages/sdk-python/pyproject.toml)
if [ -z "$floor" ]; then
  echo "python-floor.sh: packages/sdk-python/pyproject.toml has no 'requires-python = \">=X.Y\"' line" >&2
  exit 1
fi
echo "$floor"
