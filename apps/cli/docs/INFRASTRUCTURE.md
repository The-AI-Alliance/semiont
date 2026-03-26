# Infrastructure Commands

This guide covers the infrastructure-management side of the Semiont CLI: service lifecycle, deployment, and administration.

For knowledge-base setup (`init`, `backup`, `restore`, `verify`, `export`, `import`) see [Knowledge Base Commands](./KNOWLEDGE-BASE.md).
For API operations (`browse`, `gather`, `mark`, `yield`, `bind`, `match`, `listen`, `beckon`) see [Knowledge Work Commands](./KNOWLEDGE-WORK.md).

---

## Environment Configuration

Environments are configured in `~/.semiontconfig` under `[environments.<name>.*]` sections. The project name in `.semiont/config` connects the project to its configuration.

```toml
[defaults]
environment = "local"

[environments.local.services.backend]
publicURL = "http://localhost:4000"

[environments.local.auth]
email = "you@example.com"
password = "secret"

[environments.local.database]
host = "localhost"
port = 5432
name = "semiont_local"
user = "postgres"
password = "${POSTGRES_PASSWORD}"

[environments.local.workers.default.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
apiKey = "${ANTHROPIC_API_KEY}"
```

### Environment resolution order

1. `--environment` flag (highest priority)
2. `$SEMIONT_ENV` environment variable
3. `defaults.environment` in `~/.semiontconfig`
4. Error if none of the above is set

See [Managing Environments](./ADDING_ENVIRONMENTS.md) for the full schema.

---

## Service Lifecycle

```bash
semiont provision -e local                # Provision infrastructure resources
semiont start -e local                    # Start all services
semiont start -e local --service backend  # Start one service
semiont check -e local                    # Health check all services
semiont stop -e local                     # Stop all services
semiont watch -e local                    # Live web dashboard (port 3333)
```

`--dry-run` is supported on all commands and shows what would happen without making changes.

### Service selection

- `--service all` — all services in the environment (default)
- `--service backend` — a single named service
- Available service names: `frontend`, `backend`, `database`, `graph`, `event-store`, `projection`, `filesystem`, `inference`, `mcp`

### Platform support

Platforms are configured per-service in `~/.semiontconfig`:

- **`posix`** — local OS processes
- **`container`** — Docker / Podman containers
- **`aws`** — AWS infrastructure (ECS, RDS, S3+CloudFront, etc.)
- **`external`** — third-party or pre-existing services
- **`mock`** — simulated services for testing

### MCP (Model Context Protocol) server

The `mcp` service exposes Semiont APIs to AI assistants via the Model Context Protocol.

```bash
semiont provision --service mcp -e production   # OAuth setup (once)
semiont start --service mcp -e production
```

AI application configuration:

```json
{
  "semiont": {
    "command": "semiont",
    "args": ["start", "--service", "mcp"],
    "env": {
      "SEMIONT_ROOT": "/path/to/semiont",
      "SEMIONT_ENV": "production"
    }
  }
}
```

---

## Administration

```bash
semiont useradd -e local --email user@example.com   # Create or update a user
semiont clean -e local                               # Remove generated/cached files and Docker volumes
```

The `local` command is a shorthand for the full first-run sequence:

```bash
semiont local   # equivalent to: init → provision → start → useradd
```

---

## AWS ECS Deployment

For teams deploying Semiont services to AWS ECS Fargate, the CLI includes built-in handlers for `publish` and `update`:

```bash
semiont publish --service frontend -e production   # build → ECR push → new task definition
semiont update --service frontend -e production    # deploy new task definition to ECS
```

`publish` builds locally, pushes to ECR, and registers a new task definition revision. `update` detects the new revision and issues a rolling deployment, with optional `--wait` progress monitoring and CloudWatch log fetch on failure. Most teams will prefer to wire these steps into their own CI/CD pipelines directly.

---

## Further Reading

- [Knowledge Base Commands](./KNOWLEDGE-BASE.md) — init, backup, restore, verify, export, import
- [Knowledge Work Commands](./KNOWLEDGE-WORK.md) — login, browse, gather, mark, match, bind, listen, yield, beckon
- [Architecture Overview](./ARCHITECTURE.md)
- [Managing Environments](./ADDING_ENVIRONMENTS.md)
- [Adding Commands](./ADDING_COMMANDS.md)
- [Adding Platforms](./ADDING_PLATFORMS.md)
- [Adding Services](./ADDING_SERVICES.md)
- [Adding Service Types](./ADDING_SERVICE_TYPES.md)
