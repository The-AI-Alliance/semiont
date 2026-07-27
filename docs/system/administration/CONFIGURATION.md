# Semiont Configuration Guide

Semiont uses a two-layer TOML configuration model, and **both layers live in the knowledge-base repo**: `.semiont/config` is the KB's committed identity, and `.semiont/semiontconfig/<name>.toml` holds the environment wiring. A KB may ship several named configs (e.g. `anthropic.toml`, `ollama-gemma.toml`); `semiont start --config <name>` selects one.

> **Consumers of this schema.** Besides the Semiont services themselves (which
> select drivers by each role's `type`), the **`semiont` launcher** derives its
> launch plan from a KB's `.semiont/semiontconfig/*.toml`: per dependency role
> (`graph`, `vectors`, `database`, `inference`/`embedding`) it reads `type`,
> the address/port, and credentials to decide whether to launch a container,
> verify an external endpoint, or reuse a host process — plus an optional
> `image` key per role section to override its default container image. The
> launcher reads only
> those keys and ignores the rest; this document remains the schema's source of
> truth. See `apps/launcher/README.md` and `.plans/LAUNCHER-CONFIG-SYNC.md`.

## Configuration Layers

| Scope | Path | Committed? | Content |
|---|---|---|---|
| Environment | `.semiont/semiontconfig/<name>.toml` | Yes | All environment config: services, ports, URLs, driver choices, inference |
| Project | `.semiont/config` | Yes | Project identity: name, git sync, site identity (did:web) |
| Secrets | environment variables | No | `JWT_SECRET`, `SEMIONT_WORKER_SECRET`, inference API keys |

> **Where `~/.semiontconfig` fits.** Nothing on your host reads that path. The
> launcher stages a per-service copy of the selected config and bind-mounts it
> **inside each container** at `/home/semiont/.semiontconfig`, which is where
> the service process reads it from. If you see that path in service code or
> logs, it is the container's view of the file you edited in the KB repo.

### `.semiont/config` (project-local, committed)

Created by `semiont init`. The project's committed identity card:

```toml
[project]
name = "My Knowledge Base"
version = "0.1.0"

[git]
sync = true                # backend stages event-log writes with git

[site]
# Permanent did:web identity for everything this KB mints (stamped into the
# committed event log). Names the repo, not a deployment — a committed
# literal, never env-templated, never a machine address.
domain = "example.github.io:my-kb"    # ⇔ did:web:example.github.io:my-kb
siteName = "My Knowledge Base"
adminEmail = ""
oauthAllowedDomains = ["example.com"]
```

`[site] domain` is identity, not addressing: it names the repository in
did:web's colon-path form and must stay stable across deployments (the same
invariant that keeps `BACKEND_HOST` off the backend container — `publicURL`
derivation). The `semiont` launcher parses this file for display and its
roots registry (`roots.json` records each root's did:web and siteName);
environment wiring stays in the KB's `.semiont/semiontconfig/` variants.

### `.semiont/semiontconfig/<name>.toml` (per-KB, committed)

All environment-specific configuration. `semiont init` writes one; a KB may
ship several (`semiont start --list-configs` lists them) and
`semiont start --config <name>` picks which to run. Each file supports
multiple named environments:

```toml
[user]
name = "Adam Pingel"
email = "adam@example.com"

[defaults]
environment = "local"
platform = "posix"

# ── ENVIRONMENT: local ───────────────────────────────────────────────────────

[environments.local.backend]
port = 4000
publicURL = "http://localhost:4000"
frontendURL = "http://localhost:3000"

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

### Secrets

Secrets are **not** part of the config file. The backend reads them from its environment:

| Variable | Used for |
|---|---|
| `JWT_SECRET` | signing and verifying access tokens (min. 32 characters) |
| `SEMIONT_WORKER_SECRET` | the software-agent token exchange |
| inference API keys (e.g. `ANTHROPIC_API_KEY`) | provider calls |

A `$XDG_CONFIG_HOME/semiont/secrets` file used to be generated by the retired
`semiont provision`; nothing writes it now. See [Secrets](../services/SECRETS.md) and
`semiont secret` for registering where values come from.

## Environment Selection

Two independent choices:

1. **Which config file** — `semiont start --config <name>` selects
   `.semiont/semiontconfig/<name>.toml`. `--list-configs` shows what a KB ships.
2. **Which environment block inside it** — `[defaults] environment` in that
   file. This is **required**: a config with no `[defaults] environment`, or one
   naming a block it doesn't define, is a startup error rather than a silent
   fallback.

```bash
semiont start --list-configs        # what this KB ships
semiont start --config anthropic    # run .semiont/semiontconfig/anthropic.toml
```

To run a different environment, edit `[defaults] environment` in the config, or
ship a second config file that selects it.

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

Ollama configuration has two parts: the server declaration (where the server runs) and per-worker inference routing.

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

The vector store holds pre-computed embedding vectors for semantic similarity search. Configure it separately from the embedding provider.

```toml
[environments.local.vectors]
type = "qdrant"
host = "localhost"
port = 6333
```

### In-memory vector store (testing)

For development without Qdrant:

```toml
[environments.local.vectors]
type = "memory"
```

The in-memory store loses all vectors on restart.

## Embedding Configuration

The embedding service computes vector embeddings for resources and annotations. It runs independently of the inference providers used for text generation.

### Ollama (local, default)

No API key required. Ollama runs locally or in a container.

```toml
[environments.local.embedding]
platform = "external"
type = "ollama"
model = "nomic-embed-text"
baseURL = "http://localhost:11434"

[environments.local.embedding.chunking]
chunkSize = 512
overlap = 64
```

Available Ollama models: `nomic-embed-text` (768 dims), `all-minilm` (384), `mxbai-embed-large` (1024), `snowflake-arctic-embed` (1024).

### Voyage AI (cloud)

Requires a Voyage AI API key (separate from Anthropic).

```toml
[environments.local.embedding]
platform = "external"
type = "voyage"
model = "voyage-3"
apiKey = "<your-voyage-api-key>"

[environments.local.embedding.chunking]
chunkSize = 512
overlap = 64
```

Available Voyage models: `voyage-3` (1024 dims), `voyage-3-lite` (512), `voyage-code-3`, `voyage-finance-2`, `voyage-law-2`.

## Environment Variables

Only a small number of environment variables are used:

| Variable | Purpose | Required? |
|---|---|---|
| `SEMIONT_ROOT` | Override project root discovery | No (auto-detected) |
| `SEMIONT_VERSION` | Image tag to run (`local` uses locally built images) | No (defaults to `latest`) |
| `ANTHROPIC_API_KEY` | Resolved from `${ANTHROPIC_API_KEY}` in config | If using Anthropic (not needed for Ollama-only) |
| `POSTGRES_PASSWORD` | Resolved from `${POSTGRES_PASSWORD}` in config | If using variable refs |

Variable references in the config use `${VAR_NAME}` syntax. The launcher leaves them verbatim when it stages the file; interpolation happens inside the container at load time, so the values never pass through your shell history or the launcher's logs.

## Quick Start

### First-time setup

```bash
# 1. Install the launcher (single static binary — no npm, no Node.js)
brew install the-ai-alliance/semiont/semiont

# 2. Create a knowledge base (writes .semiont/config, registers the KB)
semiont init

# 3. Point it at an inference config, then bring the stack up
semiont start --list-configs
semiont start --config anthropic
semiont status
```

`semiont init` creates:
- `.semiont/config` — the project anchor: KB name and permanent `did:web` site identity, committed
  to version control

- `.semiont/semiontconfig/<name>.toml` — the environment TOML this document describes: service
  endpoints, database settings, and the graph / vectors / inference driver choices. A KB may ship
  several (`semiont start --list-configs`); `--config <name>` selects one.

Secrets never live in the config. `SEMIONT_WORKER_SECRET`, `JWT_SECRET`, and any inference API keys
reach services as environment variables — see [Secrets](../services/SECRETS.md) and
`semiont secret` for registering where they come from.

## Runtime File Locations

Services run as containers and log to stdout (`semiont logs`); persistent data lives in the
container volumes the launcher manages (`semiont clean` removes them). Launcher state — recorded
stacks, per-stack session tokens — follows XDG conventions under `$XDG_STATE_HOME/semiont/`.

The KB's own durable state is the repo itself: `.semiont/config` (project anchor) and
`.semiont/events/` (the event log — the system of record, committed).

## Troubleshooting

### Config not found

```bash
# Check project anchor
ls .semiont/config

# Check the environment configs this KB ships
ls .semiont/semiontconfig/
semiont start --list-configs

# Check SEMIONT_ROOT if set
echo $SEMIONT_ROOT
```

### Wrong environment

```bash
# Which block will be used, in the config you're running
grep -A2 '\[defaults\]' .semiont/semiontconfig/<name>.toml
```

Edit `[defaults] environment` to change it — there is no per-command override.

### Missing inference config

If you see `No inference config found for actor 'gatherer'` or similar, add the required section to the config file you're running. See [Inference Configuration](#inference-configuration) above.

## Related Documentation

- [Architecture](../README.md) — System architecture overview
- [Authentication](./AUTHENTICATION.md) — OAuth, JWT, MCP token flows
- [Services Overview](../services/OVERVIEW.md) — Service catalog
- [Launcher README](../../../apps/launcher/README.md) — `semiont` command reference
