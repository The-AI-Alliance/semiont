# Knowledge Base Commands

This guide covers the commands that manage the knowledge base itself: project initialization, backup/restore, and data export/import.

These commands do not require `--environment` (except `backup`, `restore`, `export`, `import` which need it to locate the running services).

For commands that *query* the knowledge base via the API see [Knowledge Work Commands](./KNOWLEDGE-WORK.md).
For service lifecycle management see [Infrastructure Commands](./INFRASTRUCTURE.md).

---

## init — Initialize a project

Creates `.semiont/config` in the current directory and, if missing, scaffolds `~/.semiontconfig` with service and inference defaults.

```bash
semiont init
semiont init --name my-project
semiont init --no-git                                    # skip git init and git add
semiont init --environments local,staging,production     # override default env list
semiont init --directory ./my-app --force                # overwrite existing config
```

| Flag | Short | Description |
|------|-------|-------------|
| `--name <name>` | `-n` | Project name (defaults to directory basename) |
| `--directory <path>` | `-d` | Project directory (defaults to cwd) |
| `--force` | `-f` | Overwrite existing `.semiont/config` |
| `--no-git` | | Skip `git init` and `git add .semiont/config`; sets `git.sync = false` |
| `--environments <list>` | | Comma-separated environment names to scaffold (default: `local,test,staging,production`) |

After `init`, edit `~/.semiontconfig` to add your database credentials and inference API keys, then run `semiont provision` and `semiont start`.

---

## backup / restore / verify — Archive and recover

These commands provide lossless whole-KB backup and restore. The archive is a `.tar.gz` containing `.semiont/manifest.jsonl`, per-resource event streams, and content blobs. `restore` replays events through EventBus + Stower so all materialized views rebuild naturally.

```bash
# Create a backup
semiont backup -e production --out backup.tar.gz

# Restore from a backup
semiont restore -e production --file backup.tar.gz

# Verify archive integrity (no running services needed)
semiont verify --file backup.tar.gz
```

`verify` checks: manifest format, hash chain integrity, first/last checksum match, event and blob counts. It requires no `--environment`.

---

## export / import — Portable data interchange

Export and import the knowledge base as JSON-LD Linked Data. Unlike `backup`/`restore` (which are operational and lossless), `export`/`import` produce a portable format suitable for sharing with external tools or migrating between deployments.

```bash
semiont export -e local --out export.json
semiont import -e local --file export.json
```

---

## Further Reading

- [Knowledge Work Commands](./KNOWLEDGE-WORK.md) — query and annotate the knowledge base via the API
- [Infrastructure Commands](./INFRASTRUCTURE.md) — service lifecycle, deployment, administration
- [Managing Environments](./ADDING_ENVIRONMENTS.md)
