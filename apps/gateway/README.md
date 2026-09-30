# Semiont Gateway

The HTTP entry point to a Semiont knowledge base. It is the one address clients
and sidecar services dial, and in almost every deployment it runs as the
`semiont-gateway` container on port 4000. It is a Rust binary built against
[`specs/`](../../specs/src/openapi.json), which is compiled into it.

Its job is narrow on purpose: **authenticate callers, run the bus hub, and proxy
content bytes.** It holds no part of the knowledge base. The five actors that
make meaning live in other processes, the resource tree belongs to the
Archivist, the job queue belongs to the dispatcher, and the event log is
reached over HTTP like everything else.

## What it owns, and what it does not

The gateway is defined more by subtraction than addition, so this table is the
fastest way to understand it.

| It owns | It does not |
|---|---|
| **Identity** — verifies every bearer against the issuer's published keys; mints the `did:web` agent tokens and the media tokens it signs itself | Host any actor (Stower, Browser, Gatherer, Matcher, CloneTokenManager) or any bus handler |
| **The bus hub** — `POST /bus/emit` in, `POST /bus/subscribe` (SSE) out, behind a driver (in-process, or NATS core subjects) | Mount the knowledge base. No `/kb`, no working tree, no `.git` |
| **The correlation ledger** — records who asked, decides who may see the reply, retains replies for reconnect recovery | Own the job queue or hold a database: the queue is the dispatcher's, accounts live at the issuer, and the PostgreSQL in a stack is Keycloak's |
| **The content proxy** — forwards resource bytes to the Archivist | Connect to Neo4j, Qdrant, or an inference provider; read or write projections, views, or content directly; store bytes |

The invariant, enforced by tests rather than convention: the gateway **dials no
meaning-tier service and writes no meaning-tier state.**
`TestExactlyOneContainerMountsTheKB` pins the mount half in the launcher's
golden run arguments — exactly one container mounts the KB, and it is the
Archivist.

## Running it

Normally you do not run it directly. The launcher starts it with the rest of the
stack:

```bash
semiont start
```

That resolves to roughly this, which is worth reading once because it is the
whole deployment contract:

```
container run -d --name semiont-gateway \
  --publish 4000:4000 \
  --volume <config-stage>/gateway.json:/etc/semiont/gateway.json:ro \
  --volume <state>:/semiont-state \
  --env SEMIONT_OIDC_CLIENT_ID=semiont-gateway \
  --env SEMIONT_OIDC_CLIENT_SECRET=<secret> \
  --env JWT_SECRET=<key> \
  ghcr.io/the-ai-alliance/semiont-gateway:latest
```

The state volume holds only the supervisor's events log; the gateway itself
writes nothing to disk. **There is no KB volume**, and that absence is the point. It is also enforced:
the launcher's `gatewayArgs` takes no KB root, so re-adding the mount is a
signature change, not a line someone can slip in.

Required in the environment: `JWT_SECRET` (≥32 chars), plus
`SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET` — the gateway's own
service account at the knowledge base's issuer, which it exchanges for a token
to reach the Archivist. There is no `DATABASE_URL`: the gateway holds no
database.

## Boot and shutdown

