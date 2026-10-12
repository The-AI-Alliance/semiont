# semiont-smelter

**Turns content into retrievable material.** It follows the event log, chunks what changes,
embeds it, and keeps the vector store reconciled with reality.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-smelter` |
| Port | 24101 (`/health`, and nothing else — all real traffic is the bus) |
| Entry point | `@semiont/make-meaning/dist/smelter-main.js` |
| Code | [`packages/make-meaning`](../../packages/make-meaning/) |
| npm | not published — container only |

## The source is not in this directory

Only the image recipe lives here. The entry point is
`packages/make-meaning/src/smelter-main.ts`, and the image installs the published
`@semiont/make-meaning` and runs `dist/smelter-main.js` out of it. That is deliberate: the
entry point is thin wiring over the pipeline it starts, and moving it here would mean
promoting ~18 of that package's internals to public API to satisfy a directory layout.

Change the CMD only against that file.

## The Smelter in Python is here, and no image runs it

`src/semiont_smelter` is the Smelter in Python (`pyproject.toml`, `uv.lock`, `tests/`),
whole: it does what [SMELTER.md](../../docs/protocol/SMELTER.md) states, and the
[smelter conformance suite](../../tests/conformance/smelter/README.md) runs every case
against it as it does against the TypeScript one. The image this directory builds does not
install it: the Smelter that runs in a stack is the TypeScript one this page describes.

It is started as `python -P -m semiont_smelter --config <path>`, with its service account
in its environment (`SEMIONT_OIDC_CLIENT_ID`, `SEMIONT_OIDC_CLIENT_SECRET`). Everything
else it is told is in the document at that path, a
[`SmelterConfig`](../../specs/src/components/schemas/SmelterConfig.json): the gateway, the
issuer, the Archivist, the embedding provider, the vector index, the two numbers a text is
cut by, the directory of the anchored-text store, its health port and its log. Nothing the
document leaves out is supplied, and a secret is never in it: an embedding provider's key is
named by the variable that holds it.

| Module | What it is |
| --- | --- |
| `service.py`, `config.py` | The process: what it is started with, what it refuses to start on, the order it starts in, how it stops |
| `smelter.py` | The Smelter: what each recorded event does to the index, the one place a resource is declined, the decision it signals, reconcile, the rebuild command |
| `reconcile.py` | The work a start plans, as [`reconcile-cases.json`](../../specs/src/smelter/reconcile-cases.json) states it |
| `recorded.py`, `record.py` | The nine events it follows, and what it reads of the record over the bus |
| `content.py`, `archivist.py` | A resource's bytes: what reads them, and the reader that asks the Archivist |
| `chunking.py`, `white_space.py` | How a text is cut, as [`chunk-cases.json`](../../specs/src/text/chunk-cases.json) states it |
| `extraction.py`, `anchoring.py`, `tables.py`, `ocr_text.py` | A PDF's text by its class, as [`extraction-cases.json`](../../specs/src/smelter/extraction-cases.json) states it |
| `pdf_reader.py`, `pdfium.py`; `ocr_engine.py`, `tesseract.py`; `scripted.py` | What reads a PDF (PDFium, through `pypdfium2`) and what reads a scanned page (the `tesseract` program), each behind a protocol whose second implementation answers what a test states |
| `anchored_text_store.py`, `shard.py`, `stamp.py` | The anchored-text store, each entry as its [schema](../../specs/src/components/schemas/AnchoredTextEntry.json) states it |

The index it writes and the provider it asks for vectors are
[`semiont-vectors`](../../packages/vectors-python/README.md), and what every Python service
does to be one (its document, its health, its log, its telemetry, the order it works in) is
[`semiont-service`](../../packages/service-python/README.md).

```sh
uv sync --locked
uv run pytest        # needs the `tesseract` program, with its English data
```

The tests read the PDFs in [`specs/src/smelter/fixtures`](../../specs/src/smelter/fixtures/),
which [`make-pdf-fixtures.py`](../../scripts/fixtures/make-pdf-fixtures.py) writes.

## What it does

Subscribes to domain events over SSE, reads the bytes, chunks text, embeds via
`@semiont/vectors`, and indexes into the vector store (Qdrant, in a stack the launcher runs).
Everything it emits goes back over the bus.

It also **owns anchored-text extraction** — the coordinate map that lets an annotation anchor
to a position in a PDF or a scan — and holds that store outright, as its sole writer, on its
own mount. Deriving and holding are the same process on purpose: it reaches its own output
without a round trip. The Archivist mounts the same directory to read it, and never writes
there. Every other process asks the gateway for a resource's anchored text
(`GET /resources/{id}/anchored-text`), and the gateway asks the Archivist.

**Bytes arrive verbatim over HTTP from the Archivist**, not from a local mount. That is not
incidental: every vector upsert is stamped with the embedded bytes' checksum, so any
transformation in transit would break change detection.

## Configuration

Reads `~/.semiontconfig` (TOML), section chosen by `[defaults] environment`. Of it, the
Smelter reads the `gateway`, `vectors`, `embedding`, `identity` and `archivist` sections, and
refuses to start without these:

| Key | |
| --- | --- |
| `services.gateway.publicURL` | the bus it subscribes to and emits on |
| `services.embedding.{type,model}`, and its address | the embedding provider |
| `services.vectors.host` | the vector store it indexes into |
| `services.identity.issuer` | where it signs in |
| the Archivist's address | where it reads bytes |

A launcher stack's staged config states every address. The
[service catalog](../../docs/operator/services/OVERVIEW.md) has the rest.

Its environment:

- **`SEMIONT_OIDC_CLIENT_ID`** / **`SEMIONT_OIDC_CLIENT_SECRET`** — this process's own service
  account at the knowledge base's issuer. It exchanges them for an issuer token, which buys an
  agent token from the gateway and is the bearer it shows the Archivist.
- **`SEMIONT_ANCHORED_TEXT_DIR`** — where the anchored-text store lives. The image sets it to
  `/anchored-text`, and a deployment mounts the store there. The Smelter has no default of its
  own and refuses to boot without the variable: a default would write a full OCR pass per
  representation into a directory nobody mounted, lose it on the next stop, and re-derive
  forever.

## Startup reconcile

On boot it reconciles the vector store against the knowledge system's catalog — re-embedding
what is missing or stale, deleting orphans. That is what makes recovery boring: a wiped vector
store, or events missed while the service was down, heal by restarting it. No replay command,
no manual step.

## Related

- [SMELTER.md](../../docs/protocol/SMELTER.md) — what a Smelter does, rule by rule
- [`@semiont/make-meaning`](../../packages/make-meaning/) — the pipeline and this entry point
- [`@semiont/vectors`](../../packages/vectors/) — chunking, embedding, and the store adapters
- [Archivist](../archivist/) — serves the bytes, and answers anchored-text reads
- [Weaver](../weaver/) — the other projection pipeline: same shape, graph instead of vectors
