# Semiont Gateway

The HTTP entry point to a Semiont knowledge base. It is the one address clients
and sidecar services dial, and in almost every deployment it runs as the
`semiont-gateway` container on port 4000.

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
  --volume <config-stage>/gateway.toml:/home/semiont/.semiontconfig:ro \
  --volume <state>:/semiont-state \
  --env XDG_STATE_HOME=/semiont-state \
  --env POSTGRES_HOST=<host> --env NEO4J_HOST=<host> \
  --env QDRANT_HOST=<host>   --env OLLAMA_HOST=<host> \
  --env NATS_HOST=<host>     --env KEYCLOAK_HOST=<host> \
  --env SEMIONT_OIDC_CLIENT_ID=semiont-gateway \
  --env SEMIONT_OIDC_CLIENT_SECRET=<secret> \
  --env JWT_SECRET=<key> \
  ghcr.io/the-ai-alliance/semiont-gateway:latest
```

Two things in there are easy to misread:

- **The `*_HOST` variables do not all mean it connects to those services.** It
  dials NATS (the signal plane, when `[signal]` selects it) and Keycloak (token
  verification) and nothing else on that list. The config loader expands every
  `${VAR}` in the staged TOML eagerly, so every referenced variable must be
  defined even for sections this process never consumes.
- **There is no KB volume**, and that absence is the point. It is also enforced:
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

1. **`node dist/index.js`** — the image CMD, exec'd by the shared `boot.sh`:
   directly when `SEMIONT_SUPERVISE` is unset (the container exits when the
   server dies), under the shared supervisor when the launcher sets it for
   local runs. `tini` forwards `SIGTERM` either way.

Startup then refuses rather than degrades. A missing `services.gateway`, an
absent `JWT_SECRET`, a knowledge base that declares no identity, or a missing
sign-in policy each stop the process before it listens — a gateway that accepts
connections it cannot authenticate is the failure mode these checks exist to
prevent.

`SIGTERM`/`SIGINT` close the listener, drain the signal plane under a deadline
so in-flight frames reach the broker, tear down the bus, and exit.

## Configuration

One file: `~/.semiontconfig`, bind-mounted read-only by the launcher, which
stages it per service from the knowledge base's own config. The process reads it
with no project root — there is no tree to read from — so everything it needs
arrives in that file, including the launcher-staged `[kb]` identity card
carrying the KB's committed name, `did:web` domain, and sign-in policy.

One section selects the gateway's driver, defaulting to the single-process local
shape when absent: `[signal]` (`in-process` or `nats`) chooses the bus fan-out.
The `[jobs]` section in the same file is the dispatcher's, not this process's;
`nats` and `jetstream` share one NATS daemon, and `[signal] type = "nats"` is
what gateway replicas require. See
[CONFIGURATION.md](../../docs/system/administration/CONFIGURATION.md).

Secrets are not in the file. They come from the environment.

## HTTP surface

| Router | Serves |
|---|---|
| `root.ts` | Service metadata, OpenAPI spec, Swagger UI |
| `health.ts` | `/api/health` — always 200; liveness, not readiness |
| `auth.ts` | `/api/users/me`; the agent and media tokens the gateway mints (`/api/tokens/agent`, `/api/tokens/media`); cookie consent. People sign in at the issuer, not here |
| `status.ts` | `/api/status` — the gateway's status and version |
| `well-known.ts` | `/.well-known/oauth-protected-resource` — resource metadata naming this KB's issuer |
| `resources/` | W3C-shaped resource and annotation endpoints; binary upload proxied to the Archivist |
| `bus.ts` | `/bus/emit` and `/bus/subscribe` — the hub, over the selected signal driver (`src/signal/`) |

Emitted payloads are validated against the schema the bus registry binds to each
channel, so an ill-formed event is a 400 at the edge rather than a confused
subscriber downstream.

## Development

```bash
npm run dev            # watch mode
npm run typecheck
npm test               # unit
npm run test:integration
```

The package publishes as [`@semiont/gateway`](https://www.npmjs.com/package/@semiont/gateway);
the container image installs that package and runs it directly, with no CLI
layer in between.

## Further reading

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — internal structure
- [AUTHENTICATION.md](docs/AUTHENTICATION.md) — tokens, agents, sign-in
- [DEVELOPMENT.md](docs/DEVELOPMENT.md) — working on the gateway
- [TESTING.md](docs/TESTING.md) — suites and what each covers
- [LOGGING.md](docs/LOGGING.md) — log shape and levels
- [Services overview](../../docs/system/services/OVERVIEW.md) — where the gateway sits among the services
