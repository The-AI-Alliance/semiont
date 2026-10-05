# Deploying Semiont

A Semiont deployment is a handful of Semiont's own container images, the infrastructure they talk to, and one knowledge base's working tree. This page covers the three ways to run one, and what running one on your own platform asks of you.

## Three ways to run a stack

| Where the stack runs | Who brings it up | Start here |
|---|---|---|
| Your own machine | The launcher: `semiont start` | [Running a local stack](../LOCAL-SEMIONT.md) |
| A hosted machine, in a GitHub Codespace | The launcher: `semiont start --runtime codespace` | [Knowledge Bases](../../KNOWLEDGE-BASES.md) |
| Your own platform: Kubernetes, OpenShift, a cloud's container service, machines on premises | You | [Your own platform](#your-own-platform), below |

### On your own machine

The [`semiont` launcher](../../../apps/launcher/README.md) is where everyone starts. It is one static binary that drives a container runtime you already have (Apple `container`, Docker or Podman), and one command brings up a whole stack for the knowledge base in the current directory. An analyst can run their own stack this way: one person, one machine, a knowledge base in a directory.

```bash
brew install the-ai-alliance/semiont/semiont

cd /path/to/your-kb
semiont start       # pulls the images and brings the stack up
semiont status      # each service's state and health
semiont logs        # follow the services
semiont stop        # take it down; its data stays
```

A laptop has no scheduler, and `semiont start` exits once the stack is up. So on this path the launcher has each container supervise its own process: restart it when it crashes, kill it when it stops answering its health endpoint, and give up rather than loop on a failure at boot.

### On a hosted machine

`semiont start --runtime codespace` runs the same stack in a GitHub Codespace. The launcher on your machine creates or resumes the codespace and forwards the knowledge base and its issuer to `localhost`. Inside the codespace, the codespace's own launcher runs the stack with Docker, exactly as on a laptop. Many can run at once, each forwarded to its own local port, and one Browser works in all of them.

This is the smallest remote deployment, and it shows the shape of every larger one. The stack runs on a machine in a datacenter, next to the knowledge base's repository. The people and agents who work in it reach it over the network, from a Browser or the SDK on their own machines. An organization doing this work in earnest runs that same shape on infrastructure it controls, sized for its own corpus and its own analysts.

### On your own platform

Semiont publishes container images and states what each one needs. It ships no manifests, charts, playbooks or templates for a platform: writing those is yours, in whatever you already deploy with. That may be Kubernetes or OpenShift manifests, Helm, Ansible, Terraform or the AWS CDK, and the target may be AWS, Azure, Google Cloud or machines on your own premises. The rest of this page is what that work has to cover.

## Your own platform

### What you are deploying

