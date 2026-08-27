# Semiont Troubleshooting Guide

Diagnosing a Semiont stack: reading logs, checking health, and resolving the failures that actually happen.

This guide covers the **container stack the `semiont` launcher runs**. That is the deployment this repo supports; see [Deployment](DEPLOYMENT.md) for what running the images elsewhere would involve.

For protocol-level diagnostics — distributed traces across processes, RED metrics, the `busLog` grep timeline, and trace-correlated log fields — see [Observability](OBSERVABILITY.md). Every structured log line is auto-tagged with `trace_id` and `span_id` when an OTel exporter is configured, so you can filter by those fields to jump from a failing log line to the trace span tree.

## First three commands

Almost every investigation starts here:

```bash
semiont status                     # What is up, and what is healthy
semiont logs                       # Follow all five Semiont services
semiont logs --service backend     # Follow one
```

`semiont status` reports container state per service (running / exited / absent, across every installed runtime) plus a health probe per role. Every role but `traces` counts toward its exit status, so it works as a script gate.

`semiont status --verbose` adds the launcher's own paths on this host — config, cache, log, state, staging, model cache — plus each root's persistent stack state and its disk consumption. Orphaned state is called out with the `clean` command that removes it.

`semiont logs` follows the five Semiont services as `[svc]`-prefixed streams. With `--service`, it follows any one service including the infrastructure roles: `backend`, `worker`, `smelter`, `weaver`, `browser`, `database`, `graph`, `vectors`, `inference`, `traces`. Ctrl-C stops *following* — it does not stop the stack.

Containers run without `--rm`, deliberately: a crashed container stays inspectable and its logs survive. If a service shows as `exited`, its logs are still there.

## Reaching into a container

The launcher has no `exec` verb. Use your container engine; containers are named `semiont-<service>`:

```bash
container exec -it semiont-backend sh        # or docker exec / podman exec
container ps --all | grep semiont
container inspect semiont-backend
```

The backend image sets `BACKEND_DIR` to the installed package, which prisma commands need:

```bash
container exec semiont-backend sh -c 'cd "$BACKEND_DIR" && npx prisma migrate status'
```

## Common failures

### The stack starts but nothing responds

```bash
semiont status
```

Read which service is unhealthy before anything else. The Browser has no health probe — it is a static file server — so a "Browser problem" is usually a backend problem seen through the browser.

If the backend shows `exited`, the usual cause is that `prisma migrate deploy` failed at startup. The backend's `CMD` runs migrations *before* `exec node`, so a migration failure means the server never started:

```bash
semiont logs --service backend
```

### Backend container exits immediately

Its startup contract is strict, and each unmet requirement throws:

| Missing | Symptom |
|---|---|
| `SEMIONT_ROOT` | `SEMIONT_ROOT environment variable is not set` |
| `services.backend` in the environment config | `services.backend is required in environment config` |
| `NODE_ENV` | `NODE_ENV environment variable is required` (thrown from `/api/health`) |
| `DATABASE_URL` (or the `DB_*` set) | Prisma connection error during `migrate deploy` |
| `JWT_SECRET` under 32 characters | Startup validation failure |
| `SEMIONT_WORKER_SECRET` | Backend starts, but no agent can get a token — see below |

See [CONFIGURATION.md](CONFIGURATION.md) for where each of these comes from.

### Workers, smelter, or weaver never pick up work

These three authenticate by exchanging `SEMIONT_WORKER_SECRET` at `POST /api/tokens/agent` for a JWT carrying a typed Software-agent DID. If the secret does not match the backend's, the exchange fails and they sit idle:

```bash
semiont logs --service worker | grep -iE "token|auth|secret"
```

A service restarted with `semiont start --service worker` rejoins the running stack's worker secret automatically. One started by hand with a stale secret will not.

### A job sits in "Yielding" forever

If `JWT_SECRET` changed between when a token was issued and when it was presented, the backend rejects the token with `Invalid token signature` — the generation job is never created, while the client polls for a result that will never arrive.

```bash
semiont logs --service backend | grep -i "invalid token"
```

Reconnecting the knowledge base gets a fresh token. Rotating `JWT_SECRET` invalidates every token previously issued, so treat a rotation as requiring every client to re-authenticate.

### Database connection failures

```bash
container ps --all | grep semiont-postgres
container exec semiont-postgres pg_isready -U postgres
semiont logs --service database
semiont logs --service backend | grep -iE "prisma|database|connection"
```

A full `semiont start` should not race the database: it waits for PostgreSQL to open its port **and** to be reachable from inside a container before it starts anything that depends on it, and dumps the database's logs if that wait times out (20s). So on a launcher-managed start, "the backend came up before the database was ready" is a bug worth reporting, not a retry.

Two cases where you *are* on your own:

- **`semiont start --service backend`** restarts one service without re-checking its dependencies. If you restart the backend while the database is down, it will fail to migrate.
- **An external database** (`platform = "external"` pointing off-stack) is verified for reachability but never waited on — the launcher does not own its lifecycle.

For schema drift, migration state, and reset procedures, see the [Database Guide](DATABASE.md).

