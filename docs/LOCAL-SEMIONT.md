# Local Semiont

Run Semiont locally.

There are two ways to start:

**Use an existing knowledge base** — clone a KB repository that already has documents and container scripts:

```bash
git clone https://github.com/The-AI-Alliance/gutenberg-kb.git
cd gutenberg-kb
.semiont/scripts/local_backend.sh --email admin@example.com --password password  # terminal 1
.semiont/scripts/local_frontend.sh                                                # terminal 2
```

No npm required — everything runs in containers. See the [KB README](https://github.com/The-AI-Alliance/gutenberg-kb) for prerequisites and details. The authoritative Dockerfiles and scripts live in the [semiont-template-kb](https://github.com/The-AI-Alliance/semiont-template-kb) template repository under `.semiont/`.

**Create a new knowledge base** — start from the template:

```bash
git clone https://github.com/The-AI-Alliance/semiont-template-kb.git my-kb
cd my-kb
```

Start the backend with Ollama for fully local inference (no API key needed):

```bash
.semiont/scripts/local_backend.sh --email admin@example.com --password password
```

On first run, the backend container pulls the inference and embedding models from Ollama. This is a one-time download (~2-4 GB depending on the model) and may take several minutes.

To use Anthropic cloud inference instead:

```bash
export ANTHROPIC_API_KEY=<your-api-key>
.semiont/scripts/local_backend.sh --config anthropic --email admin@example.com --password password
```

To see all available configs:

```bash
.semiont/scripts/local_backend.sh --list-configs
```

In a second terminal, start the frontend:

```bash
.semiont/scripts/local_frontend.sh
```

Open **http://localhost:3000** and enter **http://localhost:4000** as the knowledge base URL.

## Detailed Setup

- **[Backend](../apps/backend/docs/LOCAL.md)** — PostgreSQL, inference, Neo4j, service management
- **[Frontend](../apps/frontend/docs/LOCAL.md)** — SPA, desktop app, connecting to a backend

## Service Ports

| Service | Port | URL |
|---------|------|-----|
| Backend | 4000 | http://localhost:4000 |
| Frontend | 3000 | http://localhost:3000 |
| PostgreSQL | 5432 | postgresql://localhost:5432 |

## Related Documentation

- [Project Layout](./PROJECT-LAYOUT.md) — Directory structure, XDG paths, and git integration
- [Configuration Guide](./administration/CONFIGURATION.md) — Full configuration reference
- [Services Overview](./services/OVERVIEW.md) — Service catalog and runtime layout
