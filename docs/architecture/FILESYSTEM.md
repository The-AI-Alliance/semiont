# Where a knowledge base lives on disk

A knowledge base's record lives in its own working tree: the resources, and the event log under
`.semiont/events/`. Everything else is derived from that record and is kept outside the tree.

Only the Archivist mounts the working tree. Every other service reaches content through it.

## Layout

```
<KB root>/                               # the knowledge base: a git working tree
├── …                                    # resources, where they live
└── .semiont/
    └── events/                          # Immutable event log (system of record, committed)
        └── {ab}/{cd}/{resourceId}/
            └── events-{seq}.jsonl

<state dir>/                             # derived from the log; safe to delete
├── resources/                           # Materialized current state, one view per resource
│   └── {ab}/{cd}/{resourceId}.json
└── projections/                         # KB-wide projections and the storage-URI index
```

The state dir is `$XDG_STATE_HOME/semiont/{project}/`. `XDG_STATE_HOME` has no default: a service
that reaches for its state tree without it fails, because a path nothing mounted is written to and
lost. The launcher sets it to the mount it gives the service.

On the machine that runs the stack, that mount and every other store (the database, the graph, the
vectors, the job queue, the anchored text) are directories the launcher keeps for the knowledge
base. [The launcher's README](../../apps/launcher/README.md#where-the-launcher-keeps-its-files)
says where, on each system, and `semiont status --verbose` lists them with what each takes on disk.
The full layout of the log and the views is
[STORAGE-LAYOUT.md](../../packages/event-sourcing/docs/STORAGE-LAYOUT.md).

## Content

Resources reference their content via a **representation's** `storageUri` (e.g.
`file://README.md`) — Semiont reads files where they live in the working tree rather than
copying them into a separate store. The URI lives on the representation, not on the
resource, because bytes are a fact about a *rendition*: a resource may carry an original,
a thumbnail and a preview, each with its own location. Read it with
`getStorageUri(resource)` rather than reaching into `representations[...]` by hand.

## The event log

Events are append-only JSONL files, one line per event:

```jsonl
{"event":{"id":"evt-123","type":"yield:created",...},"metadata":{...}}
{"event":{"id":"evt-124","type":"mark:added",...},"metadata":{...}}
```

Each resource's events sit in one of 65,536 shards, chosen by a hash of the resource id and laid
out as a two-level path (`ab/cd/`). A file rotates at 10,000 events.

## Views

A view is one JSON file per resource: its descriptor, its annotations, and the sequence number of
the last event applied. It is derived from the event log and can be rebuilt at any time. Abridged:

```json
{
  "resource": {
    "name": "Document Title",
    "representations": [
      {
        "rel": "original",
        "mediaType": "text/markdown",
        "storageUri": "file://README.md",
        "checksum": "sha256:…",
        "byteSize": 1234
      }
    ]
  },
  "annotations": {}
}
```

## Job state

None of it is on this filesystem. The job queue is the dispatcher's, and it keeps job state in the
broker — a durable stream for delivery and lease, a key-value bucket for each job's record — in the
layout [specs/src/jobs/storage.json](../../specs/src/jobs/storage.json) states. See
[docs/protocol/JOBS.md](../protocol/JOBS.md).

## Path resolution

All paths are resolved through `SemiontProject`:

```typescript
import { SemiontProject } from '@semiont/core/node';

const project = new SemiontProject(projectRoot, { anchoredTextDir: process.env.SEMIONT_ANCHORED_TEXT_DIR! });

// The knowledge base's working tree, and the event log in it
project.root            // the KB root
project.eventsDir       // <KB root>/.semiont/events/

// Derived from the log — the state dir
project.stateDir        // $XDG_STATE_HOME/semiont/{project}/
project.resourcesDir    // stateDir/resources/
project.projectionsDir  // stateDir/projections/

// Supplied by the deployment, with no default
project.anchoredTextDir
```

A service with no working tree (the Librarian) takes `SemiontState`, which is the state dir's three
paths and nothing else.

## Rebuilding what is derived

Each derived store has one owner, and that owner recovers it from the record:

| Store | Owner | How it recovers |
|---|---|---|
| Views | Archivist | Rebuilds them from the event log every time it starts, before it serves a request |
| Graph | Weaver | Catches up from its checkpoint at startup; `weave:rebuild` is the full rebuild |
| Vectors and anchored text | Smelter | Reconciles against the catalog at startup: re-embeds what is missing or stale, purges orphans |

The procedures are the operator's: [backing up and restoring](../operator/administration/BACKUP.md)
and [rebuilding derived state](../operator/administration/MAINTENANCE.md#rebuilding-derived-state).

## Related

- [STORAGE-LAYOUT.md](../../packages/event-sourcing/docs/STORAGE-LAYOUT.md) — the log's and the views' full layout
- [KNOWLEDGE-SYSTEM.md](KNOWLEDGE-SYSTEM.md) — the actors that read and write these stores
- [Configuration](../operator/administration/CONFIGURATION.md) — where the paths are configured
