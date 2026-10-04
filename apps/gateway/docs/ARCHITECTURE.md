# Gateway Architecture

How the gateway is put together. What it serves is the spec's
([specs/src/openapi.json](../../../specs/src/openapi.json)); this is the code
that serves it.

## The crates it is built from

The gateway is a member of the repository's Rust workspace
([Cargo.toml](../../../Cargo.toml)), and is built from these of its crates:

| Crate | Directory | What the gateway takes from it |
|---|---|---|
| `semiont-gateway` | `apps/gateway` | Everything particular to the gateway: the routes, the ledger, the signal plane, token minting, principals and limits |
| `semiont-core` | [packages/core-rust](../../../packages/core-rust) | What every Rust service shares and no client needs: the embedded spec, reading the configuration document and the other service-only types generated from the spec, and (its `nats` feature) reaching the broker |
| `semiont` | [packages/sdk-rust](../../../packages/sdk-rust) | What a client needs too: the protocol's types, generated from the spec, which type every body the gateway reads and writes; naming the knowledge base and its principals; the realm's roles; and the bus log |
| `semiont-telemetry` | [packages/telemetry-rust](../../../packages/telemetry-rust) | Its spans' making and the trace context they travel in: a caller's trace continued, and the gateway's own carried on what it sends |
| `semiont-observability` | [packages/observability-rust](../../../packages/observability-rust) | What exports that telemetry, logging and the process's readings of itself |
| `semiont-http-transport` | [packages/http-transport-rust](../../../packages/http-transport-rust) | Signing in as a service account, to reach the Archivist |
| `semiont-codegen` | [packages/codegen-rust](../../../packages/codegen-rust) | Nothing at run time: the core's and the SDK's build scripts bundle the spec and generate their types with it |

## Built against the spec

The spec is compiled into the binary.
[semiont-core's build.rs](../../../packages/core-rust/build.rs) reads
`specs/src` — the bundles in `specs/` are gitignored build output — and writes
three documents the binary embeds: the protocol's OpenAPI document, the
Archivist's, and the component schemas as JSON Schema draft 7 (OpenAPI 3.0's
`nullable` made a type). It compiles every schema while it builds, so a
malformed spec fails the build, never a boot or a request, and it generates the
Rust types of the configuration documents from their schemas. The binary also
embeds the bus registry and
[bus-classification.json](../../../packages/core-rust/src/bus-classification.json),
which `scripts/bus/generate-ts.mjs` derives from the registry beside core's
TypeScript table. `semiont_core::spec` reads them: validators by schema name,
each channel's schema, the registry's operations, and which channels are
replies and which write. [src/limits.rs](../src/limits.rs) reads what the
gateway alone enforces: the limits (`x-semiont-limits`, `maxItems`), and, for
an operation that takes JSON, its body's schema and `maxBodyBytes`, which
[src/http.rs](../src/http.rs)'s `json_body` holds a body to: one its
Content-Length already puts over the limit is refused with 413 unread, and one
without a length once it passes the limit.

## Boot

[src/app.rs](../src/app.rs), in order, refusing rather than degrading at each
step — the process exits non-zero, saying what is missing and never a secret:

1. **The document** — the JSON file `--config` names
   (`/etc/semiont/gateway.json` in the image), validated against `GatewayConfig`
   ([src/config.rs](../src/config.rs), reading with `semiont_core::config`); a
   failing field is named by its JSON pointer.
2. **The key ring** (`JWT_SECRET`) and **the service account**
   (`SEMIONT_OIDC_CLIENT_ID`, `SEMIONT_OIDC_CLIENT_SECRET`).
3. **Logging and telemetry**, as the document and the environment say.
4. **The Archivist's operations it calls** must be in the Archivist's spec.
5. **The signal plane** — `in-process`, or NATS with the credentials the
   document names — composed with the ledger, whose shared tables must open
   (under NATS, a broker with JetStream), and its standing subscription,
   which is made only once the broker has confirmed it: nothing is served
   before a frame could be missed. Bounded at ten seconds.
