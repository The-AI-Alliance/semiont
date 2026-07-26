---
name: semiont-local
description: Install and run a Semiont knowledge base locally with the semiont launcher — no repo clone, no npm, no Node.js
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user get Semiont running locally. The `semiont` launcher is a single static binary
that drives their container runtime and pulls the published service images. No source checkout and no
Node.js are required.

## Prerequisites

- **Container runtime** — Apple Container, Docker, or Podman. Check with `container --version`,
  `docker --version`, or `podman --version`.
- **Homebrew** — to install the launcher.
- **Inference** — either `ANTHROPIC_API_KEY` (cloud) or [Ollama](https://ollama.com/) (local, no key).
- **`SEMIONT_WORKER_SECRET`** — any random value, e.g.
  `export SEMIONT_WORKER_SECRET=$(openssl rand -hex 32)`.

## Fastest path

```bash
brew install the-ai-alliance/semiont/semiont

# In a new directory: create a knowledge base
semiont init

# Pick an inference config and bring the stack up
semiont start --list-configs
semiont start --config anthropic
```

Then open the URL `semiont start` prints. To use an existing KB instead of creating one, clone it and
run `semiont start` from inside it.

## Common operations

All run from the knowledge-base directory:

```bash
semiont status                    # container state + per-service health
semiont logs                      # follow service logs
semiont logs --service backend    # one service
semiont stop                      # tear the stack down
semiont clean                     # remove persistent stack state (Postgres/Qdrant/Neo4j)
semiont useradd --email you@example.com --generate-password --admin
```

Run `semiont <command> --help` for a command's options, and `semiont --help` for the full verb list.

## Service ports

| Service | URL |
|---------|-----|
| Browser (frontend) | http://localhost:3000 |
| Backend API | http://localhost:4000 |

## Key file locations

| Path | Contents |
|------|----------|
| `.semiont/config` | Project anchor: KB name and permanent `did:web` identity (committed) |
| `.semiont/events/` | The event log — the system of record (committed) |
| `~/.semiontconfig` | Global config: inference provider, database, graph/vector drivers |

Service logs go to stdout (`semiont logs`); durable service data lives in container volumes the
launcher manages.

## Guidance for the AI assistant

- **Check prerequisites first.** The most common failures are a missing container runtime, no
  inference key, and an unset `SEMIONT_WORKER_SECRET`.
- **`semiont status` is the diagnostic command.** If something isn't working after `start`, run it to
  see which service is unhealthy, then `semiont logs --service <name>`.
- **Config lives in `~/.semiontconfig`.** If inference or the database isn't working, inspect that
  file first. `semiont start --list-configs` shows the presets a KB ships.
- **Restart after config changes** — `semiont stop && semiont start`. There is no separate provision
  step.
- **The KB directory is a git repo.** Resource files, `.semiont/config`, and `.semiont/events/` are
  committed; secrets never are.
- **Do not suggest `npm install -g @semiont/cli`.** That package is a deprecation stub with no
  commands; if `which semiont` points at it, the npm copy is shadowing the launcher.
