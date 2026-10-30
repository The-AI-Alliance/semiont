# semiont-dispatcher

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-dispatcher)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

**Where a worker asks what to do and reports back.** The dispatcher owns a knowledge base's job
queue: a [worker](../worker/) claims each job here and reports its progress and outcome here. It
is a Rust service. It serves `/health` on port 24105 and nothing else; all its real traffic is
the gateway's [bus](../../docs/protocol/EVENT-BUS.md). The launcher (`semiont start`) starts it.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-dispatcher` |
| Port | 24105 (`/health`, and nothing else: everything it answers is on the bus) |
| Command | `/usr/local/bin/semiont-dispatcher --config /etc/semiont/dispatcher.json` |
| Code | Rust, in this directory: [src](./src), and its crates [handlers](./handlers) and [jetstream](./jetstream) |
| Specification | [docs/protocol/JOBS.md](../../docs/protocol/JOBS.md) |
| Judged by | [tests/conformance/dispatcher](../../tests/conformance/dispatcher/README.md) |
| Published | to no package index: the image only |

## What it does

It answers the `job:*` lifecycle commands — create, claim, progress, checkpoint, complete,
fail, cancel, status. It dispatches and records; it does not perform (that is the worker).

**A control plane, not a conduit.** The dispatcher answers *what work is available* and *what a
worker has been assigned*. Content bytes and the resulting annotations never flow through it. A
worker claims a job here, pulls content from the [Archivist](../archivist/) over HTTP, writes
annotations to the Archivist over the bus, and tells the dispatcher only that it finished.
Results never route back through it, though it knows the job: that would turn a control plane
into a conduit for the knowledge base's content.

**The dispatcher is the seam a foreign worker walks through.** A worker that is not ours
reaches it over the bus with an HTTP endpoint and a token, and needs nothing else — no broker
credential, no knowledge-base mount.

### What it is made of

Three crates of the repository's Rust workspace, split so the broker stays behind an interface:

| Crate | Path | What |
| --- | --- | --- |
| `semiont-dispatcher-handlers` | [`handlers/`](handlers/) | The `JobQueue` trait and the nine handlers, generic over the queue. No NATS in its dependencies — CI's crate-tree check holds it. |
| `semiont-dispatcher-jetstream` | [`jetstream/`](jetstream/) | The queue on JetStream: the one implementation of the trait, and the only code here that names the broker (`lint:broker-boundary`). |
| `semiont-dispatcher` | [`src/`](src/) | The binary: reads its document, signs in, opens the queue, and answers the bus through the SDK's bus client (`semiont`) over its HTTP transport (`semiont-http-transport`), with `semiont-observability`'s telemetry and logs. |

## What it talks to

Three things, and nothing else:

