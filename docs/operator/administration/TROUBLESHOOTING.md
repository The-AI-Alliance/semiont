# Troubleshooting

Diagnosing a Semiont stack: reading logs, checking health, and resolving the failures that actually happen.

This guide is written for a stack the launcher runs. On [your own platform](DEPLOYMENT.md#your-own-platform) the failures are the same, and your platform's logs and probes stand in for the launcher's commands.

For protocol-level diagnostics — distributed traces across processes, RED metrics, the `busLog` grep timeline, and trace-correlated log fields — see [Observability](OBSERVABILITY.md). Every structured log line is auto-tagged with `trace_id` and `span_id` when an OTel exporter is configured, so you can filter by those fields to jump from a failing log line to the trace span tree.

## First three commands

Almost every investigation starts here:

```bash
semiont status                     # What is up, and what is healthy
semiont logs                       # Follow the Semiont services
semiont logs --service gateway     # Follow one
```

`semiont status` reports each service's container state (running, exited or absent, across every installed runtime) and the result of [its health probe](../services/OVERVIEW.md#health). To use it as a gate in a script, name what you mean with `--root`, `--repo` or `--service`: those forms exit 0 only when what they name is healthy. The plain report covers every stack on the machine and exits 0 whenever it ran.

`semiont status --verbose` adds the launcher's own paths on this machine (its state, its log, the staged configs, the model cache), and each knowledge base's stores with what each takes on disk. Orphaned state is called out with the `clean` command that removes it.

`semiont logs` follows the Semiont services, each line prefixed with its service. With `--service` it follows any one of [the launcher's names](../services/OVERVIEW.md#the-launchers-names), infrastructure included. Ctrl-C stops the following, not the stack.

Containers run without `--rm`, deliberately: a crashed container stays inspectable and its logs survive. If a service shows as `exited`, its logs are still there.

## Reaching into a container

The launcher has no `exec` verb. Use your container engine; containers are named `semiont-<service>`:

```bash
container exec -it semiont-gateway sh        # or docker exec / podman exec
container ps --all | grep semiont
container inspect semiont-gateway
```

## Common failures

### The stack starts but nothing responds

```bash
semiont status
```

Read which service is unhealthy before anything else. The Browser only serves static files, so a "Browser problem" is usually the gateway or the issuer seen through it.

If the gateway shows `exited`, read its logs — it starts no subprocesses of its own and has no database to reach, so the cause is in the server's own startup. Its `CMD` is the gateway binary and nothing else: no migration step, and nothing that can fail before the process begins.

```bash
semiont logs --service gateway
```

### Gateway container exits immediately

Its startup contract is strict: each unmet requirement stops it before it listens, and the output names what is missing.

| Missing or wrong | What it says |
|---|---|
| `--config`, the document's path (the image passes `/etc/semiont/gateway.json`) | `The gateway's configuration document is not named: start it with --config <path>` |
| The configuration document at that path | `Cannot read the gateway's configuration document at …` — the launcher writes it; check the mount |
| A field of that document | `… is not a gateway configuration document (GatewayConfig):` followed by each failing field by its JSON pointer, e.g. `/identity is missing subjectClaim` |
| `JWT_SECRET`, or a key in it under 32 characters | `JWT_SECRET is not set …` / `JWT_SECRET must be at least 32 characters long …` |
| `SEMIONT_OIDC_CLIENT_ID` / `SEMIONT_OIDC_CLIENT_SECRET` | `… not set — this gateway has no service account …` — see below |
| A broker credential variable the document names (`signal.userEnv`, `signal.passwordEnv`) | `/signal/userEnv names the environment variable …, which is not set` |
| The broker, under `signal.type = "nats"` | `cannot connect to the NATS broker at …`, `The broker is unreachable …`, or `… it must run with JetStream enabled.` |
| Routes and spec in agreement (a build defect, not configuration) | `The gateway's routes are not its spec's operations:` followed by each difference |

See [CONFIGURATION.md](CONFIGURATION.md) for where each of these comes from.

### `semiont start` refuses at the identity preflight

The realm is imported on Keycloak's first boot and never again, so a realm created by an older launcher can lack clients or roles a newer one needs. The preflight refuses rather than start services that cannot authenticate, and names the fix:

```bash
semiont identity sync   # adds missing clients, reconciles roles, redirects, web origins, lifetime; touches no secret or account
semiont start
```

A realm that does not list the Browser's origin refuses the token exchange from it: sign-in fails as `error=Verification` *after* a redirect that worked, because the Browser completes its exchange from its own origin and the realm returns no `Access-Control-Allow-Origin`. The preflight names this, and the same `sync` repairs it. Moving the Browser with `--port` needs a `sync` too, because web origins carry the port.

Needs the bootstrap admin password (`$KC_BOOTSTRAP_ADMIN_PASSWORD`, else the one persisted for this root). If sync reports a named client *already correct* rather than *created*, it exists with a different secret — delete it in the admin console and sync again. Launcher-run realms only; for your own issuer the refusal names the clients to create.

### `semiont useradd` or `semiont identity sync` is refused at the admin login

Both sign in to Keycloak's own admin, in its `master` realm, from this machine. The error carries Keycloak's reason:

- **`Invalid user credentials`** — the bootstrap admin password is not the one the realm's database was created with. Keycloak creates that admin on its first boot only; the launcher persists the password per root, and `$KC_BOOTSTRAP_ADMIN_PASSWORD` overrides it.
- **`HTTPS required`** — the master realm accepts plain HTTP only from an address it counts as private, and some runtimes deliver this machine's connections from one it does not (Docker Desktop does). `semiont start` lets the master realm answer plain HTTP, from inside the Keycloak container, every time it starts one; start the stack again with a current launcher.

### A service never picks up work

Every service authenticates at the knowledge base's issuer as its own service account (client credentials), then exchanges that token at `POST /api/tokens/agent` for one carrying its agent DID. Either leg can fail and leave them idle: the issuer may refuse the grant (wrong or missing `SEMIONT_OIDC_CLIENT_SECRET`, or a realm that never imported the client), or the gateway may refuse the exchange because the token carries no `semiont-service` role in its flat `roles` claim.

```bash
semiont logs --service worker | grep -iE "token|auth|oidc|client"
```

A worker is a special case: its token must also carry the `semiont-worker` role, or it authenticates and is never granted a job. A realm missing that role is repaired the same way.

`semiont start` runs an identity preflight that proves every service account against the realm before starting anything, so a fresh start names the failing client — and [the repair](#semiont-start-refuses-at-the-identity-preflight) — up front.

A service restarted with `semiont start --service worker` reads the same per-root credential the full start wrote, so it rejoins with nothing to recover. One started by hand must be given its own `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET`.

### Jobs stop starting after the signing key changed

Replacing `JWT_SECRET` outright invalidates every agent token at once. A service recovers when its next request is refused, but one that is only listening hears nothing until its token is next renewed, which can take up to the agent token's lifetime.

```bash
semiont logs --service gateway | grep -i "invalid token"
```

`Invalid token signature` confirms it. Stop and start the stack so every service authenticates again, and next time [rotate the key through its ring](AUTHENTICATION.md#rotating-jwt_secret-without-cutting-off-the-sidecars). People are unaffected: their tokens are the issuer's.

### Commands fail, or real-time updates stop

Suspect the broker. If it is down, the gateway keeps serving and **`/api/health` stays 200**, because it does not check the broker. But every emit is refused with 503, and open streams carry no frames.

```bash
container ps --all | grep semiont-nats
semiont logs --service gateway | grep -iE "BROKER-DOWN|BROKER-RECONNECTED"
```

`[signal BROKER-DOWN]` with no later `[signal BROKER-RECONNECTED]` confirms the outage. Until it reconnects, the gateway refuses every emit with 503 rather than accepting frames it could not deliver; open streams stay open and carry frames again once it does. **Nothing restarts the broker for you** — it is a stock third-party image, outside the launcher's process supervision. Bring it back with `semiont start --service messaging` (or start the container directly); the gateway reconnects on its own, no gateway restart. A gateway that has been up since before the broker returned recovers without intervention — the client retries indefinitely by design.

If `semiont status` shows the stack green while emits still fail, the served-health/wedged-bus gap above is why; trust the `BROKER-DOWN` breadcrumb over the health line.

### Database connection failures

```bash
container ps --all | grep semiont-postgres
container exec semiont-postgres pg_isready -U postgres
semiont logs --service database
semiont logs --service identity
```

The only thing that connects to this PostgreSQL is Keycloak, so a database failure shows as people being unable to sign in. A full `semiont start` does not race the database: it waits for PostgreSQL to open its port and to be reachable from inside a container before it starts anything that depends on it, and prints the database's logs if that wait times out. So on a start the launcher manages, "Keycloak came up before the database was ready" is a bug worth reporting, not something to retry.

Two cases where you *are* on your own:

- **`semiont start --service gateway`** restarts one service without re-checking its dependencies. The gateway itself needs no database, but it does need the issuer: restart it while Keycloak is down and it cannot verify a token.
- **A database somebody else runs** (`platform = "external"`) is checked for reachability but never waited on. The launcher does not own its lifecycle.

Semiont keeps no schema of its own here — this PostgreSQL is Keycloak's. See the [Database Guide](DATABASE.md).

### Port already in use

`semiont start` checks the ports every role needs before it starts anything, and refuses rather than half-starting. The ports are in [the service catalog](../services/OVERVIEW.md). To see what holds one:

```bash
lsof -i :4000
```

A stale container from a previous run is the most common squatter — and stopping via the *wrong* runtime is a silent no-op that leaves the real stack running. A bare `semiont stop` sweeps every installed runtime, which is why it is the safe form:

```bash
semiont stop                    # Sweeps every installed runtime
semiont stop --runtime docker   # Only if you mean exactly that one
```

`--port` moves the Browser's port only (with `--service browser`), and `semiont settings keycloak-port` moves Keycloak's.

### Graph or vectors unavailable

Neither is optional at start: the Weaver, the Archivist and the Librarian each connect to the graph when they start, the Smelter, the Archivist and the Librarian each connect to the vector store, and a service that cannot connect exits. When one becomes unavailable under a running stack, writes and reads served from the views continue, and what the lost store answers does not:

- **Graph.** Graph queries fail: search by name or entity type, referenced-by, candidate search for a reference, and the graph neighborhood of a gathered context. The Weaver logs and counts each apply that fails, and catches up at its next start. See [Graph Architecture](../../../packages/graph/docs/ARCHITECTURE.md#when-the-graph-is-behind-or-away).
- **Vectors.** A search that matches nothing by text answers with nothing rather than with similar resources, Match ranks its candidates without semantic similarity, and a context gathered around an annotation comes without `semanticContext`; a context gathered around a resource fails. The Smelter logs each index write that fails, and reconciles the index against the catalog at its next start.

```bash
semiont logs --service graph
curl -s http://localhost:6333/readyz
curl -s http://localhost:7474
```

### Inference failures

With an Anthropic config, the launcher must be able to find `ANTHROPIC_API_KEY`: exported, or registered with `semiont settings secret set ANTHROPIC_API_KEY`. With an Ollama config, the model has to be present:

```bash
curl -s http://localhost:11434/api/version
curl -s http://localhost:11434/api/tags        # Which models are present
semiont logs --service worker | grep -iE "inference|model"
```

### Authentication and sign-in failures

Sign-in happens at the issuer, so a failed sign-in is in its logs, and the gateway is never contacted:

```bash
semiont logs --service identity
```

A request the gateway refuses with 401 is in the gateway's:

```bash
semiont logs --service gateway | grep -iE "401|token"
```

The usual causes of a 401, and what each looks like, are in [Authentication](AUTHENTICATION.md#troubleshooting). Accounts are created with `semiont useradd`.

### "Missing documents" after a restart

Check the event log before concluding data was lost. `.semiont/events/` in the KB's git repo is the system of record; the graph, the vector store, and the materialized views are all projections of it. Untracked event files are not disposable, and deleted ones are recoverable:

```bash
cd /path/to/kb
git status .semiont/events
git log --all -- .semiont/events
git restore --source=<commit> .semiont/events/<file>
```

A projection that disagrees with the event log is a bug in the projection, not missing data. The archivist rebuilds the views from the log every time it starts.

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

Every store survives this by design. To discard them all, which also removes the issuer's accounts and the secrets the launcher kept:

```bash
semiont stop
semiont clean
semiont start
```

Neither touches the event log.

### Restart one service

```bash
semiont start --service gateway
```

`--service` takes exactly one name.

### Capturing state for a bug report

```bash
semiont status --verbose > status.txt
container inspect semiont-gateway > gateway-inspect.json
semiont logs --service gateway > gateway.log 2>&1     # Ctrl-C when you have enough
```

Scrub secrets before attaching any of it: `JWT_SECRET`, `SEMIONT_OIDC_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, and database passwords all live in container environments.

## Dry-run anything

`semiont start --dry-run` prints the exact runtime commands a real run would execute, without executing them. When the question is "what is the launcher actually doing", that is the authoritative answer — better than inferring it from documentation, including this page.

## Related

- [Observability](OBSERVABILITY.md) — traces, metrics, and the `busLog` timeline
- [Database Guide](DATABASE.md) — the PostgreSQL Keycloak uses; Semiont keeps no schema
- [Configuration Guide](CONFIGURATION.md) — where every setting comes from
- [Authentication](AUTHENTICATION.md) — the issuer, tokens and their lifetimes
- [Container Topology](../CONTAINER-TOPOLOGY.md) — which container talks to which
- [Services Overview](../services/OVERVIEW.md) — ports, health probes, dependencies
- [Container Images](IMAGES.md) — versions, tags, attestations
- [Maintenance](MAINTENANCE.md) — routine operations
- [launcher README](../../../apps/launcher/README.md) — every verb and flag
