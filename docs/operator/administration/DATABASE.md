# The database

How the PostgreSQL in a Semiont stack is provisioned and operated.

**Semiont itself stores nothing in it.** The gateway holds no database: it reads every caller's
identity off their token and keeps no row. Resource and annotation data lives in the event log
(`.semiont/events/`), not here. The PostgreSQL in a Semiont stack exists for **Keycloak**, the
identity provider, which owns and manages the only schema in it.

That is the whole shape of this document. If you came here looking for Semiont's tables, there are
none, and there is no ORM, no migration step and no schema of ours to evolve.

## Overview

- **Engine**: PostgreSQL 15 (`postgres:15.18-alpine`, pinned by its digest, as the launcher writes it in the issuer's document)
- **Owner**: Keycloak. It creates and migrates its own schema on first boot.
- **Semiont's schema**: none
- **Why it is here at all**: the issuer's document, which describes the Keycloak the launcher runs
  for every knowledge base here, names a PostgreSQL in its `spec.database`, because Keycloak needs
  somewhere to keep accounts, realms and sessions.

One PostgreSQL serves every knowledge base on the machine, as one Keycloak does: the
`semiont-postgres` container, with its data under `shared/postgres` in the launcher's data home
([the launcher's names](../services/OVERVIEW.md#the-launchers-names)). Keycloak keeps every knowledge
base's realm in the database `spec.database.name` names, `keycloak` as the launcher writes it. The
launcher creates that database when it runs PostgreSQL itself; against an external PostgreSQL it must
already exist, and the launcher says so at start. Renaming it on a store that already holds realms
points Keycloak at an empty database: their accounts stay in the old one.

## Where accounts live

Semiont keeps no user table. Every fact about a caller rides their token, and the gateway holds no
row of its own. What follows from that:

- **Accounts live at the issuer.** Create them with `semiont useradd`, which writes to Keycloak and
  nowhere else. Disable one with `--inactive`, restore it with `--active`.
- **Revocation is disabling at the issuer**, bounded by the access token lifetime. See
  [Authentication](./AUTHENTICATION.md).
- **There is nothing of Semiont's to back up here.** Losing this database loses Keycloak's accounts
  and every knowledge base's realm. It loses no knowledge, and no Semiont state.
- **One knowledge base's accounts go with its realm.** `semiont clean --store identity-store`
  deletes that knowledge base's realm from Keycloak, and leaves the database and every other realm
  in it. With no Keycloak running, the clean runs one for the delete and stops it again.
- **Every account goes with the database.** `semiont clean --shared --store identity-store`
  removes `shared/postgres`, and every realm in it. It is refused while a knowledge base here runs,
  or while the issuer does (`semiont stop --group issuer`). The issuer's passwords stay, so its
  next boot reuses them, and each knowledge base's next start creates its realm afresh.

## Backup and recovery

Keycloak's database is the thing worth dumping, because it holds the accounts people sign in with:

```bash
container exec semiont-postgres pg_dump -U postgres keycloak > keycloak-$(date +%Y%m%d).sql
container exec -i semiont-postgres psql -U postgres keycloak < keycloak-20260101.sql
```

Restoring it restores who can sign in. It restores nothing else, because nothing else is in there.

## Health and monitoring

The gateway's `GET /api/health` reports on no database; it has none. Check PostgreSQL directly,
and check the identity service for whether Keycloak is actually using it:

```bash
container exec semiont-postgres pg_isready -U postgres
semiont logs --service identity-store
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

Usual causes: PostgreSQL is not up yet; its data was initialized with a password the launcher no
longer has ([Secrets](../services/SECRETS.md#values-the-launcher-keeps)); or it is a PostgreSQL
somebody else runs, where the database `spec.database.name` names was never created.

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
- The launcher generates PostgreSQL's password and keeps it; no document names it. See
  [Secrets](../services/SECRETS.md).
- The passwords in here are Keycloak's to hash and hold. Semiont never sees a credential, and the
  gateway has no connection through which it could.

## Related

- [Container Topology](../CONTAINER-TOPOLOGY.md) — where PostgreSQL sits among the containers
- [Authentication](./AUTHENTICATION.md) — how identity works without a Semiont user table
- [Configuration](./CONFIGURATION.md#the-issuers-document) — the issuer's document and its `spec.database`
