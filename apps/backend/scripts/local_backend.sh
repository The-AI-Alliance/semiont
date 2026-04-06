#!/usr/bin/env bash
set -euo pipefail

# Start a local Semiont backend: Neo4j + Qdrant + Ollama + PostgreSQL + backend in containers.
#
# This script:
#   1. Detects your container runtime (Apple Container, Docker, or Podman)
#   2. Starts a Neo4j container (bolt port 7687, browser port 7474)
#   3. Starts a Qdrant container (port 6333)
#   4. Starts an Ollama container (port 11434) for local embeddings
#   5. Starts a PostgreSQL container (port 5432, database "semiont")
#   6. Builds the backend container image from .semiont/containers/Dockerfile.backend
#   7. Runs the backend container (port 4000), mounting the current KB directory
#   8. Creates an admin user if --email and --password are provided
#
# The script stays attached and streams backend logs. Press Ctrl+C to stop.
# To run in the background: .semiont/scripts/local_backend.sh &
#
# Prerequisites:
#   - Container runtime (Apple Container, Docker, or Podman)
#   - Environment variable: ANTHROPIC_API_KEY
#
# Options:
#   --no-cache              Force a fresh container build (skip layer cache)
#   --email <email>         Admin user email (requires --password)
#   --password <password>   Admin user password (requires --email)
#   --clean-ollama          Remove the Ollama model cache volume and exit
#
# Usage:
#   .semiont/scripts/local_backend.sh --email admin@example.com --password password
#   .semiont/scripts/local_backend.sh --no-cache --email admin@example.com --password password
#
# Equivalent without this script (npm required):
#   npm install -g @semiont/cli neo4j-driver
#   semiont serve

cd "$(git rev-parse --show-toplevel)"

# --- Parse arguments ---

CACHE_FLAG=""
ADMIN_EMAIL=""
ADMIN_PASSWORD=""
CLEAN_OLLAMA=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-cache) CACHE_FLAG="--no-cache"; shift ;;
    --email) ADMIN_EMAIL="$2"; shift 2 ;;
    --password) ADMIN_PASSWORD="$2"; shift 2 ;;
    --clean-ollama) CLEAN_OLLAMA=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
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
echo "Using container runtime: ${RT}"

# Handle --clean-ollama
if [[ "${CLEAN_OLLAMA}" == "true" ]]; then
  echo "Removing Ollama model cache volume..."
  "${RT}" volume rm semiont-ollama-models 2>/dev/null && echo "Removed." || echo "Volume not found."
  exit 0
fi

NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
echo "npm registry: $NPM_REGISTRY"

# --- Check required env vars ---

for var in ANTHROPIC_API_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "Missing required environment variable: $var"
    exit 1
  fi
done

# --- Resolve host address for container networking ---

HOST_ADDR=$($RT run --rm node:22-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null)
echo "Host address: $HOST_ADDR"

# --- Neo4j ---

NEO4J_NAME="semiont-neo4j"
echo ""
echo "Starting Neo4j..."
$RT stop "$NEO4J_NAME" 2>/dev/null || true
sleep 1
PID_ON_PORT=$(lsof -ti :7687 2>/dev/null || echo "")
if [[ -n "$PID_ON_PORT" ]]; then
  kill $PID_ON_PORT 2>/dev/null || true
  sleep 1
fi

$RT run -d --rm \
  --name "$NEO4J_NAME" \
  -p 7474:7474 \
  -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/localpass \
  -e NEO4J_ACCEPT_LICENSE_AGREEMENT=yes \
  neo4j:5-community > /dev/null

# Wait for Neo4j to be ready
for i in $(seq 1 30); do
  if curl -sf http://localhost:7474 > /dev/null 2>&1; then
    break
  fi
  sleep 1
done
echo "Neo4j running on bolt://localhost:7687 (browser: http://localhost:7474)"

# --- Qdrant ---

QDRANT_NAME="semiont-qdrant"
echo ""
echo "Starting Qdrant..."
$RT stop "$QDRANT_NAME" 2>/dev/null || true
sleep 1
PID_ON_PORT=$(lsof -ti :6333 2>/dev/null || echo "")
if [[ -n "$PID_ON_PORT" ]]; then
  kill $PID_ON_PORT 2>/dev/null || true
  sleep 1
fi

$RT run -d --rm \
  --name "$QDRANT_NAME" \
  -p 6333:6333 \
  qdrant/qdrant > /dev/null

for i in $(seq 1 15); do
  if curl -sf http://localhost:6333/healthz > /dev/null 2>&1; then
    break
  fi
  sleep 1
done
echo "Qdrant running on http://localhost:6333"

# --- Ollama ---

OLLAMA_NAME="semiont-ollama"
echo ""
echo "Starting Ollama..."
"${RT}" stop "${OLLAMA_NAME}" 2>/dev/null || true
sleep 1
PID_ON_PORT=$(lsof -ti :11434 2>/dev/null || echo "")
if [[ -n "${PID_ON_PORT}" ]]; then
  kill "${PID_ON_PORT}" 2>/dev/null || true
  sleep 1
fi

# Determine model cache: prefer host ~/.ollama if present (shared with local Ollama)
OLLAMA_VOLUME=""
if [ -d "${HOME}/.ollama" ]; then
  printf "Found local Ollama model cache at %s. Share it with the container? [Y/n] " "${HOME}/.ollama"
  read -r answer
  if [ "${answer}" != "n" ] && [ "${answer}" != "N" ]; then
    OLLAMA_VOLUME="${HOME}/.ollama:/root/.ollama"
    echo "Using host model cache."
  fi
fi
if [ -z "${OLLAMA_VOLUME}" ]; then
  OLLAMA_VOLUME="semiont-ollama-models:/root/.ollama"
  echo "Using named volume semiont-ollama-models for model cache."
fi

"${RT}" run -d --rm \
  --name "${OLLAMA_NAME}" \
  -p 11434:11434 \
  -v "${OLLAMA_VOLUME}" \
  ollama/ollama > /dev/null

for i in $(seq 1 30); do
  if curl -sf http://localhost:11434/api/version > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Pulling nomic-embed-text model (first run may take a minute)..."
"${RT}" exec "${OLLAMA_NAME}" ollama pull nomic-embed-text
echo "Ollama running on http://localhost:11434"

# --- PostgreSQL ---

POSTGRES_NAME="semiont-postgres"
echo ""
echo "Starting PostgreSQL..."
$RT stop "$POSTGRES_NAME" 2>/dev/null || true
sleep 1
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

ADMIN_ARGS=()
if [[ -n "$ADMIN_EMAIL" && -n "$ADMIN_PASSWORD" ]]; then
  ADMIN_ARGS=(--env ADMIN_EMAIL="$ADMIN_EMAIL" --env ADMIN_PASSWORD="$ADMIN_PASSWORD")
  echo "Admin user: $ADMIN_EMAIL"
fi

$RT run --publish 4000:4000 \
  --volume "$(pwd)":/kb \
  --env ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  --env POSTGRES_HOST="${HOST_ADDR}" \
  --env NEO4J_HOST="${HOST_ADDR}" \
  --env QDRANT_HOST="${HOST_ADDR}" \
  --env OLLAMA_HOST="${HOST_ADDR}" \
  "${ADMIN_ARGS[@]}" \
  -it semiont-backend
