# Local Semiont

Run Semiont locally.

There are two ways to start:

**Use an existing knowledge base** — clone a KB repository that already has documents and container scripts:

```bash
git clone https://github.com/The-AI-Alliance/gutenberg-kb.git
cd gutenberg-kb
.semiont/scripts/local_backend.sh    # terminal 1
.semiont/scripts/local_frontend.sh   # terminal 2
```

No npm required — everything runs in containers. See the [KB README](https://github.com/The-AI-Alliance/gutenberg-kb) for prerequisites and details. The authoritative Dockerfiles and scripts live in the [semiont-empty-kb](https://github.com/The-AI-Alliance/semiont-empty-kb) template repository under `.semiont/`.

**Create a new knowledge base** — start from scratch with your own documents:

```bash
npm install -g @semiont/cli
semiont init
semiont serve
```

`semiont serve` guides you through the entire setup interactively — it prompts for a project directory, initializes the project, provisions and starts the database and backend, and creates an admin user.

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
