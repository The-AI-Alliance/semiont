# Configuration

A knowledge base carries what it needs to run in its own repository, as YAML committed under `.semiont/`:

| File | What it holds | Schema |
|---|---|---|
| `.semiont/config.yaml` | The project file: the knowledge base's name, whether git stages its changes, and its permanent `did:web` identity | [`ProjectConfig`](../../../specs/src/kb-identity/ProjectConfig.json) |
| `.semiont/stack/knowledge-base.yaml` | The gateway, the dispatcher, the archivist, the broker between them, and the issuer the knowledge base trusts | [`KnowledgeBase`](../../../specs/src/stack/KnowledgeBase.json) |
| `.semiont/stack/index.yaml` | The graph, the vector store, the embedding model, and the librarian, the smelter and the weaver | [`KnowledgeIndex`](../../../specs/src/stack/KnowledgeIndex.json) |
| `.semiont/stack/issuer.yaml` | The Keycloak the launcher runs, and the PostgreSQL it keeps its realm in | [`Issuer`](../../../specs/src/stack/Issuer.json) |
| `.semiont/stack/inference/<name>.yaml` | The inference providers, and which provider and model serve each role | [`Inference`](../../../specs/src/stack/Inference.json) |

The launcher reads them and writes each service a JSON document ([What each service is given](#what-each-service-is-given)). No service reads a stack document; the Archivist, which mounts the repository, reads `.semiont/config.yaml` from it.

`semiont init` writes all of them for a new knowledge base. The launcher's fixture, [`packages/go/launcher/testdata/kb/.semiont/`](../../../packages/go/launcher/testdata/kb/.semiont/), is a complete set in which every document holds to its schema.

Secrets are in none of them. A document names a secret by the environment variable that holds it ([Secrets in a document](#secrets-in-a-document)).

**A document says what a knowledge base needs, not where things are.** Where each daemon listens is decided by whatever starts the stack, so the same documents work on every machine. The one exception is a daemon somebody else runs, which a document states at `external`.

## `.semiont/config.yaml`

Written by `semiont init`:

```yaml
project:
  name: "My Knowledge Base"

git:
  sync: true

site:
  domain: "example.github.io:my-kb"
  siteName: "My Knowledge Base"
```

Its schema is [`ProjectConfig`](../../../specs/src/kb-identity/ProjectConfig.json). A command run in a knowledge base whose `config.yaml` does not hold to it stops there, naming each place by its line (`status` and `roots` show the refusal instead), and the Archivist does not start on one.

`git.sync: true` has the Archivist stage each change it makes in git; committing and pushing are yours. `semiont init --no-git` writes `false`.

`site.domain` is identity, not an address. It names the knowledge base in `did:web`'s colon-path form and never changes, wherever the stack runs. Every service derives from it the knowledge base's DID, the audience its tokens must carry, and the authority its people and agents are named under. It is declared here and nowhere else.

A knowledge base with no `config.yaml` is named by its directory and has no identity, so no stack runs on it: `semiont start` cannot write the gateway's document without a `site.domain`, and the Archivist refuses to start without one.

## `.semiont/stack/`

Each file is one document in Kubernetes' resource format: `apiVersion` (always `semiont.the-ai-alliance.github.io/v1alpha1`), `kind`, `metadata.name` and `spec`. This is the fixture's `knowledge-base.yaml`:

```yaml
apiVersion: semiont.the-ai-alliance.github.io/v1alpha1
kind: KnowledgeBase
metadata:
  name: knowledge-base
spec:
  logLevel: info
  gateway:
    image: ghcr.io/the-ai-alliance/semiont-gateway:latest
    resources: { limits: { memory: 2G } }
    port: 4000
    publicURL: http://localhost:4000
  dispatcher:
    image: ghcr.io/the-ai-alliance/semiont-dispatcher:latest
    resources: { limits: { memory: 2G } }
  archivist:
    image: ghcr.io/the-ai-alliance/semiont-archivist:latest
    resources: { limits: { memory: 2G } }
  messaging:
    jobs: { type: jetstream }
    signal: { type: in-process }
    image: nats:<version>-alpine@sha256:<digest>   # the broker release the launcher pins
    resources: { limits: { memory: 512M } }
  issuer:
    ref: issuer
    subjectClaim: sub
```

The documents name one another by `metadata.name`: the KnowledgeIndex names the KnowledgeBase in `spec.knowledgeBase`, and the KnowledgeBase names its Issuer in `spec.issuer.ref`. A document's `spec.logLevel` is the log level of the services it describes; `semiont init` writes `info`. `semiont start` holds every document to its schema before it starts anything, and refuses one that does not hold, naming the file and each place by its line. The schemas, and the objects the kinds share, are listed in [`specs/src/stack/`](../../../specs/src/stack/README.md).

### Who runs each daemon

The graph, the vector store, the broker and the issuer's PostgreSQL are each one of two things:

- **`image` and `resources`**: the launcher runs it and places it, and generates and keeps its password. The document states no address and no password.
- **`external`**: somebody else runs it. The document states where it is and, where it takes one, names the variable that holds its credential, and the launcher checks that it answers and starts nothing.

Never both, and never neither: [`Runner.json`](../../../specs/src/stack/Runner.json) is the rule each of them is held to, and each one's schema says what its `external` holds. An external address must be one the containers can reach; `localhost` inside a container is the container itself.

The issuer is chosen the same way, one level up: the KnowledgeBase names an Issuer document the launcher runs, or states an issuer somebody else runs ([The issuer](#the-issuer)).

### Images

Every container the launcher runs from a document runs the `image` that document names, as a registry names it. `semiont init` writes `ghcr.io/the-ai-alliance/semiont-<service>:latest` for each of Semiont's services, and for each daemon a release pinned by its digest, `name:tag@sha256:<digest>`: the tag says which release, and the digest names its exact bytes, which a tag moved later cannot change. Every start pulls the images of Semiont's services, so a moving tag such as `latest` brings the newest; to run another version, name it in the document.

An image of Semiont's runs only when a release built it: `semiont start` verifies its build provenance first, and runs it by its digest ([What `semiont start` checks](IMAGES.md#what-semiont-start-checks)).

An image tagged `:local` is never pulled: it is one [`scripts/ci/local-build.sh`](../../../scripts/ci/local-build.sh) built on this machine, and a knowledge base runs it by naming it ([Local Development](../../contributor/LOCAL-DEVELOPMENT.md)). No release built it, so it runs unverified, and every start says so.

The Browser's image is named by its own document ([The Browser](#the-browser)). The images of Ollama and the telemetry containers are the launcher's own.

### Memory

Each container a document describes is given the memory ceiling its `resources.limits.memory` states, a whole number of gigabytes or megabytes (`2G`, `512M`). `semiont init` writes 2G for each of Semiont's services. The Browser's is its document's; the ceilings of Ollama and the telemetry containers are the launcher's own, and `--dry-run` shows the ceiling each container is given.

Two services size themselves by theirs. The gateway takes half of its memory for what it holds queued to its streams, and the rest for connections. The smelter works on as many PDFs at once as the KnowledgeIndex's `spec.smelter.pdfsAtOnce` says. Deriving a scanned document's text holds a page in pixels and an OCR process, and 2G holds one, so `semiont init` writes one for each 2G of the smelter's ceiling. A knowledge base of large scans is derived sooner with a larger ceiling and a larger number; more PDFs at once than the ceiling holds at 2G each is a smelter that can run out of memory.

### Inference

An Inference document says which engines a knowledge base uses: in `spec.providers`, the providers a machine reaches, and in `spec.engines`, the engine (a provider and a model) each job and each librarian actor is done with. A knowledge base can hold several, usually one per provider, and each machine chooses one:

```bash
semiont start --list-configs        # the Inference documents this knowledge base holds
semiont start --config anthropic    # start on .semiont/stack/inference/anthropic.yaml
semiont settings config anthropic   # make it this knowledge base's choice on this machine
```

A start with no `--config` runs the choice recorded for the knowledge base: the one `semiont init` wrote, or the one a successful start last named, else `ollama-gemma`. A document's `metadata.name` is its file's name, and a start refuses one that differs.

Each job and each actor has its engine stated by itself, keyed as a job is described ([`ArchivistEngines`](../../../specs/src/components/schemas/ArchivistEngines.json)): a `mark` job by its motivation, under `spec.engines.jobs.mark`, a `yield` job at `spec.engines.jobs.yield`, and the librarian's two actors that call a model, the `gatherer` and the `matcher`, under `spec.engines.actors`. Nothing stands in for an engine the document leaves out: a job with none is done by no software worker, and the librarian does not start without both actors' engines. An engine is how software does a job; a person who holds the worker role claims jobs from the same queue and uses none. `semiont init` gives every job and actor the one model chosen; anything finer is your edit, and providers can be mixed: a stronger model for the jobs that reason, a lighter or local one for the high-volume ones.

The shared worker serves a knowledge base only when one of its jobs has an engine ([The worker](#the-worker)). With no job's engine stated, a start takes the knowledge base off the worker's list and says so.

An engine's `provider` is one of seven, and each one an engine names needs its entry in `spec.providers`, which says how it is reached ([`Provider`](../../../specs/src/stack/Provider.json)):

- **`anthropic`** is Anthropic's API, reached at its own address unless the entry states a `baseURL`. Its `apiKey` names the variable holding your key.
- **`ollama`** with no `baseURL` is the shared Ollama: the launcher uses an Ollama installed on the computer when there is one, runs one in a container when there is not, and pulls the models its engines name. With a `baseURL`, it is an Ollama somebody else runs.
- **`openai`**, **`google`** and **`together`** are those companies' APIs, and **`vllm`** and **`llamacpp`** are servers you run or reach. Each states a `baseURL`, the address the provider's own documentation gives for its API, and the `apiKey` it takes; the launcher keeps no address for any of them, and refuses an entry with none, naming it. `semiont init` writes `anthropic` or `ollama`; these five are added by hand.

OpenAI's, Google's and Together's APIs do not say what a model can take: its window, whether it holds a reply to a schema, how its reasoning is set. A model of one of them is asked with what a model catalogue says of it. The worker's image and the Librarian's each carry the catalogue, a copy of [models.dev](https://models.dev) made when the release was cut, and a service whose model the catalogue does not list refuses to start and names the model. A model newer than the release is one it does not list.

**None of these five has been run against its real provider.** Each is tested against a stand-in that plays the provider's API as its documentation describes it.

### Embedding

The KnowledgeIndex's `spec.embedding` is the model that turns text into vectors, and it is required: semantic search is always available. Its `type` is `ollama`, served by the shared Ollama unless it states an `endpoint`, or `voyage`, with an `apiKey`. The shared Ollama is one process whoever asks for it: it serves inference too when the Inference document's `ollama` entry states no `baseURL`, and runs for the embeddings alone when inference is remote or somebody else's.

The embedding's `type` and `model` and the two chunking numbers are what the vector index is made by, and the index states them. Change any of the four and the smelter, when it next starts, clears the index and indexes every resource and every annotation again: its log says so, as a warning. That embeds every chunk of the knowledge base again, which with a remote provider is a cost, and derives the text of every PDF that has none stored, a few PDFs at a time ([Memory](#memory)): a knowledge base of large scanned documents takes a while, and its log says each one as it is done, with how much memory the smelter then holds (`residentBytes`). Where the model is served (`endpoint`) is no part of it.

### Graph and vectors

In a launcher-run stack the graph is Neo4j and the vector store is Qdrant. The packages have other drivers behind the same interfaces, for a stack you deploy yourself: see [Adapting a stack](DEPLOYMENT.md#adapting-a-stack). The in-memory vector store keeps its index inside one process, so no stack with separate services can use it, and the launcher refuses it.

### Job queue and signal plane

The KnowledgeBase's `spec.messaging` is the broker. `jobs.type` is `jetstream`, its only driver: the dispatcher's queue is NATS JetStream. `signal.type` selects how the gateway fans frames out to subscribers. `nats`, which `semiont init` writes, carries them on the same broker, which also holds the gateway's record of pending replies, so that record survives a restart and is shared by every gateway replica. `in-process` keeps both inside one gateway.

One NATS daemon serves both. The launcher runs it from `image`, with a user and password it generates and keeps. A broker somebody else runs is stated at `spec.messaging.external`, with its `servers` and the variables holding its user and password: the schema requires the credentials, because an unauthenticated broker lets anyone who reaches it read and write the job queue. Such a broker also needs `max_payload: 8388608` in its own config, as the launcher's has: a frame on the bus can be as large as the largest emit the gateway takes, 4 MiB, and the broker's default of 1 MiB refuses one larger than that.

### The issuer

The KnowledgeBase's `spec.issuer` names the one OIDC issuer the knowledge base trusts, in one of two ways:

- **`ref`** names the Issuer document, `issuer.yaml`: a Keycloak the launcher runs, and in its `spec.database` the PostgreSQL Keycloak keeps its realm in, in the database `spec.database.name` names (`keycloak` as `semiont init` writes it). The realm is `semiont`, and Keycloak is published on port 8080 on the knowledge base's port block ([Ports](../LOCAL-SEMIONT.md#ports)) unless `semiont settings keycloak-port` sets another for it. With `semiont settings network lan`, the issuer is at this Mac's address on the network, behind a proxy that passes the realm alone ([Reaching it from another machine](../LOCAL-SEMIONT.md#reaching-it-from-another-machine)). `spec.accessTokenLifespan` is how long a token the realm mints stays valid, in seconds: the window in which a disabled account can still act ([Authentication](AUTHENTICATION.md#token-lifecycle)). The PostgreSQL is Keycloak's, and Semiont stores nothing in it ([Database](DATABASE.md)).
- **`external`** is an issuer somebody else runs: its `type`, `oidc` or `keycloak`, and its `url`, exactly the `iss` its tokens carry. The knowledge base then has no `issuer.yaml`, and a start refuses one beside it.

Either way, **`subjectClaim`** names the issuer claim a person's DID is built from: `did:web:<site domain>:users:<that claim's value>`. With `sub`, which `semiont init` writes, people are named by the issuer's stable identifier, so a changed email changes nothing about who authored what. With `email`, the address is the identity.

**There is no audience setting.** The audience a token must carry is the knowledge base's own resource identifier, derived from its `site.domain`.

What an issuer of your own must provide is in [Authentication](AUTHENTICATION.md#at-the-issuer).

## The Browser

The Browser serves every knowledge base here and belongs to none, so its document is kept in the launcher's state home, not in a knowledge base's repository: `stack/browser.yaml`, held to [`Browser`](../../../specs/src/stack/Browser.json) and read as strictly as the documents above.

```yaml
apiVersion: semiont.the-ai-alliance.github.io/v1alpha1
kind: Browser
metadata:
  name: browser
spec:
  image: ghcr.io/the-ai-alliance/semiont-browser:latest
  resources:
    limits:
      memory: 1G
  port: 3000
```

The first command that needs it (a start, `semiont identity sync`, `semiont settings browser`) writes it as above, from the launcher's catalog, and says where. `semiont settings browser` shows it, and `semiont settings browser --path` prints its path alone. Edit it, and the next start runs what it says:

- **`spec.image`**: the image the Browser runs, verified as any of Semiont's are ([Images](#images)); a `:local` one runs a build of this checkout.
- **`spec.resources.limits.memory`**: its memory ceiling ([Memory](#memory)).
- **`spec.port`**: where it is published, on this machine's loopback. The issuer's realm allows sign-in from that port alone: after moving it, run `semiont identity sync`, which adds the new origin, and the start's preflight names it when it is missing.

A start keeps a running Browser that runs what its document says, and restarts one that does not.

## The worker

The worker does the jobs of the knowledge bases here, and its image, memory and log level belong to no knowledge base. So its document is kept in the launcher's state home beside the Browser's, not in a knowledge base's repository: `stack/workers.yaml`, held to [`WorkerPool`](../../../specs/src/stack/WorkerPool.json) and read as strictly as the documents above.

```yaml
apiVersion: semiont.the-ai-alliance.github.io/v1alpha1
kind: WorkerPool
metadata:
  name: workers
spec:
  logLevel: info
  worker:
    image: ghcr.io/the-ai-alliance/semiont-worker:latest
    resources:
      limits:
        memory: 2G
```

The first command that needs it (a start that runs a worker, `semiont settings worker`) writes it as above, from the launcher's catalog, and says where. `semiont settings worker` shows it, and `semiont settings worker --path` prints its path alone. Edit it, and the next start that runs a worker runs what it says:

- **`spec.worker.image`**: the image the worker runs, verified as any of Semiont's are ([Images](#images)); a `:local` one runs a build of this checkout.
- **`spec.worker.resources.limits.memory`**: its memory ceiling ([Memory](#memory)).
- **`spec.logLevel`**: how much it logs.

Which jobs it does, and with which engines, is each knowledge base's: its Inference document's `spec.engines.jobs`.

One worker serves every knowledge base on its list. A start puts its own knowledge base on the list when one of its jobs has an engine, and takes it off when none does. A knowledge base someone else runs is added from inside one on the list, `semiont worker kb add`, and is offered that one's engines ([What the worker's owner does with it](AUTHENTICATION.md#what-the-workers-owner-does-with-it)). `semiont worker kb list` shows the list. Until each local knowledge base has a gateway port of its own, a start takes off the list any other local knowledge base whose gateway was on its port, and says so.

A start resolves every provider key the list's engines name, not its own knowledge base's alone, and refuses when one is missing, naming the knowledge base that names it. It writes the worker's configuration document to `machine/worker.json` in the state home, and keeps a running worker when that document, its image and its memory are what the start would run; it restarts the worker otherwise, and stops it when the list is empty.

## A deployment of its own

A knowledge base's documents describe the stack the launcher runs on one machine. An organization deploying the knowledge base on infrastructure of its own starts from a copy of them, and changes what it runs itself:

1. **Copy `.semiont/stack/`.** The project file stays as it is: the knowledge base's identity does not change with where it runs.
2. **Trust its own issuer.** In `knowledge-base.yaml`, replace `spec.issuer.ref` with `spec.issuer.external`, giving its `type` and `url`, and delete `issuer.yaml`. Each Semiont service then needs its own client at that issuer ([What the issuer must provide](AUTHENTICATION.md#at-the-issuer)).
3. **Use its own stores.** In `index.yaml`, give the graph and the vector store `external` in place of `image` and `resources`. What `external` holds for each is in [`KnowledgeIndex.json`](../../../specs/src/stack/KnowledgeIndex.json); the broker is its own the same way, at `spec.messaging.external` in [`KnowledgeBase.json`](../../../specs/src/stack/KnowledgeBase.json).
4. **Keep the images the documents name, or name its own.**

The launcher runs documents like these too, and starts only what is left for it to run. On a platform with no launcher, the services' JSON documents are what you deliver: see [Deploying Semiont](DEPLOYMENT.md#what-your-platform-provides).

## Secrets in a document

A document never holds a secret. It names one with a [`SecretRef`](../../../specs/src/stack/SecretRef.json), the environment variable the service is handed: `apiKey: { fromEnv: ANTHROPIC_API_KEY }`.

- **`semiont start` refuses** when a variable that something it starts reads is set neither in your environment nor by a source registered with `semiont settings secret set`. A variable the documents name where nothing reads it is not asked for.
- **A service is handed only the variables its own document names.** The Anthropic key reaches the librarian and the worker and no other service.
- **The launcher's own names cannot be used**: `NEO4J_PASSWORD`, `POSTGRES_PASSWORD`, `NATS_USER` and `NATS_PASSWORD` belong to the daemons it runs, whose passwords it generates and keeps. A document that names one is refused.

## Environment variables

The launcher reads its own:

| Variable | Purpose |
|---|---|
| `SEMIONT_ROOT` | The knowledge base to act on, instead of the one found by walking up from the current directory |

`semiont start --help` lists the others a start reads. What a service reads from its environment is in [Secrets](../services/SECRETS.md), and for the gateway, the dispatcher and the Archivist in [`variables.json`](../../../specs/src/service-environment/variables.json).

## What each service is given

No service reads a stack document:

- **The gateway, the dispatcher, the archivist, the worker, the weaver, the smelter and the librarian** each read a JSON document, at `/etc/semiont/gateway.json`, `/etc/semiont/dispatcher.json`, `/etc/semiont/archivist.json`, `/etc/semiont/worker.json`, `/etc/semiont/weaver.json`, `/etc/semiont/smelter.json` and `/etc/semiont/librarian.json`, that the launcher writes from the stack's documents and from `.semiont/config.yaml`. Their schemas are [`GatewayConfig`](../../../specs/src/components/schemas/GatewayConfig.json), [`DispatcherConfig`](../../../specs/src/components/schemas/DispatcherConfig.json), [`ArchivistConfig`](../../../specs/src/components/schemas/ArchivistConfig.json), [`WorkerConfig`](../../../specs/src/components/schemas/WorkerConfig.json), [`WeaverConfig`](../../../specs/src/components/schemas/WeaverConfig.json), [`SmelterConfig`](../../../specs/src/components/schemas/SmelterConfig.json) and [`LibrarianConfig`](../../../specs/src/components/schemas/LibrarianConfig.json). A document names a credential by the variable that holds it, never by value. The worker's document lists the engines it runs, each with the jobs it does with that engine, so a worker started some other way is given the same document and reads nothing of the knowledge base.
- **The librarian's document** names the engine each of its two actors asks, from the Inference document's `spec.engines.actors`, with the address of that engine's provider and the variable that holds its key. It states two bounds, from the KnowledgeIndex's `spec.librarian`: `gather.settleTimeoutMs`, how long a gather waits for the smelter, and `search.semanticFloor`, the least similarity a hit by meaning must have. `semiont init` writes 15000 milliseconds and 0.6. The librarian defaults neither.

On your own platform, these files are what you deliver ([Deployment](DEPLOYMENT.md#what-your-platform-provides)).

## Finding the knowledge base

The launcher walks up from the current directory looking for `.semiont/`, as `git` finds `.git/`. `SEMIONT_ROOT` overrides that, and so does `--root` on the commands that take it.

## When a document is refused

`semiont start` checks the documents before it starts anything and as it writes each service's document, and a refusal names the file and the field. The common ones:

| It says | Do this |
|---|---|
| A document does not hold to its schema, naming each place by its line | Fix each place. The schema the refusal names says what may be there |
| A document is missing | Write it. The fixture has one of each kind |
| `spec.knowledgeBase` or `spec.issuer.ref` names a document that is not there | Make the name agree with that document's `metadata.name` |
| The knowledge base trusts the issuer at `spec.issuer.external`, and `issuer.yaml` describes one the launcher would run | Delete one of the two |
| An Inference document's `metadata.name` is not its file's name | Make them the same |
| An engine's provider is one `spec.providers` says nothing of | Add `spec.providers.<provider>` |
| `spec.providers.<provider>.baseURL` is not stated | State the address of the provider's API |
| `spec.engines.actors.<actor>` is not stated | State a provider and a model. The librarian cannot start without both actors' engines |
| The start says no job has an engine, and skips the worker | The stack runs with no worker, and no software does a job. To run one, state a job's engine under `spec.engines.jobs`. `semiont start --service worker` on such a document is refused, since the worker would have nothing to do |
| The documents name a variable (`fromEnv`) that is not set | Export it, or register its source with `semiont settings secret set NAME` |
| The documents name a variable the launcher keeps for a daemon it runs | Name a variable of your own |
| `spec.vectors.type` is `memory` | Use `qdrant` ([Graph and vectors](#graph-and-vectors)) |
| `<state home>/stack/browser.yaml is not a Browser`, naming each place by its line | Fix each place, or delete the file: the next start writes the launcher's ([The Browser](#the-browser)) |
| `<state home>/stack/workers.yaml is not a WorkerPool`, naming each place by its line | Fix each place, or delete the file: the next start that runs a worker writes the launcher's ([The worker](#the-worker)) |

## Related

- [Secrets](../services/SECRETS.md): which secrets exist and how they reach services
- [Authentication](AUTHENTICATION.md): the issuer, and what `spec.issuer` selects
- [The service catalog](../services/OVERVIEW.md): the roles the documents choose drivers for
- [Project Layout](../PROJECT-LAYOUT.md): where these files sit in a knowledge base
- [The launcher's README](../../../apps/launcher/README.md): `semiont init`, `settings`, and every flag
