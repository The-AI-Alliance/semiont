# Local Backend Setup

Run the Semiont backend locally. Both paths below use `~/.semiontconfig` for inference providers, database credentials, graph, and vector store settings — see the **[Configuration Guide](./administration/CONFIGURATION.md)**.

## Container (no npm required)

Clone a knowledge base repository and run the stack script:

```bash
git clone https://github.com/The-AI-Alliance/gutenberg-kb.git
cd gutenberg-kb
.semiont/scripts/start.sh --email admin@example.com --password password
```

The script pulls the published, attested Semiont service images
(`ghcr.io/the-ai-alliance/semiont-{backend,worker,smelter,weaver,frontend}`),
starts them alongside the infrastructure containers (Neo4j, Qdrant,
PostgreSQL), and bind-mounts the KB's config at runtime — KB repos build no
images. Pass `--email` and `--password` to create an admin user on startup;
`--config <name>` selects an inference config (`--list-configs` to see them);
`SEMIONT_VERSION` pins the image version (`local` consumes images built from
a monorepo working tree by
[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh)).

Prerequisites: a container runtime, plus `ANTHROPIC_API_KEY` when using the
Anthropic config. See the [KB README](https://github.com/The-AI-Alliance/gutenberg-kb) for details.

The authoritative compose files and script live in the [semiont-template-kb](https://github.com/The-AI-Alliance/semiont-template-kb) template repository under `.semiont/`; the image inventory and supply-chain verification are in [Container Images](./administration/IMAGES.md).

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
| Neo4j | 7687 | bolt://localhost:7687 |
| Qdrant | 6333 | http://localhost:6333 |

## Paths

| Path | Contents |
|------|----------|
| `~/.semiontconfig` | Global config: inference, database, graph credentials |
| `~/.config/semiont/{project}/` | Generated secrets (JWT_SECRET) |
| `~/.local/share/semiont/{project}/database/` | PostgreSQL data directory |
| `~/.local/state/semiont/{project}/backend/` | Backend log files |
| `$XDG_RUNTIME_DIR/semiont/{project}/` | Backend PID file |
