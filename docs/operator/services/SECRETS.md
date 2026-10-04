# Secrets

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

**Where they are kept**: in the knowledge base's secrets store. Each knowledge base has one,
and `semiont settings secret-store` names it:

| Store | Set with | Each value is |
|---|---|---|
| Files (the default; development only) | `semiont settings secret-store file` | a file, mode 0600, in the knowledge base's state directory: `~/Library/Application Support/semiont/roots/<key>/<name>` on macOS, `$XDG_DATA_HOME/semiont/roots/<key>/<name>` on Linux (`~/.local/share/…` when that variable is unset) |
| 1Password | `semiont settings secret-store op://<vault>` | a concealed field of one Secure Note per knowledge base, titled `Semiont — <key>`, in the vault you name: `op://<vault>/Semiont — <key>/<name>` |

`<key>` is the knowledge base's state key, derived from its domain, and `<name>` is the "Kept as"
column above.

**The files are not secure; use them for development only.** Each value is plain text. Mode 0600
keeps other accounts out, but anything running as you can read it, and every backup of your home
directory copies it. Wherever the launcher names the file store, it says so. Keep a knowledge
base whose data matters in 1Password. Give 1Password a vault that holds the launcher's items and nothing else. The
desktop app asks once per terminal session to authorize the CLI, for the whole account; to scope
the launcher to that one vault with no prompt, use a 1Password service account limited to it, by
exporting `OP_SERVICE_ACCOUNT_TOKEN`, which the `op` CLI reads itself.

A knowledge base keeps its values in exactly one store. A store that does not answer (1Password
locked and the prompt refused, or `op` not installed) stops the start: the launcher never falls
back to another store, which would generate new values over the ones kept.

**Every store operation is shown.** Each read, write and delete prints a line on stderr before
it runs, naming the operation and the secret, never its value:

```
▸ secrets: read jwt-secret (op://Semiont/Semiont — example.org/jwt-secret)
```

**Finding a value.** `semiont settings secret-store` names the store and where each value is kept
once a start generates it, from the setting alone, without contacting the store. Every start's
summary names the store, and when the launcher runs Neo4j, where its password is kept. A skill or a person connecting to
Neo4j directly reads it there: the file, or `op read "op://<vault>/Semiont — <key>/neo4j-password"`.

**Moving to another store.** Naming a different store moves every kept value: the launcher
copies each one, reads each back, records the new store, and then deletes the values from the
store it leaves. It refuses a store that already holds values for this knowledge base, so two
copies never disagree after a rotation.

```bash
semiont settings secret-store op://Semiont    # from the files into 1Password
semiont settings secret-store                 # which store, and where each value is
semiont settings secret-store file            # back to the files (development only)
```

**A default for new knowledge bases.** To keep every new knowledge base's secrets in 1Password:

```bash
semiont settings secret-store --default op://Semiont
```

A knowledge base adopts the default the first time a start needs a secret for it, if it has no
store of its own yet and keeps nothing in files. Adopting records the default as that knowledge
base's own store, so changing the default later moves nothing. A knowledge base that already keeps
files stays on them until you move it. `init`'s summary names the store a new knowledge base will
use.

The settings are per machine, kept in `secretstores.json` beside `roots.json`: the default, and
each knowledge base's own store. `semiont settings` lists them with the launcher's other settings.

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
  reference one, and `semiont settings secret set` refuses them. A config section for a daemon the
  launcher runs names no password.

**Rotating a daemon's password.** Delete it from the secrets store (its file, or its field in
the 1Password item), then clear the data the daemon initialized with the old one, for example
`semiont clean --store graph`. The next start generates a new password and a fresh data store.

**A store the launcher keeps no password for.** When a daemon's store holds data but the secrets
store keeps no password for it, the data was initialized with a password the launcher does not
have: one a config once named literally, or one that was lost. A daemon started over it would
reject every login, so `semiont start` refuses and names the fix:

```bash
semiont stop
semiont clean --store graph      # Neo4j: a projection, rebuilt from the event log
semiont clean --store database   # PostgreSQL: Keycloak's accounts go with it
semiont start
semiont useradd --email you@example.com --generate-password
```

**Removal.** An unscoped `semiont clean` deletes every kept value from the secrets store, showing
each, and removes the knowledge base's state directory. That is consistent: the accounts and the
stores those values protect are removed with them. `--dry-run` lists the values it would
delete. The store setting stays, so the next start keeps its new values in the same store. A
`--store` clean keeps every value.

A codespace keeps its own values in the file store on the codespace's filesystem, with the same
caveat: the launcher inside it generates them, and nothing is copied from the laptop.

## Values you own

Inference API keys and the like are never stored by the launcher. `semiont settings secret` registers
*where a value comes from*: a `{provider, path}` pointer, machine-wide, in `roots.json`. Every
`semiont start` reads it again by running the provider's own CLI with the terminal attached, so
its authorization prompt works.

```bash
semiont settings secret set ANTHROPIC_API_KEY    # interactive
semiont settings secret set ANTHROPIC_API_KEY op://YourVaultName/Anthropic/credential
semiont settings secret                          # pointers, never values
semiont settings secret rm ANTHROPIC_API_KEY
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
semiont settings secret push ANTHROPIC_API_KEY --repo owner/name
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
- [Authentication](../administration/AUTHENTICATION.md) — what each credential is for
- [Deploying Semiont](../administration/DEPLOYMENT.md#what-your-platform-provides) — delivering secrets on your own platform
