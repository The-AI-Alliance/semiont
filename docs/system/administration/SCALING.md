# Semiont Scaling Guide

What scales in a Semiont stack, what deliberately does not, and which signals tell you it is
time. Semiont ships container images and selects behavior from config
([DEPLOYMENT.md](./DEPLOYMENT.md), [CONFIGURATION.md](./CONFIGURATION.md)); scheduling those
containers — and what that costs — is your platform's business, so this guide is written in
replicas and drivers, not instance types.

For real-time scaling signals, the OTel metrics described in
[Observability](./OBSERVABILITY.md) are the authoritative source —
particularly `semiont.job.queue.size` (worker fan-out trigger),
`semiont.handler.duration` (per-actor latency), and
`semiont.sse.subscribers` (concurrent client load).

## What scales, per service

| Service | Replicas | How, and why |
|---|---|---|
| browser | N | Serves the UI; no server-side state. |
| gateway | N | Behind a load balancer, once the signal plane is broker-backed (`[signal] type = "nats"`). No session affinity: reply ownership is shared across replicas, reconnect recovery answers from any of them, and replay reads the Archivist. Full requirements: [DEPLOYMENT.md](./DEPLOYMENT.md) § Multiple gateway replicas. |
| worker | N | Workers claim jobs from the dispatcher over the bus; a claim is granted once — atomic in the queue, held as stream leases on `jetstream` — so each job executes exactly once however many workers compete, and only a token carrying the worker role may claim. The worker is the one service built to run off-host: no mount, no broker credential, only network addresses — the gateway's bus, the Archivist's byte surface, an inference provider — so a pool can live on a GPU box the rest of the stack never shares, and a worker that is not yours joins by having its client granted the worker role at the issuer. |
| archivist | 1 | The single writer of the git-backed record, which is the system of record. This is a design invariant, not a capacity limit. |
| weaver | 1 | Owns the graph projection: checkpointed catch-up from the record at boot, then live tailing. Derived state — rebuildable, never authoritative. |
| smelter | 1 | Owns the vector and anchored-text projections, same shape as the weaver. |
| librarian | 1 | A reader over the indices the projectors maintain; it owns no store. |
| dispatcher | 1 | Owns the job queue and answers `job:*`. It subscribes to the bus as a fan-out client, so a second would also receive every `job:create` and create a second job record; the launcher runs one. |

The split is deliberate: everything on the request path (browser, gateway, worker) replicates,
while the record, its projections, and the job queue each have exactly one writer. Write throughput to the
record scales vertically with the Archivist; read throughput scales with gateway replicas and
the projections.

## Infrastructure

- **PostgreSQL** — Keycloak's, holding the realm and nothing of Semiont's; the gateway keeps no
  rows and opens no connection. Scale it with the issuer, or hand it to a managed service.
- **Neo4j and Qdrant** — the graph and vector indices. Derived state: sizeable, but
  rebuildable from the record. Managed equivalents work; durable volumes either way
  ([BACKUP.md](./BACKUP.md)).
- **NATS** — one server carries both broker primitives: JetStream streams for the dispatcher's
  job queue (durable `/data` volume) and core subjects for the gateway's signal plane. It needs failover more
  than it needs scale; a single server serves many gateway replicas.
- **Ollama** — local inference and embeddings. Inference concurrency, not user count, is its
  load; the anthropic config moves LLM inference to the API and leaves embeddings local.
- **The KB working tree and `.semiont/events/`** — the system of record, mounted by the
  Archivist alone. Growth here is repository growth; it survives every container replacement.

## Scaling signals

- `semiont.job.queue.size` climbing and staying up: add workers.
- `semiont.sse.subscribers` per gateway replica approaching your tested ceiling: add gateway
  replicas (select the broker drivers first).
- `semiont.handler.duration` p95 rising on one actor: that actor's service is the bottleneck —
  give the projector or its backing store more resources; replicas will not help a
  single-writer service.

## What adding replicas does not fix

- **Record write throughput** — one Archivist appends the event log. This is the system of
  record's integrity model.
- **Projection lag** — one weaver, one smelter. Lag is a rebuild/catch-up speed problem: faster
  storage and CPU for the projector and its index, not more copies of it.
- **Inference latency** — scale Ollama's hardware or use API inference.

## Cost

Semiont's images are ordinary containers; cost is determined by the platform that schedules
them and the managed services you substitute. A laptop runs the whole stack; so does one VM
with Docker; so does a scheduler with the replica table above. Price the platform, not
Semiont.