6. **The route table** must be exactly the spec's operations
   ([src/routes/mod.rs](../src/routes/mod.rs)): a route the spec does not
   declare, or a declared operation nothing serves, stops the process.
7. **Listen** on `0.0.0.0:<port>`, on its own accept loop
   ([src/http.rs](../src/http.rs)), which lets a stream close its connection
   from the gateway's side.

`SIGTERM` and `SIGINT` stop accepting connections, flush the plane under the
same bound — frames already written reach the broker — export what telemetry is
buffered, and exit 0.

## Serving

Every response goes through the edge (`edge` in http.rs): CORS for any origin
and never credentials, the security headers, an `X-Request-ID`, and a log line
each way. Every error is an `ErrorResponse`. Handlers:

| File | Routes |
|---|---|
| [routes/meta.rs](../src/routes/meta.rs) | `GET /api/health`, `GET /`, `GET /api/openapi.json`, `GET /.well-known/oauth-protected-resource`, `GET /api/status`, `GET /api/users/me` |
| [routes/tokens.rs](../src/routes/tokens.rs) | `POST /api/tokens/agent`, `POST /api/tokens/media` |
| [routes/content.rs](../src/routes/content.rs) | `POST /resources`, `GET /resources/{id}`, `GET /api/resources/{id}`, `GET /resources/{id}/jsonld` |
| [routes/bus.rs](../src/routes/bus.rs) | `POST /bus/emit` |
| [routes/stream.rs](../src/routes/stream.rs) | `POST /bus/subscribe` |

Authentication is per route: [AUTHENTICATION.md](AUTHENTICATION.md).

## The signal plane

[src/signal/](../src/signal/) is the hub's fan-out behind one interface
(`SignalPlane`), implemented twice: [in_process.rs](../src/signal/in_process.rs),
where the fabric is the process and the count of subscribers at dispatch is
exact; and [nats.rs](../src/signal/nats.rs), where frames ride core subjects
and are never stored, and the shared tables are JetStream key-value buckets.
The plane moves frames and never reads one: `scope` is the one routing fact it
interprets, and a frame's `meta` — its correlation id, its trace — is carried
verbatim. Under a broker outage an emit is refused with 503, never accepted and
lost; the client reconnects on its own.

**Where the interface stands.** It is the boundary to the broker, and it is
held: `npm run lint:broker-boundary` fails when the `async_nats` crate is named
outside `nats.rs`, when the NATS plane is named outside `app.rs` (where the
plane is chosen), or when the `nats` npm client is imported outside the
dispatcher's JetStream job queue, whose `JobQueue` interface is the same
boundary on the Node side. The subjects, the bucket names and the round trip
that confirms a subscription are private to `nats.rs`. Another broker would take an implementation of
`SignalPlane` and `SharedTable` meeting the contract in
[signal/mod.rs](../src/signal/mod.rs) — delivery at most once, in order per
channel and scope; tables with an atomic insert-if-absent, a TTL per table, and
a watch that delivers what is present and then everything after, with no gap; a
subscription that resolves only once the fabric holds it; a flush that resolves
once the fabric has processed everything sent before it —
and, around it, a `JobQueue` for the dispatcher, a `signal.type` in
GatewayConfig, the launcher's container and config, and a plane in the
conformance suite's harness. It is done when the whole suite passes on that
plane. No second broker is planned; the in-process plane is the interface's
second implementation.

Entitlement is gateway policy, above the plane, in the **ledger**
([src/ledger.rs](../src/ledger.rs)): an emit on a request claims its
correlation id for (client, principal) in a table every replica shares, before
it is published; a reply reaches only the claim's owner, and a replica that has
not seen a claim yet reads the table rather than refusing the reply; the first
reply to each claim is retained for `replyRetentionSeconds` for recovery from
any replica. [src/composition.rs](../src/composition.rs) opens the ledger over
the plane and holds its standing tap — one subscription over every reply
channel for the life of the process.

