# semiont-librarian

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-librarian)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

**The Librarian is a Semiont knowledge base's reference desk**: a Python service that answers the
questions that need the graph the Weaver writes, the vector index the Smelter writes, or a
model — what a reference could refer to, which resources a text finds, what surrounds an
annotation or a resource, and what refers to a resource. It records nothing. Every question
reaches it, and every answer leaves it, on the gateway's event
[bus](../../docs/protocol/EVENT-BUS.md); its one HTTP route is `/health`, on port 24104. The
launcher starts it with `semiont start`.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-librarian` |
| Port | 24104 (`/health`, and nothing else: everything it answers is on the bus) |
| Command | `python -P -m semiont_librarian --config /etc/semiont/librarian.json` |
| Code | Python, in this directory: [`src/semiont_librarian`](./src/semiont_librarian/) |
| Specification | [docs/protocol/LIBRARIAN.md](../../docs/protocol/LIBRARIAN.md) |
| Judged by | [tests/conformance/librarian](../../tests/conformance/librarian/README.md) |
| Published | to no package index: the image only |

## What it does

It answers eight operations, each on its result channel, or on its failure channel with a
message:

| Request | What it is |
| --- | --- |
| `match:search-requested` | A reference search: the resources an annotation could refer to, scored |
| `match:resources-requested` | A text search: resources by text, in the graph, and by meaning, in the vector index, when nothing matches by text |
| `match:limits-requested` | The limits of the Matcher's engine |
| `gather:requested` | What surrounds an annotation |
| `gather:resource-requested` | What surrounds a resource |
| `gather:summary-requested` | An annotation's summary |
| `gather:referenced-by-requested` | The annotations elsewhere that refer to a resource |
| `gather:limits-requested` | The limits of the Gatherer's engine |

Two actors ask a model: the **Matcher**, in a reference search, and the **Gatherer**, in a
gather and a summary. Each has an engine of its own. The service is one agent whatever those
engines are.

**It owns no store, and makes nothing in one.** It reads the graph and the vector index, and
puts no node, no edge, no collection and no point in either. What it needs of
[the record](../../docs/protocol/ARCHIVIST.md), and the profiles of the principals a reply
names, it asks the Archivist on the bus, each read bounded by its question. A Librarian that
is stopped and started again has lost nothing.

## What it talks to

- **The gateway**, for the bus: requests arrive and replies leave this way, and nothing dials
  the Librarian. A resource's anchored text is read from the gateway too
  (`GET /resources/{id}/anchored-text`).
- **The Archivist**, for a resource's bytes (`GET /resources/{id}/content`), as its service
  account; and, on the bus, for a resource's description (`browse:resource-requested`), an
  annotation on it (`browse:annotation-requested`) and the profiles of the principals a
  reply names (`browse:profiles-requested`).
- **The graph database and the vector index**, each read directly.
- **An embedding provider**, for the vector of a query, and **the provider of each actor's
  engine**.

**It mounts no piece of the knowledge base, and opens no file of the record.** The launcher
mounts two things in it: its configuration document, read-only, and a store of its own for its
supervisor's events log.

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
| `kb` | the knowledge base it serves ([`KbIdentity`](../../specs/src/components/schemas/KbIdentity.json)): its name and its domain |
| `gatewayUrl` | the gateway: its route to the bus |
| `identity.issuer` | where its service account signs in |
| `archivist` | the Archivist's host and port |
| `graph` | the graph database ([`GraphConfig`](../../specs/src/components/schemas/GraphConfig.json)): its kind, where it is reached, and the name of the variable that holds its password |
| `vectors` | the vector index ([`VectorsConfig`](../../specs/src/components/schemas/VectorsConfig.json)): its kind and where it is |
| `embedding` | the embedding provider ([`EmbeddingConfig`](../../specs/src/components/schemas/EmbeddingConfig.json)): its kind, its model, and where it is reached |
| `matcher`, `gatherer` | each actor's engine ([`LibrarianEngineConfig`](../../specs/src/components/schemas/LibrarianEngineConfig.json)): a provider and a model, the provider's address, and the name of the variable that holds its key, where it takes one |
| `modelCatalogue` | the path of the model catalogue: what each model of `google`, `openai` and `together` can take, which those providers' APIs do not say. It is read only where an actor's model is one of theirs |
| `gather.settleTimeoutMs` | how long a gather around a resource waits for the Smelter |
| `search.semanticFloor` | the least similarity a hit by meaning must have |
| `port` | the port `/health` answers on |
| `logLevel`, `logFormat` | how it logs |

Its environment is its service account, **`SEMIONT_OIDC_CLIENT_ID`** and
**`SEMIONT_OIDC_CLIENT_SECRET`**, and each variable its document names: for the graph
database's password, for the embedding provider's key, and for the key of each actor's
model. It signs in as itself, and the gateway names it by its account:
`did:web:<the knowledge base's domain>:agents:<its subject at the issuer>`.

