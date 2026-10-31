# semiont-archivist

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-archivist)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

**The Archivist keeps Semiont's system of record**: the event log, of which everything else — views,
graph, vectors — is a projection. It appends to that record, serves it, and is **the only process
that touches the knowledge base tree**; every other service reaches it over the wire. It is a Rust
service that serves HTTP on port 24103, and the launcher starts it with `semiont start`.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-archivist` |
| Port | 24103 |
| Command | `/usr/local/bin/semiont-archivist --config /etc/semiont/archivist.json` |
| Code | Rust, in this directory: [src](./src), and its crates [record](./record) and [staging](./staging) |
| Specification | [docs/protocol/ARCHIVIST.md](../../docs/protocol/ARCHIVIST.md) |
| Judged by | [tests/conformance/archivist](../../tests/conformance/archivist/README.md) |
| Published | to no package index: the image only |

## What it does

The binary ([src](./src)) composes two crates of its own and the crates the Rust services share:

- [record](./record) — the event log, the views and the projections, and where each is filed. It
  reaches no network and runs no program; CI checks that it links no HTTP client or server, no
  broker and no git library.
- [staging](./staging) — the staging drivers: git, and none for a knowledge base that does not
  sync git. The only place git is run.

Its five jobs move together on purpose:

- **It appends events** to the event log. It is the only process that does.
- **It writes content** to the working tree.
- **It stages change** where a person can commit it.
- **It keeps the materialized views** up to date with the log, and rebuilds them at startup. A
  resource's view is what the events of its stream add up to.
- **It serves browse requests** from the log, the views and the working tree. It reads no graph,
  no vector index and no embedding provider: a read that needs one is discovery, and the
  [Librarian](../librarian/)'s.

**The startup rebuild also reaps.** It replays the log and writes a view for every resource it
finds, then **deletes the views the log no longer justifies**. Without that step the pass is
upsert-only, and a log rewrite leaves views behind that nothing ever clears — the Weaver's
catalog is those views, so it spends every boot trying to heal resources that no longer exist.
A view whose rebuild *threw* is kept rather than reaped: a transient read failure must not read
as "the log does not justify this." The rebuild logs how many views it reaped.

**Why these cannot be split.** The events and views that are written are the ones browse reads;
separating them opens a cross-process read-after-write window over the same state. And git is
single-writer — the Archivist's staging driver runs it, so two processes on one index means
`index.lock` contention, a hard failure rather than a retry. The Archivist owns the tree and is
the only process that stages into it.

**A knowledge base need not be a git repository.** Without `git.sync: true` in its committed
`.semiont/config.yaml` the Archivist runs no git, and reports no branch. A project file that says
`git.sync: true` over a tree that is not a git checkout stops the Archivist at boot, naming the tree
and the two ways out: `git init`, or `git.sync` set to `false`.

## What it talks to

**The bus, through the gateway.** The Archivist is a client of the gateway's bus: it subscribes
with `POST /bus/subscribe` (SSE) and publishes with `POST /bus/emit`. Every command it handles
(creating resources and annotations among them) and every `browse:*` read it answers passes
through the gateway, whether the gateway's bus runs in-process or on NATS. The Archivist never
connects to NATS. It publishes each persisted event the same way, as an ordinary event: once
globally, and once scoped to its resource when it names one. See [EVENT-BUS.md](../../docs/protocol/EVENT-BUS.md).

**HTTP, for bytes and a few reads of the record.**

| Route | What it does | Called by |
| --- | --- | --- |
| `GET /health` | liveness; the only unauthenticated path | health checks |
| `POST /resources` | stores an upload, multipart as the client sent it, and records the resource for the principal named in `Semiont-Principal` (its roles in `Semiont-Roles`), as a copy when the upload carries `cloneToken`; answers `{resourceId}`. 400 names what is wrong with the upload; 500 carries the record's reason for refusing it | the gateway, for `POST /resources` |
| `GET /resources/:id/content` | a resource's bytes, streamed, with its stored media type | the gateway, for `GET /resources/:id`; the Librarian, the Smelter and the workers, directly |
| `GET /resources/:id/jsonld` | a resource's linked-data description (the answer to `browse:resource-requested`); 404 when there is no such resource | the gateway, for `GET /resources/:id/jsonld` |
| `GET /resources/:id/annotations` | a resource's annotations, the persons they mention named, and how many there are; 404 when there is no such resource | the gateway, for `GET /resources/:id/annotations`; the Smelter, directly |
| `GET /resources/:id/anchored-text` | a resource's anchored text, from the anchored-text store: the text and where each piece of it sits on the page, or why there is none. Never 404: a resource the Archivist does not hold is `unknown`; a media type with no derived text (an image, a text file) is `no-map` at once; for one that has (a PDF), it waits up to 15 seconds for the Smelter to settle content the store lacks, then answers `not-yet` | the gateway, for `GET /resources/:id/anchored-text` |
| `PUT /resources/:id/anchored-text` | stores the entry the Smelter derived from the resource's content, under its checksum; 409 when the resource's content has another | the Smelter |
| `GET /resources/:id/anchored-text/stored?contentChecksum=…` | the entry stored for the resource's content, as stored, at once; 404 when there is none, 409 when the resource's content has another checksum | the Smelter, before it derives a text |
| `GET /anchored-text/entries` | the checksums the store holds entries of, under the stamp stated | the Smelter, when it starts |
| `PUT /anchored-text/stamp` | states the stamp the store's entries are taken under | the Smelter, when it starts |
| `GET /events` | every stream of the event log, `__system__` among them, each with the sequence number of its last event | a service that follows the record, when it starts and each time its stream opens again |
| `GET /events/:resourceId?fromSequence=N` | one stream's events from a sequence number, at most `maxEvents` of them, and the sequence number of its last event; `__system__` is the knowledge base's own stream | the gateway, when a client resumes its subscription with a `lastEventId`; a service that follows the record, for what its stream did not deliver |

The contract is [specs/src/archivist/openapi.json](../../specs/src/archivist/openapi.json): every
status each route answers and its body — a missing resource's bytes are a 404 whose `code` is
`resource` or `representation` — and the headers. The Archivist's conformance suite checks every
reply against it, and the gateway's holds its stand-in Archivist to it.

A browser never calls these: its requests go to the gateway, which calls them with its own
credential.

**Every caller holds `semiont-service`.** Everything but `/health` requires a bearer token from
the knowledge base's identity provider carrying the `semiont-service` role. Each caller gets one
with its own service account. Every refusal is **401**, with the challenge `Bearer`, or
`Bearer error="invalid_token"` when a token was presented and refused.

The principal headers on `POST /resources` are believed because the caller holds the
`semiont-service` role: only the stack's own services call this surface, and the gateway is the one
that verified the person.

**Standing rule: this surface serves content, and nothing else** — the KB tree, each resource's
linked-data description, and the anchored-text store, which the Smelter keeps here. Those are the
answers whose size follows the document's, and the bus is for messages of bounded size. Every other
`browse:*`, and `match:*` and `gather:*`, stay on the bus. An endpoint that is none of these does
not belong here.

**Known limit: a worker outside the stack.** A worker reads resource bytes here directly, so it
needs this port and a token carrying `semiont-service`. This service accepts the same role for
reading the event log and for writing bytes into the working tree. A worker run outside the stack
therefore holds a credential that can write here, and only network access keeps it out.

## What it owns on disk

**It is the only container that mounts the knowledge base**, pinned by
`TestExactlyOneContainerMountsTheKB` in the launcher. `/kb` is the working tree (the document's
`root`): the resources, and the event log under `.semiont/events/`. The views it derives from the
log go to the state volume (the document's `stateHome`), under `semiont/<name>`; the Librarian
reads what it needs of them over the bus. The anchored-text store (`/anchored-text`) holds the text
the Smelter derives from a PDF, with where each piece of it sits on its page; the Smelter stores
each entry here over HTTP. No other container mounts the state volume or the anchored-text store
either. [Where a knowledge base lives on disk](../../docs/architecture/FILESYSTEM.md) has the
layout.

## When it starts

It starts **after the gateway** (it asks the gateway who it is as it signs in) and **before the
worker and the Smelter**, which read bytes from it. Its `/health` answers only once it has booted,
which is what makes that ordering enforceable.

## Configuration

It reads one configuration document, an
[`ArchivistConfig`](../../specs/src/components/schemas/ArchivistConfig.json), from the path its
`--config` flag names; the image passes `/etc/semiont/archivist.json`. The document names the
gateway, the issuer, the knowledge base's root, the state volume, the anchored-text store, the
engine for each job and each Librarian actor, the port, and the staging bounds. Mount the knowledge base, the state volume and
the anchored-text store where the document says they are.

**Its own service account.** Set `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET` to its
service account at the knowledge base's issuer. The token the issuer grants it is its bearer at
the gateway, and it requires a token of the same kind on its own surface.

**`skipRebuild`** in the document skips the startup view rebuild, and with it the reap: views the
log no longer justifies survive until a rebuild runs or `semiont clean --store state` clears them.

## What the image carries

The binary, at `/usr/local/bin/semiont-archivist`, on Alpine, with `tini`, `git` (which trusts
the knowledge base's working tree, mounted at `/kb`) and the shared `boot.sh` and supervisor.
It runs as the user `semiont`, carries no source, and builds, installs or fetches nothing at
start.

## Working on it

Its three crates, `semiont-archivist`, `semiont-archivist-record` and
`semiont-archivist-staging`, are members of the Rust workspace in
[packages/rust](../../packages/rust/README.md). From there,

```bash
cargo test -p semiont-archivist -p semiont-archivist-record -p semiont-archivist-staging
```

runs their tests, which CI's Rust Tests job runs with the rest of the workspace, under
`cargo llvm-cov`. The [conformance suite](../../tests/conformance/archivist/README.md) holds a
built Archivist to [ARCHIVIST.md](../../docs/protocol/ARCHIVIST.md), and in CI that Archivist is
built instrumented, so its coverage counts what the suite runs too.

## Building it

From the repository root, with the toolchain
[`scripts/ci/rust-toolchain.sh`](../../scripts/ci/rust-toolchain.sh) prints:

```bash
docker build --build-arg RUST_TOOLCHAIN=$(scripts/ci/rust-toolchain.sh) \
  --file images/archivist/Dockerfile --tag ghcr.io/the-ai-alliance/semiont-archivist:local .
```

[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) and the publish workflow pass
the toolchain the same way. The [Dockerfile](Dockerfile)'s builder stage is the gateway's and
the dispatcher's too, and builds all three binaries (`lint:rust-images`). A built image is
held to
[`scripts/container/check-document-image.sh`](../../scripts/container/check-document-image.sh):
no source and no Node in it, and, with no configuration document mounted, a prompt refusal
that names the document it cannot read.

## Related

- [Librarian](../librarian/) — the deliberate pair: the Archivist holds the record and answers
  *"what is there?"*; the Librarian searches it and answers *"what is relevant?"*
- [Knowledge System](../../docs/architecture/KNOWLEDGE-SYSTEM.md) — the actors and the stores
- [Where a knowledge base lives on disk](../../docs/architecture/FILESYSTEM.md) — the working
  tree, the event log, and what is derived from them
- [Service catalog](../../docs/operator/services/OVERVIEW.md) — what it mounts and reaches, beside
  the other services
