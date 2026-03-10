# Local Semiont

Run Semiont locally using published npm packages -- no need to clone the Semiont repository.

The CLI installs and provisions backend and frontend from pre-built npm packages, generates `.env` files, and runs database migrations. The database and Envoy proxy run as containers (Docker/Podman).

## Prerequisites

### Node.js

Version 20 or higher. Install from [nodejs.org](https://nodejs.org/) or via a version manager like [nvm](https://github.com/nvm-sh/nvm).

```bash
node --version   # should print v20.x or higher
```

### Docker or Podman

Used for the PostgreSQL database and Envoy proxy containers. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [Podman](https://podman.io/docs/installation).

```bash
docker --version   # or: podman --version
```

### Inference (Anthropic)

Required for AI-powered annotation features. Other inference providers coming soon. Get a key from the [Anthropic Console](https://console.anthropic.com/settings/keys).

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Graph (Neo4j)

Required for knowledge graph features. Other graph databases coming soon. Set up a free instance at [Neo4j Aura](https://neo4j.com/cloud/aura/) or run Neo4j locally.

```bash
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USERNAME=neo4j
export NEO4J_PASSWORD=your-password
export NEO4J_DATABASE=neo4j
```

## Setup

### 1. Install the CLI

```bash
npm install -g @semiont/cli
```

### 2. Initialize a Project

```bash
mkdir my_semiont_project
cd my_semiont_project
export SEMIONT_ROOT=$(pwd)
export SEMIONT_ENV=local
semiont init --verbose
```

`SEMIONT_ROOT` tells the CLI where your project lives, so you can run commands from any directory. `semiont init` creates `semiont.json` and `environments/local.json`.

Review `environments/local.json` and edit database credentials or ports as needed. The default configuration uses:
- **backend** and **frontend** as `posix` platform (local Node.js processes, resolved from installed npm packages)
- **database** as `container` platform (Docker/Podman)
- **graph** as `external` platform (Neo4j, uses `NEO4J_*` environment variables)
- **inference** as `external` platform (Anthropic, uses `ANTHROPIC_API_KEY`)

### 3. Provision Services

```bash
semiont provision --verbose
```

This generates `.env` files for backend and frontend, runs database migrations using the Prisma schema bundled in the backend package, and processes proxy configuration.

### 4. Start Services

```bash
semiont start --verbose
semiont check
```

Starts the database container, backend, frontend, and proxy. `semiont check` verifies all services are healthy.

### 5. Create an Admin User

```bash
semiont useradd --email you@example.com --generate-password --admin
```

Note the generated password from the output.

### 6. Access the Application

Open http://localhost:8080 and log in with the admin credentials from step 5.

To run demo workflows, see the [Semiont Workflows](https://github.com/The-AI-Alliance/semiont-workflows) repository.

## Service Ports

| Service | Port | URL |
|---------|------|-----|
| Envoy Proxy | 8080 | http://localhost:8080 (main entry point) |
| Frontend | 3000 | http://localhost:3000 (direct) |
| Backend | 4000 | http://localhost:4000 (direct) |
| PostgreSQL | 5432 | postgresql://localhost:5432 |

## Common Tasks

### Start/Stop Individual Services

```bash
semiont start --service backend
semiont stop --service backend
semiont check
```

### Re-provision After Config Changes

```bash
semiont provision --service frontend
semiont provision --service backend
```

## Developer Mode

If you need to modify Semiont itself (backend, frontend, or CLI), see the [Semiont repository](https://github.com/The-AI-Alliance/semiont) for development setup instructions.
