# Semiont CLI

[![npm version](https://img.shields.io/npm/v/@semiont/cli.svg)](https://www.npmjs.com/package/@semiont/cli)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/cli.svg)](https://www.npmjs.com/package/@semiont/cli)
[![License](https://img.shields.io/npm/l/@semiont/cli.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The Semiont CLI provides two related capabilities: **knowledge-base operations** (annotating resources, gathering context, streaming events) and **infrastructure management** (service lifecycle, deployment, backup/restore).

---

## Installation

```bash
npm install -g @semiont/cli
semiont --help
```

Or from source:

```bash
cd apps/cli && npm run build && npm link
```

---

## Common Options

All commands support:

| Flag | Short | Description |
|------|-------|-------------|
| `--environment <env>` | `-e` | Target environment (required for most commands). Fallback: `defaults.environment` in `~/.semiontconfig` |
| `--dry-run` | | Preview changes without applying |
| `--verbose` | `-v` | Show detailed output |
| `--quiet` | `-q` | Suppress progress output |
| `--output <format>` | `-o` | `summary` \| `table` \| `json` \| `yaml` |

### Connection Options (API commands only)

Commands that call the Semiont API (`browse`, `gather`, `mark`, `yield`, `bind`, `match`, `listen`) also accept:

| Flag | Short | Description |
|------|-------|-------------|
| `--bus <url>` | `-b` | Backend URL. Fallback: `$SEMIONT_BUS` → `services.backend.publicURL` in `~/.semiontconfig` |
| `--user <email>` | | Login email. Fallback: `$SEMIONT_USER` → `[environments.<env>.auth] email` in `~/.semiontconfig` |
| `--password <pw>` | | Login password. Fallback: `$SEMIONT_PASSWORD` → `[environments.<env>.auth] password` in `~/.semiontconfig` |

---

## Knowledge Base Operations

These commands interact with the Semiont backend API. They require a running backend service.

### browse — Inspect the knowledge base

Human-readable traversal of resources, annotations, references, and events. Output goes to stdout as JSON; progress labels go to stderr.

```bash
# List resources
semiont browse resources -e local
semiont browse resources -e local --search "Paris"
semiont browse resources -e local --entity-type Location --limit 20

# Inspect a resource
semiont browse resource <resourceId> -e local
semiont browse resource <resourceId> -e local --annotations
semiont browse resource <resourceId> -e local --references

# Inspect an annotation
semiont browse annotation <resourceId> <annotationId> -e local

# See what resources link to this one
semiont browse references <resourceId> -e local

# Event log and annotation audit trail
semiont browse events <resourceId> -e local
semiont browse history <resourceId> <annotationId> -e local

# Available entity types
semiont browse entity-types -e local

# Composable with jq
semiont browse resources -e local | jq '.[][\"@id\"]'
semiont browse entity-types -e local | jq '.[].tag'
```

### gather — Fetch LLM-optimised context

Fetches a resource or annotation and returns structured context suitable for LLM pipelines (JSON to stdout).

```bash
semiont gather <resourceId> -e local
semiont gather <resourceId> --annotation <annotationId> -e local
```

Use `gather` (not `browse`) when feeding context into AI pipelines.

### mark — Create an annotation

Creates a W3C annotation on a resource. Operates in manual mode by default or AI-assisted delegate mode with `--delegate`.

```bash
# Manual annotation
semiont mark <resourceId> --motivation tagging --body '{"value":"important"}' -e local

# AI-assisted: gather context and let the model draft the annotation
semiont mark <resourceId> --delegate -e local
```

### yield — Upload or generate a resource

Uploads a local file as a new resource, or generates a new resource from gathered context.

```bash
# Upload a file
semiont yield --upload ./paper.pdf -e local

# AI-generated resource from gathered context
semiont yield --delegate <resourceId> -e local
```

### bind — Resolve a linking annotation

Resolves a linking annotation to a target resource.

```bash
semiont bind <resourceId> <annotationId> --target <targetResourceId> -e local
```

### match — Find binding candidates

Searches for candidate resources to bind to a linking annotation.

```bash
semiont match <resourceId> <annotationId> -e local
```

### listen — Stream domain events

Opens a persistent SSE connection and prints domain events as NDJSON (one event per line). Runs until Ctrl-C or the server closes the connection.

```bash
# All system events
semiont listen -e local

# Events for a specific resource
semiont listen resource <resourceId> -e local

# Composable
semiont listen -e local | jq .type
semiont listen resource <resourceId> -e local | grep annotation
```

### beckon — Direct attention *(backend endpoint pending)*

Directs a participant's attention to a resource or annotation.

```bash
semiont beckon <resourceId> -e local
```

---

## Infrastructure Management

For full details see [Infrastructure Commands](./docs/INFRASTRUCTURE.md).

### Service lifecycle

```bash
semiont init -e local                     # Initialize a new project
semiont provision -e local                # Provision infrastructure resources
semiont start -e local                    # Start all services
semiont start -e local --service backend  # Start one service
semiont check -e local                    # Health check
semiont stop -e local                     # Stop all services
semiont watch -e local                    # Live web dashboard (port 3333)
```

Available service names: `frontend`, `backend`, `database`, `graph`, `event-store`, `projection`, `filesystem`, `inference`, `mcp`.

Platforms: `posix` (local OS), `container` (Docker/Podman), `aws`, `external`, `mock`.

### Deployment

```bash
# Build and push artifacts (does NOT deploy)
semiont publish --service frontend -e production

# Deploy what publish prepared
semiont update --service frontend -e production
```

### Backup, restore, and verify

```bash
semiont backup -e production --out backup.tar.gz
semiont restore -e production --file backup.tar.gz
semiont verify --file backup.tar.gz          # no environment needed
```

The archive contains `.semiont/manifest.jsonl`, per-resource event streams, and content blobs. `restore` replays events through EventBus + Stower so materialized views rebuild naturally.

### Other commands

```bash
semiont local start / stop / status       # Local dev environment
semiont useradd -e local --email user@example.com
semiont export -e local --out export.json
semiont import -e local --file export.json
semiont clean -e local
```

---

## Environment Configuration

Environments are configured in `~/.semiontconfig`:

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

See [Managing Environments](./docs/ADDING_ENVIRONMENTS.md) for the full schema.

---

## Further Reading

- [Infrastructure Commands](./docs/INFRASTRUCTURE.md) — service lifecycle, deployment, backup/restore, MCP
- [Architecture Overview](./docs/ARCHITECTURE.md)
- [Managing Environments](./docs/ADDING_ENVIRONMENTS.md)
- [Adding Commands](./docs/ADDING_COMMANDS.md)
- [Adding Platforms](./docs/ADDING_PLATFORMS.md)
- [Adding Services](./docs/ADDING_SERVICES.md)
- [Adding Service Types](./docs/ADDING_SERVICE_TYPES.md)

---

## License

Apache License 2.0 — see the LICENSE file for details.
