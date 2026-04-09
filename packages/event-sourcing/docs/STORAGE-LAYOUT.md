# Storage Layout

Event sourcing data is split between **two directories** with different durability guarantees:

- **Event log** (`<projectRoot>/.semiont/events/`) — durable, source of truth, committed to repo
- **Materialized views and projections** (`<stateDir>`, e.g. `$XDG_STATE_HOME/semiont/<project>/`) — ephemeral, derived state, safe to wipe

The materialized layer is rebuildable from the event log at any time via `ViewManager.rebuildAll(eventLog)`, which runs once during `createKnowledgeBase` at process start. See [Ephemerality and rebuild](#ephemerality-and-rebuild) below.

## Directory Structure

```
<projectRoot>/.semiont/
  events/                          # Append-only event log (DURABLE)
    shard-00/                      # Jump-consistent hash shards
      doc-sha256-abc123.jsonl      # One file per resource
      doc-sha256-def456.jsonl
    shard-01/
      doc-sha256-789xyz.jsonl
    __system__.jsonl               # System-level events (entity types)

<stateDir>/                        # Materialized layer (EPHEMERAL)
  resources/                       # Materialized resource views
    ab/                            # 4-hex jump-consistent hash sharding
      cd/
        doc-sha256-abc123.json     # ResourceView (descriptor + annotations)
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

## Resource Views (`<stateDir>/resources/`)

Each resource has a materialized JSON view built by the ViewMaterializer, sharded into `ab/cd/` directories by 4-hex jump-consistent hash. The view is rebuilt from events on each write and contains:

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

## Storage URI Index (`<stateDir>/projections/storage-uri-index.json`)

Maps `file://` URIs to resource IDs, enabling lookup of resources by their filesystem path. Used by the CLI and file-watcher integrations.

## Ephemerality and rebuild

The split between `<projectRoot>/.semiont/events/` and `<stateDir>/` is deliberate:

- **Event log** is the **single source of truth**. It is durable, append-only, hash-chained, and committed to the repository. Nothing else in the system holds state that can't be reconstructed from these JSONL files.
- **Materialized views and projections** under `<stateDir>` are **derived state**. They are a fast read model layered over the event log. The directory is ephemeral by design — `SemiontProject.destroy()` wipes it, container recreation wipes it, dev cleanup wipes it. None of that loses data, because it can all be rebuilt.

The rebuild step that makes "ephemeral" safe is `ViewManager.rebuildAll(eventLog)`, called once from `createKnowledgeBase` before the HTTP server begins accepting requests. It walks every event in the log and writes:

1. The system projections (currently `entitytypes.json`).
2. Each resource view file under `resources/<ab>/<cd>/`.
3. The storage-uri index entries.

It is idempotent: existing files are overwritten, not appended. Running it on every startup is safe and is in fact the design — startup rebuild + live incremental update is the same pattern used by the graph (`GraphDBConsumer.rebuildAll()` + per-event consumer) and the vectors (`Smelter.rebuildAll()` + per-event smelter), giving all three derived read models the same lifecycle treatment.

If you wipe `<stateDir>` manually for debugging, the next process restart will repopulate it. The `<projectRoot>/.semiont/events/` directory is the only thing you must not delete.

## Integrity Verification

The `EventValidator` class can verify the hash chain for any resource:

```typescript
const query = new EventQuery(eventStore.log.storage);
const events = await query.getResourceEvents(resourceId);
const result = new EventValidator().validateChain(events);
```

This checks that each event's `prevEventHash` matches the previous event's `checksum`, and that each `checksum` matches the event's actual content.