The container entrypoint (`tini` as PID 1, exec'ing the shared `boot.sh`) runs
one step:

1. **`/usr/local/bin/semiont-gateway`** — the image CMD, exec'd by the shared
   `boot.sh`: directly when `SEMIONT_SUPERVISE` is unset (the container exits
   when the server dies), under the shared supervisor when the launcher sets it
   for local runs. `tini` forwards `SIGTERM` either way. Nothing is built,
   installed or fetched at start; the image carries the binary and no source.

Startup then refuses rather than degrades. A configuration document that does
not validate, an absent or short `JWT_SECRET`, no service account, a broker that
does not answer or runs without JetStream, or routes that are not exactly the
spec's operations each stop the process before it listens (the order is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#boot)) — a gateway that
accepts connections it cannot authenticate, or serves a route no one declared,
is the failure mode these checks exist to prevent.

`SIGTERM`/`SIGINT` close the listener, drain the signal plane under a deadline
so in-flight frames reach the broker, export what telemetry is buffered, and
exit.

## Configuration

One document: a JSON `GatewayConfig`
([schema](../../specs/src/components/schemas/GatewayConfig.json)) at the path
its `--config` flag names, bind-mounted read-only. The image passes
`/etc/semiont/gateway.json`, where the launcher mounts the document; without
`--config`, the gateway refuses to start. The launcher writes it resolved from the knowledge base's config and
committed identity: no `${VAR}` is left in it, and the gateway defaults nothing.
The gateway validates it against the schema at boot, and refuses to serve —
naming each failing field by its JSON pointer — when it does not match.

```json
{
  "kb": { "name": "My KB", "domain": "example.github.io:my-kb" },
  "port": 4000,
  "publicUrl": "http://localhost:4000",
  "identity": { "issuer": "http://keycloak:8080/realms/semiont", "subjectClaim": "sub" },
  "archivist": { "host": "archivist", "port": 24103 },
  "signal": { "type": "nats", "servers": "nats:4222" },
  "logLevel": "info",
  "logFormat": "json",
  "capacity": { "queuedBytes": 1073741824, "connections": 52428 }
}
```

`signal.type` is `in-process` (one gateway) or `nats` (the fabric replicas
share, which needs `servers` and a broker with JetStream). `capacity` is what
the process can hold: the bytes queued for all its streams, and the
connections it holds open. The launcher derives both from the memory it gives
the container — half for queued bytes, the other half at 20 KiB a connection. A gateway started
without the launcher is given the same document.

Secrets are never in it. The gateway's own are environment variables —
`JWT_SECRET`, `SEMIONT_OIDC_CLIENT_ID`, `SEMIONT_OIDC_CLIENT_SECRET` — and a
broker credential is named by the variable holding it (`signal.userEnv`,
`signal.passwordEnv`). Every environment variable the gateway reads, what
sets it and what it changes, is in
[`specs/src/gateway-environment/variables.json`](../../specs/src/gateway-environment/variables.json).

It runs one worker thread per CPU it may use — its container's CPU limit and
affinity — so that limit is what sizes it. No variable does: not even
`TOKIO_WORKER_THREADS`, which its runtime would otherwise read.

## HTTP surface

The OpenAPI document in [specs/src](../../specs/src/openapi.json) is the contract:
every route, every status each can answer and its body, the headers, the bus
stream's messages and id formats, the limits, and the claims a token must carry.
[TRANSPORT-HTTP.md](../../docs/protocol/TRANSPORT-HTTP.md) states the semantics a
schema cannot hold.

| Route | Serves |
|---|---|
| `GET /api/health`, `GET /` | Liveness: 200 once the process serves |
| `GET /api/openapi.json` | The OpenAPI document, stamped with this build's version and public URL |
| `GET /.well-known/oauth-protected-resource` | Resource metadata naming this knowledge base's issuer (RFC 9728) |
| `GET /api/users/me` | The principal the bearer token names |
| `POST /api/tokens/agent`, `POST /api/tokens/media` | The tokens the gateway mints. People sign in at the issuer, not here |
| `GET /api/status` | The gateway's status and version |
| `POST /bus/emit`, `POST /bus/subscribe` | The bus hub, over the selected signal plane (`src/signal/`) |
| `POST /resources` | Upload: streamed to the Archivist, which stores the bytes and records the resource |
| `GET /resources/{id}`, `GET /api/resources/{id}` | The stored bytes, streamed from the Archivist; the second takes a `?token=` media token |
| `GET /resources/{id}/jsonld` | The resource's JSON-LD description |

Every error, on every route, is a JSON `ErrorResponse`. Emitted payloads are
validated against the schema the bus registry binds to each channel, so an
ill-formed event is a 400 at the edge rather than a confused subscriber
downstream.

## Development

The gateway is a member of the repository's Rust workspace
([Cargo.toml](../../Cargo.toml) at the root), and the toolchain is the one
[rust-toolchain.toml](../../rust-toolchain.toml) pins; run it in its image
(`rust:<channel>-alpine`) as the rest of the repository runs its tools, from
the repository root:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                 # the shared-table runners: the only Rust tests
cargo build --release -p semiont-gateway   # target/release/semiont-gateway
```

The gateway's behavioural contract is the black-box
[conformance suite](../../tests/conformance/gateway/README.md), run against the
built binary on both signal planes; see [TESTING.md](docs/TESTING.md). To run
one by hand, write a `GatewayConfig` to a file, pass its path to `--config`, and
set `JWT_SECRET`, `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET`.

The image ([Dockerfile](Dockerfile)) compiles the crate from the repository
with that toolchain — pass `--build-arg RUST_TOOLCHAIN=<channel>`, as
`scripts/ci/local-build.sh` and the publish workflow do — and is held to
[`scripts/container/check-gateway-image.sh`](../../scripts/container/check-gateway-image.sh):
no source in it, and `/api/health` served within its start bound.

## Further reading

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it is built: the embedded spec, boot, the signal plane, the ledger, the stream
- [AUTHENTICATION.md](docs/AUTHENTICATION.md) — tokens, agents, sign-in
- [TESTING.md](docs/TESTING.md) — the conformance suite and what each check covers
- [LOGGING.md](docs/LOGGING.md) — log shape and levels
- [Services overview](../../docs/system/services/OVERVIEW.md) — where the gateway sits among the services