- **The gateway's bus**, in and out. SSE (server-sent events) in for the nine `job:*` command
  channels plus the two reply channels below; `POST /bus/emit` out for every reply, for the
  `job:assign` that follows a claim (the Stower records it as `job:assigned` on the
  resource's stream), and for `job:queued`, the queue's own broadcast that wakes parked
  workers.
- **The messaging broker (NATS JetStream), directly**, for the queue itself. Job state lives
  in JetStream, in the layout [specs/src/jobs/storage.json](../../specs/src/jobs/storage.json)
  states, so the dispatcher holds no state tree and mounts nothing.
- **The Archivist, over the bus**, for the two validations `job:create` makes: the knowledge
  base's registered entity types (`browse:entity-types-requested`) and tag schemas
  (`browse:tag-schemas-requested`). It asks the service that owns those projections rather than
  mounting them. The one piece of knowledge-base vocabulary that travels the control plane is
  the resolved tag schema, embedded into a tagging job's params beside its `schemaId` so the
  worker stays independent of the registry.

## A claim is authorized, not just authenticated

`job:claim` is admitted only when the caller's token carries the `semiont-worker` role. The
issuer's realm grants that role to worker clients; the gateway forwards the roles the caller's
token carries on the frame as `_roles` — set or cleared on every emit, so a caller cannot supply
it. Every sidecar (a service with its own service account) carries `semiont-service`; that is the
floor, not the discriminator, so the Archivist's or the Smelter's token is refused here exactly as
a person's is.

That is what makes the seam foreign-worker-shaped: admitting a worker that is not ours means
granting its client the role at the issuer, and nothing in this service changes.

A claim that finds nothing pending is declined on `job:claim-failed`; it is not an error. The
two verdicts a worker's claim loop must tell apart travel as `CommandError.code`:

- `none-pending` — park until a wake-up.
- `unauthorized` — this credential can never claim; stop, loudly.

A refusal carrying neither is unclassified — a malformed record or a missing injection — and
the consumer logs it.

A realm whose worker client lacks the role stamps only `semiont-service` on it; such a worker
authenticates but can never claim. `semiont start` refuses that realm by name, and
`semiont identity sync` reconciles the client's roles mapper.

## Exactly one per knowledge base

The dispatcher subscribes to the bus as a fan-out client, like every sidecar — not as a
competing-consumer group. A second dispatcher on the same knowledge base would also receive
every `job:create` and create a second job record. The launcher runs one; nothing in the
service enforces it. Workers, by contrast, may be many: a claim is atomic in the queue, so
concurrent workers never share a job.

## Configuration

One document, `DispatcherConfig` in [specs/](../../specs/src/components/schemas/DispatcherConfig.json),
at the path `--config` names. The launcher writes it, resolved, and mounts it where the image's
`CMD` passes it: `/etc/semiont/dispatcher.json`. Started without `--config`, or with a path that
names no file, the dispatcher refuses to start and says which; a document that does not validate
is refused naming each failing field. **Secrets are never values in it:** a field that needs one
names the environment variable holding it.

Every other variable it reads, what sets it and what it changes, is in
[`specs/src/service-environment/variables.json`](../../specs/src/service-environment/variables.json).
Among them:

- **`SEMIONT_OIDC_CLIENT_ID`** / **`SEMIONT_OIDC_CLIENT_SECRET`** — this process's own service
  account at the knowledge base's issuer. It exchanges them for an issuer token, which is its
  bearer at the gateway.
- `SEMIONT_BUS_LOG`.
- The telemetry variables.

## What the image carries

The binary, at `/usr/local/bin/semiont-dispatcher`, on Alpine, with `tini` and the shared
`boot.sh` and supervisor. It runs as the user `semiont`, carries no source, and builds,
installs or fetches nothing at start.

## Working on it

The judge of all three crates is the black-box suite in
[`tests/conformance/dispatcher`](../../tests/conformance/dispatcher/), which drives the binary as
a process on the wire.

The suite reaches the dispatcher through a gateway, which refuses a payload that is not its
channel's before it is published. What the dispatcher does with a frame, or a stored record, that
does not decode is therefore held below the bus, by the crates' own tests:
[`handlers/tests/bad_ids.rs`](handlers/tests/bad_ids.rs), the handlers over a queue that records
what it is asked, and the unit tests of [`jetstream/src/lib.rs`](jetstream/src/lib.rs).

## Building it

From the repository root, with the toolchain
[`scripts/ci/rust-toolchain.sh`](../../scripts/ci/rust-toolchain.sh) prints:

```bash
docker build --build-arg RUST_TOOLCHAIN=$(scripts/ci/rust-toolchain.sh) \
  --file images/dispatcher/Dockerfile --tag ghcr.io/the-ai-alliance/semiont-dispatcher:local .
```

[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) and the publish workflow pass
the toolchain the same way. The [Dockerfile](Dockerfile)'s builder stage is the gateway's and
the Archivist's too, and builds all three binaries (`lint:rust-images`). A built image is
held to
[`scripts/container/check-document-image.sh`](../../scripts/container/check-document-image.sh):
no source and no Node in it, and, with no configuration document mounted, a prompt refusal
that names the document it cannot read.

## Related

- [docs/protocol/JOBS.md](../../docs/protocol/JOBS.md) — what it does, channel by channel
- [docs/protocol/WORKER-CONTRACT.md](../../docs/protocol/WORKER-CONTRACT.md) — the worker's side, which every SDK has
- [semiont-worker](../worker/) — the executor, and a client of this service
- [semiont-archivist](../archivist/) — keeps the record: the bytes a worker reads through the gateway, and the annotations it commits
- [Container Topology](../../docs/operator/CONTAINER-TOPOLOGY.md) — where it sits in the fleet
- [Authentication](../../docs/operator/administration/AUTHENTICATION.md) — the service-account
  and worker-role requirements an issuer must meet
