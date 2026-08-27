# Backup and Restore

Back up a Semiont knowledge base and restore it with the `semiont` launcher. Backups are
lossless — the complete event history and all content — and neither direction needs a running
stack, because both are file operations.

**Related guides**: [Configuration](./CONFIGURATION.md) | [Deployment](./DEPLOYMENT.md) | [Maintenance](./MAINTENANCE.md)

## There is no archive format

The archive is the KB directory itself, as a plain `.tar.gz`. No manifest, no format version, no
schema — nothing is transformed, so there is nothing to specify:

```bash
tar -xzf kb.tar.gz            # a working KB directory
cat .semiont/events/*.jsonl   # the history, one JSON object per line
```

That is the design, not an omission (EXPORT-VIA-LAUNCHER D4). The content is already files at
their natural paths and the event log is already JSONL; inventing a representation for data that
has a good one on disk is what the retired exchange format did. tar.gz rather than a git bundle
for the same reason — a format needing git would mean "your data is yours, if you have git", and
tar is on every machine.

A restore is `tar -xzf` plus registering the root. Any tool that reads tar can read your KB.

## Backing up

```bash
semiont export
```

Writes the KB's **durable** state: content files and the event log. Nothing derived — projections,
jobs, anchored text and the databases all rebuild from the log, and they live outside the KB root
anyway.

| Option | Effect |
|---|---|
| `--root <path\|name>` | KB to export (default: the root containing the cwd) |
| `--repo <owner/name>` | Export a codespace-hosted KB over ssh |
| `-o, --output <file>` | Archive path (default: `<kb-name>.tar.gz`) |
| `--with-git` | Include `.git` |
| `--force` | Overwrite an existing archive |

**On `--with-git`.** Off by default: the event log is the system of record and a restore without
`.git` is complete. Turn it on when the archive needs to *attest* rather than merely restore — for
a git-synced KB the commits are the log's tamper-evidence and `.git/config` records where the KB
came from. Restorable and attestable are different properties, and only you know which this
archive is for.

**`.semiont/export.json`** is written into the archive as an advisory marker, so a file found on a
drive years later can say what it is. Nothing reads it back for correctness — the moment a restore
depended on it, it would be a format contract by the back door.

## Restoring

```bash
semiont import <archive.tar.gz>
```

Untars the archive, checks the result is a KB, and registers the root. It replays nothing, so
there is no import mode, no vocabulary gate to escape, and no progress phases — the restored files
*are* the knowledge base.

Guards, all of which refuse rather than repair:

- **A non-empty root is refused.** Two event logs interleaved in one directory is the only
  irreversible mistake available here.
- **An archive with no `.semiont/` is named as not-a-KB**, rather than failing confusingly at the
  next start.
- **Entries with `..` or absolute paths are refused outright.** An archive from `semiont export`
  cannot contain one, so its presence means the archive is corrupt or crafted.

## What is not backed up

PostgreSQL holds user accounts only. Backing it up is not backing up the knowledge base, and
backing up the knowledge base does not preserve accounts. See [DATABASE.md](./DATABASE.md).

## History

Backup and restore were once admin API routes with a GUI, and the archive was a bespoke format
with a manifest, a format version and validators. The routes, the SDK calls and the page were
removed in EXPORT-VIA-LAUNCHER P1–P2 and the TypeScript reader/writer in P3; the launcher verbs
replaced them in P4–P5. The old format is gone and no archive of it exists — there were no users.

**Consequence worth knowing:** export requires access to the working tree, so it is a
local-operator capability. A KB you reach only over the network cannot be exported by you through
the app; `--repo` covers the codespace case over ssh.
