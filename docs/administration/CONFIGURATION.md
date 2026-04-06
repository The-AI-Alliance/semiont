# Semiont Configuration Guide

Semiont uses a two-layer TOML configuration model, analogous to Git's `~/.gitconfig` + `.git/config`.

## Configuration Layers

| Scope | Path | Committed? | Content |
|---|---|---|---|
| Global | `~/.semiontconfig` | No | All environment config: services, ports, URLs, credentials, inference |
| Project | `.semiont/config` | Yes | Project name only |
| Secrets | `$XDG_CONFIG_HOME/semiont/secrets` | No | JWT secret (mode 0600) |

### `.semiont/config` (project-local, committed)

Created by `semiont init`. Contains only the project name:

```toml
[project]
name = "my-semiont-project"
```

Everything else lives in `~/.semiontconfig`, keyed to this name.

### `~/.semiontconfig` (user-global, never committed)

All environment-specific configuration. Supports multiple named environments:

```toml
[user]
name = "Adam Pingel"
email = "adam@example.com"

[defaults]
environment = "local"
platform = "posix"

# ── ENVIRONMENT: local ───────────────────────────────────────────────────────

[environments.local.backend]
port = 3001
publicURL = "http://localhost:3001"
frontendURL = "http://localhost:3000"
corsOrigin = "http://localhost:3000"

[environments.local.site]
domain = "localhost"
siteName = "Semiont (local)"
adminEmail = "admin@example.com"
oauthAllowedDomains = ["localhost"]
enableLocalAuth = true

[environments.local.database]
host = "localhost"
port = 5432
name = "semiont_local"
user = "postgres"
password = "${POSTGRES_PASSWORD}"

[environments.local.make-meaning.graph]
type = "memory"   # or: neo4j

[environments.local.make-meaning.actors.gatherer.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
maxTokens = 4096
apiKey = "${ANTHROPIC_API_KEY}"

[environments.local.make-meaning.actors.matcher.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
maxTokens = 2048
apiKey = "${ANTHROPIC_API_KEY}"

# One default for all workers; override per-worker as needed
[environments.local.workers.default.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
maxTokens = 4096
apiKey = "${ANTHROPIC_API_KEY}"

# Override for workers that need more capability
[environments.local.workers.reference-annotation.inference]
model = "claude-sonnet-4-6"
maxTokens = 8192

[environments.local.workers.generation.inference]
model = "claude-sonnet-4-6"
maxTokens = 16384
```

### `$XDG_CONFIG_HOME/semiont/secrets` (mode 0600, never committed)

Stores the JWT shared secret (`JWT_SECRET`) used by the backend for signing and verifying tokens. Created automatically by `semiont provision` if absent.

Default path: `~/.config/semiont/secrets`

```toml
[secrets]
JWT_SECRET = "..."
```

## Environment Selection

In order of precedence:

1. `--environment` CLI flag
2. `SEMIONT_ENV` environment variable
3. `defaults.environment` in `~/.semiontconfig`
4. Falls back to `"local"` if none set

```bash
# Use --environment flag
semiont start --environment staging

# Or set SEMIONT_ENV
export SEMIONT_ENV=staging
semiont start
```

## Project Discovery

Semiont walks up from the current directory looking for `.semiont/`, exactly as `git` finds `.git/`. `SEMIONT_ROOT` may be set explicitly to override discovery — useful in CI and scripting.

```bash
# Auto-detect (recommended)
cd /anywhere/in/project
semiont start

# Explicit override
export SEMIONT_ROOT=/path/to/project
semiont start
```

## Inference Configuration

Semiont supports **Anthropic** (cloud) and **Ollama** (local) inference providers. Each actor and worker can be independently configured, and providers can be mixed within a single environment.

Inference config merges from most-specific to least-specific:

```
worker.<name>.inference  →  workers.default.inference  →  (error if missing)
actor.<name>.inference   →  (no inference if absent — Stower has none)
```

### Anthropic

```toml
[environments.local.workers.default.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
maxTokens = 4096
apiKey = "${ANTHROPIC_API_KEY}"
```

### Ollama (local)

Ollama configuration has two parts: the server declaration (used by `semiont provision` to know where the server runs) and per-worker inference routing.

```toml
# Ollama server location
[environments.local.inference.ollama]
platform = "posix"
baseURL = "http://localhost:11434"

# Route all workers to Ollama by default
[environments.local.workers.default.inference]
type = "ollama"
model = "gemma3:4b"
```

### Mixed Providers

Workers can use different providers independently. A typical setup uses a capable cloud model for reasoning-heavy workers and a fast local model for simpler detection:

```toml
# Anthropic for most workers
[environments.local.workers.default.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.actors.gatherer.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.actors.matcher.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

# Ollama for highlight detection (fast, lower stakes)
[environments.local.workers.highlight-annotation.inference]
type = "ollama"
model = "gemma3:4b"

# Haiku for lightweight comment/tag workers
[environments.local.workers.comment-annotation.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"

[environments.local.workers.tag-annotation.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
```

Both providers must be declared when used together:

```toml
[environments.local.inference.anthropic]
platform = "external"
endpoint = "https://api.anthropic.com"
apiKey = "${ANTHROPIC_API_KEY}"

[environments.local.inference.ollama]
platform = "posix"
baseURL = "http://localhost:11434"
```

