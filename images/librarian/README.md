# semiont-librarian

**The reference desk.** It answers the questions that need the graph, the vector index or a
model: what a reference could refer to, which resources a text finds, what surrounds an
annotation or a resource, and what refers to a resource. It records nothing.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-librarian` |
| Port | 24104 (`/health`, and nothing else: everything it answers is on the bus) |
| Command | `python -P -m semiont_librarian --config /etc/semiont/librarian.json` |
| Code | Python, in this directory: [`src/semiont_librarian`](./src/semiont_librarian/) |
| Package indexes | not published — container only |

What the service does is written rule by rule in [LIBRARIAN.md](../../docs/protocol/LIBRARIAN.md),
and the [librarian conformance suite](../../tests/conformance/librarian/README.md) holds a
Librarian to it, as a process behind a real gateway and a real Archivist, reading a neo4j a
real Weaver writes and a Qdrant a real Smelter writes. This page is the image, and how it is
run.

## What it does

It answers eight operations, each on its result channel, or on its failure channel with a
message:

| Request | What it is |
| --- | --- |
| `match:search-requested` | A reference search: the resources an annotation could refer to, scored |
| `match:resources-requested` | A text search: resources by text, in the graph, and by meaning, in the vector index, when nothing matches by text |
| `match:limits-requested` | The limits of the Matcher's model |
| `gather:requested` | What surrounds an annotation |
| `gather:resource-requested` | What surrounds a resource |
| `gather:summary-requested` | An annotation's summary |
| `gather:referenced-by-requested` | The annotations elsewhere that refer to a resource |
| `gather:limits-requested` | The limits of the Gatherer's model |

Two actors ask a model: the **Matcher**, in a reference search, and the **Gatherer**, in a
gather and a summary. Each has a model of its own. The service is one agent whatever those
models are.

**It owns no store, and makes nothing in one.** It reads the graph the Weaver writes and the
vector index the Smelter writes, and puts no node, no edge, no collection and no point in
either. What it needs of the record, and what the knowledge base calls the people a reply
names, it asks the Archivist on the bus, each read bounded by its question. A Librarian that
is stopped and started again has lost nothing.

## What it reaches

- **The gateway**, for the bus: requests arrive and replies leave this way, and nothing dials
  the Librarian. A resource's anchored text is read from the gateway too
  (`GET /resources/{id}/anchored-text`).
- **The Archivist**, for a resource's bytes (`GET /resources/{id}/content`), as its service
  account; and, on the bus, for a resource's description (`browse:resource-requested`), an
  annotation on it (`browse:annotation-requested`) and the profiles of the people a reply
  names (`browse:people-requested`).
- **The graph database and the vector index**, each read directly.
- **An embedding provider**, for the vector of a query, and **the provider of each actor's
  model**.

It mounts no volume and no piece of the knowledge base, and opens no file of the record.

## Readers of two signals

It follows `weave:applied`, by which it knows how far the Weaver has applied a resource's
events, and `smelt:settled`, by which it knows what the Smelter decided of a resource's
bytes. A gather waits on each within a bound, and answers with less when the bound runs out.
It follows no recorded event.

## When it starts

It reads its document, signs in, reaches the graph database and the vector index, begins to
take requests from the bus, and opens its health port last. So a Librarian whose health
answers is answering. It loads nothing at start: no view, no graph and no index is read into
it.

A graph database or a vector index that does not answer within a minute ends the start, with
a status other than 0.

## Configuration

It reads one document, the protocol's
[`LibrarianConfig`](../../specs/src/components/schemas/LibrarianConfig.json), at the path
`--config` names. Whoever starts a Librarian writes it, resolved, and mounts it where the
image's command looks: `/etc/semiont/librarian.json`. The Librarian defaults nothing in it.

| Member | |
| --- | --- |
| `gatewayUrl` | the gateway: its route to the bus |
| `identity.issuer` | where its service account signs in |
| `archivist` | the Archivist's host and port |
| `graph` | the graph database ([`GraphConfig`](../../specs/src/components/schemas/GraphConfig.json)): its kind, where it is reached, and the name of the variable that holds its password |
| `vectors` | the vector index ([`VectorsConfig`](../../specs/src/components/schemas/VectorsConfig.json)): its kind and where it is |
| `embedding` | the embedding provider ([`EmbeddingConfig`](../../specs/src/components/schemas/EmbeddingConfig.json)): its kind, its model, and where it is reached |
| `matcher`, `gatherer` | each actor's model ([`LibrarianModelConfig`](../../specs/src/components/schemas/LibrarianModelConfig.json)): a provider and a model, the provider's address, and the name of the variable that holds its key, where it takes one |
| `gather.settleTimeoutMs` | how long a gather around a resource waits for the Smelter |
| `search.semanticFloor` | the least similarity a hit by meaning must have |
| `port` | the port `/health` answers on |
| `logLevel`, `logFormat` | how it logs |

Its environment is its service account, **`SEMIONT_OIDC_CLIENT_ID`** and
**`SEMIONT_OIDC_CLIENT_SECRET`**, and each variable its document names: for the graph
database's password, for the embedding provider's key, and for the key of each actor's
model. It signs in as itself and works as the agent `(semiont, librarian)`:
`did:web:<the knowledge base's domain>:agents:semiont:librarian`.

