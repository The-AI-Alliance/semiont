# The services in a stack

A Semiont stack is eight of Semiont's own container images and the infrastructure they need. This page is the one place their facts are stated: what each is, where it listens, what it reads, what it mounts and what it reaches. Other pages link here.

For how the containers connect, see [Container Topology](../CONTAINER-TOPOLOGY.md). For what the actors inside them do, see [Knowledge System](../../architecture/KNOWLEDGE-SYSTEM.md).

## Semiont's own images

All eight are published to `ghcr.io/the-ai-alliance/`, for `linux/amd64` and `linux/arm64`. See [Container Images](../administration/IMAGES.md) for tags and for verifying one.

| Service | Image | Port | Built from | What it does |
|---|---|---|---|---|
| [gateway](../../../images/gateway/README.md) | `semiont-gateway` | 4000 | Rust, `images/gateway` | Verifies every caller's token, relays the bus, and proxies content bytes to the Archivist. It hosts no actors and holds no datastore |
| [dispatcher](../../../images/dispatcher/README.md) | `semiont-dispatcher` | 24105 | Rust, `images/dispatcher` | Owns the job queue and answers the `job:*` lifecycle. No content flows through it |
| [archivist](../../../images/archivist/README.md) | `semiont-archivist` | 24103 | Rust, `images/archivist` | Keeps the record. The only service that mounts the knowledge base's working tree: it appends the event log, writes content, and keeps the views |
| [librarian](../../../images/librarian/README.md) | `semiont-librarian` | 24104 | Python, `images/librarian` | Searches the knowledge base: finds resources by text, gathers context, lists what refers to a resource, and matches candidates |
| [worker](../../../images/worker/README.md) | `semiont-worker` | 24100 | Python, `images/worker` | The worker pool: claims annotation and generation jobs and runs them against a model |
| [smelter](../../../images/smelter/README.md) | `semiont-smelter` | 24101 | Python, `images/smelter` | Keeps the vector index in step with the record, and derives a PDF's anchored text |
| [weaver](../../../images/weaver/README.md) | `semiont-weaver` | 24102 | Python, `images/weaver` | Keeps the graph in step with the record |
| [browser](../../../images/browser/README.md) | `semiont-browser` | 3000, or the port its document names ([The Browser](../administration/CONFIGURATION.md#the-browser)) | `images/browser` | Serves the Semiont Browser's static files. The app itself runs in the user's web browser and connects to gateways from there |

## What each service needs

This is the contract a deployment satisfies, whoever does the deploying. The launcher satisfies it on a laptop and in a codespace; on your own platform it is yours ([Deployment](../administration/DEPLOYMENT.md)).

| Service | Configuration | Mounts | Reaches | Instances |
|---|---|---|---|---|
| gateway | `/etc/semiont/gateway.json`, a [`GatewayConfig`](../../../specs/src/components/schemas/GatewayConfig.json) document | none | The issuer's published keys; the Archivist; the broker, when the signal plane is `nats` | any number, once the signal plane is `nats` |
| dispatcher | `/etc/semiont/dispatcher.json`, a [`DispatcherConfig`](../../../specs/src/components/schemas/DispatcherConfig.json) document | none | The gateway's bus; the broker's JetStream | one |
| archivist | `/etc/semiont/archivist.json`, an [`ArchivistConfig`](../../../specs/src/components/schemas/ArchivistConfig.json) document | The working tree at `/kb`, read-write; the state directory, where it writes views; the anchored-text store, read-write. No other container mounts any of them | The gateway's bus | one |
| librarian | `/etc/semiont/librarian.json`, a [`LibrarianConfig`](../../../specs/src/components/schemas/LibrarianConfig.json) document | none | The gateway, for the bus (where it reads what the record holds of a resource, and the people a reply names) and for anchored text; graph; vectors; embedding; inference; the Archivist, for bytes | one |
| worker | `/etc/semiont/worker.json`, a [`WorkerConfig`](../../../specs/src/components/schemas/WorkerConfig.json) document | none | The gateway, for the bus and for bytes; inference | any number |
| smelter | `/etc/semiont/smelter.json`, a [`SmelterConfig`](../../../specs/src/components/schemas/SmelterConfig.json) document | Its document alone | The gateway's bus; vectors; embedding; the Archivist, for bytes, for a resource's annotations and to keep the anchored-text store | one |
| weaver | `/etc/semiont/weaver.json`, a [`WeaverConfig`](../../../specs/src/components/schemas/WeaverConfig.json) document | none | The gateway's bus; graph | one |
| browser | none; `PORT` only | none | nothing | any number |

Every service but the Browser has its own service account at the knowledge base's issuer, which it receives as `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET`. The worker is the exception: it holds one key, `SEMIONT_OIDC_CLIENT_KEY`, and its document names its client at each knowledge base it serves. It signs in with that account, and the issuer's token is its bearer at the gateway, which names it by that account: the agent its work is attributed to.

No service reads the knowledge base's TOML: each reads its document, which names every secret by the variable that holds it. [`service-environment/variables.json`](../../../specs/src/service-environment/variables.json) lists every environment variable the gateway, the dispatcher and the Archivist read.

Why each service has one instance or many is in [Scaling](../administration/SCALING.md). Which secrets reach which service is in [Secrets](SECRETS.md).

## The infrastructure beside them

Each row is a role a stack needs, and the technology the launcher runs for it. A knowledge base's config names the driver for each role ([Configuration](../administration/CONFIGURATION.md)).

| Role | What the launcher runs | Port | Who uses it |
|---|---|---|---|
| `identity` | Keycloak | 8080 | People and services sign in there; the gateway verifies every token against its keys |
| `identity-store` | PostgreSQL | 5432 | Keycloak, and nothing else. Semiont stores nothing in it ([Database](../administration/DATABASE.md)) |
| `messaging` | NATS, with JetStream | 4222 | The dispatcher's job queue; the gateway's signal plane, when it is `nats` |
| `graph` | Neo4j | 7687 (Bolt), 7474 (HTTP) | Librarian, weaver |
| `vectors` | Qdrant | 6333 | Librarian, smelter |
| `inference` | Ollama, or nothing when a remote API such as Anthropic does the inference | 11434 | Librarian, worker |
| `embedding` | The machine's Ollama (the one inference uses, when inference is on it), or nothing when Voyage does the embedding | 11434 | Librarian, smelter |
| `collector` | OpenTelemetry Collector | 4318 (OTLP), 24110 (its own metrics) | Every service exports traces and metrics to it |
| `traces` | Jaeger | 16686 (UI), 14318 (OTLP) | The collector forwards traces to it |
| `metrics` | Prometheus | 9090 | Scrapes the collector |

The ports in both tables are where each container listens. The launcher publishes a knowledge base's at the same ports on its port block 0, 10 higher on block 1, and so on, and every document it stages names the published ones ([Ports](../LOCAL-SEMIONT.md#ports)). The gateway is published at the port its document commits. The worker, the Browser, Ollama and the telemetry are the machine's, at their own ports.

`embedding` never has a container of its own: an Ollama embedding is served by the Ollama that `inference` runs, and Voyage is a remote API. `semiont start --no-observe` leaves out `traces` and `metrics`; the collector still runs.

None of these is fixed. Each role sits behind a driver interface, so a stack can use a daemon you already run, or a different technology: see [Adapting a stack](../administration/DEPLOYMENT.md#adapting-a-stack).

## Start order

`semiont start` brings a stack up in this order:

1. `traces`, `metrics`, `collector`
2. `identity-store`, `messaging`, `identity`
3. `gateway`
4. `graph`, `vectors`, `inference`, `embedding`
5. `archivist`, `librarian`, `dispatcher`
6. `worker`, `smelter`, `weaver`
7. `browser`

`semiont stop` takes it down in reverse. A scheduler need not reproduce the order exactly, because each service waits for what it depends on within a deadline: see [Retry and deadlines](../../architecture/RETRY-AND-DEADLINES.md).

## Health

Every service answers a health request on its own port. `semiont status` probes each role and reports the result beside the container's state:

| Role | Probe |
|---|---|
| gateway | `GET /api/health` on 4000 |
| worker, smelter, weaver, archivist, librarian, dispatcher | `GET /health` on the service's port |
| `identity` | the realm's own URL |
| `identity-store`, `messaging` | a TCP connect |
| `graph` | `GET /` on 7474 |
| `vectors` | `GET /readyz` on 6333 |
| `inference`, `embedding` | `GET /api/version` on 11434 |
| `collector` | `GET /metrics` on 24110 |
| `traces` | `GET /` on 16686 |
| `metrics` | `GET /-/healthy` on 9090 |

These answer liveness: the process is up and serving. The gateway's `/api/health` checks nothing behind it, so it stays healthy while the broker or the issuer is down ([Troubleshooting](../administration/TROUBLESHOOTING.md)).

## The launcher's names

`--service <name>` on `semiont start`, `stop`, `logs` and `status` takes a role name from the tables above: `gateway`, `dispatcher`, `archivist`, `librarian`, `worker`, `smelter`, `weaver`, `browser`, `identity`, `identity-store`, `messaging`, `graph`, `vectors`, `inference`, `embedding`, `collector`, `traces` or `metrics`. It takes exactly one. Omitting it means the whole stack. Each of these commands acts on the knowledge base whose clone you stand in, or the one `--root <path>` names: `semiont logs --service gateway` follows that knowledge base's gateway.

Several knowledge bases run side by side on one machine, so each one's containers are named for it: `semiont-<kb>-<product>`. `<product>` is `gateway`, `dispatcher`, `archivist`, `librarian`, `smelter`, `weaver`, `keycloak`, `postgres`, `nats`, `neo4j` or `qdrant`. `<kb>` is the knowledge base's did:web domain, the `site.domain` in its [`.semiont/config.yaml`](../administration/CONFIGURATION.md#semiontconfigyaml), with each run of characters outside `A-Z a-z 0-9 . _ -` replaced by one `-`. So `did:web:example.org:my-kb` runs its gateway as `semiont-example.org-my-kb-gateway`. The machine's containers serve every knowledge base on it and are named `semiont-<name>`: `semiont-worker`, `semiont-browser`, `semiont-ollama`, `semiont-otel-collector`, `semiont-jaeger`, `semiont-prometheus`.

## Related

- [Container Topology](../CONTAINER-TOPOLOGY.md): how the containers connect, in two diagrams
- [Deployment](../administration/DEPLOYMENT.md): the three ways to run a stack
- [Configuration](../administration/CONFIGURATION.md): choosing a driver for each role
- [Secrets](SECRETS.md): which secrets exist and which service receives each
- [The launcher's README](../../../apps/launcher/README.md): every verb and flag
