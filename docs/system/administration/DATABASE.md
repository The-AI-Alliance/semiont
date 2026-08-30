# Database Management Guide

How Semiont manages its PostgreSQL database, including schema definition, migrations, and operational procedures.

**PostgreSQL stores user authentication only.** Resource and annotation data lives in the event log (`.semiont/events/`) and its projections — see [Knowledge System](../KNOWLEDGE-SYSTEM.md) and the [event-sourcing package](../../../packages/event-sourcing/). There is no document or annotation table, and none should be added; see [Adding tables](#adding-tables).

## Overview

- **Engine**: PostgreSQL 15 (`postgres:15.18-alpine` when the launcher provisions it)
- **ORM**: [Prisma](https://www.prisma.io/) — [schema](../../../apps/gateway/prisma/schema.prisma)
- **Migrations**: versioned migration files under [`apps/gateway/prisma/migrations/`](../../../apps/gateway/prisma/migrations/), applied with `prisma migrate deploy` when the gateway container starts
- **Connection**: pooled by Prisma Client
- **Scope**: the `users` table, nothing else

In a launcher-managed stack, PostgreSQL runs as the `semiont-postgres` container, and the gateway reaches it over the stack network. See [Container Topology](../CONTAINER-TOPOLOGY.md).

## Schema

The whole schema is one model:

```prisma
model User {
  id              String    @id @default(cuid())
  email           String    @unique
  name            String?
  image           String?   // Profile picture from OAuth provider
  provider        String    // 'password', 'google', 'github', etc.
  providerId      String    // OAuth provider's user ID (or email for password users)
  passwordHash    String?   // bcrypt — NULL for OAuth users, required for password provider
  domain          String    // Email domain for access control
  isActive        Boolean   @default(true)
  isAdmin         Boolean   @default(false)
  isModerator     Boolean   @default(false)
  termsAcceptedAt DateTime?
  lastLogin       DateTime?
  tokenVersion    Int       @default(0) // bumped on logout to revoke this user's tokens
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@unique([provider, providerId])
  @@map("users")
}
```

[`schema.prisma`](../../../apps/gateway/prisma/schema.prisma) is the authority — read it rather than this excerpt when it matters.

## Migrations

The gateway container applies migrations on startup, before the server process starts. From [`apps/gateway/Dockerfile`](../../../apps/gateway/Dockerfile):

```dockerfile
CMD set -e; \
    (cd "$GATEWAY_DIR" && npx prisma migrate deploy --schema=prisma/schema.prisma); \
    exec node "$GATEWAY_DIR/dist/index.js"
```

`migrate deploy` applies any migration in `prisma/migrations/` that the database has not recorded yet. It never generates migrations and never resets data. If it fails, the container exits — the server does not start against a database whose schema it does not match.

Because migrations ship inside the image, **the image version determines the schema version**. Upgrading a stack to a newer `SEMIONT_VERSION` is what applies new migrations.

### Adding a migration

Migrations are authored against a database, from `apps/gateway/`:

```bash
npx prisma migrate dev --name add_something
```

This writes a new timestamped directory under `prisma/migrations/`, applies it locally, and regenerates the client. Commit the migration directory — it is part of the source, and CI and the published image both depend on it.

## Operating on the database

The `semiont` launcher has no `exec` verb. Reach into a running container with your container engine directly. Containers are named `semiont-<service>`:

```bash
container exec -it semiont-gateway sh     # or: docker exec -it semiont-gateway sh
container exec -it semiont-postgres psql -U postgres semiont
```

Prisma lives inside the gateway package, so prisma commands need its directory. `GATEWAY_DIR` is set in the image:

```bash
# Confirm the gateway can reach the database and see the expected schema
container exec semiont-gateway sh -c 'cd "$GATEWAY_DIR" && npx prisma db pull --print'

# Migration state: which migrations are applied, which are pending
container exec semiont-gateway sh -c 'cd "$GATEWAY_DIR" && npx prisma migrate status'

# The schema the image shipped with
container exec semiont-gateway sh -c 'cat "$GATEWAY_DIR/prisma/schema.prisma"'
```

### Prisma Studio

Studio is a browser UI over the database. Run it from the host against the stack's PostgreSQL rather than from inside the container — the port is already exposed and you avoid a second port mapping:

```bash
cd apps/gateway
DATABASE_URL="postgresql://postgres:localpass@localhost:5432/semiont" npx prisma studio
```

Those are the values `semiont init` generates into the KB's
`.semiont/semiontconfig/<name>.toml` under
`[environments.local.database]` (`name`, `user`, `password`, `port`). Read that
block rather than assuming them — they are configurable, and a stack pointed at an
external PostgreSQL will differ.

### Resetting

`semiont clean` removes the stack's persistent state — PostgreSQL, Qdrant, and Neo4j volumes — so the next `semiont start` comes up with an empty database and re-applies every migration. This deletes all users. It does **not** touch the event log, which lives in the KB's git repo.

```bash
semiont stop
semiont clean                      # every store
semiont clean --store database     # PostgreSQL only, leaving graph and vectors
semiont clean --dry-run            # what would go, and how big
semiont start
```

The stack must be stopped first — `clean` refuses to remove state a recorded
stack may still be mounting.

Prefer this to `prisma db push --force-reset`: it resets the whole stack consistently, rather than leaving the graph and vector stores holding state for users that no longer exist.

## Schema evolution

### Adding tables

PostgreSQL holds authentication only. Resources, annotations, and their relationships belong in the event log — adding them here would create a second system of record that the event log cannot reconcile with. See [the event log is the system of record](../KNOWLEDGE-SYSTEM.md).

Authentication-adjacent tables are legitimate. An audit log of sign-in events, for example:

```prisma
model AuditLog {
  id        String   @id @default(cuid())
  userId    String
  action    String   // 'login', 'logout', 'password_reset', etc.
  ipAddress String?
  userAgent String?
  user      User     @relation(fields: [userId], references: [id])
  createdAt DateTime @default(now())

  @@map("audit_logs")
}

model User {
  // ... existing fields
  auditLogs AuditLog[]
}
```

Then generate the migration (`npx prisma migrate dev --name add_audit_log`), commit it, and rebuild the gateway image.

### Modifying existing tables

`migrate deploy` applies whatever the migration says, including destructive changes — the safety lives in review of the generated SQL, not in the deploy step. When `prisma migrate dev` generates a migration that would drop data, it says so; read the SQL it produced before committing.

Adding a required column to a populated table needs the usual two-step: add it nullable with a backfill, then tighten it in a second migration.

### Verifying a migration applied

```bash
semiont logs --service gateway | grep -i migrat
container exec semiont-gateway sh -c 'cd "$GATEWAY_DIR" && npx prisma migrate status'
```

## Backup and recovery

The database holds user accounts. The knowledge itself — every resource, annotation, and reference — is in the KB's git repo, so backing up the database is not backing up the knowledge base. See [BACKUP.md](BACKUP.md) for the event log and content.

To dump and restore the user table:

```bash
container exec semiont-postgres pg_dump -U postgres semiont > users-$(date +%Y%m%d).sql
container exec -i semiont-postgres psql -U postgres semiont < users-20260101.sql
```

Losing the database loses user accounts and their credentials; it does not lose knowledge. Recreate accounts with `semiont useradd`.

## Health and monitoring

The gateway reports database reachability at `GET /api/health`:

```bash
curl -s http://localhost:4000/api/health
```

`database` is `connected` or `disconnected`, from a `SELECT 1` in `DatabaseConnection.checkHealth()` ([`apps/gateway/src/db.ts`](../../../apps/gateway/src/db.ts)). `semiont status` surfaces the same check per service.

For query-level inspection:

```bash
# Active connections and long-running queries
container exec semiont-postgres psql -U postgres semiont \
  -c "SELECT pid, state, now() - query_start AS duration, query FROM pg_stat_activity WHERE state = 'active';"

# Database-related gateway logs
semiont logs --service gateway | grep -iE "prisma|database|connection"
```

## Troubleshooting

### The gateway container exits at startup

`migrate deploy` failed, so the server never started. The reason is in the logs:

```bash
semiont logs --service gateway
```

Usual causes: PostgreSQL not up yet (the launcher orders startup, but a slow first boot can still race), wrong credentials, or a migration that conflicts with the database's recorded history.

### Connection refused / timeouts

```bash
container ps --all | grep semiont-postgres
container exec semiont-postgres pg_isready -U postgres
semiont logs --service database
```

### Schema drift

A database changed outside migrations no longer matches the schema the image ships:

```bash
container exec semiont-gateway sh -c 'cd "$GATEWAY_DIR" && npx prisma migrate status'
container exec semiont-gateway sh -c 'cd "$GATEWAY_DIR" && npx prisma db pull --print'
```

Reconcile by writing a migration that captures the intended state. If the database is disposable, `semiont clean` and start fresh.

### Long-running queries blocking work

```bash
container exec semiont-postgres psql -U postgres semiont \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query_start < now() - interval '5 minutes' AND state = 'active';"
```

## Security

- The database is not published outside the stack network except for the port the launcher maps for local development.
- Credentials come from configuration, never from the image; see [CONFIGURATION.md](CONFIGURATION.md) and [SECRETS.md](../services/SECRETS.md).
- Passwords are bcrypt hashes in `passwordHash`; OAuth users have none.
- `tokenVersion` is bumped on logout, which revokes every token previously issued to that user.

## Related

- [Container Topology](../CONTAINER-TOPOLOGY.md) — where PostgreSQL sits among the containers
- [CONFIGURATION.md](CONFIGURATION.md) — how the gateway is told where the database is
- [SECRETS.md](../services/SECRETS.md) — credential handling
- [BACKUP.md](BACKUP.md) — backing up the knowledge, which is not in PostgreSQL
- [Knowledge System](../KNOWLEDGE-SYSTEM.md) — where resource and annotation data actually lives
