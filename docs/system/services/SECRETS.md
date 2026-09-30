# Secrets Management

Two kinds of secret reach a running stack, and the launcher treats them in opposite ways:

- **Values the launcher keeps.** It generates them once per knowledge base and keeps them,
  because each one must outlive the stack: the token-signing key, the identity provider's
  credentials, and the passwords of the daemons it runs. The Neo4j password is one.
- **Values you own.** The launcher never stores them. It keeps a pointer to where each one
  lives and reads it at every start. An inference API key such as `ANTHROPIC_API_KEY` is one.

Either way, a service receives only the values it reads, and no value ever appears on a
command line.

## Values the launcher keeps

| Value | Variable | Kept as | Used by |
|---|---|---|---|
| Token-signing key | `JWT_SECRET` | `jwt-secret` | the gateway |
| Keycloak's admin password | `KC_BOOTSTRAP_ADMIN_PASSWORD` | `keycloak-admin-password` | Keycloak, `semiont useradd` |
| A service's account secret | `SEMIONT_OIDC_CLIENT_SECRET_<SERVICE>` | `oidc-client-secret-<service>` | that service, and the realm Keycloak imports |
| Neo4j's password | `NEO4J_PASSWORD` | `neo4j-password` | Neo4j, and the services that read `[graph]` |
| PostgreSQL's password | `POSTGRES_PASSWORD` | `postgres-password` | PostgreSQL, and Keycloak's connection to it |
| The broker's password | `NATS_PASSWORD` (user `NATS_USER`, always `semiont`) | `nats-password` | the NATS broker, the dispatcher, and the gateway when its signal plane is the broker |

There is one service account for each stack service: the gateway, archivist, dispatcher,
librarian, smelter, weaver and worker. A daemon's password exists only when the launcher runs
that daemon.

**Where they are kept**: one file per value, mode 0600, in the knowledge base's state directory:
`~/Library/Application Support/semiont/roots/<key>/` on macOS, and
`$XDG_DATA_HOME/semiont/roots/<key>/` on Linux (`~/.local/share/semiont/roots/<key>/` when that
variable is unset). `<key>` is the knowledge base's state key, derived from its domain. A start
that generates a value names the file it wrote, and when the launcher runs Neo4j, the start's
summary names the file its password is kept in: a skill or a person connecting to Neo4j directly
reads it from there.

**Generated once, then kept.** Each value is generated on the first start that needs it and
written to its file before use. Every later start reuses it, because replacing it breaks
something that outlived the stack:
- A new token-signing key invalidates every agent and media token already issued.
- A data directory keeps the password it was initialized with, so a new daemon password
  locks the services out of their own data.
- Keycloak creates its admin, and imports the service accounts, on its first boot.

**What you may set yourself.**
- An exported `JWT_SECRET` wins. It is an ordered ring, `<new>,<old>`, which is how the key
  rotates without cutting off the sidecars. See
  [Authentication](../administration/AUTHENTICATION.md#rotating-jwt_secret-without-cutting-off-the-sidecars).
- An exported `KC_BOOTSTRAP_ADMIN_PASSWORD`, or `SEMIONT_OIDC_CLIENT_SECRET_<SERVICE>`, wins:
  one variable per service, never one shared by all.
- The daemons' names (`NEO4J_PASSWORD`, `POSTGRES_PASSWORD`, `NATS_USER`, `NATS_PASSWORD`) are
  the launcher's. An exported one is refused for a daemon the launcher runs, a config may not
  reference one, and `semiont secret set` refuses them. A config section for a daemon the
  launcher runs names no password.

**Rotating a daemon's password.** Delete its file, then clear the store the daemon initialized
with the old one, for example `semiont clean --store graph`. The next start generates a new
password and a fresh store.

**A store the launcher keeps no password for.** When a daemon's store holds data but its
password file is missing, the store was initialized with a password the launcher does not have:
one a config once named literally, or a file that was lost. A daemon started over it would
reject every login, so `semiont start` refuses and names the fix:

```bash
semiont stop
semiont clean --store graph      # Neo4j: a projection, rebuilt from the event log
semiont clean --store database   # PostgreSQL: Keycloak's accounts go with it
semiont start
semiont useradd --email you@example.com --generate-password
```

**Removal.** An unscoped `semiont clean` removes the knowledge base's state directory, and every
kept value with it. That is consistent: the accounts and the stores those values protect are
removed with them. A `--store` clean keeps them all.

A codespace keeps its own values: the launcher inside it generates them on the codespace's
filesystem, and nothing is copied from the laptop.

## Values you own

Inference API keys and the like are never stored by the launcher. `semiont secret` registers
*where a value comes from*: a `{provider, path}` pointer, machine-wide, in `roots.json`. Every
`semiont start` reads it again by running the provider's own CLI with the terminal attached, so
its authorization prompt works.

```bash
semiont secret set ANTHROPIC_API_KEY                          # interactive
semiont secret set ANTHROPIC_API_KEY op://OSS/Anthropic/credential
semiont secret list                                           # pointers, never values
semiont secret rm ANTHROPIC_API_KEY
```

Exporting the variable yourself always wins, and is the escape hatch on a machine with no secret
manager installed. A name the launcher keeps cannot be registered.

**Providers**: 1Password: `op://<vault>/<item>/<field>`, with the `op` CLI on PATH. The URI
scheme selects the provider from a registry, so an OS keychain or a cloud secrets manager is one
more entry in it.

A start asks only for the variables something reads: a section a service reads, or one the
launcher resolves itself. A reference in another environment, or in a section nothing reads, is
not asked for, and so raises no provider prompt. See
[Configuration](../administration/CONFIGURATION.md) for the rule.

### Codespace stacks

A codespace runs on GitHub's machine and cannot reach your local provider, so the value has to
live there too:

```bash
semiont secret push ANTHROPIC_API_KEY --repo owner/name
```

This resolves the pointer, hands the value to `gh` on stdin (never argv), and *adds* the repo to
the secret's existing selection rather than replacing it. It is the one place the launcher moves
a value instead of pointing at one.

## How values reach services

**Only to the services that read them.** Each service is handed the variables named in the
config sections it reads, as listed in
[specs/src/service-config/sections.json](../../../specs/src/service-config/sections.json). The
Anthropic key in `[inference]` reaches the librarian and the worker, and no other service. They are
the only services that call a model, so they are also the ones that report each model's limits
(context window, output ceiling); the archivist lists the collaborator directory without a key.
A daemon's password reaches the services that connect to that daemon: Neo4j's goes to the
services that read `[graph]` (the archivist, librarian and weaver), and the broker's pair goes to
the dispatcher, which reads `[jobs]`, and to the gateway when its signal plane is the broker.

**Never on a command line.** A container is started with `--env NAME` alone, and the value
travels in the container runtime's own environment. A process listing on the machine shows the
names, never the values. The gateway's configuration document names its credentials by variable
rather than holding them.

## Related Documentation

- [Configuration Guide](../administration/CONFIGURATION.md) — Full configuration reference
- [Authentication](../administration/AUTHENTICATION.md) — JWT and OAuth flow
- [Running Semiont on AWS](../platforms/AWS.md) — unsupported; secrets are your integration
