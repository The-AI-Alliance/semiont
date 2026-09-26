# semiont-archivist

**The service that keeps the system of record.**

The event log is Semiont's system of record; everything else — views, graph, vectors — is a
projection of it. The Archivist accessions that record, serves it, and is **the only process
that touches the knowledge base tree**. Every other service reaches it over the wire.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-archivist` |
| Port | 24103 |
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

**The startup rebuild also reaps.** It replays the log and writes a view for every resource it
finds, then **deletes the views the log no longer justifies**. Without that step the pass is
upsert-only, and a log rewrite leaves views behind that nothing ever clears — the weaver's
catalog is those views, so it spends every boot trying to heal resources that no longer exist.
A view whose rebuild *threw* is kept rather than reaped: a transient read failure must not read
as "the log does not justify this." Each reap is logged by resource id, with a count.

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

## How requests reach it

**The bus, through the gateway.** The Archivist is a client of the gateway's bus: it subscribes
with `POST /bus/subscribe` (SSE) and publishes with `POST /bus/emit`. Every command it handles —
creating resources and annotations — and every `browse:*` read it answers passes through the
gateway, under either signal driver. It never connects to NATS. Persisted events go out the same
way, as ordinary events (once globally, once scoped to their resource). See
[EVENT-BUS.md](../../docs/protocol/EVENT-BUS.md).

**HTTP, for bytes and a few reads of the record.**

| Route | What it does | Called by |
| --- | --- | --- |
| `GET /health` | liveness; the only unauthenticated path | health checks |
| `PUT /content/:storageUri` | stores an upload's bytes, streamed; a supplied `checksum` is verified before anything is written (409 on mismatch). The resource is not recorded until the gateway's `yield:create` arrives on the bus and the Stower commits the file. | the gateway, for `POST /resources` |
| `GET /resources/:id/content` | a resource's bytes, streamed, with its stored media type | the gateway, for `GET /resources/:id`; the Librarian, the Smelter and the workers, directly |
| `GET /events/:resourceId?fromSequence=N` | one resource's events from a sequence number | the gateway, when a client resumes its subscription with `Last-Event-ID` |
| `GET /kb/branch` | the working tree's git branch | the gateway, for `GET /api/status` |

A browser never calls these: its requests go to the gateway, which calls them with its own
credential.

Everything but `/health` requires a bearer token from the knowledge base's identity provider
carrying the `semiont-service` role. Each caller gets one with its own service account. The
gateway requires the same role to issue a service its agent token.

Every refusal is **401**, including when no identity provider is configured: without a verifier,
every path but `/health` refuses.

**⚠️ Standing rule: this surface serves the KB tree, and nothing else.** `browse:*`, `match:*`
and `gather:*` stay on the bus. An endpoint that is not a KB-tree read or write does not belong
here.

**Known limit: a worker outside the stack.** A worker reads resource bytes here directly, so it
needs this port and a token carrying `semiont-service`. This service accepts the same role for
reading the event log and for writing bytes into the working tree. A worker run outside the stack
therefore holds a credential that can write here, and only network access keeps it out.

## Running it

Mount the KB at `/kb` and the shared state and anchored-text directories at their declared
paths; the image fixes the container-side paths so the launcher passes no path env. Set
`SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET` — its own service account at the
knowledge base's issuer. It exchanges them for a token to reach the gateway, and requires a
token of the same kind on its own surface. `SEMIONT_SKIP_REBUILD=true` skips the startup view rebuild — and with it the reap, so views
the log no longer justifies survive until a rebuild runs or `semiont clean --store state`
clears them.

**The heap ceiling is explicit, and paired.** The image sets
`NODE_OPTIONS=--max-old-space-size=1536` against a 2 GB container allocation. Without it V8
picks its own default, which lands well under the cgroup limit — this process once died at
~1016 MB inside 2048 MB, with half the memory it was allotted unreachable. The 1536/2048 pair
must move together: raising the cap to the container's full allocation trades a catchable V8
heap error for an uncatchable cgroup kill. `semiont.runtime.heap{heap.stat="limit"}` reports the
ceiling actually in force, so a cap that was set but did not apply is visible rather than
assumed. Rationale in full lives in the Dockerfile beside the `ENV`.

Start it **after the gateway** (it mints an agent token there) and **before the sidecars** (they
dial it). Its `/health` answers only once the actors and bus pumps are up, which is what makes
that ordering enforceable.

## Related

- [`@semiont/make-meaning`](../../packages/make-meaning/) — the actors and this entry point
- [Librarian](../librarian/) — the deliberate pair: the Archivist holds the record and answers
  *"what is there?"*; the Librarian searches it and answers *"what is relevant?"*
- [Knowledge System](../../docs/system/KNOWLEDGE-SYSTEM.md) — the event-store architecture
