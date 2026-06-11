# Storage Layout

Event sourcing data is split between **two directories** with different durability guarantees:

- **Event log** (`<projectRoot>/.semiont/events/`) — durable, source of truth, staged into git on every append when `gitSync` is enabled
- **Materialized views and projections** (`<stateDir>`, e.g. `$XDG_STATE_HOME/semiont/<project>/`) — ephemeral, derived state, safe to wipe

The materialized layer is rebuildable from the event log at any time via `ViewManager.rebuildAll(eventLog)`, which runs once during `createKnowledgeBase` at process start. See [Ephemerality and rebuild](#ephemerality-and-rebuild) below.

## Directory Structure

```
<projectRoot>/.semiont/
  events/                          # Append-only event log (DURABLE)
    ab/                            # Two-level 4-hex hash shards (ab/cd)
      cd/
        doc-sha256-abc123/         # One directory per resource
          events-000001.jsonl      # Rotated every 10,000 events
          events-000002.jsonl
    __system__/                    # System-level events (entity types, tag schemas)
      events-000001.jsonl

<stateDir>/                        # Materialized layer (EPHEMERAL)
  resources/                       # Materialized resource views
    ab/                            # Same 4-hex sharding
      cd/
        doc-sha256-abc123.json     # ResourceView (descriptor + annotations)
  projections/                     # System projections
    __system__/
      entitytypes.json             # Global entity type collection
      tagschemas.json              # Tag schema collection
    storage-uri/                   # file:// URI → resourceId index
      ab/
        cd/
          <sha256-of-uri>.json     # { uri, resourceId }
```

## Event Log (.semiont/events/)

Each resource gets its own directory of JSONL files, rotated every 10,000 events. Lines are flat `StoredEvent` objects — the event fields plus a `metadata` block:

```jsonl
{"id":"uuid","type":"yield:created","timestamp":"...","resourceId":"doc-sha256-abc","userId":"did:web:...","version":1,"payload":{...},"metadata":{"sequenceNumber":1}}
{"id":"uuid","type":"mark:added","timestamp":"...","resourceId":"doc-sha256-abc","userId":"did:web:...","version":1,"payload":{...},"metadata":{"sequenceNumber":2,"correlationId":"cmd-123"}}
```

Older logs may contain the legacy nested format (`{"event":{...},"metadata":{...}}`) and a removed `metadata.streamPosition` field (always `0`); the reader handles both.

### Metadata fields

- **sequenceNumber** — Monotonic position in the event log. Source of truth for ordering.
- **correlationId** — Optional id propagated from a command, letting clients match command-result events back to the POST that initiated them. See [EVENT-BUS.md](../../../docs/protocol/EVENT-BUS.md).

### Sharding

Resource directories are distributed across 65,536 shards, laid out as two-level 4-hex paths (`ab/cd/`), by hashing the resource ID. The current hash is a simple modulo — see the TODO in [`src/storage/shard-utils.ts`](../src/storage/shard-utils.ts) for the planned jump-consistent-hash replacement. Resource views and the storage-uri index use the same scheme.

### System events

Events without a `resourceId` (e.g., `frame:entity-type-added`) bypass sharding and are stored under `__system__/` at the events root.

## Resource Views (`<stateDir>/resources/`)

Each resource has a materialized JSON view built by the ViewMaterializer, sharded into `ab/cd/` directories. The view is updated incrementally on each append (and rebuilt in full from events when the view file is missing). It pairs the resource descriptor with the annotation collection:

```json
{
  "resource": {
    "@context": "https://schema.org/",
    "@id": "doc-sha256-abc",
    "name": "My Document",
    "entityTypes": ["Person", "Organization"],
    "representations": [{ "mediaType": "text/markdown", "checksum": "sha256:...", "rel": "original" }],
    "archived": false,
    "dateCreated": "2026-04-08T...",
    "wasAttributedTo": { "@type": "Person", "@id": "did:web:...", "name": "alice" }
  },
  "annotations": {
    "resourceId": "doc-sha256-abc",
    "annotations": [
      { "id": "ann-uuid", "motivation": "linking", "target": {...}, "body": [...] }
    ],
    "version": 5,
    "updatedAt": "2026-04-08T..."
  }
}
```

## Storage URI Index (`<stateDir>/projections/storage-uri/`)

Maps `file://` URIs to resource IDs, enabling lookup of resources by their filesystem path. Used by the CLI and file-watcher integrations.

One JSON file per URI at `storage-uri/<ab>/<cd>/<sha256-of-uri>.json`, each containing `{ uri, resourceId }`. The index is maintained solely by the ViewMaterializer: `yield:created` (with a `storageUri`) writes an entry, `yield:moved` removes the old URI's entry and writes the new one. Archive/unarchive leave entries in place — archived resources remain findable by URI.

## Ephemerality and rebuild

The split between `<projectRoot>/.semiont/events/` and `<stateDir>/` is deliberate:

- **Event log** is the **single source of truth**. It is durable and append-only, and staged into git when `gitSync` is enabled. Nothing else in the system holds state that can't be reconstructed from these JSONL files.
- **Materialized views and projections** under `<stateDir>` are **derived state**. They are a fast read model layered over the event log. The directory is ephemeral by design — `SemiontProject.destroy()` wipes it, container recreation wipes it, dev cleanup wipes it. None of that loses data, because it can all be rebuilt.

The rebuild step that makes "ephemeral" safe is `ViewManager.rebuildAll(eventLog)`, called once from `createKnowledgeBase` before the HTTP server begins accepting requests. It walks every event in the log and writes:

1. The system projections (`entitytypes.json`, `tagschemas.json`).
2. Each resource view file under `resources/<ab>/<cd>/`.
3. The storage-uri index entries.

It is idempotent: existing files are overwritten, not appended. Running it on every startup is safe and is in fact the design — startup rebuild + live incremental update is the same pattern used by the graph (`GraphDBConsumer.rebuildAll()` + per-event consumer) and the vectors (`Smelter.rebuildAll()` + per-event smelter), giving all three derived read models the same lifecycle treatment.

If you wipe `<stateDir>` manually for debugging, the next process restart will repopulate it. The `<projectRoot>/.semiont/events/` directory is the only thing you must not delete.

## Integrity

Per-event hash chaining (`prevEventHash`/`checksum` metadata and the `EventValidator` class) was removed in [#642](https://github.com/The-AI-Alliance/semiont/pull/642). Integrity is now provided by git at the commit level: when `gitSync` is enabled, every append stages the event log file in the git index, and once committed, git's own object hashes make tampering evident. The currently-unused `signature` field on `StoredEvent` (`EventSignature`) is the planned mechanism for cross-KB authorship binding if federation becomes a requirement.
