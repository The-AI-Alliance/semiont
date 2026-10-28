# semiont-gateway

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-gateway)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

**The HTTP entry point to a Semiont knowledge base**: the one address clients and sidecar
services dial. It is a Rust binary built against [`specs/`](../../specs/src/openapi.json),
which is compiled into it, and it serves on port 4000. The launcher starts it, as the
`semiont-gateway` container, with the rest of the stack (`semiont start`).

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-gateway` |
| Port | 4000 |
| Command | `/usr/local/bin/semiont-gateway --config /etc/semiont/gateway.json` |
| Code | Rust, in this directory: [src](./src) |
| Specification | the OpenAPI spec, [specs/src/openapi.json](../../specs/src/openapi.json) |
| Judged by | [tests/conformance/gateway](../../tests/conformance/gateway/README.md) |
| Published | to no package index: the image only |

## What it does

Its job is narrow on purpose: **authenticate callers, run the bus hub, and proxy content
bytes.** It holds no part of the knowledge base: the resource tree and the event log are the
Archivist's, reached over HTTP.

| It owns | It does not |
|---|---|
| **Identity** — verifies every bearer against the issuer's published keys; mints the `did:web` agent tokens and the media tokens it signs itself | Host any actor (Stower, Browser, Gatherer, Matcher, CloneTokenManager) or any bus handler |
| **The bus hub** — `POST /bus/emit` in, `POST /bus/subscribe` (SSE) out, behind a driver (in-process, or NATS core subjects) | Mount the knowledge base. No `/kb`, no working tree, no `.git` |
| **The correlation ledger** — records who asked, decides who may see the reply, retains replies for reconnect recovery | Own the job queue or hold a database: the queue is the dispatcher's, accounts live at the issuer, and the PostgreSQL in a stack is Keycloak's |
| **The content proxy** — forwards resource bytes to the Archivist | Connect to Neo4j, Qdrant, or an inference provider; read or write projections, views, or content directly; store bytes |

The invariant, enforced by tests rather than convention: **the gateway dials no meaning-tier
service and writes no meaning-tier state** — the meaning tier being the actors, the knowledge
base and the stores the right-hand column names. For the mount half, the launcher's
`gatewayArgs` takes no KB root, so mounting the KB in the gateway takes a signature change,
and `TestExactlyOneContainerMountsTheKB` checks the launcher's run arguments: exactly one
container mounts the KB, and it is the Archivist.

## What it talks to

- **The issuer** — for the published keys that verify every bearer, and for the token,
  granted to its own service account, with which it reaches the Archivist.
- **The Archivist** — for every content route, and the events a resumed subscription replays
  ([the calls](docs/ARCHITECTURE.md#calls-to-the-archivist)).
- **A NATS broker with JetStream**, when `signal.type` is `nats`.

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
| `GET /resources/{id}/annotations` | The resource's annotations, as the Archivist answers them |
| `GET /resources/{id}/anchored-text` | The resource's anchored text, as the Archivist answers it |

Every error, on every route, is a JSON `ErrorResponse`. Emitted payloads are
validated against the schema the bus registry binds to each channel, so an
ill-formed event is a 400 at the edge rather than a confused subscriber
downstream.

## When it starts

For the gateway, `semiont start` resolves to roughly this:

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

The state volume holds only the supervisor's events log; the gateway itself writes nothing to
disk. There is no KB volume.

`tini` is PID 1 and execs the shared `boot.sh`, which execs the image CMD,
`/usr/local/bin/semiont-gateway`: directly when `SEMIONT_SUPERVISE` is unset, so the container
exits when the server dies; under the shared supervisor when the launcher sets it, for local
runs. `tini` forwards `SIGTERM` either way.

**Startup refuses rather than degrades.** Each of these stops the process before it listens
(the order is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#boot)):

- a configuration document that does not validate
- an absent or short `JWT_SECRET`
- no service account
- a broker that does not answer, or runs without JetStream
- routes that are not exactly the spec's operations

A gateway that accepts connections it cannot authenticate, or serves a route no one declared,
is the failure these checks exist to prevent.

`SIGTERM`/`SIGINT` close the listener, drain the signal plane under a deadline so in-flight
frames reach the broker, export what telemetry is buffered, and exit.

## Configuration

One document: a JSON `GatewayConfig`
([schema](../../specs/src/components/schemas/GatewayConfig.json)) at the path its `--config`
flag names, bind-mounted read-only. Without `--config`, the gateway refuses to start; the
image passes `/etc/semiont/gateway.json`, where the launcher mounts the document. The
launcher writes it from the knowledge base's stack documents and its committed identity:

- every address in it is a literal;
- every credential is named by the variable that holds it;
- the gateway defaults nothing.

A gateway started without the launcher is given the same document. At boot the gateway
validates it against the schema and, when it does not match, refuses to serve, naming each
failing field by its JSON pointer.

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

`signal.type` is `in-process` (one gateway) or `nats` (shared by every replica on one broker;
it needs `servers` and a broker with JetStream). `capacity` is what the process can hold: the
bytes queued for all its streams, and the connections it holds open. The launcher derives both
from the memory it gives the container: half for queued bytes, the other half at 20 KiB a
connection.

**Secrets are never in it.** The gateway's own are environment variables, each required:

- `JWT_SECRET`, its token-signing key, at least 32 characters
- `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET`, its own service account at the
  knowledge base's issuer

A broker credential is named by the variable holding it (`signal.userEnv`,
`signal.passwordEnv`). Every environment variable the gateway reads, what sets it and what it
changes, is in
[`specs/src/service-environment/variables.json`](../../specs/src/service-environment/variables.json).

It runs one worker thread per CPU it may use — its container's CPU limit and affinity — so
that limit is what sizes it. No variable does: not even `TOKIO_WORKER_THREADS`, which its
runtime would otherwise read.

## What the image carries

The binary, at `/usr/local/bin/semiont-gateway`, with the spec compiled into it; `tini`; and
the shared `boot.sh` and supervisor. It carries no source, and nothing is built, installed or
fetched at start.

## Working on it

The gateway is a member of the repository's Rust workspace, whose root is `packages/rust`
([Cargo.toml](../../packages/rust/Cargo.toml)). The toolchain is the one
[rust-toolchain.toml](../../packages/rust/rust-toolchain.toml) pins; run it in its image
(`rust:<channel>-alpine`), as the repository runs its other tools, from `packages/rust`:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                 # every crate's tests, the gateway's among them
cargo build --release -p semiont-gateway   # target/release/semiont-gateway
```

