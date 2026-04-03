#!/usr/bin/env bash
set -euo pipefail

# Build all Semiont packages and apps.
#
# Usage:
#   ./scripts/ci/build.sh
#
# Runs from repo root. Installs dependencies, bundles the OpenAPI spec,
# builds all library packages, CLI, backend, and frontend.

cd "$(git rev-parse --show-toplevel)"

echo "==> Installing dependencies..."
npm ci --include=optional

echo "==> Bundling OpenAPI spec..."
npm run openapi:bundle

echo "==> Building library packages..."
for pkg in api-client ontology core content event-sourcing graph inference jobs make-meaning react-ui; do
  npm run build --workspace=@semiont/$pkg
done

echo "==> Building CLI..."
(cd apps/cli && npm run build)

echo "==> Building backend..."
(cd apps/backend && npm run build)

echo "==> Building frontend..."
(cd apps/frontend && npm run build)

echo "==> Build complete."
