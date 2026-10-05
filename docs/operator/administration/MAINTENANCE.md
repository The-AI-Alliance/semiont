# Maintenance

Routine care of a running stack. For diagnosing a failure, see [Troubleshooting](TROUBLESHOOTING.md).

A stack the launcher runs has no scheduled chores. What needs attention:

| Concern | When | Why |
|---|---|---|
| [The event log](#the-event-log-is-the-thing-to-protect) | Continuously | It is the system of record |
| [Upgrades](#upgrading-a-stack) | When a version ships | New images; Semiont has no schema to migrate |
| [Secret rotation](#secret-rotation) | On compromise, or by policy | Rotating a secret invalidates what it signed |
| [Disk](#persistent-state-and-disk) | Occasionally | Stores grow, and orphaned ones accumulate |
| [Logs](#log-review) | On a symptom | |

## The event log is the thing to protect

`.semiont/events/` in the knowledge base's working tree, with the content beside it, is the system of record. The graph, the vector store and the views are derived from it, and none of them is worth backing up.

So most of maintenance is git discipline:

```bash
cd /path/to/kb
git status .semiont/events        # uncommitted events are unprotected
git add .semiont/events && git commit -m "events"
git push
```

With `[git] sync = true` in `.semiont/config`, the archivist stages each event-log write as it makes it; committing and pushing are yours. Once committed, git's object hashes make tampering evident. Untracked event files are not disposable. If events seem to be missing, check git history before concluding anything was lost ([Troubleshooting](TROUBLESHOOTING.md#missing-documents-after-a-restart)).

To copy a whole knowledge base out, or bring one back, see [Backup](BACKUP.md). The stack's PostgreSQL holds the issuer's accounts and nothing of the knowledge base: back it up separately ([Database](DATABASE.md)).

## Upgrading a stack

There is no schema migration: the gateway holds no database, and Keycloak manages its own schema. Upgrading is stopping and starting on newer images:

```bash
semiont stop
semiont start                             # pulls the current images
SEMIONT_VERSION=<version> semiont start   # or a version you name
```

Upgrade the launcher as well (`brew upgrade semiont`): the launcher and the images share one version.

Then watch the stack come up:

```bash
semiont status
semiont logs --service gateway
```

Two things a start may do on an upgrade:

- **Clear and rebuild a derived store.** When the image behind the graph, the vectors, the views or the anchored text has changed, the launcher says it is clearing that store, and the service that owns it rebuilds it from the event log.
- **Refuse over the database.** PostgreSQL's data is never cleared for you. If a config names a different database image than the one that wrote the data, the start refuses and names the fix ([Troubleshooting](TROUBLESHOOTING.md#an-image-version-mismatch-on-start)).

If the start refuses at the identity preflight, the realm was created by an older launcher: `semiont identity sync` brings it up to date ([Troubleshooting](TROUBLESHOOTING.md#semiont-start-refuses-at-the-identity-preflight)).

## Secret rotation

[Secrets](../services/SECRETS.md) lists every secret a stack has and where each is kept. Rotating one is never free:

**The token-signing key (`JWT_SECRET`)** signs the tokens the gateway mints for software agents and for media, and nothing else. People's tokens are the issuer's and are unaffected. Rotate it through its ring, new key first and old key behind it, so tokens already issued keep verifying until they expire: [Rotating `JWT_SECRET`](AUTHENTICATION.md#rotating-jwt_secret-without-cutting-off-the-sidecars). Replacing it outright invalidates every agent and media token at once. Each key is at least 32 characters, and the gateway refuses to start on a shorter one.

**A service account's secret (`SEMIONT_OIDC_CLIENT_SECRET_<SERVICE>`)** is that service's own credential at the issuer. Each service has its own, so rotating one means changing it at the issuer and in the knowledge base's secrets store, then restarting that one service.

**A daemon's password** (Neo4j, PostgreSQL, the broker) is tied to the data it initialized. Rotating one means deleting it from the secrets store and clearing that daemon's store: [Rotating a daemon's password](../services/SECRETS.md#values-the-launcher-keeps).

**A provider's API key** (`ANTHROPIC_API_KEY` and the like) is yours. Change it where it lives, and restart the services that use it: the librarian and the worker.

Cutting off one person is not a rotation. Disable their account at the issuer. That stops new tokens and the refresh grant at once, and the access token they hold works until it expires. There is no session to invalidate at the gateway, which stores nothing about a caller.

## Persistent state and disk

`semiont stop` leaves every store in place so the next start reuses it. Over time, and across knowledge bases, that adds up:

```bash
semiont status --verbose      # each knowledge base's stores, and what each takes on disk
```

The report calls out orphaned state, whose knowledge base's directory no longer exists, with the command that removes it. `semiont clean` is the only command that deletes a store. It needs the stack stopped, and it never touches the knowledge base's own directory:

```bash
semiont clean --dry-run              # what would go, and how big
semiont clean --store vectors        # one store: database, graph, vectors,
                                     #   anchored-text, messaging or state
semiont clean --root <path|name|key> # another knowledge base's, including an orphan's
```

An unscoped `semiont clean` also deletes the secrets the launcher kept for the knowledge base. Clearing `database` removes the issuer's accounts with it, and clearing `messaging` drops the jobs that were waiting.

The Ollama model cache is separate, and can be large:

```bash
semiont start --clean-ollama         # remove the model cache and exit
```

### Rebuilding derived state

Views, the graph and the vectors are derived from the event log, and each recovers on its own when its service starts: see [where a knowledge base lives on disk](../../architecture/FILESYSTEM.md#rebuilding-what-is-derived). The archivist rebuilds every view at startup, so restarting it is the rebuild:

```bash
semiont start --service archivist
```

To force a store to be rebuilt from nothing, clear it and start again:

```bash
semiont stop
semiont clean --store graph
semiont start
```

## Log review

Services write structured JSON to their output. The container runtime holds it, and a crashed service's container is kept so its log survives:

```bash
semiont logs                                    # the Semiont services
semiont logs --service gateway | grep -i error
```

Review on a symptom, not on a schedule. When something is wrong, [Troubleshooting](TROUBLESHOOTING.md) starts from `semiont status`. For traces and metrics, and for following a log line to its trace, see [Observability](OBSERVABILITY.md).

## Related

- [Troubleshooting](TROUBLESHOOTING.md): diagnosing a failure
- [Backup](BACKUP.md): exporting a knowledge base and restoring it
- [Secrets](../services/SECRETS.md): every secret, and where it is kept
- [Container Images](IMAGES.md): versions and tags
- [Scaling](SCALING.md): which services replicate
