# semiont-archivist

**The service that keeps the system of record.**

The event log is Semiont's system of record; everything else — views, graph, vectors — is a
projection of it. The Archivist is the service that accessions that record, serves it, and
owns the files it lives in.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-archivist` |
| Port | 9093 |
| Entry point | `@semiont/make-meaning/dist/archivist-main.js` |
| Code | [`packages/make-meaning`](../../packages/make-meaning/) |
| npm | not published — container only |

## What it runs

Three actors, and they move together on purpose:

- **Stower** — accessions the record: appends events and maintains the projections derived
  from them. The **only** caller that appends events.
- **Browser** — serves it: answers every `browse:*` read from those projections and the graph.
- **CloneTokenManager** — handles the items themselves, in the content store.

Plus the annotation-assembly handler, the entity-type bootstrap, and the startup view rebuild.

**Why these three cannot be split.** Stower writes the events and projections that Browser
reads; separating them would open a cross-process read-after-write window over the same
state. And git is single-writer — the working-tree store shells out to `git add`/`git mv`,
so two processes writing one index means `index.lock` contention, a hard failure rather than
a retry. The Archivist owns the tree; every other writer passes `noGit: true`.

## What it owns on disk

**It is the only service that mounts the knowledge base.** `/kb` is the working tree
(`SEMIONT_ROOT=/kb`), and it owns the XDG state tree where the event log and materialized
views live. Anchored text (`/anchored-text`) it reads **read-only** — the Smelter writes that.

Because it holds the bytes, its HTTP surface is how they travel: the gateway proxies external
content requests through it, and internal readers dial it directly.

## What it talks to

The bus (SSE in, `POST /bus/emit` out), Neo4j for one query (`browse:referenced-by`), and an
embedding provider for Browser's semantic-search fallback.

**Its facts ride the ordinary bus.** Persisted events are emitted through `/bus/emit` like
every other participant — twice per fact, global and resource-scoped — rather than through a
private ingest route. See [EVENT-BUS.md](../../docs/protocol/EVENT-BUS.md).

## Resume replay

`/bus/subscribe`'s `Last-Event-ID` replay reads the event log **from here**, over
`host:port` plus the worker secret. If that fetch fails, the gateway degrades to a scoped
`bus:resume-gap` rather than silently serving nothing.

## Related

- [`@semiont/make-meaning`](../../packages/make-meaning/) — the actors and this entry point
- [Librarian](../librarian/) — the deliberate pair: the Archivist holds the record and
  answers *"what is there?"*; the Librarian searches it and answers *"what is relevant?"*
- [Knowledge System](../../docs/system/KNOWLEDGE-SYSTEM.md) — the event-store architecture
