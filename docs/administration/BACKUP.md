# Backup and Restore

This guide covers how to create full backups of a Semiont knowledge base and restore them. Backups are lossless — they capture the complete event history and all content, allowing exact reconstruction of the knowledge base.

**Related guides**: [Configuration](./CONFIGURATION.md) | [Deployment](./DEPLOYMENT.md) | [Maintenance](./MAINTENANCE.md)

## Overview

Semiont also supports a separate [Linked Data exchange format](../moderation/EXCHANGE.md) for standards-based data sharing. This document covers the **Full Backup** format used for disaster recovery and migration.

## GUI: Backup & Restore

The Administration section includes a **Backup & Restore** page at `/admin/exchange`. This is available to users with the admin role.

### Creating a Backup

1. Navigate to **Administration → Backup & Restore**
2. Click **Export Backup**
3. The browser downloads a `.tar.gz` archive

The archive contains the complete event history and all content-addressed blobs. It can fully reconstruct the knowledge base.

### Restoring from a Backup

1. Navigate to **Administration → Backup & Restore**
2. Drop or select a `.tar.gz` backup archive
3. Review the file preview (format and version are shown)
4. Click **Restore** and confirm

The restore process replays all events through the EventBus → Stower pipeline. Progress is reported in phases:

- **Started** — Archive uploaded and parsed
- **Entity Types** — Schema entity types restored
- **Resources** — Resources and content recreated
- **Annotations** — Annotations replayed
- **Complete** — Hash chain verification result shown

**Warning**: Restore adds data to the existing knowledge base. It does not wipe existing data first.

## CLI

The CLI currently supports the [Linked Data exchange format](../moderation/EXCHANGE.md) (`semiont export` / `semiont import`), not the full backup format. Full backup and restore is available through the GUI only.

## Backup Archive Format

A full backup is a gzip-compressed POSIX tar archive with the following structure:

```
semiont-backup-{timestamp}.tar.gz
├── .semiont/
│   ├── manifest.jsonl
│   └── events/
│       ├── __system__.jsonl
│       ├── {resourceId}.jsonl
│       └── ...
├── {checksum}.md
├── {checksum}.pdf
└── ...
```

### Manifest (`manifest.jsonl`)

The manifest is a JSONL file. The first line is the header; subsequent lines are per-stream summaries.

**Header** (first line):

```json
{
  "format": "semiont-backup",
  "version": 1,
  "exportedAt": "2026-03-15T12:00:00.000Z",
  "sourceUrl": "https://semiont.example.com",
  "stats": {
    "streams": 5,
    "events": 142,
    "blobs": 12,
    "contentBytes": 45678
  }
}
```

**Stream summaries** (subsequent lines):

```json
{"stream": "__system__", "eventCount": 9, "firstChecksum": "b25b56...", "lastChecksum": "1a0759..."}
{"stream": "4feadd89-...", "eventCount": 12, "firstChecksum": "65b696...", "lastChecksum": "abc123..."}
```

Each stream summary records the first and last event checksums, enabling hash chain verification during restore.

### Event Streams (`.semiont/events/`)

Each file is a JSONL stream of `StoredEvent` objects. Events are stored in their original order.

- `__system__.jsonl` — System-level events (e.g., `mark:entity-type-added`)
- `{resourceId}.jsonl` — Per-resource events (e.g., `yield:created`, `mark:added`, `mark:body-updated`, `mark:archived`)

### Content Blobs (root level)

Content-addressed files stored at the archive root: `{checksum}.{ext}` (e.g., `519d39ca.md`, `a1b2c3d4.pdf`). The checksum and media type are extracted from `yield:created` event payloads. The file extension is derived from the content's MIME type.

## Hash Chain Verification

Events in each stream form a hash chain: each event's `prevEventHash` field references the preceding event's `checksum`. During restore, the importer verifies this chain and reports whether it is intact. A broken chain indicates the archive may have been tampered with or corrupted, but restore proceeds regardless (with a warning).

## What Is Included

- Complete event history (all streams, all events)
- Content blobs (all content-addressed files)
- System events (entity types, tag schemas)
- Resource lifecycle (creation, archival, unarchival)
- Annotation lifecycle (creation, body updates, deletion)
- Entity tag assignments

## What Is Excluded

- **Materialized views** — Rebuilt automatically from events during restore
- **Graph database** — Rebuilt from events by the GraphDBConsumer after restore
- **Job queue state** — Transient; jobs re-run as needed
- **User database** — Managed separately in PostgreSQL
- **Application configuration** — Stored in environment config files, not in the knowledge base

## Restore Architecture

Restore does not write directly to storage. Instead, it replays events through the same pipeline used during normal operation:

```
Archive → Importer → EventBus → Stower → EventStore + Views
```

This ensures all derived state (materialized views, search indices) rebuilds correctly. Events are replayed sequentially with backpressure — each command event waits for its result before the next is emitted. A 30-second timeout applies per event.

The replay handles these event types:

| Event | Replay Action |
|-------|---------------|
| `mark:entity-type-added` | `mark:add-entity-type` → await `mark:entity-type-added` |
| `yield:created` | Resolve content blob, `yield:create` → await `yield:created` |
| `mark:added` | `mark:create` → await `mark:created` |
| `mark:body-updated` | `mark:update-body` → await `mark:body-updated` |
| `mark:removed` | `mark:delete` → await `mark:deleted` |
| `mark:archived` | `mark:archive` |
| `mark:unarchived` | `mark:unarchive` |
| `mark:entity-tag-added/removed` | `mark:update-entity-types` |
| Job events | Skipped (transient) |
| Representation events | Skipped (content stored via `yield:created`) |
