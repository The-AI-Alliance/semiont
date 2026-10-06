# Configuration

A knowledge base carries its own configuration, in two files, both committed to its repository:

| File | What it holds |
|---|---|
| `.semiont/config` | The knowledge base's identity: its name and its permanent `did:web` domain |
| `.semiont/semiontconfig/<name>.toml` | What the knowledge base needs to run: which inference provider and models, which graph and vector store, which issuer |

Secrets are in neither. They reach services as environment variables: see [Secrets](../services/SECRETS.md).

**A config says what a knowledge base needs, not where things are.** Where each daemon listens is decided by whatever starts the stack, so the same file works on every machine. The one exception is a daemon somebody else runs, which the config says with `platform = "external"`.

## `.semiont/config`

Written by `semiont init`:

```toml
[project]
name = "My Knowledge Base"

[git]
sync = true                # the archivist stages event-log writes with git

[site]
# Permanent did:web identity for everything this KB mints (stamped into the
# committed event log). Names the repo, not a deployment — a committed
# literal, never env-templated, never a machine address.
domain = "example.github.io:my-kb"    # ⇔ did:web:example.github.io:my-kb
siteName = "My Knowledge Base"
```

`[site] domain` is identity, not an address. It names the knowledge base in `did:web`'s colon-path form and never changes, wherever the stack runs. Every service derives from it the knowledge base's DID, the audience its tokens must carry, and the authority its people and agents are named under. It is declared here and nowhere else: `semiont start` and every service refuse an `[environments.<name>.site]` section.

## `.semiont/semiontconfig/<name>.toml`

A knowledge base can have several, usually one per inference provider. `semiont start --list-configs` lists them, `--config <name>` picks one for a start, and `semiont settings config <name>` sets the knowledge base's default.

This is what `semiont init --inference anthropic --embedding ollama:nomic-embed-text` writes, with the model it bound:

```toml
[user]
name = ""
email = ""

[defaults]
environment = "local"

[environments.local.gateway]
platform = "posix"
port = 4000
publicURL = "http://${GATEWAY_HOST:-localhost}:4000"

[environments.local.jobs]
type = "jetstream"

[environments.local.signal]
type = "nats"

[environments.local.graph]
platform = "container"
type = "neo4j"
name = "neo4j"
username = "neo4j"
database = "neo4j"

[environments.local.vectors]
type = "qdrant"

[environments.local.embedding]
type = "ollama"
model = "nomic-embed-text"

[environments.local.embedding.chunking]
chunkSize = 512
overlap = 64

[environments.local.inference.anthropic]
platform = "external"
endpoint = "https://api.anthropic.com"
apiKey = "${ANTHROPIC_API_KEY}"

[environments.local.actors.gatherer.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.actors.matcher.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.workers.default.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.database]
platform = "container"
name = "semiont"
user = "postgres"

[environments.local.identity]
type = "keycloak"
subjectClaim = "sub"
```

No section names a host, and none names a password. The launcher places each daemon it runs, generates each daemon's password and keeps it, and writes the addresses into the copy of the config it gives each service.

### Environments

A file holds one or more named environments under `[environments.<name>]`, and `[defaults] environment` says which one runs. It is required: a config without it, or one naming an environment the file does not define, is refused. To run a different environment, edit that line or add a second file.

### Who runs each daemon

For the graph, the vector store, the database, the broker, the issuer and Ollama, a section's `platform` says who runs the daemon:

- **`platform = "external"`**: somebody else runs it. The section states where it is, and the launcher checks that it answers and starts nothing.
- **Anything else, or no `platform`**: the launcher runs it and places it. The section states no address, and the launcher refuses one that does, because that would be a second answer to who runs the daemon.

```toml
# A Neo4j the launcher runs: no address, no password
[environments.local.graph]
type = "neo4j"
username = "neo4j"
database = "neo4j"

# A Neo4j somebody else runs: where it is, and a password from your own variable
[environments.local.graph]
type = "neo4j"
platform = "external"
uri = "bolt://neo4j.example.com:7687"
username = "neo4j"
password = "${MY_NEO4J_PASSWORD}"
database = "neo4j"
```

An external address must be one the containers can reach. `localhost` inside a container is the container itself.

A section for a daemon the launcher runs may name `image`, to run a different image of the same product.

### Gateway

