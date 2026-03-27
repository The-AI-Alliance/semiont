---
name: semiont-local
description: Install, provision, and run Semiont locally using published npm packages — no repo clone needed
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user get Semiont running locally. The CLI installs backend, frontend, database, and proxy from published npm packages. No source checkout required.

## Prerequisites

- **Node.js 20+** — `node --version`
- **Docker or Podman** — for PostgreSQL and Envoy proxy containers
- **Inference** — either `ANTHROPIC_API_KEY` (cloud) or [Ollama](https://ollama.com/) (local, no key needed)
- **Neo4j** (optional, for knowledge graph) — free at [Neo4j Aura](https://neo4j.com/cloud/aura/) or local

## Fastest path

```bash
npm install -g @semiont/cli
semiont local
```

`semiont local` is fully interactive — it prompts for a project directory, runs init + provision + start + useradd, and prints the login URL and credentials at the end. Use this when starting fresh.

## Manual setup (step by step)

```bash
npm install -g @semiont/cli

mkdir my_project && cd my_project
semiont init          # creates .semiont/config and ~/.semiontconfig

# Edit ~/.semiontconfig: set inference provider and database credentials

semiont provision     # generates secrets, envoy.yaml, runs DB migrations
semiont start
semiont check         # verify all services healthy

semiont useradd --email you@example.com --generate-password --admin
# Open http://localhost:8080
```

## Service ports

| Service | URL |
|---------|-----|
| Main entry point (Envoy) | http://localhost:8080 |
| Backend API | http://localhost:4000 |
| Frontend | http://localhost:3000 |

## Common operations

```bash
# Start/stop individual services
semiont start --service backend
semiont stop --service backend
semiont check

# Re-provision after config changes
semiont provision --service backend
semiont provision --service frontend

# View logs
semiont logs --service backend
semiont logs --service frontend
```

## Key file locations

| Path | Contents |
|------|----------|
| `~/.semiontconfig` | Global config: inference provider, DB credentials, default environment |
| `.semiont/config` | Project name (committed to git) |
| `~/.config/semiont/{project}/` | Generated proxy config and secrets (never committed) |
| `~/.local/share/semiont/{project}/database/` | PostgreSQL data |
| `~/.local/state/semiont/{project}/` | Log files, job state, projections cache |

## Neo4j (if needed)

```bash
npm install -g neo4j-driver
```

Add to `~/.semiontconfig`:

```toml
[environments.local.graph]
type = "neo4j"
uri = "${NEO4J_URI}"
username = "${NEO4J_USERNAME}"
password = "${NEO4J_PASSWORD}"
```

## Guidance for the AI assistant

- **Start with `semiont local`** if the user is setting up for the first time — it's the single interactive command that covers everything.
- **Check prerequisites first.** The most common failures are missing Docker/Podman or no inference key. Run `docker --version` and check for `ANTHROPIC_API_KEY` before proceeding.
- **`semiont check` is the diagnostic command.** If something isn't working after start, run it to see which services are unhealthy.
- **Config lives in `~/.semiontconfig`.** If inference or DB isn't working, that's the first file to inspect.
- **Re-provision after config changes** — `semiont provision` must be re-run for config changes to take effect; a restart alone is not enough.
- **Logs are in `~/.local/state/semiont/{project}/`** — `semiont logs --service backend` is the fastest way to see errors.
- **The project directory is a git repo.** Resource files, `.semiont/config`, and `.semiont/events/` are committed. Secrets and generated configs are never in the repo.
