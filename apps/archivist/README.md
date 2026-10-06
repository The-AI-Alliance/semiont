# semiont-archivist

**The service that keeps the system of record.**

The event log is Semiont's system of record; everything else — views, graph, vectors — is a
projection of it. The Archivist accessions that record, serves it, and is **the only process
that touches the knowledge base tree**. Every other service reaches it over the wire.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-archivist` |
| Port | 24103 |
| Runs | the Rust binary `semiont-archivist` |
| Code | this directory: [src](./src), and its crates [record](./record) and [staging](./staging) |
| Specification | [docs/protocol/ARCHIVIST.md](../../docs/protocol/ARCHIVIST.md) |
| Judged by | [tests/conformance/archivist](../../tests/conformance/archivist/README.md) |

## What it is made of

The binary ([src](./src)) composes two crates of its own and the crates the Rust services share:

- [record](./record) — the event log, the views and the projections, and where each is filed. It
  reaches no network and runs no program, and CI holds it to that.
- [staging](./staging) — the staging drivers: git, and none for a knowledge base that does not
  sync git. The only place git is run.

## What it does

Five jobs, and they move together on purpose:

- **It appends events** to the event log. It is the only process that does.
- **It writes content** to the working tree.
- **It stages change** where a person can commit it.
- **It keeps the materialized views** up to date with the log, and rebuilds them at startup.
- **It serves browse requests** from the log, the views and the working tree. It reads no graph,
  no vector index and no embedding provider: a read that needs one is discovery, and the
  [Librarian](../librarian/)'s.

**The startup rebuild also reaps.** It replays the log and writes a view for every resource it
finds, then **deletes the views the log no longer justifies**. Without that step the pass is
upsert-only, and a log rewrite leaves views behind that nothing ever clears — the weaver's
catalog is those views, so it spends every boot trying to heal resources that no longer exist.
A view whose rebuild *threw* is kept rather than reaped: a transient read failure must not read
as "the log does not justify this." Each reap is logged by resource id, with a count.

**Why these cannot be split.** The events and views that are written are the ones browse reads;
separating them opens a cross-process read-after-write window over the same state. And git is
single-writer — the Archivist's staging driver runs it, so two processes on one index means
`index.lock` contention, a hard failure rather than a retry. The Archivist owns the tree and is
the only process that stages into it.

**A knowledge base need not be a git repository.** Without `[git] sync = true` in its committed
config the Archivist runs no git, and reports no branch. A config that says `sync = true` over a
tree that is not a git checkout stops the Archivist at boot, naming the tree and the two ways out:
`git init`, or `sync = false`.

## What it owns on disk

**It is the only container that mounts the knowledge base** — pinned by
`TestExactlyOneContainerMountsTheKB` in the launcher, not merely intended. `/kb` is the working
tree (the document's `root`): the resources, and the event log under `.semiont/events/`. The views
it derives from the log go to the state volume (the document's `stateHome`), which the Librarian mounts to
read them. Anchored text (`/anchored-text`) it mounts **read-only** — the Smelter writes that.
[Where a knowledge base lives on disk](../../docs/architecture/FILESYSTEM.md) has the layout.

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
| `POST /resources` | an upload, multipart as the client sent it, for the principal named in `Semiont-Principal` (with its roles in `Semiont-Roles`): the bytes are stored and the resource is recorded — as a copy when the upload carries `cloneToken` — and the answer is `{resourceId}`. 400 names what is wrong with the upload; 500 carries the record's reason for refusing it. | the gateway, for `POST /resources` |
| `GET /resources/:id/content` | a resource's bytes, streamed, with its stored media type | the gateway, for `GET /resources/:id`; the Librarian, the Smelter and the workers, directly |
| `GET /resources/:id/jsonld` | a resource's linked-data description (the answer to `browse:resource-requested`); 404 when there is no such resource | the gateway, for `GET /resources/:id/jsonld` |
| `GET /events/:resourceId?fromSequence=N` | one resource's events from a sequence number | the gateway, when a client resumes its subscription with `Last-Event-ID` |

The contract is [specs/src/archivist/openapi.json](../../specs/src/archivist/openapi.json): every
status each route answers and its body — a missing resource's bytes are a 404 whose `code` is
`resource` or `representation` — and the headers. The Archivist's conformance suite checks every
reply against it, and the gateway's holds its stand-in Archivist to it.

A browser never calls these: its requests go to the gateway, which calls them with its own
credential.

Everything but `/health` requires a bearer token from the knowledge base's identity provider
carrying the `semiont-service` role. Each caller gets one with its own service account. The
gateway requires the same role to issue a service its agent token.

Every refusal is **401**. Its challenge is `Bearer`, or `Bearer error="invalid_token"` when a
token was presented and refused.

**⚠️ Standing rule: this surface serves the KB tree and each resource's linked-data description,
and nothing else.** Every other `browse:*`, and `match:*` and `gather:*`, stay on the bus. An
endpoint that is none of these does not belong here.

The principal headers on `POST /resources` are believed because the caller holds the
`semiont-service` role: only the stack's own services call this surface, and the gateway is the one
that verified the person.

**Known limit: a worker outside the stack.** A worker reads resource bytes here directly, so it
needs this port and a token carrying `semiont-service`. This service accepts the same role for
reading the event log and for writing bytes into the working tree. A worker run outside the stack
therefore holds a credential that can write here, and only network access keeps it out.

## Running it

It reads one configuration document, an
[`ArchivistConfig`](../../specs/src/components/schemas/ArchivistConfig.json), from the path its
`--config` flag names; the image passes `/etc/semiont/archivist.json`. The document names the
gateway, the issuer, the knowledge base's root, the state volume, the anchored-text store, who
serves each role, the port, and the staging bounds. Mount the knowledge base, the state volume and
the anchored-text store where the document says they are. Set
`SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET` — its own service account at the
knowledge base's issuer. It exchanges them for a token to reach the gateway, and requires a
token of the same kind on its own surface. `skipRebuild` in the document skips the startup view
rebuild — and with it the reap, so views the log no longer justifies survive until a rebuild runs
or `semiont clean --store state` clears them.

What it keeps and answers is specified in
[docs/protocol/ARCHIVIST.md](../../docs/protocol/ARCHIVIST.md).

Start it **after the gateway** (it mints an agent token there) and **before the worker and the
Smelter**, which read bytes from it. Its `/health` answers only once it has booted, which is what
makes that ordering enforceable.

The
[service catalog](../../docs/operator/services/OVERVIEW.md) states what it mounts and reaches
beside the other services.

## Related

- [Librarian](../librarian/) — the deliberate pair: the Archivist holds the record and answers
  *"what is there?"*; the Librarian searches it and answers *"what is relevant?"*
- [Knowledge System](../../docs/architecture/KNOWLEDGE-SYSTEM.md) — the actors and the stores
- [Where a knowledge base lives on disk](../../docs/architecture/FILESYSTEM.md) — the working
  tree, the event log, and what is derived from them
