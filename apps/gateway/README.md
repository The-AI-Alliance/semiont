# Semiont Gateway

The HTTP entry point to a Semiont knowledge base. It is the one address clients
and sidecar services dial, and in almost every deployment it runs as the
`semiont-gateway` container on port 4000.

Its job is narrow on purpose: **authenticate callers, relay the bus, and proxy
content bytes.** It holds no part of the knowledge base. The five actors that
make meaning live in other processes, the resource tree belongs to the
Archivist, and the event log is reached over HTTP like everything else.

## What it owns, and what it does not

The gateway is defined more by subtraction than addition, so this table is the
fastest way to understand it.

| It owns | It does not |
|---|---|
| **Identity** — issues and verifies user and agent tokens, mints `did:web` agent identities | Host any actor (Stower, Browser, Gatherer, Matcher, CloneTokenManager) |
| **Postgres** — users, sessions, admin state. Its only datastore | Mount the knowledge base. No `/kb`, no working tree, no `.git` |
| **The bus relay** — `POST /bus/emit` in, `POST /bus/subscribe` (SSE) out | Connect to Neo4j, Qdrant, or an inference provider |
| **The job queue** — file-backed, on the shared state mount | Read or write projections, views, or content directly |
| **The content proxy** — forwards resource bytes to the Archivist | Store bytes. They never touch this process's disk |

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
  --env SEMIONT_WORKER_SECRET=<secret> \
  --env JWT_SECRET=<key> \
  ghcr.io/the-ai-alliance/semiont-gateway:latest
```

Two things in there are easy to misread:

- **The three non-Postgres host variables do not mean it connects to those
  services.** The config loader expands every `${VAR}` in the staged TOML
  eagerly, so every referenced variable must be defined even for sections this
  process never consumes.
- **There is no KB volume**, and that absence is the point. It is also enforced:
  the launcher's `gatewayArgs` takes no KB root, so re-adding the mount is a
  signature change, not a line someone can slip in.

Required in the environment: `JWT_SECRET` (≥32 chars) and
`SEMIONT_WORKER_SECRET`. `DATABASE_URL` is optional — set it to override the
value derived from config.

## Boot and shutdown

The container entrypoint runs three steps before the server exists:

1. **Derive `DATABASE_URL`** (`dist/cli/db-url.js`) from the staged config, so
   the password never appears in `container inspect`.
2. **`prisma migrate deploy`** — a separate process, which is why the URL is
   derived outside the server rather than inside it.
3. **`node dist/index.js`** — as PID 1, so it receives `SIGTERM` directly.

Startup then refuses rather than degrades. A missing `services.gateway`, an
absent `JWT_SECRET`, a knowledge base that declares no identity, or a missing
sign-in policy each stop the process before it listens — a gateway that accepts
connections it cannot authenticate is the failure mode these checks exist to
prevent.

`SIGTERM`/`SIGINT` close the listener, stop the job-status subscription, tear
down the bus, and disconnect Postgres before exiting.

## Configuration

One file: `~/.semiontconfig`, bind-mounted read-only by the launcher, which
stages it per service from the knowledge base's own config. The process reads it
with no project root — there is no tree to read from — so everything it needs
arrives in that file, including the launcher-staged `[kb]` identity card
carrying the KB's committed name, `did:web` domain, and sign-in policy.

Secrets are not in the file. They come from the environment.

## HTTP surface

| Router | Serves |
|---|---|
| `root.ts` | Service metadata, OpenAPI spec, Swagger UI |
| `health.ts` | `/api/health` — always 200; liveness, not readiness |
| `auth.ts` | Token issuance and refresh, OAuth and password sign-in |
| `status.ts` | `/api/status` — KB identity, version, branch |
| `admin.ts` | User administration |
| `resources/` | W3C-shaped resource and annotation endpoints; binary upload proxied to the Archivist |
| `bus.ts` | `/bus/emit` and `/bus/subscribe` — the relay |

Emitted payloads are validated against the schema the bus registry binds to each
channel, so an ill-formed event is a 400 at the edge rather than a confused
subscriber downstream.

## Development

```bash
npm run dev            # watch mode
npm run typecheck
npm test               # unit
npm run test:integration   # needs Docker (testcontainers)
npm run prisma:studio  # database GUI
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