### Port already in use

`semiont start` preflights the ports each role needs and refuses rather than half-starting. The ports in play:

| Port | Role |
|---|---|
| 3000 | browser |
| 4000 | backend |
| 5432 | database (PostgreSQL) |
| 6333 | vectors (Qdrant) |
| 7474, 7687 | graph (Neo4j HTTP, Bolt) |
| 9090, 9091, 9092 | worker, smelter, weaver |
| 11434 | inference (Ollama) |
| 16686, 4318 | traces (Jaeger UI, OTLP) |

```bash
lsof -i :4000
```

A stale container from a previous run is the most common squatter — and stopping via the *wrong* runtime is a silent no-op that leaves the real stack running. A bare `semiont stop` sweeps every installed runtime, which is why it is the safe form:

```bash
semiont stop                    # Sweeps every installed runtime
semiont stop --runtime docker   # Only if you mean exactly that one
```

`--port` moves the browser port only (with `--service browser`); every other port belongs to the KB's config.

### Graph or vectors unavailable

Both degrade rather than fail — core features keep working without them. See [Graph Architecture](../../../packages/graph/docs/ARCHITECTURE.md#graceful-degradation).

```bash
semiont logs --service graph
curl -s http://localhost:6333/readyz
curl -s http://localhost:7474
```

### Inference failures

With an Anthropic config, `ANTHROPIC_API_KEY` must be set in the environment the launcher runs in — the generated config references it as `${ANTHROPIC_API_KEY}`. With an Ollama config, the model has to actually be pulled:

```bash
curl -s http://localhost:11434/api/version
curl -s http://localhost:11434/api/tags        # Which models are present
semiont logs --service worker | grep -iE "inference|model"
```

### Authentication and sign-in failures

```bash
semiont logs --service backend | grep -iE "oauth|auth|jwt"
container exec semiont-backend sh -c 'env | grep -E "^(JWT_SECRET|GOOGLE)" | sed "s/=.*/=<set>/"'
```

Note the `sed` — do not print secret values to a terminal or into a bug report.

Accounts are created with `semiont useradd`; see [AUTHENTICATION.md](AUTHENTICATION.md).

### "Missing documents" after a restart

Check the event log before concluding data was lost. `.semiont/events/` in the KB's git repo is the system of record; the graph, the vector store, and the materialized views are all projections of it. Untracked event files are not disposable, and deleted ones are recoverable:

```bash
cd /path/to/kb
git status .semiont/events
git log --all -- .semiont/events
git restore --source=<commit> .semiont/events/<file>
```

A projection that disagrees with the event log is a bug in the projection, not missing data. Views repopulate from the log whenever their directory is empty at startup.

### An image-version mismatch on start

`semiont start` refuses to bring up a database whose persisted state was written by a different image version, and names `semiont clean` as the way out. That refusal is protecting you from a corrupt store — read it before reaching for the workaround.

```bash
semiont stop
semiont clean --dry-run          # What would go, and how big
semiont clean --store database
semiont start
```

## Emergency procedures

### Full restart

```bash
semiont stop
semiont start
```

Persistent state survives this by design. To also discard PostgreSQL, Qdrant, and Neo4j data:

```bash
semiont stop
semiont clean
semiont start
```

Neither touches the event log.

### Restart one service

```bash
semiont start --service backend
```

`--service` takes exactly one name — there is no `--service all` and no comma list.

### Long-running queries blocking the database

```bash
container exec semiont-postgres psql -U postgres semiont \
  -c "SELECT pid, state, now() - query_start AS duration, query FROM pg_stat_activity WHERE state = 'active';"

container exec semiont-postgres psql -U postgres semiont \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query_start < now() - interval '5 minutes' AND state = 'active';"
```

### Capturing state for a bug report

```bash
semiont status --verbose > status.txt
container inspect semiont-backend > backend-inspect.json
semiont logs --service backend > backend.log 2>&1     # Ctrl-C when you have enough
```

Scrub secrets before attaching any of it: `JWT_SECRET`, `SEMIONT_WORKER_SECRET`, `ANTHROPIC_API_KEY`, and database passwords all live in container environments.

## Dry-run anything

`semiont start --dry-run` prints the exact runtime commands a real run would execute, without executing them. When the question is "what is the launcher actually doing", that is the authoritative answer — better than inferring it from documentation, including this page.

## Related

- [Observability](OBSERVABILITY.md) — traces, metrics, and the `busLog` timeline
- [Database Guide](DATABASE.md) — migrations, schema drift, resets
- [Configuration Guide](CONFIGURATION.md) — where every setting comes from
- [Authentication](AUTHENTICATION.md) — accounts, JWTs, OAuth
- [Container Topology](../CONTAINER-TOPOLOGY.md) — which container talks to which
- [Services Overview](../services/OVERVIEW.md) — ports, health probes, dependencies
- [Container Images](IMAGES.md) — versions, tags, attestations
- [Maintenance](MAINTENANCE.md) — routine operations
- [launcher README](../../../apps/launcher/README.md) — every verb and flag
