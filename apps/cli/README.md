# Semiont CLI

[![npm version](https://img.shields.io/npm/v/@semiont/cli.svg)](https://www.npmjs.com/package/@semiont/cli)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/cli.svg)](https://www.npmjs.com/package/@semiont/cli)
[![License](https://img.shields.io/npm/l/@semiont/cli.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The Semiont CLI provides four categories of commands:

| Category | Commands | Auth model |
|----------|----------|------------|
| **Credential** | `login` | Writes a cached token |
| **Knowledge Work** | `browse`, `gather`, `mark`, `match`, `bind`, `listen`, `yield`, `beckon` | Reads the cached token (`--bus`) |
| **Knowledge Base** | `init`, `backup`, `restore`, `verify`, `export`, `import` | None / `--environment` |
| **Infrastructure** | `local`, `provision`, `start`, `stop`, `check`, `mv`, `useradd`, `clean`, `watch` | `--environment` |

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
| `--dry-run` | | Preview changes without applying |
| `--verbose` | `-v` | Show detailed output |
| `--quiet` | `-q` | Suppress progress output |
| `--output <format>` | `-o` | `summary` \| `table` \| `json` \| `yaml` |

---

## Quick Start

```bash
# 1. Log in (once — token cached for 24 hours)
semiont login --bus http://localhost:4000 --user alice@example.com

# 2. Browse the knowledge base
semiont browse resources

# 3. Gather LLM context for a resource
semiont gather resource <resourceId>

# 4. Create an annotation
semiont mark <resourceId> --motivation highlighting --quote "key phrase"
```

---

## Command Categories

### Credential — `login`

Authenticates against a Semiont backend and caches a token. Run this once before using any API command.

```bash
semiont login --bus http://localhost:4000 --user alice@example.com
semiont login --bus https://api.acme.com   # prompts for password interactively
semiont login --refresh --bus https://api.acme.com
```

Token is cached at `$XDG_STATE_HOME/semiont/auth/<bus-slug>.json` and is valid for 24 hours. Multiple backends can be logged into simultaneously.

See [Knowledge Work Commands](./docs/KNOWLEDGE-WORK.md) for the full credential resolution order.

---

### Knowledge Work Commands

These commands call the Semiont backend. They require a cached token from `semiont login`.

| Flag | Short | Description |
|------|-------|-------------|
| `--bus <url>` | `-b` | Backend URL. Fallback: `$SEMIONT_BUS` |

For full details see [Knowledge Work Commands](./docs/KNOWLEDGE-WORK.md).

**browse** — inspect resources, annotations, references, events

```bash
semiont browse resources
semiont browse resource <resourceId> --annotations
semiont browse annotation <resourceId> <annotationId>
semiont browse entity-types
```

**gather** — fetch LLM-optimised context

```bash
semiont gather resource <resourceId>
semiont gather annotation <resourceId> <annotationId>
```

**mark** — create W3C annotations (manual or AI-delegate)

```bash
semiont mark <resourceId> --motivation highlighting --quote "key phrase"
semiont mark <resourceId> --motivation linking --delegate --entity-type Person
```

**match / bind** — find and resolve linking annotations

```bash
semiont match <resourceId> <annotationId>
semiont bind <resourceId> <annotationId> <targetResourceId>
```

**listen** — stream domain events as NDJSON

```bash
semiont listen
semiont listen resource <resourceId>
```

**yield** — upload or AI-generate a resource

```bash
semiont yield --upload ./paper.pdf
semiont yield --delegate --resource <resourceId> --annotation <annotationId> --storage-uri file://out.md
```

**beckon** — direct a participant's attention

```bash
semiont beckon <resourceId>
```

---

### Knowledge Base Commands

These commands manage the knowledge base itself. `init` needs no flags; the others take `--environment`.

For full details see [Knowledge Base Commands](./docs/KNOWLEDGE-BASE.md).

```bash
semiont init
semiont backup -e production --out backup.tar.gz
semiont restore -e production --file backup.tar.gz
semiont verify --file backup.tar.gz
semiont export -e local --out export.json
semiont import -e local --file export.json
```

---

### Infrastructure Commands

These commands manage service lifecycle and deployment. They require `--environment` (or a default set in `~/.semiontconfig`).

| Flag | Short | Description |
|------|-------|-------------|
| `--environment <env>` | `-e` | Target environment. Fallback: `$SEMIONT_ENV` → `defaults.environment` in `~/.semiontconfig` |

For full details see [Infrastructure Commands](./docs/INFRASTRUCTURE.md).

```bash
# Service lifecycle
semiont provision -e local
semiont start -e local
semiont check -e local
semiont stop -e local
semiont watch -e local

# Administration
semiont useradd -e local --email user@example.com
semiont clean -e local
```

---

## Further Reading

- [Knowledge Work Commands](./docs/KNOWLEDGE-WORK.md) — login, browse, gather, mark, match, bind, listen, yield, beckon
- [Knowledge Base Commands](./docs/KNOWLEDGE-BASE.md) — init, backup, restore, verify, export, import
- [Infrastructure Commands](./docs/INFRASTRUCTURE.md) — service lifecycle, deployment, administration
- [Architecture Overview](./docs/ARCHITECTURE.md)
- [Managing Environments](./docs/ADDING_ENVIRONMENTS.md)
- [Adding Commands](./docs/ADDING_COMMANDS.md)
- [Adding Platforms](./docs/ADDING_PLATFORMS.md)
- [Adding Services](./docs/ADDING_SERVICES.md)
- [Adding Service Types](./docs/ADDING_SERVICE_TYPES.md)

---

## License

Apache License 2.0 — see the LICENSE file for details.