**Its telemetry goes where `OTEL_EXPORTER_OTLP_ENDPOINT` says**, as `semiont-librarian`, naming
the knowledge base it serves by its DID (`semiont.kb`): what every Python service says of its
own process, a span for each frame it sends and receives on the bus, what a driver records of
each request of a model, and the count of gathers that went without something
(`semiont.gather.degraded`). Without the endpoint the Librarian
exports nothing, unless `OTEL_CONSOLE_EXPORTER=true` asks for its spans and metrics on stdout. Its log lines carry the trace and the span they were written in.

**It refuses to start** without its document, without its account or without a variable its
document names: one line on stderr that begins `[fatal] `, and a status other than 0. It
refuses a graph or a vector index of the kind `memory` too: neither could be shared with the
service that writes it. It refuses a settle bound that, with the longest wait for the graph,
is not less than the time after which a held job is called stalled. And it refuses an actor
whose provider takes a key when the actor's `apiKeyEnv` is not stated, a `modelCatalogue`
that does not serve an actor's model, and a port it cannot listen on.

## What the image carries

The service, and the five Python packages of this repository it runs on:

- the SDK ([`packages/python/sdk`](../../packages/python/sdk/)), its client of the gateway;
- the graph stores ([`packages/python/graph`](../../packages/python/graph/)), which ask a
  graph database;
- the vector stores and embedding providers ([`packages/python/vectors`](../../packages/python/vectors/)),
  which ask a Qdrant and a provider over HTTP;
- the inference drivers ([`packages/python/inference`](../../packages/python/inference/)),
  which ask a model provider;
- what every Python service is built on ([`packages/python/service`](../../packages/python/service/)),
  which reads its configuration, answers for its health, writes its log, exports its telemetry
  and reads a resource's bytes from the Archivist.

All six are built into the image from the commit it is published from, and carry
[`version.json`](../../version.json)'s version. Everything else in its environment is what
[`uv.lock`](./uv.lock) pins. Nothing is built, installed or fetched when the container starts.
The image also carries the model catalogue, at `/usr/share/semiont/model-catalogue.json`, the
path the launcher writes into `modelCatalogue`.

**Every graph database's client and every provider's library is in it.** The stores ask each
database through that database's own client, and the drivers ask each provider through that
provider's own library. Each is an extra of its package, named for the store or the provider
(what an install has: [the stores'](../../packages/python/graph/README.md#what-an-install-has),
[the drivers'](../../packages/python/inference/README.md#what-an-install-has)). The image is
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
RUN uv sync --project images/librarian --locked --no-dev --no-editable --extra neo4j --extra anthropic
```

An image whose models are Ollama's names the database's extra alone: Ollama is asked with
what every install has. A service whose document names a database or a provider its image
has no client or library for refuses to start, and names the extra that brings it.

## Working on it

In this directory:

```sh
uv sync --locked
uv run pytest
```

The [librarian conformance suite](../../tests/conformance/librarian/README.md) holds a
Librarian to [LIBRARIAN.md](../../docs/protocol/LIBRARIAN.md), as a process behind a real
gateway and a real Archivist, reading a Neo4j a real Weaver writes and a Qdrant a real Smelter
writes.

## Building it

From the repository root, on the Python [`scripts/ci/python-floor.sh`](../../scripts/ci/python-floor.sh)
prints:

```bash
docker build --build-arg PYTHON_FLOOR=$(scripts/ci/python-floor.sh) \
  --file images/librarian/Dockerfile --tag ghcr.io/the-ai-alliance/semiont-librarian:local .
```

[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) builds it so with the other
images, and [`scripts/container/check-python-image.sh`](../../scripts/container/check-python-image.sh)
checks what a built one promises.

## Related

- [LIBRARIAN.md](../../docs/protocol/LIBRARIAN.md) — what a Librarian does, rule by rule
- [Gather flow](../../docs/protocol/flows/GATHER.md) · [Match flow](../../docs/protocol/flows/MATCH.md) — the client's side of what it answers
- [`semiont-graph`](../../packages/python/graph/), [`semiont-vectors`](../../packages/python/vectors/)
  and [`semiont-inference`](../../packages/python/inference/) — the stores, the embedding
  providers and the drivers it reads and asks through
- [Gateway](../gateway/) — the bus it rides
- [Archivist](../archivist/) — the other half of the pair: it holds the record and answers
  *"what is there?"*; the Librarian searches it and answers *"what is relevant?"*
- [Weaver](../weaver/) and [Smelter](../smelter/) — the writers of the graph and the index it
  reads, whose signals its gathers wait on
