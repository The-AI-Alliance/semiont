# semiont-dispatcher

**Where a worker asks what to do and reports back.** It owns the job queue and answers the
`job:*` lifecycle commands — create, claim, progress, checkpoint, complete, fail, cancel,
status. It dispatches and records; it does not perform (that is the [worker](../worker/)).

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-dispatcher` |
| Port | 24105 (`/health`, and nothing else — all real traffic is the bus) |
| Binary | `semiont-dispatcher`, Rust, built from this directory |
| Protocol | [docs/protocol/JOBS.md](../../docs/protocol/JOBS.md) |
| npm | not published — container only |

## What is here

Three crates of the repository's Rust workspace, split so the broker stays behind an interface:

| Crate | Path | What |
| --- | --- | --- |
| `semiont-dispatcher-handlers` | [`handlers/`](handlers/) | The `JobQueue` trait and the nine handlers, generic over the queue. No NATS in its dependencies — CI's crate-tree check holds it. |
| `semiont-dispatcher-jetstream` | [`jetstream/`](jetstream/) | The queue on JetStream: the one implementation of the trait, and the only code here that names the broker (`lint:broker-boundary`). |
| `semiont-dispatcher` | [`src/`](src/) | The binary: reads its document, signs in, opens the queue, and answers the bus — through the SDK's bus client (`semiont`) over its HTTP transport (`semiont-http-transport`), with `semiont-observability`'s telemetry and logs. |

The judge of all three is the black-box suite in
[`tests/conformance/dispatcher`](../../tests/conformance/dispatcher/), which drives the binary as a
process on the wire.

The suite reaches the dispatcher through a gateway, which refuses a payload that is not its
channel's before it is published. What the dispatcher does with a frame, or a stored record, that
does not decode is therefore held below the bus, by the crates' own tests:
[`handlers/tests/bad_ids.rs`](handlers/tests/bad_ids.rs), the handlers over a queue that records what
it is asked, and the unit tests of [`jetstream/src/lib.rs`](jetstream/src/lib.rs).

## What it is — a control plane, not a conduit

The dispatcher answers questions about *what work is available* and *what a worker has been
assigned*, and records what workers report back. **Content bytes and the resulting annotations
never flow through it.** A worker claims a job here, pulls content from the
[Archivist](../archivist/) over HTTP, writes annotations to the Archivist over the bus, and
tells the dispatcher only that it finished. Routing results back through the dispatcher —
tempting, since it already knows the job — would turn a control plane into a conduit for
knowledge-system content, and it never will.

This is the seam a **foreign** worker walks through: it reaches the dispatcher over the bus
with an HTTP endpoint and a token, and needs nothing else — no broker credential, no KB mount.

## What it talks to

Three things, and nothing else:

- **The gateway's bus**, in and out. SSE in for the nine `job:*` command channels plus the two
  reply channels below; `POST /bus/emit` out for every reply and for `job:queued`, the queue's
  own broadcast that wakes parked workers.
- **The messaging broker, directly**, for the queue itself. Job state lives in JetStream, in the
  layout [specs/src/jobs/storage.json](../../specs/src/jobs/storage.json) states, so the
  dispatcher holds no state tree and mounts nothing.
- **The Archivist, over the bus**, for the two validations `job:create` makes: the KB's
  registered entity types (`browse:entity-types-requested`) and tag schemas
  (`browse:tag-schemas-requested`). It asks the service that owns those projections rather than
  mounting them. The one piece of KB vocabulary that travels the control plane is the resolved
  tag schema, embedded into a tag-annotation job's params so the worker stays independent of
  the registry.

## A claim is authorized, not just authenticated

`job:claim` is admitted only when the caller's token carries the `semiont-worker` role. The realm
grants that role to worker clients; the gateway stamps it onto the agent token a worker mints at
`/api/tokens/agent` and forwards it on the frame as `_roles` — set or cleared on every emit, so
a caller cannot supply it. Every sidecar carries `semiont-service`; that is the floor, not the
discriminator, so an archivist's or smelter's token is refused here exactly as a person's is.

That is what makes the seam foreign-worker-shaped: admitting a worker that is not ours means
granting its client the role at the issuer, and nothing in this service changes. A claim that
finds nothing pending is declined on `job:claim-failed`, not an error — and the two verdicts a
worker's claim loop must tell apart travel as `CommandError.code`: `none-pending` (park until a
wake-up) and `unauthorized` (this credential can never claim; stop, loudly). A refusal carrying
neither is unclassified — a malformed record or a missing injection — and the consumer logs it.

A realm imported before the role existed stamps only `semiont-service` on the worker's client;
such a worker authenticates but can never claim. `semiont start` refuses that realm by name,
and `semiont identity sync` reconciles the client's roles mapper.

## Exactly one per knowledge base

The dispatcher subscribes to the bus as a fan-out client, like every sidecar — not as a
competing-consumer group. A second dispatcher on the same KB would also receive every
`job:create` and create a second job record. The launcher runs one; nothing in the service
enforces it. Workers, by contrast, may be many: a claim is atomic in the queue, so concurrent
workers never share a job.

## Configuration

One document, `DispatcherConfig` in [specs/](../../specs/src/components/schemas/DispatcherConfig.json),
at the path `--config` names. The launcher writes it, resolved, and mounts it where the image's `CMD`
passes it: `/etc/semiont/dispatcher.json`. Started without `--config`, or with a path that names no
file, the dispatcher refuses to start and says which; a document that does not validate is refused
naming each failing field. Secrets are never values in it: a field that needs one names the
environment variable holding it.

Every other variable it reads, what sets it and what it changes, is in
[`specs/src/service-environment/variables.json`](../../specs/src/service-environment/variables.json)
— among them **`SEMIONT_OIDC_CLIENT_ID`** / **`SEMIONT_OIDC_CLIENT_SECRET`**, this process's own
service account at the knowledge base's issuer, which it exchanges for an issuer token that buys an
agent token from the gateway; `SEMIONT_BUS_LOG`; and the telemetry variables.

## Related

- [docs/protocol/JOBS.md](../../docs/protocol/JOBS.md) — what it does, channel by channel
- [`@semiont/jobs`](../../packages/jobs/) — the worker's side
- [Worker](../worker/) — the executor, and a client of this service
- [Archivist](../archivist/) — serves the bytes and records the annotations, directly to workers
- [Container Topology](../../docs/system/CONTAINER-TOPOLOGY.md) — where it sits in the fleet
- [Authentication](../../docs/system/administration/AUTHENTICATION.md) — the service-account
  and worker-role requirements an issuer must meet
