# Operating Semiont

An operator runs a Semiont stack: brings it up, configures it, keeps it secure, watches it, and fixes it when something is wrong. The stack may be on your own laptop, for your own work, or on infrastructure a whole team depends on.

For working in a knowledge base, see **[../analyst/](../analyst/)**. For building on the SDK, **[../builder/](../builder/)**. For how Semiont works inside, **[../architecture/](../architecture/)**. For changing Semiont itself, **[../contributor/](../contributor/)**.

## What a stack is

One stack serves one knowledge base. It is:

- **Eight Semiont images**: the gateway, the dispatcher, the archivist, the librarian, the worker, the smelter, the weaver and the Browser.
- **The infrastructure they talk to**: an identity provider, a message broker, a graph database, a vector store, and models for inference and embedding.
- **The knowledge base itself**: a git working tree holding the content and the event log. That is the system of record. Everything else is rebuilt from it.

[The service catalog](services/OVERVIEW.md) lists every piece, and [Container Topology](CONTAINER-TOPOLOGY.md) draws how they connect.

## Three ways to run one

**Start with the launcher.** `semiont` is one binary that brings up a whole stack on your machine with one command. It is the path the [Quick Start](../builder/QUICK-START.md) takes, and an analyst can run their own knowledge base this way. See [Running a local stack](LOCAL-SEMIONT.md).

**Put the stack on a hosted machine.** The same launcher places a stack in a GitHub Codespace and forwards it to your machine: `semiont start --runtime codespace`. The stack runs next to the knowledge base's repository, and people reach it from wherever they are. That is the shape of a real deployment at its smallest. See [Knowledge Bases](../KNOWLEDGE-BASES.md).

**Deploy it on your own platform.** Semiont is a handful of container images with a stated contract. Running them on Kubernetes, OpenShift, AWS, Azure, Google Cloud or machines on your own premises is yours to build, with whatever you already deploy with. See [Deploying Semiont](administration/DEPLOYMENT.md).

Inference, the graph, the vector store, identity and messaging each sit behind a driver interface. If the technology a stack uses by default is not a good fit for you, Semiont is designed to be adapted there: see [Adapting a stack](administration/DEPLOYMENT.md#adapting-a-stack). A stack can also run with nothing outside your control, local models included, which is what on-premises and sovereign AI deployments need.

## Running a stack

| Doc | What it covers |
|---|---|
| [LOCAL-SEMIONT.md](LOCAL-SEMIONT.md) | Running a stack with the launcher: an existing knowledge base or a new one, choosing a config, the ports, and where the launcher keeps things |
| [platforms/](platforms/README.md) | The systems and container runtimes the launcher runs on, with [Windows](platforms/WINDOWS.md) in detail |
| [PROJECT-LAYOUT.md](PROJECT-LAYOUT.md) | What is in a knowledge base's directory, and what to commit |
| [administration/DEPLOYMENT.md](administration/DEPLOYMENT.md) | The three ways to run a stack; what your own platform must provide; adapting a stack |

## What is running

| Doc | What it covers |
|---|---|
| [services/OVERVIEW.md](services/OVERVIEW.md) | The service catalog: every image and every infrastructure role, with ports, configuration, mounts, dependencies and health checks |
| [CONTAINER-TOPOLOGY.md](CONTAINER-TOPOLOGY.md) | How the containers connect: who talks to whom, and what attaches to what |
| [administration/IMAGES.md](administration/IMAGES.md) | The published images, their tags, and verifying one before you run it |

## Configuring and securing

| Doc | What it covers |
|---|---|
| [administration/CONFIGURATION.md](administration/CONFIGURATION.md) | The knowledge base's two config files, and choosing a driver for each role |
| [services/SECRETS.md](services/SECRETS.md) | The secrets the launcher keeps, the ones you own, and how each reaches a service |
| [administration/AUTHENTICATION.md](administration/AUTHENTICATION.md) | The trusted issuer, tokens and their lifetimes, revocation, and what an issuer of your own must provide |
| [administration/SECURITY.md](administration/SECURITY.md) | What Semiont enforces, what it leaves to the issuer and the platform, and what it does not do |

## Keeping it running

| Doc | What it covers |
|---|---|
| [administration/OBSERVABILITY.md](administration/OBSERVABILITY.md) | Traces, metrics and logs |
| [administration/TROUBLESHOOTING.md](administration/TROUBLESHOOTING.md) | Diagnosing a stack, failure by failure |
| [administration/MAINTENANCE.md](administration/MAINTENANCE.md) | Upgrades, protecting the event log, rotating secrets, disk |
| [administration/BACKUP.md](administration/BACKUP.md) | Exporting a knowledge base and restoring it |
| [administration/DATABASE.md](administration/DATABASE.md) | The PostgreSQL in a stack, which is the identity provider's |
| [administration/SCALING.md](administration/SCALING.md) | Which services replicate, which do not, and the signals to watch |

## The launcher's own manual

[apps/launcher/README.md](../../apps/launcher/README.md) documents every verb and flag of `semiont`, how it places a stack in a codespace, and [where it keeps its files](../../apps/launcher/README.md#where-the-launcher-keeps-its-files). These pages say what to do with it; that one says what it does.
