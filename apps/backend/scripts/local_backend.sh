#!/usr/bin/env bash
set -euo pipefail

# Start a local Semiont backend: PostgreSQL + backend in containers.
#
# This script:
#   1. Detects your container runtime (Apple Container, Docker, or Podman)
#   2. Starts a PostgreSQL container (port 5432, database "semiont", password "localpass")
#   3. Builds the backend container image from .semiont/containers/Dockerfile.backend
#   4. Runs the backend container (port 4000), mounting the current KB directory
#
# The script stays attached and streams backend logs. Press Ctrl+C to stop.
# To run in the background: .semiont/scripts/local_backend.sh &
#
# Prerequisites:
#   - Container runtime (Apple Container, Docker, or Podman)
#   - Environment variables: NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD,
#     NEO4J_DATABASE, ANTHROPIC_API_KEY
#
# Options:
#   --no-cache    Force a fresh container build (skip layer cache)
#
# Usage:
#   .semiont/scripts/local_backend.sh
#   .semiont/scripts/local_backend.sh --no-cache
#
# Equivalent without this script (npm required):
#   npm install -g @semiont/cli neo4j-driver
#   semiont serve

cd "$(git rev-parse --show-toplevel)"

# --- Parse arguments ---

CACHE_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --no-cache) CACHE_FLAG="--no-cache" ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# --- Detect container runtime ---

for rt in container docker podman; do
  if command -v "$rt" > /dev/null 2>&1; then
    RT="$rt"
    break
  fi
done
if [[ -z "${RT:-}" ]]; then
  echo "No container runtime found. Install Apple Container, Docker, or Podman."
  exit 1
fi
echo "Using container runtime: $RT"

NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
echo "npm registry: $NPM_REGISTRY"

# --- Check required env vars ---

for var in NEO4J_URI NEO4J_USERNAME NEO4J_PASSWORD NEO4J_DATABASE ANTHROPIC_API_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "Missing required environment variable: $var"
    exit 1
  fi
done

# --- Resolve host address for container networking ---

HOST_ADDR=$($RT run --rm node:22-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null)
echo "Host address: $HOST_ADDR"

# --- PostgreSQL ---

POSTGRES_NAME="semiont-postgres"
echo ""
echo "Starting PostgreSQL..."
$RT stop "$POSTGRES_NAME" 2>/dev/null || true
sleep 1
# Kill anything on port 5432
PID_ON_PORT=$(lsof -ti :5432 2>/dev/null || echo "")
if [[ -n "$PID_ON_PORT" ]]; then
  kill $PID_ON_PORT 2>/dev/null || true
  sleep 1
fi

$RT run -d --rm \
  --name "$POSTGRES_NAME" \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=localpass \
  -e POSTGRES_DB=semiont \
  postgres:15-alpine > /dev/null

# Wait for postgres to be ready
for i in $(seq 1 20); do
  if $RT run --rm postgres:15-alpine pg_isready -h "$HOST_ADDR" -p 5432 > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
echo "PostgreSQL running on port 5432"

# --- Build backend ---

echo ""
echo "Building backend..."
$RT build $CACHE_FLAG --tag semiont-backend \
  --build-arg NPM_REGISTRY="$NPM_REGISTRY" \
  --file .semiont/containers/Dockerfile.backend .

# --- Run backend ---

echo ""
echo "Starting backend on http://localhost:4000..."
$RT run --publish 4000:4000 \
  --volume "$(pwd)":/kb \
  --env NEO4J_URI="$NEO4J_URI" \
  --env NEO4J_USERNAME="$NEO4J_USERNAME" \
  --env NEO4J_PASSWORD="$NEO4J_PASSWORD" \
  --env NEO4J_DATABASE="$NEO4J_DATABASE" \
  --env ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --env POSTGRES_HOST="$HOST_ADDR" \
  -it semiont-backend
