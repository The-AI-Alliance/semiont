# Semiont Project Layout

A Semiont project is a directory managed by both `git` and Semiont. Your resource files live directly in the project root alongside `.semiont/`, which holds Semiont-internal state. Everything is designed to be committed to git.

## Directory Structure

```
my-project/
├── .semiont/
│   ├── config                        # Project name and settings (commit this)
│   ├── events/                       # Event log (commit this)
│   │   └── {shard}/{shard}/{id}/
│   │       └── events-000001.jsonl
│   ├── scripts/                      # Optional convenience scripts
│   │   ├── local_backend.sh
│   │   └── local_frontend.sh
│   ├── compose/                      # Optional Docker Compose files
│   │   ├── backend.yml
│   │   └── frontend.yml
│   └── containers/                   # Optional Dockerfiles
│       ├── Dockerfile.backend
│       └── Dockerfile.frontend
├── literature/
│   └── prometheus-bound.md           # Resource files — any structure you choose
└── places/
    └── scythian-steppe.md
```

### `.semiont/config`

A TOML file containing the project name and local settings. Commit this to git — it identifies the project to collaborators.

### `.semiont/events/`

The event log: an append-only record of everything that has happened to every resource — annotations, content storage, entity bindings, and computed embeddings. Files are sharded by resource ID for performance. Commit this to git alongside your resource files so the full history travels with the repository.

### `.semiont/scripts/`, `.semiont/compose/`, `.semiont/containers/` (optional)

These directories are not used by Semiont itself — they are convenience infrastructure that KB authors can include to make it easy for others to run the project. Scripts wrap container commands, compose files define service stacks (PostgreSQL, Neo4j, Qdrant, backend, frontend), and Dockerfiles build the application images. The authoritative versions live in the [semiont-empty-kb](https://github.com/The-AI-Alliance/semiont-empty-kb) template repository; KB repos include them so users can get started without cloning the Semiont repo.

### Resource files

Resource files (documents, images, PDFs, etc.) live anywhere in the project root. Their location is recorded as a `file://`-prefixed URI in the event log. When you create a resource via the UI or CLI you choose where in the project to save it.

## What lives outside the project

Machine-specific and secret state is kept in standard XDG directories, never committed. See [Local Semiont — Paths Outside the Project](./LOCAL-SEMIONT.md#paths-outside-the-project) for the full table.

## Example

```
% find * .semiont
literature/prometheus-bound.md
places/scythian-steppe.md
.semiont
.semiont/config
.semiont/events/44/05/e1c62010590ece4ed4e6ebc0c44faa7f/events-000001.jsonl
.semiont/events/49/eb/b159903ba674ceae99087416d3ad988a/events-000001.jsonl

% git log --oneline
6bdbaec Prometheus Bound + Scythian Steppe
```

## Initializing a project

```bash
mkdir my-project && cd my-project
semiont init
```

`semiont init` runs `git init` automatically if the directory is not already a git repository, and stages `.semiont/config` for you.

## Related

- [Local Semiont](../LOCAL-SEMIONT.md) — Installing and running Semiont locally
- [Configuration Guide](./administration/CONFIGURATION.md) — Full configuration reference
