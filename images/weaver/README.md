# semiont-weaver

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-weaver)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

**The Weaver keeps the graph in step with the record.** The record is a knowledge base's event
log, which the [Archivist](../archivist/) keeps; the graph is a graph database, Neo4j where the
[launcher](../../apps/launcher/) runs it. The Weaver follows the recorded events that change
what the graph holds, applies each to the graph, and says how far it has got. It is a Python
service that answers `/health` on port 24102, and the launcher starts it with a knowledge base's
other services (`semiont start`).

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-weaver` |
| Port | 24102 (`/health`, and nothing else: everything it does is on the bus and in the graph) |
| Command | `python -P -m semiont_weaver --config /etc/semiont/weaver.json` |
| Code | Python, in this directory: [`src/semiont_weaver`](./src/semiont_weaver/) |
| Specification | [docs/protocol/WEAVER.md](../../docs/protocol/WEAVER.md) |
| Judged by | [tests/conformance/weaver](../../tests/conformance/weaver/README.md) |
| Published | to no package index: the image only |

## What it does

[WEAVER.md](../../docs/protocol/WEAVER.md) states what a Weaver does, rule by rule; the
[weaver conformance suite](../../tests/conformance/weaver/README.md) holds a Weaver to each rule,
as a process behind a real gateway, a real Archivist and a real Neo4j.

It follows the record as every follower of it does
([TRANSPORT-CONTRACT.md § What repairs a passing frame](../../docs/protocol/TRANSPORT-CONTRACT.md#what-repairs-a-passing-frame)):
it keeps a cursor for each resource's log, the last event of it taken, moved one event at a
time; and it sweeps the record for what it missed at its start and each time its stream opens
again. Its fold, what each event does to the graph, applies eight events and takes every other
as nothing:

- `yield:created`, `mark:archived`, `mark:unarchived`: a resource, and whether it is archived
- `mark:added`, `mark:removed`, `mark:body-updated`: an annotation, its link to another
  resource and its entity tags
- `mark:entity-tag-added`, `mark:entity-tag-removed`: a resource's entity types

That graph is what the [Librarian](../librarian/) answers
[`gather.referencedBy`](../../docs/protocol/flows/GATHER.md) from, and what gather's
knowledge-graph traversal walks.

**The graph says what the record says.** A resource is dated when its event was recorded, and
attributed to whom the event records. An annotation is by the creator its event records, who
asked for it, and never by whoever sent the event. A person is held without a name: the name is
the directory's, which the Archivist joins onto every read
([WEAVER.md § What the graph holds](../../docs/protocol/WEAVER.md#what-the-graph-holds)).

**`weave:rebuild` is the one command it answers:** for one resource or for the whole graph, one
at a time, answered with `weave:rebuild-ok` or `weave:rebuild-failed`. A rebuild that stopped at
an event it could not apply answers that it failed.

## What it talks to

It mounts no piece of the knowledge base and no state, and reaches three things:

- the gateway, for the bus ([EVENT-BUS.md](../../docs/protocol/EVENT-BUS.md))
- the Archivist's own HTTP surface, for the record by position and a resource's annotations
- the graph database

## Readers wait on its signals

Each time it has taken more of a resource's log it emits `weave:applied`, with the resource and
the sequence number it has reached. The Librarian keeps those, and the read-after-write barrier
in gather's knowledge-graph build waits on that signal before it reads the graph again.

So a stopped Weaver is not a quiet degradation. A read that needs a node just written waits at
the barrier and then fails: the graph stays as it was, and a gather finds nothing new to walk.

## When it starts

It reads its document, signs in, connects to the graph database, begins following the record,
opens its health port, sweeps the record once its stream is open, and once that sweep is done
runs reconcile. `/health` reports how it follows the record and how reconcile ended.

**Its first sweep** takes what was recorded while it was not running: from the cursors it kept,
or every log from its first event where it kept none. **Reconcile** then compares the graph with
what the record's views (the Archivist's current state of each resource) say, and rebuilds from
the record any resource the graph holds wrongly: the backstop for what following the record
cannot see, such as a graph volume that was wiped.

**An event whose applying fails stops that resource's log, and does not end the service.** It is
said in the log, counted at `/health` (`stopped`), and taken on by the next sweep; every other
resource goes on. An event the graph cannot take as recorded is refused instead: taken as
nothing, and counted (`refused`). A reconcile that fails is said in the log and at `/health`.
Those log lines are the signal that the graph may be behind.

**An orphaned view is reported, not healed.** A resource the Archivist's catalog lists and the
record holds no events for cannot be rebuilt, so reconcile counts it as `orphaned`. It means
history was rewritten without the views being made again; `semiont clean --store state` clears
them.

## Configuration

It reads one document, the protocol's
[`WeaverConfig`](../../specs/src/components/schemas/WeaverConfig.json), at the path `--config`
names. The launcher writes it for the Weaver it starts, resolved, and mounts it at
`/etc/semiont/weaver.json`. Whoever starts a Weaver another way writes the same document.

| Member | |
| --- | --- |
| `kb` | the knowledge base it serves ([`KbIdentity`](../../specs/src/components/schemas/KbIdentity.json)): its name and its domain |
| `gatewayUrl` | the gateway: its route to the bus |
| `identity.issuer` | where its service account signs in |
| `archivist` | where the Archivist listens: it reads the record by position there, and a resource's annotations |
| `graph` | the graph database ([`GraphConfig`](../../specs/src/components/schemas/GraphConfig.json)): its kind, where it is reached, and the name of the variable that holds its password |
| `cursorsPath` | the file it keeps its cursors in ([`CursorsPath`](../../specs/src/components/schemas/CursorsPath.json)) |
| `port` | the port `/health` answers on |
| `logLevel`, `logFormat` | how it logs |

Its environment holds its service account, `SEMIONT_OIDC_CLIENT_ID` and
`SEMIONT_OIDC_CLIENT_SECRET`, and the one variable its document names for the graph database's
password (`NEO4J_PASSWORD`, for a Neo4j the launcher runs). It signs in as itself, and the
gateway names it by its account: `did:web:<the knowledge base's domain>:agents:<its subject at
the issuer>`.

**Its telemetry goes where `OTEL_EXPORTER_OTLP_ENDPOINT` says**, as `semiont-weaver`, naming the
knowledge base it serves by its DID (`semiont.kb`): what every service says of its own process,
and a span for each frame it sends and receives on the bus
([WEAVER.md § Telemetry](../../docs/protocol/WEAVER.md#telemetry)). The launcher sets the
endpoint for a stack it runs. Without it the Weaver exports nothing, unless
`OTEL_CONSOLE_EXPORTER=true` asks for its spans and metrics on stdout. Its log lines carry the
trace and the span they were written in.

Started without its document, without its account or without that password, it refuses to
start: one line on stderr that begins `[fatal] `, and status 1. A graph of the kind `memory` is
refused too: a graph in the Weaver's own memory could not be shared with a reader.

**Its cursors are never a correctness input.** The launcher has it keep them in the container's
own temporary directory, never in the knowledge base, so they last as long as the container
does. A Weaver that finds none takes the whole record again and ends with the same graph.

## What the image carries

The service, and the three Python packages of this repository it runs on:

- the SDK ([`packages/python/sdk`](../../packages/python/sdk/)), its client of the gateway
- the graph stores ([`packages/python/graph`](../../packages/python/graph/)), which ask a graph
  database
- what every Python service is built on ([`packages/python/service`](../../packages/python/service/)),
  which reads its configuration, answers for its health, writes its log and exports its telemetry

All four are built into the image from the commit it is published from, and carry
[`version.json`](../../version.json)'s version. Everything else in its environment is what
[`uv.lock`](./uv.lock) pins. Nothing is built, installed or fetched when the container starts.

**Every graph database's client is in it.** The stores ask each database through that
database's own client, which their package brings as an extra named for the store
([what an install has](../../packages/python/graph/README.md#what-an-install-has)). The image is
built with every extra, so it is not rebuilt to be pointed at another database.

**The launcher writes its document for Neo4j alone,** the one graph database it runs and the one
the stores have been run against. The JanusGraph and Neptune stores have never run against a
server.

It runs on the oldest Python the repository's Python packages support, on Alpine, as the user
`semiont`. It carries no installer (`pip`, `uv`) and no Node.

### A slimmer image

The one line that decides which databases' clients an image has is the builder stage's `uv sync`
in the [Dockerfile](./Dockerfile). `--all-extras` asks for every extra of `semiont-weaver`, each
of which brings the stores' extra of the same name. An image for one database names that
database's in its place:

```dockerfile
RUN uv sync --project images/weaver --locked --no-dev --no-editable --extra neo4j
```

A service whose document names a database its image has no client for refuses to start, and
names the stores' extra that brings it.

## Working on it

From this directory, as CI checks it:

```sh
uv sync --locked
uv run pytest        # CI adds --cov --cov-report=xml: what the badge reports
uv run mypy && uv run pyright && uv run ruff check && uv run ruff format --check
```

The tests run the fold's case table ([`fold-cases.json`](../../specs/src/weaver/fold-cases.json))
and the Weaver over a scripted transport and a graph in the process. They start no service and
reach no database: the Weaver as a process is the conformance suite's.

## Building it

From the repository root, on the Python [`packages/python/scripts/python-floor.sh`](../../packages/python/scripts/python-floor.sh)
prints:

```bash
docker build --build-arg PYTHON_FLOOR=$(packages/python/scripts/python-floor.sh) \
  --file images/weaver/Dockerfile --tag ghcr.io/the-ai-alliance/semiont-weaver:local .
```

[`images/local-build.sh`](../local-build.sh) builds it the same way, with the
other images, and [`images/scripts/check-python-image.sh`](../scripts/check-python-image.sh)
checks what a built one promises.

## Related

- [WEAVER.md](../../docs/protocol/WEAVER.md) — what a Weaver does, rule by rule
- [`semiont-graph`](../../packages/python/graph/) — the graph stores, and what the graph holds
- [Gateway](../gateway/) — the bus it rides
- [Librarian](../librarian/) — the reader whose barrier waits on its signals
- [Archivist](../archivist/) — the record it reads, by position, and a resource's annotations
- [Smelter](../smelter/) — the other projection: the same shape, vectors instead of a graph
