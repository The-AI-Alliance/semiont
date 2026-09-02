# semiont-smelter

**Turns content into retrievable material.** It follows the event log, chunks what changes,
embeds it, and keeps the vector store reconciled with reality.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-smelter` |
| Port | 9091 (`/health`, and nothing else — all real traffic is the bus) |
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

## What it does

Subscribes to domain events over SSE, reads the bytes, chunks text, embeds via
`@semiont/vectors`, and indexes into Qdrant. Everything it emits goes back over the bus.

It also **owns anchored-text extraction** — the coordinate map that lets an annotation anchor
to a position in a PDF or a scan — and holds that store outright, as its sole writer, on its
own mount. Deriving and holding are the same process on purpose: it reaches its own output
without a round trip. Nothing else mounts that directory; other processes read the map over
the bus (`browse:anchored-text-requested`), which the Archivist answers.

**Bytes arrive verbatim over HTTP from the Archivist**, not from a local mount. That is not
incidental: every vector upsert is stamped with the embedded bytes' checksum, so any
transformation in transit would break change detection.

## Configuration

Reads `~/.semiontconfig` (TOML), section chosen by `[defaults] environment`. Required:

| Key | |
| --- | --- |
| `services.gateway.publicURL` | the bus it subscribes to and emits on |
| `services.embedding.{type,model}` | the embedding provider |

Two environment variables:

- **`SEMIONT_WORKER_SECRET`** — JWT auth with the knowledge system, and the bearer this
  process shows the Archivist.
- **`SEMIONT_ANCHORED_TEXT_DIR`** — where the anchored-text store lives. No default, and it
  refuses to boot without one. A default would write a full OCR pass per representation into
  a directory nobody mounted, lose it on the next stop, and re-derive forever.

## Startup reconcile

On boot it reconciles Qdrant against the knowledge system's catalog — re-embedding what is
missing or stale, deleting orphans. That is what makes recovery boring: a wiped Qdrant
volume, or events missed while the service was down, heal by restarting it. No replay
command, no manual step.

## Related

- [`@semiont/make-meaning`](../../packages/make-meaning/) — the pipeline and this entry point
- [`@semiont/vectors`](../../packages/vectors/) — chunking, embedding, and the store adapters
- [Archivist](../archivist/) — serves the bytes, and answers anchored-text reads
- [Weaver](../weaver/) — the other projection pipeline: same shape, graph instead of vectors