```toml
[environments.local.gateway]
port = 4000
publicURL = "http://${GATEWAY_HOST:-localhost}:4000"
```

`publicURL` is the address clients reach the gateway at. The launcher sets `${GATEWAY_HOST}` itself. A section spelled `[environments.<env>.backend]` is read as this one; a file with both is refused.

### Inference

Inference has two parts: a provider section holding credentials, and bindings that give each consumer a provider and a model.

```toml
# Providers
[environments.local.inference.anthropic]
platform = "external"
endpoint = "https://api.anthropic.com"
apiKey = "${ANTHROPIC_API_KEY}"

[environments.local.inference.ollama]
platform = "posix"

# Bindings
[environments.local.actors.gatherer.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.actors.matcher.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.workers.default.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

# One worker on a local model
[environments.local.workers.highlight-annotation.inference]
type = "ollama"
model = "gemma3:4b"
```

The two actors that call a model are the `gatherer` and the `matcher`. The workers are `reference-annotation`, `highlight-annotation`, `assessment-annotation`, `comment-annotation`, `tag-annotation` and `generation`. A worker with no binding of its own uses `workers.default`, and a worker with neither does not start. A binding may also set `maxTokens`.

Providers can be mixed: a stronger model for the workers that reason, a lighter or local one for the high-volume ones. Every provider a binding names needs its provider section.

With any binding on Ollama, the launcher uses an Ollama installed on the machine when there is one, runs one in a container when there is not, and pulls the models the bindings name.

### Embedding

Required. Semantic search is always available, so a config with no embedding provider is refused.

```toml
# Ollama, local: no key
[environments.local.embedding]
type = "ollama"
model = "nomic-embed-text"

# Voyage, a remote API: the key from a variable you name
[environments.local.embedding]
type = "voyage"
model = "voyage-3"
apiKey = "${MY_VOYAGE_KEY}"

[environments.local.embedding.chunking]
chunkSize = 512
overlap = 64
```

An Ollama embedding is served by the same Ollama that serves inference. On a config whose inference is all remote, Ollama runs for the embeddings alone.

### Graph and vectors

```toml
[environments.local.graph]
type = "neo4j"
username = "neo4j"
database = "neo4j"

[environments.local.vectors]
type = "qdrant"
```

