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
> truth. See `apps/launcher/README.md`.

## Configuration Layers

| Scope | Path | Committed? | Content |
|---|---|---|---|
| Environment | `.semiont/semiontconfig/<name>.toml` | Yes | All environment config: services, ports, URLs, driver choices, inference |
| Project | `.semiont/config` | Yes | Project identity: name, git sync, site identity (did:web) |
| Secrets | environment variables | No | `JWT_SECRET`, the per-service `SEMIONT_OIDC_CLIENT_SECRET`, inference API keys |

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
sync = true                # gateway stages event-log writes with git

[site]
# Permanent did:web identity for everything this KB mints (stamped into the
# committed event log). Names the repo, not a deployment — a committed
# literal, never env-templated, never a machine address.
domain = "example.github.io:my-kb"    # ⇔ did:web:example.github.io:my-kb
siteName = "My Knowledge Base"
adminEmail = ""
```

`[site] domain` is identity, not addressing: it names the repository in
did:web's colon-path form and must stay stable across deployments (the same
invariant that keeps the gateway-host vars off the gateway container — `publicURL`
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

[environments.local.gateway]
port = 4000
publicURL = "http://localhost:4000"

[environments.local.site]
domain = "localhost"
siteName = "Semiont (local)"
adminEmail = "admin@example.com"

[environments.local.identity]
type = "keycloak"
issuer = "http://localhost:8080/realms/semiont"
subjectClaim = "sub"

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

### `[gateway]` and `[backend]` are one section

Both spellings load, and `semiont init` writes `[environments.<env>.gateway]`.

Declaring **both** in one environment is an error, not a precedence rule:

```
environment "local" declares both [environments.local.gateway] and
[environments.local.backend]; they are one section under two spellings —
keep gateway and delete backend
```

A file with both is half-migrated, and silently choosing one would leave the next reader unable
to tell which section is live. Delete the `[backend]` section and keep `[gateway]`.

The same applies to the host variable the generated `publicURL` interpolates: the launcher sets
**both** `${GATEWAY_HOST}` and `${BACKEND_HOST}`, so either resolves.

### Secrets

Secrets are **not** part of the config file. The gateway reads them from its environment:

| Variable | Used for |
|---|---|
| `JWT_SECRET` | signing and verifying agent and media tokens (min. 32 characters) |
| `SEMIONT_OIDC_CLIENT_ID` / `SEMIONT_OIDC_CLIENT_SECRET` | this service's own account at the knowledge base's issuer |
| inference API keys (e.g. `ANTHROPIC_API_KEY`) | provider calls |

See [Secrets](../services/SECRETS.md) and `semiont secret` for registering where values come
from.

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

## Job Queue Configuration

The dispatcher selects its job queue driver from config; nothing is inferred. An absent section
means `fs` — a driver that needs a writable state tree the launcher's dispatcher does not mount,
so a launcher-run stack selects `jetstream`.

```toml
# Filesystem queue — the reference driver; needs a writable state tree
[environments.local.jobs]
type = "fs"

# NATS JetStream — stream-held leases; what the launcher template ships
[environments.local.jobs]
type = "jetstream"
servers = "${NATS_HOST}:4222"
```

`servers` may reference environment via `${VAR}` placeholders — the config names the
variable. A section that names `type = "jetstream"` without `servers` refuses at load.

## Signal Plane Configuration

The gateway's real-time hub (SSE fan-out, correlated replies, handler dispatch) selects its
driver the same way. An absent section means `in-process` — the permanent local default.

```toml
# In-process (default): the RxJS relay inside the gateway
[environments.local.signal]
type = "in-process"

