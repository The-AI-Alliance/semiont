# Semiont CLI

[![npm version](https://img.shields.io/npm/v/@semiont/cli.svg)](https://www.npmjs.com/package/@semiont/cli)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/cli.svg)](https://www.npmjs.com/package/@semiont/cli)
[![License](https://img.shields.io/npm/l/@semiont/cli.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The Semiont CLI provides two categories of commands:

| Category | Commands | Auth model |
|----------|----------|------------|
| **Knowledge Base** | `init`, `backup`, `restore`, `verify`, `export`, `import` | None / `--environment` |
| **Infrastructure** | `local`, `provision`, `start`, `stop`, `check`, `publish`, `update`, `useradd`, `clean`, `watch` | `--environment` |

> **Knowledge work lives in the launcher.** `login`, `browse`, `gather`, `mark`, `match`, `bind`,
> `listen`, `yield`, and `beckon` are verbs of the host-installed `semiont` launcher (see
> [apps/launcher](../launcher/README.md)), not of this package. For programmatic use, reach the same
> capabilities through [`@semiont/sdk`](../../packages/sdk/README.md).

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
# 1. Initialize a project
semiont init

# 2. Provision and start services
semiont provision -e local
semiont start -e local

# 3. Confirm health
semiont check -e local
```

---

## Command Categories

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