The gateway's behavioural contract is the black-box
[conformance suite](../../tests/conformance/gateway/README.md), run against the built binary
on both signal planes; see [TESTING.md](docs/TESTING.md). To run one by hand, write a
`GatewayConfig` to a file, pass its path to `--config`, and set the three variables under
[Configuration](#configuration).

## Building it

From the repository root, with the toolchain
[`scripts/ci/rust-toolchain.sh`](../../scripts/ci/rust-toolchain.sh) prints:

```bash
docker build --build-arg RUST_TOOLCHAIN=$(scripts/ci/rust-toolchain.sh) \
  --file images/gateway/Dockerfile --tag ghcr.io/the-ai-alliance/semiont-gateway:local .
```

[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) and the publish workflow pass
the toolchain the same way. The [Dockerfile](Dockerfile)'s builder stage is the Archivist's
and the dispatcher's too, and builds all three binaries (`lint:rust-images`). A built image is
held to
[`scripts/container/check-gateway-image.sh`](../../scripts/container/check-gateway-image.sh):
no source in it, and `/api/health` served within its start bound.

## Related

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it is built: the embedded spec, boot, the signal plane, the ledger, the stream
- [AUTHENTICATION.md](docs/AUTHENTICATION.md) — tokens, agents, sign-in
- [TESTING.md](docs/TESTING.md) — the conformance suite and what each check covers
- [LOGGING.md](docs/LOGGING.md) — log shape and levels
- [Services overview](../../docs/operator/services/OVERVIEW.md) — where the gateway sits among the services
