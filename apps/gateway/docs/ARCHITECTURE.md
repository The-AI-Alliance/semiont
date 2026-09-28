# Gateway Architecture

How the gateway is put together. What it serves is the spec's
([specs/src/openapi.json](../../../specs/src/openapi.json)); this is the code
that serves it.

## Built against the spec

The gateway is a Rust binary, and the spec is compiled into it.
[build.rs](../build.rs) reads `specs/src` — the bundles in `specs/` are
gitignored build output — and writes three documents the binary embeds: the
gateway's OpenAPI document, the Archivist's, and the component schemas as JSON
Schema draft 7 (OpenAPI 3.0's `nullable` made a type). It compiles every schema
while it builds, so a malformed spec fails the build, never a boot or a request.
The binary also embeds the bus registry and
[src/bus-classification.json](../src/bus-classification.json), which
`scripts/bus/generate-ts.mjs` derives from the registry beside core's TypeScript
table. [src/spec.rs](../src/spec.rs) reads them: validators by schema name, each
channel's schema, the registry's operations, which channels are replies and
which write, and the limits (`x-semiont-limits`, `maxItems`). An operation that
takes JSON names its body's schema and `maxBodyBytes` in the spec, and
[src/http.rs](../src/http.rs)'s `json_body` reads both from there: a body its
Content-Length already puts over the limit is refused with 413 unread, and one
without a length once it passes the limit.

## Boot

[src/app.rs](../src/app.rs), in order, refusing rather than degrading at each
step — the process exits non-zero, saying what is missing and never a secret:

1. **The document** — `~/.semiontconfig`, validated against `GatewayConfig`
   ([src/config.rs](../src/config.rs)); a failing field is named by its JSON
   pointer.
2. **The key ring** (`JWT_SECRET`) and **the service account**
   (`SEMIONT_OIDC_CLIENT_ID`, `SEMIONT_OIDC_CLIENT_SECRET`).
3. **Logging and telemetry**, as the document and the environment say.
4. **The Archivist's operations it calls** must be in the Archivist's spec.
5. **The signal plane** — `in-process`, or NATS with the credentials the
   document names — composed with the ledger, whose shared tables must open
   (under NATS, a broker with JetStream); then, under NATS, one round trip
   through the broker so every subscription made so far is registered before a
   frame can be missed. Each is bounded at ten seconds.
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
boundary on the Node side. The subjects, the bucket names and the readiness
flush are private to `nats.rs`. Another broker would take an implementation of
`SignalPlane` and `SharedTable` meeting the contract in
[signal/mod.rs](../src/signal/mod.rs) — delivery at most once, in order per
channel and scope; tables with an atomic insert-if-absent, a TTL per table, and
a watch that delivers what is present and then everything after, with no gap; a
flush that resolves once the fabric has processed everything sent before it —
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

## Calls to the Archivist

The Archivist holds the knowledge base's bytes and event log;
[src/archivist.rs](../src/archivist.rs) is how the gateway reaches it, as itself
— a token from the issuer's client-credentials grant, kept until shortly before
it expires:

| Client calls the gateway | The gateway calls the Archivist |
|---|---|
| `POST /resources` | `POST /resources`, the multipart body streamed unchanged, naming the caller in `Semiont-Principal` and `Semiont-Roles` |
| `GET /resources/{id}`, `GET /api/resources/{id}` | `GET /resources/{id}/content`, streamed back unchanged |
| `GET /resources/{id}/jsonld` | `GET /resources/{id}/jsonld` |
| `POST /bus/subscribe` with a watermark | `GET /events/{resourceId}?fromSequence=N`, held to `ArchivistEventsResponse` |

Everything else the Archivist answers, it answers over the bus the gateway
relays. The gateway makes no bus request of its own.

## Telemetry

[src/telemetry.rs](../src/telemetry.rs) exports over OTLP/HTTP (protobuf) the
spans and metrics [specs/src/gateway-telemetry/telemetry.json](../../../specs/src/gateway-telemetry/telemetry.json)
lists, and nothing else. It reads its variables itself and configures the SDK
from them; nothing lets a library read the environment on its own behalf.

## Related Documentation

- [Container Topology](../../../docs/system/CONTAINER-TOPOLOGY.md) - what runs where
- [Dispatcher](../../dispatcher/README.md) - the job queue, which the gateway only relays
- [AUTHENTICATION.md](AUTHENTICATION.md) - the identity plane
- [TESTING.md](TESTING.md) - what checks the gateway