**Its telemetry goes where `OTEL_EXPORTER_OTLP_ENDPOINT` says**, as `semiont-librarian`: what
every Python service says of its own process, a span for each frame it sends and receives on
the bus, what a driver records of each request of a model, and the count of gathers that
went without something (`semiont.gather.degraded`). Without the endpoint the Librarian
exports nothing. Its log lines carry the trace and the span they were written in.

Started without its document, without its account or without a variable its document names,
it refuses to start: one line on stderr that begins `[fatal] `, and a status other than 0. A graph or a
vector index of the kind `memory` is refused too: neither could be shared with the service
that writes it. So is a settle bound that, with the longest wait for the graph, is not less
than the time after which a held job is called stalled.

## What the image carries

The service, and the five Python packages of this repository it runs on: the SDK
([`packages/sdk-python`](../../packages/sdk-python/)), its client of the gateway; the graph
stores ([`packages/graph-python`](../../packages/graph-python/)), which ask a graph database;
the vector stores and embedding providers
([`packages/vectors-python`](../../packages/vectors-python/)), which ask a Qdrant and a
provider over HTTP; the inference drivers
([`packages/inference-python`](../../packages/inference-python/)), which ask a model
provider; and what every Python service is built on
([`packages/service-python`](../../packages/service-python/)), which reads its configuration,
answers for its health, writes its log, exports its telemetry and reads a resource's bytes
from the Archivist. All six are built into the image from the commit it is published from,
and carry [`version.json`](../../version.json)'s version. Everything else in its environment
is what [`uv.lock`](./uv.lock) pins. Nothing is built, installed or fetched when the
container starts.

**Every graph database's client and every provider's library is in it.** The stores ask each
database through that database's own client, and the drivers ask each provider through that
provider's own library. Each is an extra of its package, named for the store or the provider
(what an install has: [the stores'](../../packages/graph-python/README.md#what-an-install-has),
[the drivers'](../../packages/inference-python/README.md#what-an-install-has)). The image is
built with every extra, so it is not rebuilt to be pointed at another database or another
provider. The vector stores and the embedding providers have no extra: each is asked with
what every install has.

It runs on the oldest Python the repository's Python packages support, on Alpine, as the
user `semiont`. It carries no installer (`pip`, `uv`) and no Node.

### A slimmer image

The one line that decides which clients and which libraries an image has is the builder
stage's `uv sync` in the [Dockerfile](./Dockerfile). `--all-extras` asks for every extra of
`semiont-librarian`, each of which brings the stores' or the drivers' extra of the same name.
An image for one database and one provider names those two in its place:

```dockerfile
RUN uv sync --project apps/librarian --locked --no-dev --no-editable --extra neo4j --extra anthropic
```

An image whose models are Ollama's names the database's extra alone: Ollama is asked with
what every install has. A service whose document names a database or a provider its image
has no client or library for refuses to start, and names the extra that brings it.

## Working on it

```sh
uv sync --locked
uv run pytest
```

## Building it

From the repository root, on the Python [`scripts/ci/python-floor.sh`](../../scripts/ci/python-floor.sh)
prints:

```bash
docker build --build-arg PYTHON_FLOOR=$(scripts/ci/python-floor.sh) \
  --file apps/librarian/Dockerfile --tag ghcr.io/the-ai-alliance/semiont-librarian:local .
```

[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) builds it so with the other
images, and [`scripts/container/check-python-image.sh`](../../scripts/container/check-python-image.sh)
checks what a built one promises.

## Related

- [LIBRARIAN.md](../../docs/protocol/LIBRARIAN.md) — what a Librarian does, rule by rule
- [Gather flow](../../docs/protocol/flows/GATHER.md) · [Match flow](../../docs/protocol/flows/MATCH.md) — the client's side of what it answers
- [`semiont-graph`](../../packages/graph-python/), [`semiont-vectors`](../../packages/vectors-python/)
  and [`semiont-inference`](../../packages/inference-python/) — the stores, the embedding
  providers and the drivers it reads and asks through
- [Gateway](../gateway/) — the bus it rides
- [Archivist](../archivist/) — the other half of the pair: it holds the record and answers
  *"what is there?"*; the Librarian searches it and answers *"what is relevant?"*
- [Weaver](../weaver/) and [Smelter](../smelter/) — the writers of the graph and the index it
  reads, whose signals its gathers wait on
