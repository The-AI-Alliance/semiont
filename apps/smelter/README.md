# semiont-smelter

**Turns content into retrievable material.** It follows the recorded events that change what
the vector index holds, gets the text of what changed, cuts it, has it embedded, and keeps the
index in step with the record. It also derives the text of a PDF, with where each word is on
its page, and keeps that.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-smelter` |
| Port | 24101 (`/health`, and nothing else: everything it does is on the bus, in the index and in the anchored-text store) |
| Command | `python -P -m semiont_smelter --config /etc/semiont/smelter.json` |
| Code | Python, in this directory: [`src/semiont_smelter`](./src/semiont_smelter/) |
| Package indexes | not published — container only |

What the service does is written rule by rule in [SMELTER.md](../../docs/protocol/SMELTER.md),
and the [smelter conformance suite](../../tests/conformance/smelter/README.md) holds a Smelter
to each rule, as a process behind a real gateway, a real Archivist and a real Qdrant, with an
embedding provider the suite plays. This page is the image, and how it is run.

## What it does

It follows eleven of the events a knowledge base records. For a resource it reads the bytes,
takes their checksum, gets their text (decoded, or derived from a PDF), cuts it into chunks,
has every chunk embedded, and then writes the points and says what it decided. A copy of a
resource is indexed as a new one is. For an annotation it embeds the text the annotation
quotes, and the annotations of one resource that are waiting together are embedded in one
request. Archiving takes a resource's points out. A tag rewrites the entity types a
resource's points carry, and a change to an annotation's body those its point carries, each
with nothing embedded.

**The index states what made it**: the embedding provider's type and its model, and the two
numbers a text is cut by. A Smelter that starts on an index made by another model or another
cut, or on one that states nothing, clears it and indexes everything again. A resource whose
bytes give no text is remembered in the index as skipped, by its bytes and their media type,
so that a start does not read it again.

It reaches four things: the gateway, for the bus; the Archivist, for a resource's bytes; its
embedding provider; and the vector index. **The bytes arrive as they are stored**, from the
Archivist's `GET /resources/{id}/content`: every point carries the checksum of the bytes it
was made from, so anything that changed them on the way would break the check that tells a
start what to index again.

**It owns the anchored-text store.** What deriving a PDF's text came to (the text with the
place of each word, or the name the document was declined by) is kept under the checksum of
the bytes, on a mount of the Smelter's own. It is the store's one writer. The Archivist mounts
the same directory to read it, and every other process asks the gateway for a resource's
anchored text. A PDF is read with PDFium, and a page with no text of its own by the
`tesseract` program.

## Readers wait on its signal

For each resource it is asked to index it emits `smelt:settled`: the resource, the checksum
of the bytes it read, and `indexed`, or `skipped` with the reason. A reader that has just seen
bytes recorded waits on that signal to know the index, and the anchored text, have caught up
with them.

**Bytes it could not read are no decision.** Nothing is signalled and the index is left as it
was; the failure is in the log, and whoever waits is left to the end of its own wait.

`smelt:rebuild-anchors` is the one command it answers: it derives anchored text, for one
resource or for every PDF of the catalog, wherever the store has no entry. It answers
`smelt:rebuild-anchors-ok`, or `smelt:rebuild-anchors-failed` with how many of how many it
could not do.

## When it starts

It reads its document, signs in, reaches the vector index, begins following the record, opens
its health port, and then reconciles: it compares what the index holds, what the catalog says
the knowledge base holds, and which bytes the anchored-text store has an entry for, and does
the work that brings them together. So an index that was cleared, an anchored-text store that
was cleared, and events recorded while no Smelter ran are each mended by starting it. `/health`
reports how the reconcile ended, and what it came to. Beside that it says what only the
Smelter knows: the state of its stream of the record and how many times that has dropped, how
many events it has applied, could not apply and has waiting, and what its index is made by.
It answers for itself alone, and asks nothing of the gateway or the vector database to answer.

**A reconcile that fails does not end the service.** The failure is said in the log and at
`/health`, and the Smelter goes on applying what arrives.

**The index is made as wide as the model's vectors.** Where the index has to be made, the
Smelter asks its provider for one vector to learn the width. A provider that is still
starting, or still fetching the model, is asked again; one that does not answer within a
minute ends the start.

## Configuration

It reads one document, the protocol's
[`SmelterConfig`](../../specs/src/components/schemas/SmelterConfig.json), at the path
`--config` names. The launcher writes it for the Smelter it starts, resolved, and mounts it at
`/etc/semiont/smelter.json`. Whoever starts a Smelter another way writes the same document.

| Member | |
| --- | --- |
| `gatewayUrl` | the gateway: its route to the bus |
| `identity.issuer` | where its service account signs in |
| `archivist` | where the Archivist listens: the host and the port it reads bytes from |
| `embedding` | the embedding provider ([`EmbeddingConfig`](../../specs/src/components/schemas/EmbeddingConfig.json)): its kind, its model, where it is reached, and, for a provider that takes a key, the name of the variable that holds it |
| `vectors` | the vector index ([`VectorsConfig`](../../specs/src/components/schemas/VectorsConfig.json)): its kind, and where it is reached |
| `chunking` | the two numbers a text is cut by: a chunk's size, and how much of it the next repeats |
| `anchoredTextDir` | the directory of the anchored-text store |
| `port` | the port `/health` answers on |
| `logLevel`, `logFormat` | how it logs |

Nothing the document leaves out is supplied. Its environment is its service account,
**`SEMIONT_OIDC_CLIENT_ID`** and **`SEMIONT_OIDC_CLIENT_SECRET`**, and, for a provider that
takes a key, the one variable its document names for it. It signs in as itself and works as
the agent its embedding provider and its model name, so two Smelters that embed with
different models are two agents.

**Its telemetry goes where `OTEL_EXPORTER_OTLP_ENDPOINT` says**, as `semiont-smelter`: what
every service says of its own process, how many points its index holds
(`semiont.vector.index.size`), and a span for each frame it sends and receives on the bus
([SMELTER.md § Telemetry](../../docs/protocol/SMELTER.md#telemetry)). The launcher sets the
endpoint for a stack it runs. Without it the Smelter exports nothing. Its log lines carry the
trace and the span they were written in.

Started without its document, without its account or without a key its document names, it
refuses to start: one line on stderr that begins `[fatal] `, and status 1. An index of the
kind `memory` is refused too: nothing else could search an index in the Smelter's own memory.

## What the image carries

The service, and the three Python packages of this repository it runs on: the SDK
([`packages/sdk-python`](../../packages/sdk-python/)), its client of the gateway; the vector
stores and embedding providers ([`packages/vectors-python`](../../packages/vectors-python/)),
which ask a Qdrant and a provider over HTTP; and what every Python service is built on
([`packages/service-python`](../../packages/service-python/)), which reads its configuration,
answers for its health, writes its log and exports its telemetry. All four are built into
the image from the commit it is published from, and carry
[`version.json`](../../version.json)'s version. Everything else in its environment is what
[`uv.lock`](./uv.lock) pins. Nothing is built, installed or fetched when the container
starts.

**Two engines read a PDF, and both are in the image.** PDFium reads a document's own text and
takes out the images its pages paint; it arrives inside the `pypdfium2` package. The
`tesseract` program, with its English data, reads those images: a page with no text of its
own is read from its pixels. Neither reaches the network. The stamp every anchored-text entry
is written under names the Smelter's version and both engines', so an entry derived by other
engines is derived again. No more PDFs are worked on at once than its document says
(`pdfsAtOnce`), however many are waiting: a scanned page held in pixels, beside the `tesseract`
process reading it, is what fills the Smelter's memory, and the rest of what it does goes on
beside them. The launcher writes the number the environment states, and otherwise one for each
2 GB it gives the Smelter's container.

It runs on the oldest Python the repository's Python packages support, on Alpine, as the
user `semiont`. It carries no installer (`pip`, `uv`) and no Node.

## Working on it

| Module | What it is |
| --- | --- |
| `service.py`, `config.py` | The process: what it is started with, what it refuses to start on, the order it starts in, how it stops |
| `smelter.py` | The Smelter: what each recorded event does to the index, the one place a resource is declined, the decision it signals, reconcile, the rebuild command |
| `reconcile.py` | The work a start plans, as [`reconcile-cases.json`](../../specs/src/smelter/reconcile-cases.json) states it |
| `index_stamp.py` | What made the index, which the index states: an index made by another model, or cut another way, is made again when the Smelter starts |
| `telemetry.py` | The number of points the index holds, as the gauge of it reads it |
| `recorded.py`, `record.py` | The eleven events it follows, and what it reads of the record over the bus |
| `chunking.py` | How a text is cut, as [`chunk-cases.json`](../../specs/src/text/chunk-cases.json) states it |
| `extraction.py`, `anchoring.py`, `tables.py`, `ocr_text.py` | A PDF's text by its class, as [`extraction-cases.json`](../../specs/src/smelter/extraction-cases.json) states it |
| `pdf_reader.py`, `pdfium.py`; `ocr_engine.py`, `tesseract.py`; `scripted.py` | What reads a PDF and what reads a scanned page, each behind a protocol whose second implementation answers what a test states |
| `anchored_text_store.py`, `stamp.py` | The anchored-text store, each entry as its [schema](../../specs/src/components/schemas/AnchoredTextEntry.json) states it |

What reads a resource's bytes and the reader that asks the Archivist, where an entry of the
store is filed, and what white space is are every Python service's, in
[`semiont-service`](../../packages/service-python/README.md) (`content`, `archivist`, `shard`,
`white_space`).

```sh
uv sync --locked
uv run pytest        # needs the `tesseract` program, with its English data
```

The tests read the PDFs in [`specs/src/smelter/fixtures`](../../specs/src/smelter/fixtures/),
which [`make-pdf-fixtures.py`](../../scripts/fixtures/make-pdf-fixtures.py) writes.

## Building it

From the repository root, on the Python [`scripts/ci/python-floor.sh`](../../scripts/ci/python-floor.sh)
prints:

```bash
docker build --build-arg PYTHON_FLOOR=$(scripts/ci/python-floor.sh) \
  --file apps/smelter/Dockerfile --tag ghcr.io/the-ai-alliance/semiont-smelter:local .
```

[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) builds it so with the other
images, and [`scripts/container/check-python-image.sh`](../../scripts/container/check-python-image.sh)
checks what a built one promises.

## Related

- [SMELTER.md](../../docs/protocol/SMELTER.md) — what a Smelter does, rule by rule
- [`semiont-vectors`](../../packages/vectors-python/) — the vector stores and the embedding
  providers, and what the index holds
- [Gateway](../gateway/) — the bus it rides
- [Archivist](../archivist/) — serves the bytes, and answers reads of anchored text from the
  store the Smelter writes
- [Librarian](../librarian/) — searches the index it writes
- [Weaver](../weaver/) — the other projection: the same shape, a graph instead of vectors
