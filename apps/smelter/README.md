# semiont-smelter

**Turns content into retrievable material.** It follows the event log, chunks what changes,
embeds it, and keeps the vector store reconciled with reality.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-smelter` |
| Port | 9091 |
| Entry point | `@semiont/make-meaning/dist/smelter-main.js` |
| Code | [`packages/make-meaning`](../../packages/make-meaning/) |
| npm | not published — container only |

## What it does

Subscribes to domain events, reads the bytes, chunks text, embeds via `@semiont/vectors`,
and indexes into Qdrant. It also **owns anchored-text extraction** — the coordinate map that
lets an annotation anchor to a position in a PDF or an image — and writes it to
`/anchored-text`, which the Archivist and gateway mount read-only.

**Bytes arrive verbatim over HTTP from the Archivist**, not from a local mount. That is not
incidental: every vector upsert is stamped with the embedded bytes' checksum, so any
transformation in transit would break change detection.

## Startup reconcile

On boot it reconciles Qdrant against the knowledge system's catalog — re-embedding what is
missing or stale, deleting orphans. That is what makes recovery boring: a wiped Qdrant
volume, or events missed while the service was down, heal by restarting it. No replay
command, no manual step.

## What it talks to

The bus (SSE in, `POST /bus/emit` out), Qdrant, an embedding provider, and the Archivist's
HTTP surface for bytes.

## Related

- [`@semiont/make-meaning`](../../packages/make-meaning/) — the pipeline and this entry point
- [`@semiont/vectors`](../../packages/vectors/) — chunking, embedding, and the store adapters
- [Weaver](../weaver/) — the other projection pipeline: same shape, graph instead of vectors