Eight images, listed with their ports, configuration, mounts and dependencies in [the service catalog](../services/OVERVIEW.md). The table under [What each service needs](../services/OVERVIEW.md#what-each-service-needs) is the contract. In short:

- The **gateway** is the one service clients reach. Everything else talks to it, or to the infrastructure.
- The **archivist** is the one service that mounts the knowledge base. Exactly one runs.
- The **worker** needs only network addresses, so a pool of them can run wherever the models are.
- The **Browser** image is static files. Serve it from anywhere, or have people use the desktop app instead.

A stack the launcher has running is a worked example of the whole contract. `semiont start --dry-run` prints every container's arguments, and the launcher's staging directory, which `semiont status --verbose` names, holds each service's configuration exactly as that service reads it.

### What your platform provides

**Configuration.** The librarian, the worker, the smelter and the weaver each read a TOML file at `/home/semiont/.semiontconfig`, whose schema is in [Configuration](CONFIGURATION.md). The gateway, the dispatcher and the archivist each read a JSON document, at `/etc/semiont/gateway.json`, `/etc/semiont/dispatcher.json` and `/etc/semiont/archivist.json`, whose schemas are [`GatewayConfig`](../../../specs/src/components/schemas/GatewayConfig.json), [`DispatcherConfig`](../../../specs/src/components/schemas/DispatcherConfig.json) and [`ArchivistConfig`](../../../specs/src/components/schemas/ArchivistConfig.json). Getting those files into each container is yours: a ConfigMap, a mounted volume, or a layer you bake. With no launcher to place the daemons, every section states its address.

**Secrets.** Services read secrets from environment variables and from no secret store. The gateway needs `JWT_SECRET`. Every service needs its own `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET`. Inference keys and daemon passwords arrive as whatever variables your config references. Mapping them from your store (Kubernetes Secrets, Vault, a cloud's secret manager) is yours. See [Secrets](../services/SECRETS.md).

**An issuer.** Every knowledge base trusts one OIDC issuer. Use the one your organization already has: set `[identity] type = "oidc"` and give each of the seven services its own client there. [What the issuer must provide](AUTHENTICATION.md#at-the-issuer) lists the claims, roles and clients. Accounts are then the issuer's to manage; `semiont useradd` administers only a Keycloak the launcher runs.

**Storage that lasts.**

| What | Why it matters |
|---|---|
| The knowledge base's working tree, including `.semiont/events/` | The system of record. Everything else can be rebuilt from it |
| The broker's `/data` | The job queue, and the gateway's record of pending replies |
| The issuer's database | The accounts people sign in with |
| The graph, the vectors, the views and the anchored text | Derived from the record. Keeping them saves a rebuild; losing them loses nothing |

**The working tree.** The archivist mounts the knowledge base's git clone at `/kb`, read-write, and no other container mounts it. On Kubernetes or OpenShift that is a `ReadWriteOnce` volume claimed by the one archivist pod; on a virtual machine it is a directory. Committing the event log and pushing it is how the record leaves the machine ([Maintenance](MAINTENANCE.md#the-event-log-is-the-thing-to-protect)).

**Ingress and TLS.** Clients reach the gateway on 4000 and the Browser on 3000. Terminating TLS and routing to them is the platform's. The gateway serves long-lived Server-Sent Events streams, so the route must pass responses unbuffered, with an idle timeout above the gateway's 15-second heartbeat. The gateway's `publicUrl` is the address clients reach it at.

**Restart and liveness.** Each image runs one service process under `tini` and exits when that process dies, so your platform's restart policy and liveness probes work as they normally do. The probe endpoints are in [the catalog](../services/OVERVIEW.md#health). Do not set `SEMIONT_SUPERVISE`: it turns on the in-container supervisor the launcher uses in place of a scheduler, and a container that restarts itself never looks unhealthy to yours.

**Telemetry.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` on each service to export traces and metrics to your collector. Unset, a service exports nothing. See [Observability](OBSERVABILITY.md).

### More than one gateway

The gateway runs as several replicas behind a load balancer once its signal plane is the broker. In each replica's configuration document:

```json
"signal": {
  "type": "nats",
  "servers": "nats.example.internal:4222",
  "userEnv": "BROKER_USER",
  "passwordEnv": "BROKER_PASSWORD"
}
```

The document names the variables that hold the broker's credentials, never the credentials. A stack the launcher runs gets the same from `[signal] type = "nats"` in the knowledge base's config, which is what `semiont init` writes.

With that in place:

- **The broker** is one NATS server with JetStream enabled and a durable `/data`. Its core subjects carry the signal plane. JetStream carries the dispatcher's job queue and the tables where every replica records the replies it is waiting for.
- **Every replica shares one `JWT_SECRET`**, so an agent or media token minted by one verifies on another.
- **The load balancer needs no session affinity.** Any replica can answer a reconnecting client, and replay after a dropped stream is read from the archivist.
- **The dispatcher stays at one instance** per knowledge base, whatever the gateway count. See [Scaling](SCALING.md) for every service.

A request that no service handles fails at the 30-second bus timeout rather than at once, because a broker cannot tell the gateway that nobody is listening.

## Adapting a stack

The technologies in a launcher-run stack are defaults. Inference, embedding, the graph, the vector store, identity, messaging and telemetry each sit behind a driver interface, and a knowledge base's config names the driver for each. That gives two ways to fit Semiont to infrastructure you already have or prefer.

**Use a daemon you already run.** A section that says `platform = "external"` names a daemon somebody else runs, and states where it is. This works with the launcher too: it checks that the daemon answers and starts nothing for that role. A managed Neo4j, a shared Qdrant cluster, a model server on a GPU machine or your organization's NATS all fit this way.

```toml
[environments.<env>.graph]
type = "neo4j"
platform = "external"
uri = "bolt://neo4j.example.internal:7687"
username = "neo4j"
password = "${MY_NEO4J_PASSWORD}"
database = "neo4j"
```

**Use a different technology.** Where the code already has a driver, select it by `type`. Where it has none, the interface is what a new driver implements, and the services that use it do not change.

| Role | Interface | Drivers in the code |
|---|---|---|
| Inference | `InferenceClient`, in [`@semiont/inference`](../../../packages/inference/) | Anthropic, Ollama |
| Embedding | `EmbeddingProvider`, in [`@semiont/vectors`](../../../packages/vectors/) | Ollama, Voyage |
| Vector store | `VectorStore`, in `@semiont/vectors` | Qdrant, in-memory |
| Graph | `GraphDatabase`, in [`@semiont/graph`](../../../packages/graph/) | Neo4j, Neptune, JanusGraph, in-memory |
| Identity | OpenID Connect | Any conforming issuer. Keycloak is the one the launcher runs |
| Signal plane | `SignalPlane`, in the gateway | In-process, NATS |
| Job queue | The dispatcher's queue | NATS JetStream |
| Telemetry | OTLP | Any collector or backend that accepts it |

The launcher runs Neo4j, Qdrant, Keycloak and NATS, with Ollama or Anthropic for inference and Ollama for embeddings. It starts none of the other drivers; those are for a stack you deploy. If a default is not a good fit for your environment, Semiont is designed to be adapted at these seams, without deep changes to the services on either side of them.

## Keeping a deployment under your own control

Nothing in a stack has to run on infrastructure you do not control, which is what on-premises and sovereign AI deployments need:

- **The record is files.** A knowledge base is a git working tree: content at its own paths and an event log of JSON lines. It lives on storage you choose, and it is readable without Semiont.
- **Models can be local.** With Ollama serving inference and embeddings, no document, annotation or prompt is sent to a model API outside the stack. A remote API such as Anthropic's is a choice a config makes, per actor and per worker.
- **Identity is yours.** People and services sign in at the issuer you name, and Semiont keeps no accounts of its own.
- **Telemetry goes where you send it**, or nowhere.
- **The images are verifiable.** Each carries a signed build provenance and a bill of materials, so you can check one before mirroring it into your own registry ([Container Images](IMAGES.md#supply-chain-verification)).

## Verifying a deployment

However the stack was started:

```bash
curl http://<gateway-host>:4000/api/health     # the gateway is up
curl http://<browser-host>:3000/               # the Browser is being served
```

Then sign in. A sign-in exercises the issuer, the gateway's verification and the archivist together, which a health endpoint does not. For a stack the launcher runs, `semiont status` reports every service. See [Troubleshooting](TROUBLESHOOTING.md) when something is wrong.

## Related

- [The service catalog](../services/OVERVIEW.md): what each image needs
- [Container Topology](../CONTAINER-TOPOLOGY.md): how the containers connect
- [Configuration](CONFIGURATION.md): the config schema, and choosing drivers
- [Scaling](SCALING.md): which services replicate
- [Container Images](IMAGES.md): tags, and verifying an image
- [The launcher's README](../../../apps/launcher/README.md): every verb and flag
