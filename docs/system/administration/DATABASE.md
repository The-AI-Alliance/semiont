# Database Management Guide

How Semiont's PostgreSQL is provisioned and operated.

**Semiont itself stores nothing in it.** The gateway holds no database: it reads every caller's
identity off their token and keeps no row. Resource and annotation data lives in the event log
(`.semiont/events/`), not here. The PostgreSQL in a Semiont stack exists for **Keycloak**, the
identity provider, which owns and manages the only schema in it.

That is the whole shape of this document. If you came here looking for Semiont's tables, there are
none, and there is no ORM, no migration step and no schema of ours to evolve.

## Overview

- **Engine**: PostgreSQL 15 (`postgres:15.18-alpine` when the launcher provisions it)
- **Owner**: Keycloak. It creates and migrates its own schema on first boot.
- **Semiont's schema**: none
- **Why it is here at all**: `type = "keycloak"` in `[identity]` requires a `[database]` section,
  because Keycloak needs somewhere to keep accounts, realms and sessions.

In a launcher-managed stack, PostgreSQL runs as the `semiont-postgres` container and Keycloak
reaches it over the stack network. The launcher creates the `keycloak` database there when it runs
PostgreSQL itself; against an external PostgreSQL that database must already exist, and the launcher
says so at start.

## What happened to the users table

Semiont kept a `users` table until 2026-09-18. It held roles, a display name, and a join key to the
identity that authenticated. Every row of it was either a fact the token already carried or a flag
no route read, so it was dropped along with Prisma and the gateway's PostgreSQL dependency.

The consequences worth knowing:

- **Accounts live at the issuer.** Create them with `semiont useradd`, which writes to Keycloak and
  nowhere else. Disable one with `--inactive`, restore it with `--active`.
- **Revocation is disabling at the issuer**, bounded by the access token lifetime. See
  [Authentication](./AUTHENTICATION.md).
- **There is nothing of Semiont's to back up here.** Losing this database loses Keycloak's accounts
  and realm configuration. It loses no knowledge, and no Semiont state.

## Backup and recovery

Keycloak's database is the thing worth dumping, because it holds the accounts people sign in with:

```bash
container exec semiont-postgres pg_dump -U postgres keycloak > keycloak-$(date +%Y%m%d).sql
container exec -i semiont-postgres psql -U postgres keycloak < keycloak-20260101.sql
```

Restoring it restores who can sign in. It restores nothing else, because nothing else is in there.

## Health and monitoring

The gateway's `GET /api/health` no longer reports on a database, because it has none to report on.
Check PostgreSQL directly, and check the identity service for whether Keycloak is actually using it:

```bash
container exec semiont-postgres pg_isready -U postgres
semiont logs --service database
semiont logs --service identity
```

For query-level inspection:

```bash
container exec semiont-postgres psql -U postgres keycloak \
  -c "SELECT pid, state, now() - query_start AS duration, query FROM pg_stat_activity WHERE state = 'active';"
```

## Troubleshooting

### The identity container exits at startup

Keycloak could not reach PostgreSQL or could not find its database. The reason is in the logs:

```bash
semiont logs --service identity
```

Usual causes: PostgreSQL not up yet, wrong credentials in `[database]`, or an external PostgreSQL
where the `keycloak` database was never created.

### Connection refused or timeouts

```bash
container ps --all | grep semiont-postgres
container exec semiont-postgres pg_isready -U postgres
```

### The gateway is healthy but nobody can sign in

That is an identity problem, not a database one. The gateway does not talk to PostgreSQL, so it will
report itself healthy whatever state the database is in. Start at
[Authentication](./AUTHENTICATION.md).

## Security

- The database is not published outside the stack network except for the port the launcher maps for
  local development.
- Credentials come from configuration, never from the image; see
  [CONFIGURATION.md](CONFIGURATION.md) and [SECRETS.md](../services/SECRETS.md).
- The passwords in here are Keycloak's to hash and hold. Semiont never sees a credential, and the
  gateway has no connection through which it could.

## Related

- [Container Topology](../CONTAINER-TOPOLOGY.md) — where PostgreSQL sits among the containers
- [Authentication](./AUTHENTICATION.md) — how identity works without a Semiont user table
- [Configuration](./CONFIGURATION.md) — the `[database]` and `[identity]` sections
