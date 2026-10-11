# semiont-weaver

**Keeps the graph in step with the record.** It follows the recorded events that change what
the graph holds, applies each to a graph database, and says how far it has got.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-weaver` |
| Port | 24102 (`/health`, and nothing else: everything it does is on the bus and in the graph) |
| Command | `python -P -m semiont_weaver --config /etc/semiont/weaver.json` |
| Code | Python, in this directory: [`src/semiont_weaver`](./src/semiont_weaver/) |
| Package indexes | not published — container only |

What the service does is written rule by rule in [WEAVER.md](../../docs/protocol/WEAVER.md),
and the [weaver conformance suite](../../tests/conformance/weaver/README.md) holds a Weaver
to each rule, as a process behind a real gateway, a real Archivist and a real neo4j. This
page is the image, and how it is run.

## What it does

It follows eight of the events a knowledge base records and writes each into the graph: a
resource, an annotation, an annotation's link to another resource and its entity tags, and a
resource's archiving and entity types. That graph is what
`gather.referencedBy` answers from, and what gather's knowledge-graph traversal walks.

It reaches two things: the gateway, for the bus, and the graph database. It mounts no piece
of the knowledge base and no state. The history it replays arrives as `browse:*` reads over
the bus, answered by the Archivist.

**The graph says what the record says.** A resource is dated when its event was recorded and
is by whom the event records; an annotation is by the creator its event records, who asked
for it, and never by whoever sent the event. A person is held without a name: the name is
the directory's, which the Archivist joins onto every read.

## Readers wait on its signals

Each time it has applied more of a resource's record it emits `weave:applied`, with the
resource and the sequence number it has reached. The Archivist and the Librarian each keep
those, and the read-after-write barrier in gather's knowledge-graph build waits on that
signal rather than polling.

So a stopped Weaver is not a quiet degradation. A read that needs a node just written waits
at the barrier and then fails: the graph stays as it was, and a gather finds nothing new to
walk.

`weave:rebuild` is the one command it answers: for one resource or for the whole graph, one
at a time, answered with `weave:rebuild-ok` or `weave:rebuild-failed`. A rebuild that left
events not applied answers that it failed, and says how many.

## When it starts

It reads its document, signs in, connects to the graph database, begins following the
record, opens its health port, and then runs two passes. Both can be run again, so a restart
runs them again, and `/health` reports how each ended.

**Catch-up** applies what was recorded while it was not running: from the marks it kept, or
everything where it kept none. **Reconcile** then compares the graph with what the record's
views say, and rebuilds from the record any resource the graph holds wrongly: the backstop
for what catch-up cannot see, such as a graph volume that was wiped.

**A pass that fails does not end the service.** A failed pass is said in the log and at
`/health`, and the Weaver goes on applying what arrives. That log line is the one signal
that the graph may be behind.

**An orphaned view is reported, not healed.** A resource the catalog lists and the record
holds no events for cannot be rebuilt, so reconcile counts it as `orphaned`. It means history
was rewritten without the views being made again; `semiont clean --store state` clears them.

## Configuration

It reads one document, the protocol's
[`WeaverConfig`](../../specs/src/components/schemas/WeaverConfig.json), at the path
`--config` names. The launcher writes it for the Weaver it starts, resolved, and mounts it at
`/etc/semiont/weaver.json`. Whoever starts a Weaver another way writes the same document.

| Member | |
| --- | --- |
| `gatewayUrl` | the gateway: its route to the bus |
| `identity.issuer` | where its service account signs in |
| `graph` | the graph database ([`GraphConfig`](../../specs/src/components/schemas/GraphConfig.json)): its kind, where it is reached, and the name of the variable that holds its password |
| `checkpointPath` | the file it keeps its marks in |
| `port` | the port `/health` answers on |
| `logLevel`, `logFormat` | how it logs |

Its environment is its service account, **`SEMIONT_OIDC_CLIENT_ID`** and
**`SEMIONT_OIDC_CLIENT_SECRET`**, and the one variable its document names for the graph
database's password (`NEO4J_PASSWORD`, for a Neo4j the launcher runs). It signs in as itself
and works as the agent `(semiont, weaver)`:
`did:web:<the knowledge base's domain>:agents:semiont:weaver`.

**Its telemetry goes where `OTEL_EXPORTER_OTLP_ENDPOINT` says**, as `semiont-weaver`: what
every service says of its own process, and a span for each frame it sends and receives on the
bus ([WEAVER.md § Telemetry](../../docs/protocol/WEAVER.md#telemetry)). The launcher sets the
endpoint for a stack it runs. Without it the Weaver exports nothing. Its log lines carry the
trace and the span they were written in.

Started without its document, without its account or without that password, it refuses to
start: one line on stderr that begins `[fatal] `, and status 1. A graph of the kind `memory`
is refused too: a graph in the Weaver's own memory could not be shared with a reader.

**Its marks are never a correctness input.** The launcher has it keep them in the
container's own temporary directory, so they last as long as the container does. A Weaver
that finds none applies the whole record again and ends with the same graph.

## What the image carries

The service, and the three Python packages of this repository it runs on: the SDK
([`packages/sdk-python`](../../packages/sdk-python/)), its client of the gateway; the
graph stores ([`packages/graph-python`](../../packages/graph-python/)), which ask a graph
database; and what every Python service is built on
([`packages/service-python`](../../packages/service-python/)), which reads its configuration,
answers for its health, writes its log and exports its telemetry. All four are built into
the image from the commit it is published from, and carry
[`version.json`](../../version.json)'s version. Everything else in its environment is what
[`uv.lock`](./uv.lock) pins. Nothing is built, installed or fetched when the container
starts.

**Every graph database's client is in it.** The stores ask each database through that
database's own client, which their package brings as an extra named for the store
([what an install has](../../packages/graph-python/README.md#what-an-install-has)). The image
is built with every extra, so it is not rebuilt to be pointed at another database.

**The launcher writes its document for Neo4j alone,** the one graph database it runs and the
one the stores have been run against. The JanusGraph and Neptune stores have never run
against a server.

It runs on the oldest Python the repository's Python packages support, on Alpine, as the
user `semiont`. It carries no installer (`pip`, `uv`) and no Node.

### A slimmer image

The one line that decides which databases' clients an image has is the builder stage's
`uv sync` in the [Dockerfile](./Dockerfile). `--all-extras` asks for every extra of
`semiont-weaver`, each of which brings the stores' extra of the same name. An image for one
database names that database's in its place:

```dockerfile
RUN uv sync --project apps/weaver --locked --no-dev --no-editable --extra neo4j
```

A service whose document names a database its image has no client for refuses to start, and
names the stores' extra that brings it.

## Building it

From the repository root, on the Python [`scripts/ci/python-floor.sh`](../../scripts/ci/python-floor.sh)
prints:

```bash
docker build --build-arg PYTHON_FLOOR=$(scripts/ci/python-floor.sh) \
  --file apps/weaver/Dockerfile --tag ghcr.io/the-ai-alliance/semiont-weaver:local .
```

[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) builds it so with the other
images, and [`scripts/container/check-python-image.sh`](../../scripts/container/check-python-image.sh)
checks what a built one promises.

## Related

- [WEAVER.md](../../docs/protocol/WEAVER.md) — what a Weaver does, rule by rule
- [`semiont-graph`](../../packages/graph-python/) — the graph stores, and what the graph holds
- [Gateway](../gateway/) — the bus it rides
- [Librarian](../librarian/) and [Archivist](../archivist/) — the readers whose barriers wait on
  its signals
- [Smelter](../smelter/) — the other projection: the same shape, vectors instead of a graph
