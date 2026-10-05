# Storage Layout

Event sourcing data is split between **two directories** with different durability guarantees:

- **Event log** (`<projectRoot>/.semiont/events/`) — durable, source of truth, staged into git on every append when `gitSync` is enabled
- **Materialized views and projections** (`<stateDir>`, e.g. `$XDG_STATE_HOME/semiont/<project>/`) — ephemeral, derived state, safe to wipe

The materialized layer is rebuildable from the event log at any time via `ViewManager.rebuildAll(eventLog)`, which the Archivist runs once at process start. See [Why two directories](#why-two-directories) below.

## Directory Structure

```
<projectRoot>/.semiont/
  events/                          # Append-only event log (DURABLE)
    ab/                            # Two-level 4-hex hash shards (ab/cd)
      cd/
        doc-sha256-abc123/         # One directory per resource
          events-000001.jsonl      # Rotated every 10,000 events
          events-000002.jsonl
    __system__/                    # System-level events (entity types, tag schemas, people)
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
      people.json                  # DID → current display name
    storage-uri/                   # file:// URI → resourceId index
      ab/
        cd/
          <sha256-of-uri>.json     # { uri, resourceId }
```

## Event Log (.semiont/events/)

Each resource gets its own directory of JSONL files, rotated every 10,000 events. Lines are flat `StoredEvent` objects — the event fields plus a `metadata` block:

```jsonl
{"id":"uuid","type":"yield:created","timestamp":"...","resourceId":"doc-sha256-abc","userId":"did:web:...","version":1,"payload":{...},"metadata":{"sequenceNumber":1}}
{"id":"uuid","type":"mark:added","timestamp":"...","resourceId":"doc-sha256-abc","userId":"did:web:...","version":1,"payload":{...},"metadata":{"sequenceNumber":2}}
```

The reader also accepts a nested line (`{"event":{...},"metadata":{...}}`) and flattens it.

### Metadata fields

- **sequenceNumber** — Monotonic position in the event log. Source of truth for ordering.

### Sharding

Resource directories are distributed across 65,536 shards, laid out as two-level 4-hex paths (`ab/cd/`), by hashing the resource ID. The hash is a simple modulo, not a consistent hash: changing the shard count would move every resource (see [`packages/core/src/shard-utils.ts`](../../core/src/shard-utils.ts)). Resource views and the storage-uri index use the same scheme.

### System events

Events without a `resourceId` (e.g., `frame:entity-type-added`) bypass sharding and are stored under `__system__/` at the events root.

## Resource Views (`<stateDir>/resources/`)

Each resource has a materialized JSON view built by the ViewMaterializer, sharded into `ab/cd/` directories. The view is updated incrementally on each append (and rebuilt in full from events when the view file is missing). It pairs the resource descriptor with the annotation collection, and carries the sequence number of the last event applied:

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
    "wasAttributedTo": [{ "@type": "Person", "@id": "did:web:..." }]
  },
  "annotations": {
    "resourceId": "doc-sha256-abc",
    "annotations": [
      { "id": "ann-uuid", "motivation": "linking", "target": {...}, "body": [...] }
    ],
    "version": 5,
    "updatedAt": "2026-04-08T..."
  },
  "lastSequence": 5
}
```

## Storage URI Index (`<stateDir>/projections/storage-uri/`)

Maps `file://` URIs to resource IDs, enabling lookup of resources by their filesystem path. Used by the Stower to find the resource a `yield:mv` names by its URI.

One JSON file per URI at `storage-uri/<ab>/<cd>/<sha256-of-uri>.json`, each containing `{ uri, resourceId }`. The index is maintained solely by the ViewMaterializer: `yield:created` and `yield:cloned` (with a `storageUri`) write an entry, `yield:moved` removes the old URI's entry and writes the new one. Archive/unarchive leave entries in place — archived resources remain findable by URI.

## Why two directories

- **The event log** is the record. It is durable and append-only, and staged into git when `gitSync` is enabled. Nothing under `<stateDir>` holds anything that cannot be made again from these files.
- **`<stateDir>`** is derived. `SemiontProject.destroy()` wipes it and so does `semiont clean`, and neither loses anything: `ViewManager.rebuildAll(eventLog)` writes the system projections, every resource view and the storage-uri index again when the Archivist next starts. How, and why that is the design, is in the [API reference](API.md#why-startup-rebuild-exists).

`<projectRoot>/.semiont/events/` is the only directory here that must not be deleted.

## Integrity

Integrity is provided by git at the commit level: when `gitSync` is enabled, every append stages the event log file in the git index, and once committed, git's own object hashes make tampering evident. There is no per-event hash chain. The `signature` field on `StoredEvent` (`EventSignature`) is unused; it is the planned mechanism for cross-KB authorship binding if federation becomes a requirement.
