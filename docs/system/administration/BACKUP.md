# Backup and Restore

This guide covers how to create full backups of a Semiont knowledge base and restore them. Backups are lossless — they capture the complete event history and all content, allowing exact reconstruction of the knowledge base.

**Related guides**: [Configuration](./CONFIGURATION.md) | [Deployment](./DEPLOYMENT.md) | [Maintenance](./MAINTENANCE.md)

## Overview

Semiont also supports a separate [Linked Data exchange format](../../protocol/EXCHANGE.md) for standards-based data sharing. This document covers the **Full Backup** format used for disaster recovery and migration.

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
- **Complete** — Replay statistics shown (events replayed, resources created, annotations created, entity types added)

If the archive is invalid or replay fails, an error phase is reported with the failure message.

**Warning**: Restore adds data to the existing knowledge base. It does not wipe existing data first.

## CLI

The CLI supports both formats:

- `semiont backup` / `semiont restore` — full backup archives (the format described in this document)
- `semiont verify` — validates a backup archive offline without importing it (no running services needed)
- `semiont export` / `semiont import` — the [Linked Data exchange format](../../protocol/EXCHANGE.md)

See [Knowledge Base Commands](../../../apps/cli/docs/KNOWLEDGE-BASE.md) for usage.

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
{"stream": "__system__", "eventCount": 9}
{"stream": "4feadd89-...", "eventCount": 12}
```

Each stream summary records the stream's event count, which `semiont verify` checks against the actual stream contents.

### Event Streams (`.semiont/events/`)

Each file is a JSONL stream of `StoredEvent` objects. Events are stored in their original order.

- `__system__.jsonl` — System-level events (e.g., `frame:entity-type-added`)
- `{resourceId}.jsonl` — Per-resource events (e.g., `yield:created`, `mark:added`, `mark:body-updated`, `mark:archived`)

### Content Blobs (root level)

Content-addressed files stored at the archive root: `{checksum}.{ext}` (e.g., `519d39ca.md`, `a1b2c3d4.pdf`). The checksum and media type are extracted from `yield:created` event payloads. The file extension is derived from the content's MIME type.

## Integrity

Backup archives carry no per-event integrity metadata. During restore, the importer validates the manifest (presence, format, version) and warns about event streams that are listed in the manifest but missing from the archive; restore proceeds regardless. For offline validation before restoring, `semiont verify` additionally checks each stream's event count and the content blob count against the manifest.

Integrity of the live event log is provided by git at the commit level: when `gitSync` is enabled, every append stages the event log file, and once committed, git's object hashes make tampering evident. See [Storage Layout](../../../packages/event-sourcing/docs/STORAGE-LAYOUT.md) for details.

## What Is Included

- Complete event history (all streams, all events)
- Content blobs (all content-addressed files)
- System events (entity types, tag schemas)
- Resource lifecycle (creation, archival, unarchival)
- Annotation lifecycle (creation, body updates, deletion)
- Entity tag assignments

## What Is Excluded

- **Materialized views** — Rebuilt automatically from events during restore
- **Graph database** — Rebuilt from events by the Weaver after restore
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
| `frame:entity-type-added` | `frame:add-entity-type` → await `frame:entity-type-added` |
| `yield:created` | Resolve content blob, `yield:create` → await `yield:created` |
| `mark:added` | `mark:create` → await `mark:created` |
| `mark:body-updated` | `mark:update-body` → await `mark:body-updated` |
| `mark:removed` | `mark:delete` → await `mark:deleted` |
| `mark:archived` | `mark:archive` |
| `mark:unarchived` | `mark:unarchive` |
| `mark:entity-tag-added/removed` | `mark:update-entity-types` |
| Job events | Skipped (transient) |
| Representation events | Skipped (content stored via `yield:created`) |