A vector store is required: a config without `[vectors]` is refused. In a launcher-run stack the graph is Neo4j and the vector store is Qdrant. The packages have other drivers behind the same interfaces, for a stack you deploy yourself: see [Adapting a stack](DEPLOYMENT.md#adapting-a-stack). The in-memory vector store keeps its index inside one process, so no stack with separate services can use it, and the launcher refuses it.

### Job queue and signal plane

```toml
[environments.local.jobs]
type = "jetstream"

[environments.local.signal]
type = "nats"
```

`[jobs]` is required, and `jetstream` is its only driver: the dispatcher's queue is NATS JetStream.

`[signal]` selects how the gateway fans frames out to subscribers. `nats` carries them on the same broker, which also holds the gateway's record of pending replies, so that record survives a restart and is shared by every gateway replica. `in-process`, which is also what an absent section means, keeps both inside one gateway.

One NATS daemon serves both sections. The launcher runs it, with a user and password it generates and keeps. For a broker somebody else runs, both sections say `platform = "external"`, state the same `servers`, and name a `user` and `password`: the launcher refuses an external broker without credentials, because an unauthenticated one lets anyone who reaches it read and write the job queue.

### Identity

```toml
# The Keycloak the launcher runs
[environments.local.identity]
type = "keycloak"
subjectClaim = "sub"

# An issuer you run
[environments.local.identity]
type = "oidc"
issuer = "https://id.example.com/realms/analysts"   # exactly the token's `iss`
subjectClaim = "sub"
```

`type` and `subjectClaim` are required, and `oidc` requires `issuer`. Nothing is defaulted.

- **`subjectClaim`** names the issuer claim a person's DID is built from: `did:web:<site domain>:users:<that claim's value>`. With `"sub"`, people are named by the issuer's stable identifier, so a changed email changes nothing about who authored what. With `"email"`, the address is the identity.
- **There is no `audience` key.** The audience a token must carry is the knowledge base's own resource identifier, derived from its `[site] domain`.
- **`type = "keycloak"`** needs a `[database]` section, because Keycloak keeps its realm in PostgreSQL. It may also set `accessTokenLifespan`, in seconds, and `image`. `semiont settings keycloak-port` moves the port Keycloak is published on.

What an issuer of your own must provide is in [Authentication](AUTHENTICATION.md#at-the-issuer).

### Database

```toml
[environments.local.database]
name = "semiont"
user = "postgres"
```

The PostgreSQL in a stack is Keycloak's, and Semiont stores nothing in it ([Database](DATABASE.md)). With `type = "oidc"` the section is not needed.

## Variables in a config

A value may reference an environment variable as `${NAME}`, or `${NAME:-default}` to supply a default. Use them for secrets and for nothing the launcher places.

- **`semiont start` refuses** when a `${NAME}` that something reads is set neither in your environment nor by a source registered with `semiont settings secret set`. A reference in another environment, or in a section no service reads, is not asked for.
- **A service is handed only the variables in the sections it reads**, as [`sections.json`](../../../specs/src/service-config/sections.json) lists them. The Anthropic key reaches the librarian and the worker and no other service.
- **The launcher's own names cannot be referenced**: `NEO4J_PASSWORD`, `POSTGRES_PASSWORD`, `NATS_USER` and `NATS_PASSWORD` belong to the daemons it runs.

The rule every resolver follows is specified in [`config-placeholders/cases.json`](../../../specs/src/config-placeholders/cases.json).

## Environment variables

The launcher reads a few of its own:

| Variable | Purpose |
|---|---|
| `SEMIONT_ROOT` | The knowledge base to act on, instead of the one found by walking up from the current directory |
| `SEMIONT_VERSION` | The image tag to run. `latest` when unset; `local` runs images built from a checkout and pulls nothing |

What a service reads from its environment is in [Secrets](../services/SECRETS.md), and for the gateway and the dispatcher in [`variables.json`](../../../specs/src/service-environment/variables.json).

## What each service is given

No service reads the files in the repository directly:

- **The librarian, the worker, the smelter and the weaver** each read a TOML file at `/home/semiont/.semiontconfig`. The launcher writes one per service from the selected config, with every address filled in.
- **The gateway, the dispatcher and the archivist** each read a JSON document, at `/etc/semiont/gateway.json`, `/etc/semiont/dispatcher.json` and `/etc/semiont/archivist.json`, that the launcher writes from the config and from `.semiont/config`. Their schemas are [`GatewayConfig`](../../../specs/src/components/schemas/GatewayConfig.json), [`DispatcherConfig`](../../../specs/src/components/schemas/DispatcherConfig.json) and [`ArchivistConfig`](../../../specs/src/components/schemas/ArchivistConfig.json). A document names a credential by the variable that holds it, never by value.

On your own platform, these files are what you deliver ([Deployment](DEPLOYMENT.md#what-your-platform-provides)).

## Finding the knowledge base

The launcher walks up from the current directory looking for `.semiont/`, as `git` finds `.git/`. `SEMIONT_ROOT` overrides that, and so does `--root` on the commands that take it.

## When a config is refused

`semiont start` checks the config before it starts anything, each service checks the sections it reads when it starts, and a refusal names the section, the key and the fix. The common ones:

| It says | Do this |
|---|---|
| A section states an address, and the launcher places every daemon it runs | Delete the address, or add `platform = "external"` if somebody else runs the daemon |
| A section says `platform = "external"` and states no address | Add the address |
| A section names a password for a daemon the launcher runs | Delete it. The launcher generates and keeps that password |
| `[defaults] environment` is missing, or names an environment the file lacks | Set it to an environment the file defines |
| A service finds no inference config for a worker or an actor | Add the binding; `[environments.<env>.workers.default.inference]` covers every worker |
| A `${NAME}` is not set | Export it, or register its source with `semiont settings secret set NAME` |

## Related

- [Secrets](../services/SECRETS.md): which secrets exist and how they reach services
- [Authentication](AUTHENTICATION.md): the issuer, and what `[identity]` selects
- [The service catalog](../services/OVERVIEW.md): the roles a config chooses drivers for
- [Project Layout](../PROJECT-LAYOUT.md): where these files sit in a knowledge base
- [The launcher's README](../../../apps/launcher/README.md): `semiont init`, `settings`, and every flag
