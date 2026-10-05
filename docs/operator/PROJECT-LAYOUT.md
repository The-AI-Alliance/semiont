# What is in a knowledge base

A knowledge base is a directory managed by both `git` and Semiont. Your resource files live directly in its root, beside `.semiont/`, which holds the knowledge base's identity, its configs and its event log. All of it is meant to be committed.

This page is what an operator needs to recognize and commit. How Semiont reads and writes these files, and where everything derived from them is kept, is in [where a knowledge base lives on disk](../architecture/FILESYSTEM.md).

## Directory Structure

```
my-kb/
├── .semiont/
│   ├── config                        # Name and permanent identity (commit)
│   ├── events/                       # Event log (commit)
│   │   ├── __system__/               # System-scoped events (entity types, etc.)
│   │   │   └── events-000001.jsonl
│   │   └── {ab}/{cd}/{resourceId}/   # Per-resource streams, sharded
│   │       └── events-000001.jsonl
│   └── semiontconfig/                # What the knowledge base needs to run (commit)
│       ├── anthropic.toml
│       └── ollama-gemma.toml
├── README.md                         # Optional, but recommended
└── <your content>                    # Resource files — any structure you choose
```

### `.semiont/config`

A TOML file holding the knowledge base's name and its permanent `did:web` domain, which is stamped into every event. Commit it: it is who the knowledge base is. See [Configuration](./administration/CONFIGURATION.md#semiontconfig).

### `.semiont/events/`

The event log: an append-only record of everything that has happened to every resource — creations, annotations, tag changes, moves, and job lifecycle. Commit this to git alongside your resource files so the full history travels with the repository.

Two kinds of streams live under `events/`:

- **Per-resource streams**, at `events/{ab}/{cd}/{resourceId}/events-NNNNNN.jsonl`. The two 2-character shard directories come from a Jump Consistent Hash of the resource id, keeping any single shard directory from exceeding a few thousand entries at scale.
- **The `events/__system__/` stream**, for events that have no resource, such as `frame:entity-type-added`, which registers an entity type for the whole knowledge base.

### `.semiont/semiontconfig/`

One TOML file per way of running the knowledge base, usually one per inference provider (`anthropic.toml`, `ollama-gemma.toml`). Each names the models, the embedding provider, the graph, the vector store and the issuer. `semiont init` writes the first; `semiont start --config <name>` picks one. A config states no machine address and no secret, so it is safe to commit and works on any machine. See [Configuration](./administration/CONFIGURATION.md).

### Resource files

Resource files (documents, images, PDFs, etc.) live anywhere in the project root. Their location is recorded as a `file://`-prefixed URI in the event log. When you create a resource via the UI or CLI you choose where in the project to save it.

Real KBs organise their content however suits the domain. Two examples:

- **[semiont-gutenberg-kb](https://github.com/The-AI-Alliance/semiont-gutenberg-kb)** — public-domain literature, organised by author and work:
  ```
  authors/Aeschylus/Four_Plays_by_Aeschylus/sections/Prologos.txt
  authors/Aeschylus/Four_Plays_by_Aeschylus/places/Scythian_steppe.md
  ```
- A fictional family dataset, split by content type:
  ```
  bios/
  generated/
  photos/
  ```

Neither layout is prescribed by Semiont. The only constraint is that the path you choose
at creation time is recorded as the `storageUri` on the resource's primary representation.
The event log is append-only, so the creating event's path never changes — but the location
the projection serves is **maintained across moves**: a later `yield:moved` relocates it,
and reads through `getStorageUri(resource)` follow.

## What lives outside it

Everything derived from the record, and every secret, is kept outside the knowledge base and never committed: in XDG directories on Linux, and in each other system's own equivalent. See [the launcher's manual — Where the launcher keeps its files](../../apps/launcher/README.md#where-the-launcher-keeps-its-files) for the full table.

## Example

A knowledge base after two resources have been added:

```
% ls -A
.semiont  authors  data  README.md

% find .semiont -type f | sort
.semiont/config
.semiont/events/50/fa/47488f8a27471bf16f33aba56af90d12/events-000001.jsonl
.semiont/events/66/71/1ed8b4936cfad473c2a7b14c22a945c0/events-000001.jsonl
.semiont/events/__system__/events-000001.jsonl
.semiont/semiontconfig/anthropic.toml
.semiont/semiontconfig/ollama-gemma.toml

% git log --oneline
9f12ab3 Add Aeschylus resources + initial annotations
8c001a7 semiont init
```

Note the `__system__` stream alongside the two per-resource shard directories — that's where global events (like new entity-type registrations) live, and it's committed the same as everything else.

## Creating one

```bash
mkdir my-kb && cd my-kb
semiont init
```

`semiont init` runs `git init` if the directory is not already a git repository, and stages what it wrote.

## Related

- [Running a local stack](./LOCAL-SEMIONT.md): starting a stack for a knowledge base
- [Configuration](./administration/CONFIGURATION.md): what the two config files hold
- [Where a knowledge base lives on disk](../architecture/FILESYSTEM.md): the event log, the views, and what rebuilds what
- [Knowledge Bases](../KNOWLEDGE-BASES.md): the demo knowledge bases, and starting one of your own
