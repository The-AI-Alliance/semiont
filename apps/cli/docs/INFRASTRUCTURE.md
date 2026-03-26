# Infrastructure Commands

This guide covers the infrastructure-management side of the Semiont CLI: service lifecycle, deployment, backup/restore, and MCP.

For knowledge-base operations (`browse`, `gather`, `mark`, `yield`, `bind`, `match`, `listen`) see the main [README](../README.md).

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
2. `defaults.environment` in `~/.semiontconfig`
3. Error if neither is set

See [Managing Environments](./ADDING_ENVIRONMENTS.md) for the full schema.

---

## Service Lifecycle

```bash
semiont init -e local                     # Initialize a new project
semiont provision -e local                # Provision infrastructure resources
semiont start -e local                    # Start all services
semiont start -e local --service backend  # Start one service
semiont check -e local                    # Health check all services
semiont stop -e local                     # Stop all services
semiont watch -e local                    # Live web dashboard (port 3333)
```

`--dry-run` is supported on all infrastructure commands and shows what would happen without making changes.

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

---

## Deployment: Publish and Update

`publish` and `update` are intentionally separate:

**Publish** — builds and pushes artifacts, does NOT deploy:
```bash
semiont publish --service frontend -e production
```
- Builds application and Docker images
- Pushes to registries (ECR, Docker Hub, etc.)
- Creates new task definitions / deployment manifests

**Update** — deploys what `publish` prepared:
```bash
semiont update --service frontend -e production
```
- Detects newer versions created by `publish`
- Deploys to running services
- Reports success/failure

For mutable tags (`:latest`), `update` can force redeployment even without version changes. For immutable tags (git hashes), `update` only deploys if a newer version exists.

---

## Backup, Restore, and Verify

These commands provide lossless whole-KB backup and restore. The archive is a tar.gz containing `.semiont/manifest.jsonl`, per-resource event streams, and content blobs.

```bash
# Create a backup
semiont backup -e production --out backup.tar.gz

# Restore from a backup (replays events through EventBus + Stower)
semiont restore -e production --file backup.tar.gz

# Verify archive integrity without restoring (no environment needed)
semiont verify --file backup.tar.gz
```

`verify` checks manifest format, hash chain integrity, first/last checksum match, event and blob counts.

---

## Local Development Environment

```bash
semiont local start     # Start the local dev environment
semiont local stop      # Stop the local dev environment
semiont local status    # Show status
```

---

## MCP (Model Context Protocol) Server

The Semiont CLI can run an MCP server so AI assistants can interact with Semiont APIs.

### Setup (once per environment)

```bash
semiont provision --service mcp -e production
# Opens browser for OAuth; stores refresh token in
# ~/.config/semiont/mcp-auth-production.json
```

### Start

```bash
semiont start --service mcp -e production
```

### AI application configuration

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

Tokens are cached locally (access tokens 1 hour, refresh tokens 30 days). Re-run `provision` if authentication fails.

---

## Other Commands

```bash
semiont useradd -e local --email user@example.com   # Add a user
semiont export -e local --out export.json            # Export KB data
semiont import -e local --file export.json           # Import KB data
semiont clean -e local                               # Remove generated/cached files
```

---

## Further Reading

- [Architecture Overview](./ARCHITECTURE.md)
- [Managing Environments](./ADDING_ENVIRONMENTS.md)
- [Adding Commands](./ADDING_COMMANDS.md)
- [Adding Platforms](./ADDING_PLATFORMS.md)
- [Adding Services](./ADDING_SERVICES.md)
- [Adding Service Types](./ADDING_SERVICE_TYPES.md)