## Graph Configuration

```toml
# In-memory (development, no persistence)
[environments.local.make-meaning.graph]
type = "memory"

# Neo4j
[environments.local.make-meaning.graph]
type = "neo4j"
uri = "bolt://localhost:7687"
username = "neo4j"
password = "${NEO4J_PASSWORD}"
database = "neo4j"
```

## Vectors Configuration

Vector search enables semantic similarity across resources and annotations. Requires a vector store (Qdrant or in-memory) and an embedding provider (Ollama or Voyage AI).

### Ollama (local, default)

No API key required. Ollama runs locally or in a container.

```toml
[environments.local.vectors]
type = "qdrant"
host = "localhost"
port = 6333

[environments.local.vectors.embedding]
type = "ollama"
model = "nomic-embed-text"
baseURL = "http://localhost:11434"

[environments.local.vectors.chunking]
chunkSize = 512
overlap = 64
```

Available Ollama models: `nomic-embed-text` (768 dims), `all-minilm` (384), `mxbai-embed-large` (1024), `snowflake-arctic-embed` (1024).

### Voyage AI (cloud)

Requires a Voyage AI API key (separate from Anthropic).

```toml
[environments.local.vectors]
type = "qdrant"
host = "localhost"
port = 6333

[environments.local.vectors.embedding]
type = "voyage"
model = "voyage-3"
apiKey = "<your-voyage-api-key>"

[environments.local.vectors.chunking]
chunkSize = 512
overlap = 64
```

Available Voyage models: `voyage-3` (1024 dims), `voyage-3-lite` (512), `voyage-code-3`, `voyage-finance-2`, `voyage-law-2`.

### In-memory vector store (testing)

For development without Qdrant:

```toml
[environments.local.vectors]
type = "memory"

[environments.local.vectors.embedding]
type = "ollama"
model = "nomic-embed-text"
baseURL = "http://localhost:11434"
```

The in-memory store loses all vectors on restart.

## Environment Variables

Only a small number of environment variables are used:

| Variable | Purpose | Required? |
|---|---|---|
| `SEMIONT_ROOT` | Override project root discovery | No (auto-detected) |
| `SEMIONT_ENV` | Default environment selection | No (falls back to `defaults.environment`) |
| `ANTHROPIC_API_KEY` | Resolved from `${ANTHROPIC_API_KEY}` in config | If using Anthropic (not needed for Ollama-only) |
| `POSTGRES_PASSWORD` | Resolved from `${POSTGRES_PASSWORD}` in config | If using variable refs |

Variable references in `~/.semiontconfig` use `${VAR_NAME}` syntax and are resolved from `process.env` at load time.

## Quick Start

### First-time setup

```bash
# 1. Install CLI
npm install -g @semiont/cli

# 2. Initialize project (creates .semiont/config, prompts for ~/.semiontconfig if absent)
mkdir my-project && cd my-project
semiont init

# 3. Provision services (generates secrets, pulls models, runs migrations)
semiont provision

# 4. Start
semiont start
semiont check
```

`semiont init` creates:
- `.semiont/config` — project name
- `~/.semiontconfig` — global config (if absent, prompts interactively)
- `~/.config/semiont/` — XDG config dir (mode 0700)

`semiont provision` creates:
- `~/.config/semiont/secrets` — JWT secret (mode 0600, generated on first run)
- `~/.config/semiont/{project}/` — per-project generated configs (e.g. `proxy/envoy.yaml`)

## Runtime File Locations

All runtime state follows XDG conventions — nothing is written into the project directory.

| File type | Location | Notes |
|---|---|---|
| Pid files | `$XDG_RUNTIME_DIR/semiont/{project}/` | tmpfs, cleaned on logout |
| Log files | `$XDG_STATE_HOME/semiont/{project}/` | `~/.local/state/semiont/{project}/` |
| Generated configs | `$XDG_CONFIG_HOME/semiont/{project}/` | `~/.config/semiont/{project}/` |
| Database data | `$XDG_DATA_HOME/semiont/{project}/database/` | `~/.local/share/semiont/{project}/database/` |
| Projections, jobs | `$XDG_STATE_HOME/semiont/{project}/` | Same as logs base |

On macOS, `$XDG_RUNTIME_DIR` is not set; the fallback is `$TMPDIR/semiont/{project}/`.

## Troubleshooting

### Config not found

```bash
# Check project anchor
ls .semiont/config

# Check global config
cat ~/.semiontconfig

# Check SEMIONT_ROOT if set
echo $SEMIONT_ROOT
```

### Wrong environment

```bash
# Check what's active
echo $SEMIONT_ENV
grep -A2 '\[defaults\]' ~/.semiontconfig

# Override per-command
semiont start --environment staging
```

### Missing inference config

If you see `No inference config found for actor 'gatherer'` or similar, add the required section to `~/.semiontconfig`. See [Inference Configuration](#inference-configuration) above.

## Related Documentation

- [Architecture](../ARCHITECTURE.md) — System architecture and Git analogy
- [Authentication](./AUTHENTICATION.md) — OAuth, JWT, MCP token flows
- [Services Overview](../services/OVERVIEW.md) — Service catalog
- [CLI README](../../apps/cli/README.md) — CLI command reference
