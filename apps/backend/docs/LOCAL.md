# Local Backend Setup

Run the Semiont backend locally.

## Container (no npm required)

Clone a knowledge base repository and run the backend script:

```bash
git clone https://github.com/The-AI-Alliance/gutenberg-kb.git
cd gutenberg-kb
.semiont/scripts/local_backend.sh --email admin@example.com --password password
```

The script starts Neo4j, PostgreSQL, and the backend in containers. Pass `--email` and `--password` to create an admin user on startup. If omitted, no user is created.

Prerequisites: a container runtime and `ANTHROPIC_API_KEY`. See the [KB README](https://github.com/The-AI-Alliance/gutenberg-kb) for details.

The authoritative Dockerfile and script live in the Semiont repo:
- [apps/backend/Dockerfile](../Dockerfile)
- [apps/backend/scripts/local_backend.sh](../scripts/local_backend.sh)

## npm

```bash
npm install -g @semiont/cli neo4j-driver
semiont serve
```

`semiont serve` initializes the project, provisions and starts the database and backend, and creates an admin user.

### Prerequisites

- **Node.js 20+** — [nodejs.org](https://nodejs.org/)
- **Container runtime** — [Apple Container](https://github.com/apple/container), [Docker](https://www.docker.com/), or [Podman](https://podman.io/) (for PostgreSQL)
- **Inference** — `ANTHROPIC_API_KEY` or [Ollama](https://ollama.com/)
- **Neo4j** — [Neo4j Aura](https://neo4j.com/cloud/aura/) (free) or local

### Step by step

```bash
# 1. Install
npm install -g @semiont/cli neo4j-driver

# 2. Initialize a project
mkdir my-kb && cd my-kb
semiont init

# 3. Set credentials
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USERNAME=neo4j
export NEO4J_PASSWORD=your-password
export NEO4J_DATABASE=neo4j
export ANTHROPIC_API_KEY=sk-ant-...

# 4. Provision and start
semiont provision
semiont start
semiont check

# 5. Create admin user
semiont useradd --email you@example.com --generate-password --admin
```

The backend runs at **http://localhost:4000**.

### Configuration

Edit `~/.semiontconfig` to set inference providers, database credentials, and graph connection. See the [Configuration Guide](../../docs/administration/CONFIGURATION.md).

### Service management

```bash
semiont start --service backend
semiont stop --service backend
semiont check
```

### Logs

```bash
tail -f ~/.local/state/semiont/{project}/backend/app.log
```

### Re-provision after config changes

```bash
semiont provision --service backend
```

## Ports

| Service | Port | URL |
|---------|------|-----|
| Backend | 4000 | http://localhost:4000 |
| PostgreSQL | 5432 | postgresql://localhost:5432 |

## Paths

| Path | Contents |
|------|----------|
| `~/.semiontconfig` | Global config: inference, database, graph credentials |
| `~/.config/semiont/{project}/` | Generated secrets (JWT_SECRET) |
| `~/.local/share/semiont/{project}/database/` | PostgreSQL data directory |
| `~/.local/state/semiont/{project}/backend/` | Backend log files |
| `$XDG_RUNTIME_DIR/semiont/{project}/` | Backend PID file |