## The stream

`POST /bus/subscribe` ([routes/stream.rs](../src/routes/stream.rs)) subscribes
first, then replays each watermarked scope's events from the Archivist and the
replies named in `pendingReplies`, buffering live frames meanwhile, and only
then drains the buffer and goes live, with a ping every `heartbeatSeconds`. Its
frames wait in a queue the response body drains; the bytes not yet taken are
what `pendingWriteBytes` bounds. Past it, or past `replayBufferEvents` during a
replay, the connection is closed from the gateway's side and its queue freed.
Opening and closing are presence: `session:joined`, `session:left`.

## Limits

What one principal may take and what one process can hold
([TRANSPORT-HTTP.md § Limits](../../../docs/protocol/TRANSPORT-HTTP.md#limits)).
Nothing here asks whether a principal is a person or an agent: a limit's
coefficient comes from the principal's roles ([src/limits.rs](../src/limits.rs)
`PrincipalLimit`) — the baseline when it holds none the limit names, and
unlimited for `semiont-service` and `semiont-worker`.

- **Emits** ([src/rates.rs](../src/rates.rs)): a token bucket per DID in this
  process, checked before the body is read and before any correlation claim, so
  a refused emit claims nothing and its retry is no conflict.
- **Streams** ([src/stream_counts.rs](../src/stream_counts.rs)): each stream a
  limited principal holds is a lease in `streams_held`, a table every replica
  shares; its connection renews it each heartbeat and deletes it at teardown,
  and a lease its replica stopped renewing lapses two heartbeats later. Each
  replica counts against its projection, so near the limit two replicas may
  each admit one more.
- **Capacity** (GatewayConfig `capacity`): the bytes queued for every stream
  together — at the budget a new stream is refused 503 before it subscribes —
  and the connections the accept loop holds; one past them is closed
  unanswered.

Every refusal names its limit in `code`, carries `Retry-After`, and counts in
`semiont.gateway.refused`.

## Calls to the Archivist

The Archivist holds the knowledge base's bytes and event log;
[src/archivist.rs](../src/archivist.rs) is how the gateway reaches it, as itself
— its service account's token (`semiont_http_transport::service_account`), from the issuer's
client-credentials grant, kept until shortly before it expires:

| Client calls the gateway | The gateway calls the Archivist |
|---|---|
| `POST /resources` | `POST /resources`, the multipart body streamed unchanged, naming the caller in `Semiont-Principal` and `Semiont-Roles` |
| `GET /resources/{id}`, `GET /api/resources/{id}` | `GET /resources/{id}/content`, streamed back unchanged |
| `GET /resources/{id}/jsonld` | `GET /resources/{id}/jsonld` |
| `POST /bus/subscribe` with a watermark | `GET /events/{resourceId}?fromSequence=N`, held to `ArchivistEventsResponse` |

Everything else the Archivist answers, it answers over the bus the gateway
relays. The gateway makes no bus request of its own.

## Telemetry

`semiont_observability::telemetry` exports over OTLP/HTTP (protobuf) the spans and
metrics [specs/src/service-telemetry/telemetry.json](../../../specs/src/service-telemetry/telemetry.json)
lists for the gateway, and nothing else: the process's own readings, the gateway's
instruments ([src/metrics.rs](../src/metrics.rs)) made on its meter, and the spans the
routes state over `semiont_telemetry`, which reports to what it registered. It reads
its variables itself and configures the SDK from them; nothing lets a library
read the environment on its own behalf.

## Related Documentation

- [Container Topology](../../../docs/system/CONTAINER-TOPOLOGY.md) - what runs where
- [Dispatcher](../../dispatcher/README.md) - the job queue, which the gateway only relays
- [AUTHENTICATION.md](AUTHENTICATION.md) - the identity plane
- [TESTING.md](TESTING.md) - what checks the gateway