# Core NATS subjects — required for gateway replicas
[environments.local.signal]
type = "nats"
servers = "${NATS_HOST}:4222"
```

Signal frames ride core NATS subjects only and are never captured — signals are never a
record; the event log is. The gateway's correlation ledger keeps its claims, and the replies
it retains for reconnect recovery, in JetStream KV buckets on the same server, so the server
must run JetStream; the gateway refuses to start until those tables open. When both this and the `jetstream` jobs driver are selected, they
share one NATS server (the launcher runs it as the `messaging` service): JetStream streams for
jobs, KV buckets for the ledger, core subjects for signals — disjoint subject spaces. Both sections must then name the same
`servers` — the launcher refuses a split. Running gateway replicas requires both broker-backed
drivers: see [DEPLOYMENT.md](./DEPLOYMENT.md) § Multiple gateway replicas.

## Identity Configuration

Every knowledge base trusts one OIDC issuer for people's tokens, and names the claim its
people are identified by:

```toml
[environments.local.identity]
type = "keycloak"                                       # "keycloak": the launcher runs it; "oidc": an issuer you run
issuer = "http://${KEYCLOAK_HOST}:8080/realms/semiont"  # exactly the token's `iss`
subjectClaim = "sub"                                    # the issuer claim a person's DID is built from
```

All three keys are required — the gateway, every sidecar and `semiont start` refuse a config
missing any of them, naming the key. There is no `audience` key: the audience is the knowledge
base's own resource identifier, derived from its committed `did:web` domain.

`subjectClaim` decides who a person *is*. Their DID is `did:web:<site domain>:users:<that
claim's value>`, under the same `[site] domain` the deployment's software agents are minted
beneath, so people and agents are peers under one authority. `"sub"` names people by the
issuer's stable identifier — a changed email changes nothing about who authored what;
`"email"` names them by address, and the operator has said so. Nothing is defaulted.
`accessTokenLifespan` (seconds) and `image` apply to `type = "keycloak"` only and are read by
the launcher alone. See [Authentication](./AUTHENTICATION.md).

## Environment Variables

Only a small number of environment variables are used:

| Variable | Purpose | Required? |
|---|---|---|
| `SEMIONT_ROOT` | Override project root discovery | No (auto-detected) |
| `SEMIONT_VERSION` | Image tag to run (`local` uses locally built images) | No (defaults to `latest`) |
| `ANTHROPIC_API_KEY` | Resolved from `${ANTHROPIC_API_KEY}` in config | If using Anthropic (not needed for Ollama-only) |
| `POSTGRES_PASSWORD` | Resolved from `${POSTGRES_PASSWORD}` in config | If using variable refs |
| `NATS_HOST` | Resolved from `${NATS_HOST}` in the `[jobs]`/`[signal]` sections; the launcher stages it for its `messaging` container | If a broker-backed driver uses the placeholder |
| `SEMIONT_SUPERVISE` | Runs the service under an in-container supervisor that restarts a crashed process and kills a hung one. Any non-empty value enables it. | No — **set by the launcher for local runs; do not set it yourself** |

`SEMIONT_SUPERVISE` exists because a laptop has no scheduler: `semiont start` brings the stack up and
exits, so nothing outside a container would restart a service that died. Every other way of running
these images already has something that does that job — compose's `restart:` policy, a Kubernetes
`restartPolicy` and liveness probe, an ECS or Nomad task policy — and a container that restarts
itself defeats them, because it never exits and a crash-looping process reads as healthy. So the
images run one process and exit by default, and only the launcher's local path opts in. Codespace
stacks do not set it either: compose owns the services inside. See
[DEPLOYMENT.md](./DEPLOYMENT.md) for restart ownership on each supported path.

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

Secrets never live in the config. `JWT_SECRET`, the per-service `SEMIONT_OIDC_CLIENT_SECRET`, and any inference API keys
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
- [Authentication](./AUTHENTICATION.md) — the trusted issuer, bearer verification, and what an issuer must provide
- [Services Overview](../services/OVERVIEW.md) — Service catalog
- [Launcher README](../../../apps/launcher/README.md) — `semiont` command reference
