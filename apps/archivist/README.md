# semiont-archivist

**The service that keeps the system of record.**

The event log is Semiont's system of record; everything else — views, graph, vectors — is a
projection of it. The Archivist accessions that record, serves it, and is **the only process
that touches the knowledge base tree**. Every other service reaches it over the wire.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-archivist` |
| Port | 9093 |
| Entry point | `@semiont/make-meaning/dist/archivist-main.js` |
| Code | [`packages/make-meaning`](../../packages/make-meaning/) |
| npm | not published — container only |

## What it runs

Three actors, and they move together on purpose:

- **Stower** — accessions the record: appends events and maintains the projections derived from
  them. The **only** caller that appends events.
- **Browser** — serves it: answers every `browse:*` read from those projections and the graph.
- **CloneTokenManager** — validates clone tokens so a copy inherits its source's metadata.
  Byte-free: it resolves storage URIs, never content.

Plus the annotation-assembly and annotation-context handlers, the entity-type bootstrap, and the
startup view rebuild — this is the one rebuild owner.

**Why these cannot be split.** Stower writes the events and projections Browser reads;
separating them opens a cross-process read-after-write window over the same state. And git is
single-writer — the working-tree store shells out to `git add`/`git mv`, so two processes on one
index means `index.lock` contention, a hard failure rather than a retry. The Archivist owns the
tree; every other writer passes `noGit: true`.

## What it owns on disk

**It is the only container that mounts the knowledge base** — pinned by
`TestExactlyOneContainerMountsTheKB` in the launcher, not merely intended. `/kb` is the working
tree (`SEMIONT_ROOT`), and it owns the XDG state tree holding the event log and materialized
views. Anchored text (`/anchored-text`) it mounts **read-only** — the Smelter writes that.

## Its two surfaces

**The bus** — it subscribes over SSE and emits through `POST /bus/emit`, like every other
participant. Persisted events ride out as ordinary facts (twice: global and resource-scoped),
not through a private ingest route. See [EVENT-BUS.md](../../docs/protocol/EVENT-BUS.md).

**HTTP** — because it holds the bytes and the record, this is how both travel:

| | |
| --- | --- |
| `GET /health` | liveness; the only unauthenticated path |
| `GET /kb/branch` | which line of work this knowledge base is on |
| `GET /events/:resourceId?fromSequence=N` | sequence-ranged replay — backs the gateway's SSE resume |
| `GET /resources/:id/content` | a representation's bytes, streamed, with its stored media type |
| `PUT /content/:storageUri` | accept bytes, streamed and checksum-verified before they land |

Everything but `/health` authenticates with `SEMIONT_WORKER_SECRET`. With no secret configured
those paths return 503 — absence fails loudly; it is never served open.

**⚠️ Standing rule: this surface serves the KB tree, and nothing else.** `browse:*`, `match:*`
and `gather:*` stay on the bus. An endpoint that is not a KB-tree read or write does not belong
here.

The gateway proxies external content requests through these; internal readers (Smelter,
Librarian, Worker) dial them directly via `archivistContentReads`.

## Running it

Mount the KB at `/kb` and the shared state and anchored-text directories at their declared
paths; the image fixes the container-side paths so the launcher passes no path env. Set
`SEMIONT_WORKER_SECRET` — it authenticates to the gateway with it and requires it on its own
surface. `SEMIONT_SKIP_REBUILD=true` skips the startup view rebuild.

Start it **after the gateway** (it mints an agent token there) and **before the sidecars** (they
dial it). Its `/health` answers only once the actors and bus pumps are up, which is what makes
that ordering enforceable.

## Related

- [`@semiont/make-meaning`](../../packages/make-meaning/) — the actors and this entry point
- [Librarian](../librarian/) — the deliberate pair: the Archivist holds the record and answers
  *"what is there?"*; the Librarian searches it and answers *"what is relevant?"*
- [Knowledge System](../../docs/system/KNOWLEDGE-SYSTEM.md) — the event-store architecture
