# Storage Layout

Event sourcing data lives under the `.semiont/` directory (the project's `stateDir`).

## Directory Structure

```
.semiont/
  events/                          # Append-only event log
    shard-00/                      # Jump-consistent hash shards
      doc-sha256-abc123.jsonl      # One file per resource
      doc-sha256-def456.jsonl
    shard-01/
      doc-sha256-789xyz.jsonl
    __system__.jsonl               # System-level events (entity types)

  views/                           # Materialized resource views
    doc-sha256-abc123.json         # ResourceView (descriptor + annotations)
    doc-sha256-def456.json

  projections/                     # System projections
    __system__/
      entitytypes.json             # Global entity type collection
    storage-uri-index.json         # file:// URI → resourceId mapping
```

## Event Log (.semiont/events/)

Each resource gets its own JSONL file. Lines are `StoredEvent` objects:

```jsonl
{"event":{"id":"uuid","type":"yield:created","timestamp":"...","resourceId":"doc-sha256-abc","userId":"did:web:...","version":1,"payload":{...}},"metadata":{"sequenceNumber":1,"streamPosition":0,"timestamp":"...","prevEventHash":null,"checksum":"sha256:..."}}
{"event":{"id":"uuid","type":"mark:added","timestamp":"...","resourceId":"doc-sha256-abc","userId":"did:web:...","version":1,"payload":{...}},"metadata":{"sequenceNumber":2,"streamPosition":512,"timestamp":"...","prevEventHash":"sha256:...","checksum":"sha256:..."}}
```

### Metadata fields

- **sequenceNumber** — Monotonic position in the event log. Source of truth for ordering.
- **streamPosition** — Byte offset in the JSONL file (for efficient seeking).
- **prevEventHash** — SHA-256 of the previous event. Forms a tamper-evident hash chain. `null` for the first event.
- **checksum** — SHA-256 of this event's JSON representation.

### Sharding

Resource JSONL files are distributed across shards using jump-consistent hashing on the resource ID. This bounds the number of files per directory. The shard count is fixed at creation time.

### System events

Events without a `resourceId` (e.g., `mark:entity-type-added`) are stored in `__system__.jsonl` at the events root.

## Resource Views (.semiont/views/)

Each resource has a materialized JSON view built by the ViewMaterializer. The view is rebuilt from events on each write and contains:

```json
{
  "resource": {
    "@context": "https://schema.org/",
    "@id": "doc-sha256-abc",
    "name": "My Document",
    "entityTypes": ["Person", "Organization"],
    "representations": [{ "mediaType": "text/markdown", "checksum": "sha256:..." }],
    "archived": false,
    "dateCreated": "2026-04-08T...",
    "wasAttributedTo": { "type": "Person", "name": "Alice" }
  },
  "annotations": [
    { "id": "ann-uuid", "motivation": "linking", "target": {...}, "body": [...] }
  ],
  "version": 5,
  "updatedAt": "2026-04-08T..."
}
```

## Storage URI Index (.semiont/projections/storage-uri-index.json)

Maps `file://` URIs to resource IDs, enabling lookup of resources by their filesystem path. Used by the CLI and file-watcher integrations.

## Integrity Verification

The `EventValidator` class can verify the hash chain for any resource:

```typescript
const query = new EventQuery(eventStore.log.storage);
const events = await query.getResourceEvents(resourceId);
const result = new EventValidator().validateChain(events);
```

This checks that each event's `prevEventHash` matches the previous event's `checksum`, and that each `checksum` matches the event's actual content.
