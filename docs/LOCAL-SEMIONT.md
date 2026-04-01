# Local Semiont

Run Semiont locally using published npm packages — no need to clone the Semiont repository.

The CLI installs and provisions the backend and database from pre-built npm packages, runs database migrations, and starts all services. The database runs as a container (Docker/Podman).

## Quick Start

The fastest way to get Semiont running is a single command:

```bash
npm install -g @semiont/cli
semiont serve
```

`semiont serve` guides you through the entire setup interactively — it prompts for a project directory, initializes the project, provisions and starts the database and backend, and creates an admin user. At the end it prints the Knowledge Base URL and your credentials, and tells you how to start the frontend separately.

> `semiont local` is an alias for `semiont serve`.

See [Prerequisites](#prerequisites) below before running if you haven't installed Node.js or Docker yet.

---

## Prerequisites

### Node.js

Version 20 or higher. Install from [nodejs.org](https://nodejs.org/) or via a version manager like [nvm](https://github.com/nvm-sh/nvm).

```bash
node --version   # should print v20.x or higher
```

### Docker or Podman

Used for the PostgreSQL database container. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [Podman](https://podman.io/docs/installation).

```bash
docker --version   # or: podman --version
```

### Inference (Anthropic or Ollama)

Required for AI-powered annotation features.

**Option A: Anthropic (cloud)**

Get a key from the [Anthropic Console](https://console.anthropic.com/settings/keys).

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**Option B: Ollama (local)**

Install [Ollama](https://ollama.com/). `semiont provision` will pull the configured model automatically. No API key required.

### Graph (Neo4j)

Required for knowledge graph features. Set up a free instance at [Neo4j Aura](https://neo4j.com/cloud/aura/) or run Neo4j locally. Set the connection details in `~/.semiontconfig` under `[environments.local.graph]`:

```toml
[environments.local.graph]
type = "neo4j"
uri = "${NEO4J_URI}"
username = "${NEO4J_USERNAME}"
password = "${NEO4J_PASSWORD}"
```

Then export the corresponding environment variables:

```bash
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USERNAME=neo4j
export NEO4J_PASSWORD=your-password
```

Also install the `neo4j-driver` npm package alongside the CLI:

```bash
npm install -g neo4j-driver
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
semiont init
```

`semiont init` creates:
- `.semiont/config` — project name (committed to version control)
- `~/.semiontconfig` — your global config file (if it doesn't exist yet), with a prompt for your name, email, and default environment
- `~/.config/semiont/` — XDG config directory (mode 0700)

If `~/.semiontconfig` already exists, `semiont init` only creates `.semiont/config` for the new project.

After `init`, review `~/.semiontconfig` and set your inference provider and database credentials. See [Configuration Guide](./administration/CONFIGURATION.md) for the full schema.

The project directory is a standard git repository. Resource files live directly in the project root and are committed to git alongside `.semiont/config` and `.semiont/events/`. See [Project Layout](./PROJECT-LAYOUT.md) for the full directory structure.

### 3. Provision Services

```bash
semiont provision
```

This:
- Generates `~/.config/semiont/secrets` with a JWT secret (if absent)
- Runs database migrations
- Creates XDG runtime directories for the backend (`~/.local/state/semiont/backend/`, PID dir)

### 4. Start Services

```bash
semiont start
semiont check
```

Starts the database container and backend. `semiont check` verifies all services are healthy.

### 5. Start the Frontend (optional)

The frontend is a separate service and is not started by `semiont serve`. To start it:

```bash
semiont start --service frontend
```

The frontend is a globally-installed service and does not require a project directory.

### 6. Create an Admin User

```bash
semiont useradd --email you@example.com --generate-password --admin
```

Note the generated password from the output.

### 7. Access the Application

- **Knowledge Base API**: http://localhost:4000
- **Frontend UI** (if started): http://localhost:3000

Log in with the admin credentials from step 6.

To run demo workflows, see the [Semiont Workflows](https://github.com/The-AI-Alliance/semiont-workflows) repository.

## Service Ports

| Service | Port | URL |
|---------|------|-----|
| Backend (Knowledge Base) | 4000 | http://localhost:4000 |
| Frontend UI | 3000 | http://localhost:3000 (start separately) |
| PostgreSQL | 5432 | postgresql://localhost:5432 |

## Paths Outside the Project

Machine-specific and secret state is kept in standard XDG directories, never committed to git:

| Path | Contents |
|------|----------|
| `~/.semiontconfig` | Global user config: inference provider, database credentials, default environment |
| `~/.config/semiont/{project}/` | Generated config files for managed processes (secrets) |
| `~/.local/share/semiont/{project}/database/{service}/` | PostgreSQL data directory |
| `~/.local/share/semiont/{project}/graph/` | JanusGraph data directory — only when `type = "janusgraph"` in config (not the default) |
| `~/.local/state/semiont/{project}/projections/` | Materialized view cache (rebuilt from event log on demand) |
| `~/.local/state/semiont/{project}/jobs/` | Background job state |
| `~/.local/state/semiont/{project}/backend/` | Backend log files |
| `~/.local/state/semiont/frontend/` | Frontend log files (keyed by service name, not project) |
| `$XDG_RUNTIME_DIR/semiont/{project}/` | Backend PID file (falls back to `$TMPDIR/semiont/{project}/`) |
| `$XDG_RUNTIME_DIR/semiont/frontend/` | Frontend PID file (falls back to `$TMPDIR/semiont/frontend/`) |

See [Project Layout](./PROJECT-LAYOUT.md) for the full layout including what lives inside the project root.

## Common Tasks

### Start/Stop Individual Services

```bash
semiont start --service backend
semiont stop --service backend
semiont start --service frontend
semiont stop --service frontend
semiont check
```

### Re-provision After Config Changes

```bash
semiont provision --service backend
```

### View Logs

Log files are stored in XDG state directories:

```bash
tail -f ~/.local/state/semiont/{project}/backend/app.log
tail -f ~/.local/state/semiont/frontend/app.log
```

## Developer Mode

If you need to modify Semiont itself (backend, frontend, or CLI), see the [Semiont repository](https://github.com/The-AI-Alliance/semiont) for development setup instructions.

## Related Documentation

- [Project Layout](./PROJECT-LAYOUT.md) — Directory structure and git integration
- [Configuration Guide](./administration/CONFIGURATION.md) — Full configuration reference
- [Services Overview](./services/OVERVIEW.md) — Service catalog and runtime layout
