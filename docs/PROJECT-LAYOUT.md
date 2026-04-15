# Semiont Project Layout

A Semiont project is a directory managed by both `git` and Semiont. Your resource files live directly in the project root alongside `.semiont/`, which holds Semiont-internal state. Everything is designed to be committed to git.

## Directory Structure

```
my-project/
├── .semiont/
│   ├── config                        # Project name and settings (commit)
│   ├── events/                       # Event log (commit)
│   │   ├── __system__/               # System-scoped events (entity types, etc.)
│   │   │   └── events-000001.jsonl
│   │   └── {ab}/{cd}/{resourceId}/   # Per-resource streams, sharded
│   │       └── events-000001.jsonl
│   ├── scripts/                      # Optional convenience scripts
│   │   └── start.sh                  # Spin up backend + dependencies
│   ├── compose/                      # Optional Docker Compose files
│   │   └── backend.yml
│   └── containers/                   # Optional Dockerfiles & configs
│       ├── Dockerfile                # Backend image
│       └── semiontconfig/            # Inference/embedding configs (TOML)
│           ├── anthropic.toml
│           └── ollama-gemma.toml
├── README.md                         # Optional, but recommended
└── <your content>                    # Resource files — any structure you choose
```

### `.semiont/config`

A TOML file containing the project name and local settings. Commit this to git — it identifies the project to collaborators.

### `.semiont/events/`

The event log: an append-only record of everything that has happened to every resource — creations, annotations, tag changes, moves, and job lifecycle. Commit this to git alongside your resource files so the full history travels with the repository.

Two kinds of streams live under `events/`:

- **Per-resource streams**, at `events/{ab}/{cd}/{resourceId}/events-NNNNNN.jsonl`. The two 2-character shard directories come from a Jump Consistent Hash of the resource id, keeping any single shard directory from exceeding a few thousand entries at scale.
- **The `events/__system__/` stream**, for events that have no resource — currently `mark:entity-type-added` (registering a new global entity type) and similar project-wide facts.

### `.semiont/scripts/`, `.semiont/compose/`, `.semiont/containers/` (optional)

These directories are not used by Semiont itself — they are convenience infrastructure that KB authors can include so others can run the project without cloning the Semiont repo. The authoritative versions live in the [semiont-template-kb](https://github.com/The-AI-Alliance/semiont-template-kb) template repository, and most KBs stay in sync with it.

- **`scripts/start.sh`** — one entry point that starts Neo4j, Qdrant, Ollama (if not already running), PostgreSQL, and the Semiont backend, all in containers, wiring them to the KB's `.semiont/containers/semiontconfig/{name}.toml` config of your choice.
- **`compose/backend.yml`** — Docker Compose definition for the same service stack, for environments that prefer compose over the start.sh orchestration.
- **`containers/Dockerfile`** — builds the backend image (pulling `@semiont/backend` from npm at build time). Only the backend is KB-specific; the frontend image is shared across KBs and built from the Semiont repo itself.
- **`containers/semiontconfig/*.toml`** — inference-provider presets the user selects at start time (e.g., `--config ollama-gemma` vs `--config anthropic`). Each file names the chat model, embedding model, and any provider-specific parameters.

### Resource files

Resource files (documents, images, PDFs, etc.) live anywhere in the project root. Their location is recorded as a `file://`-prefixed URI in the event log. When you create a resource via the UI or CLI you choose where in the project to save it.

Real KBs organise their content however suits the domain. Two examples:

- **[gutenberg-kb](https://github.com/The-AI-Alliance/gutenberg-kb)** — public-domain literature, organised by author and work:
  ```
  authors/Aeschylus/Four_Plays_by_Aeschylus/sections/Prologos.txt
  authors/Aeschylus/Four_Plays_by_Aeschylus/places/Scythian_steppe.md
  ```
- **synthetic-family** — a fictional family dataset split by content type:
  ```
  bios/
  generated/
  photos/
  ```

Neither layout is prescribed by Semiont. The only constraint is that the path you choose at creation time becomes the resource's immutable `storageUri` in the event log (changeable later only via an explicit `yield:moved` event).

## What lives outside the project

Machine-specific and secret state is kept in standard XDG directories, never committed. See [Local Semiont — Paths Outside the Project](./LOCAL-SEMIONT.md#paths-outside-the-project) for the full table.

## Example

A snapshot of a real KB after two resources have been added and the template
scripts are in place:

```
% ls -A
.semiont  authors  data  README.md

% find .semiont -type f | sort
.semiont/compose/backend.yml
.semiont/config
.semiont/containers/Dockerfile
.semiont/containers/semiontconfig/anthropic.toml
.semiont/containers/semiontconfig/ollama-gemma.toml
.semiont/events/50/fa/47488f8a27471bf16f33aba56af90d12/events-000001.jsonl
.semiont/events/66/71/1ed8b4936cfad473c2a7b14c22a945c0/events-000001.jsonl
.semiont/events/__system__/events-000001.jsonl
.semiont/scripts/start.sh

% git log --oneline
9f12ab3 Add Aeschylus resources + initial annotations
4d82e1a Sync template scripts
8c001a7 semiont init
```

Note the `__system__` stream alongside the two per-resource shard directories — that's where global events (like new entity-type registrations) live, and it's committed the same as everything else.

## Initializing a project

```bash
mkdir my-project && cd my-project
semiont init
```

`semiont init` runs `git init` automatically if the directory is not already a git repository, and stages `.semiont/config` for you.

## Related

- [Local Semiont](../LOCAL-SEMIONT.md) — Installing and running Semiont locally
- [Configuration Guide](./administration/CONFIGURATION.md) — Full configuration reference
