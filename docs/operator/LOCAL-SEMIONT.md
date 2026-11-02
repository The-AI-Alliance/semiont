# Running knowledge bases on your computer

The [`semiont` launcher](../../apps/launcher/README.md) runs a stack on your own machine, for the knowledge base in the directory you run it from. If this is your first time, follow the [Quick Start](../builder/QUICK-START.md): it goes from install to a first annotation. This page covers what the Quick Start leaves out.

To put the stack on a hosted machine instead, see [Knowledge Bases](../KNOWLEDGE-BASES.md). To deploy it on your own platform, see [Deploying Semiont](administration/DEPLOYMENT.md).

## What you need

- The launcher: `brew install the-ai-alliance/semiont/semiont` on macOS and Linux. On Windows, see [Semiont on Windows](platforms/WINDOWS.md).
- A container runtime: Apple `container`, Docker or Podman. The launcher uses the one it finds; `--runtime` names one, and `semiont settings runtime` makes that choice stick.
- `git`.

The launcher is a single static binary. Nothing else is installed on your machine, and nothing is built: every Semiont image is pulled from `ghcr.io/the-ai-alliance`, and a knowledge base's repository carries no Dockerfile and no scripts.

## Start a stack

From a knowledge base you already have, such as a clone of one of the [demo knowledge bases](../KNOWLEDGE-BASES.md):

```bash
git clone https://github.com/The-AI-Alliance/gutenberg-kb.git
cd gutenberg-kb
semiont start
semiont useradd --email you@example.com
```

For a new one, `semiont init` creates a knowledge base in the current directory first ([Quick Start](../builder/QUICK-START.md)).

`semiont start` pulls the images, starts the infrastructure and then the services in [order](services/OVERVIEW.md#start-order), waits for each to be healthy, and exits. The stack keeps running. A new stack has no accounts: `semiont useradd` creates the first one, and every one after it, and prompts for the password.

## What runs

`semiont status` reads what runs in the groups the launcher starts and stops, each service by the name `--service` takes:

| Group | Services | Whose |
|---|---|---|
| `record` | `gateway`, `archivist`, `dispatcher` and `messaging` (NATS) | each knowledge base's own |
| `index` | `librarian`, `smelter`, `weaver`, `graph` (Neo4j) and `vectors` (Qdrant) | each knowledge base's own |
| `issuer` | `identity` (Keycloak) and `identity-store` (its PostgreSQL), where people sign in | each knowledge base's own |
| `knowledge-workers` | `browser`, where people work, and `worker`, which runs agents' jobs | shared |
| `providers` | `inference` and `embedding`: Ollama, or a hosted provider's API | shared |
| `telemetry` | `collector` (OpenTelemetry), `traces` (Jaeger) and `metrics` (Prometheus) | shared |

A knowledge base is everything behind its gateway: its record, its index and its issuer, which it runs for itself. `status` shows each knowledge base with those three, then each shared group once. A shared service serves every knowledge base here, whichever start ran it: a start keeps a running one that is current, and `semiont stop` stops the shared services with the last knowledge base. Where a service runs (a container runtime, a codespace, a host process, somebody else's address) is a column of its row, not a section.

## Choose a config

A knowledge base can ship several Inference documents under `.semiont/stack/inference/`, usually one per inference provider, and `--config` names the one a start runs:

```bash
semiont start --list-configs        # the Inference documents this knowledge base has
semiont start --config anthropic    # start on one of them
semiont settings config anthropic   # make it this knowledge base's default on this machine
```

- **With local models (Ollama)**, no key is needed. The first start downloads the models the document names, which can take several minutes and several gigabytes. The launcher uses an Ollama already installed on your machine when there is one, and runs one in a container when there is not. That Ollama is shared, not one knowledge base's: it serves every knowledge base that names it, a start keeps it running, and `semiont stop` stops it with the last knowledge base. `semiont stop --service inference` stops it alone.
- **With Anthropic**, the document names the variable that holds the key: `apiKey: { fromEnv: ANTHROPIC_API_KEY }`. Tell the launcher where the key lives with `semiont settings secret set ANTHROPIC_API_KEY`, or export the variable. See [Secrets](services/SECRETS.md).

What the documents can say is in [Configuration](administration/CONFIGURATION.md).

## Day to day

```bash
semiont status                      # each knowledge base by group, then what they share
semiont logs                        # follow the Semiont services
semiont logs --service gateway      # follow one, infrastructure included
semiont start --service gateway     # restart one service
semiont start --group index         # restart a group, and first whatever it needs that is down
semiont stop --group index          # stop a group, and whatever in its knowledge base needs it
semiont stop                        # take the stack down; its data stays
semiont clean                       # delete the stack's data; the knowledge base is untouched
semiont start --dry-run             # print what a start would run, and run nothing
```

`--service` takes one of [the launcher's names](services/OVERVIEW.md#the-launchers-names), and `--group` one of [the groups](#what-runs). A group's start and stop say what else they start or stop, and why; a shared group stops alone, and each knowledge base goes on without it. `semiont stop` keeps every store, so the next start picks up where this one left off; `semiont clean` is the only command that deletes them, and it never touches the knowledge base's own directory.

## The Browser

Any start also makes sure the Browser is running, at `http://localhost:3000`. It is not part of the stack: one Browser serves every knowledge base here, running on this computer or forwarded from a codespace, and lists them under **Found on this machine**. `semiont stop` closes it with the last knowledge base, and `semiont stop --service browser` closes it alone.

The Browser has a document of its own, as a knowledge base's services do: `stack/browser.yaml` in the launcher's state home, naming its image, its memory and the port it is published on. The first start writes it, and says where; `semiont settings browser` shows it. Edit it, and the next start runs what it says: a port it moves needs `semiont identity sync` too, so the realm allows sign-in from there ([Configuration](administration/CONFIGURATION.md#the-browser)). The worker's image, memory and log level belong to no knowledge base the same way, in `stack/workers.yaml` beside it ([Configuration](administration/CONFIGURATION.md#the-worker)).

To use the Browser without running a stack, see [Get the Browser](../analyst/README.md#get-the-browser).

## Ports

A knowledge base running here, and the services it shares, publish these for you to open:

| Port | What |
|---|---|
| 3000 | The Browser, as its document names it ([The Browser](#the-browser)) |
| 4000 | The gateway: the knowledge base's address, as its `knowledge-base.yaml` commits it |
| 8080 | Keycloak, where people sign in |
| 7474, 7687 | Neo4j's console and its bolt port |
| 16686, 9090 | Jaeger and Prometheus ([Observability](administration/OBSERVABILITY.md)), shared: one each serves every knowledge base here |

The services' own ports and the infrastructure's are in [the service catalog](services/OVERVIEW.md). `semiont start` checks that every port it needs is free before it starts anything.

Each knowledge base on this Mac has a port block of its own. Its first start takes the lowest block no other knowledge base keeps, and it keeps that block until `semiont forget` drops it. Block 0 is the ports above and in the catalog. Block 1 places each of them 10 higher, block 2 20 higher, and so on: on block 1, Keycloak is at 8090, Neo4j at 7484 and 7697, PostgreSQL at 5442, NATS at 4232, Qdrant at 6343, and the services behind the gateway at 24111–24115. Each container still listens on its own port inside; only where it is published moves. Three ports are not in the block:

- **The gateway's** is the one the knowledge base commits. `semiont init` writes one no other knowledge base this Mac knows commits: 4000, else 4010, 4020, and so on.
- **Keycloak's** is the one `semiont settings keycloak-port` sets, if it has been set, and otherwise 8080 on the block.
- **The shared services** keep their own ports whichever knowledge base runs: the Browser, the worker, Ollama and the telemetry.

Each start says where it publishes each service as it comes up.

Several knowledge bases run at once. Each one's containers are named for it ([the launcher's names](services/OVERVIEW.md#the-launchers-names)), and a start leaves every other knowledge base's stack running. A start refuses a second copy of a knowledge base another clone is running, and a port another running knowledge base's stack holds: two clones of one template both commit gateway port 4000, so give the second a port of its own in its `knowledge-base.yaml`. `semiont stop` in a clone stops that knowledge base's stack, and the shared services with the last one; `--root <path>` names a knowledge base from anywhere.

Where each port listens depends on the container runtime:

- **Apple `container`:** what you open listens on `127.0.0.1`. What the containers dial listens on the bridge address, `192.168.64.1`, which answers this Mac and its containers and refuses other machines: the databases, the broker, the vector store, the collector and Jaeger's OTLP port, a containerized Ollama, the services' own ports, and Keycloak, whose address is the bridge address so that you and the containers sign in at the same URL, `http://192.168.64.1:8080`. The gateway and Neo4j's bolt port, which you and the containers both dial, take a second port on the bridge address, 10000 above their own: 14000 and 17687. So does the Browser, at 13000, for a browser that runs in a container, as the end-to-end suite's does.
- **Docker and Podman:** every port listens on every interface, and Keycloak is at `http://keycloak.localhost:8080`.

## Reaching it from another machine

By default a stack under Apple `container` answers this Mac alone. `semiont settings network lan` lets the network reach two things more, from the next start on, and `semiont settings network local` returns it to the default:

- **The gateway**, on port 4000 at this Mac's address on the network.
- **The issuer**, at `http://<this Mac's address>:8080/realms/<the knowledge base's realm>`. The issuer moves there for everyone, this Mac and the containers included, because a token names one issuer. A proxy the launcher runs answers at that address and passes the realm's sign-in pages and nothing else: Keycloak's admin console, its admin API and its master realm stay on the bridge address. `semiont stop` ends the proxy, and `semiont status` starts it again if it has died.

The address is read afresh at every start. When it changes, so does the issuer every token names, and people sign in again.

Nothing else answers the network, the Browser included: a person on another machine runs a Browser of their own ([Get the Browser](../analyst/README.md#get-the-browser)) and adds the knowledge base at `<this Mac's address>`, port 4000. Every `lan` start says what answers the network and that it is plain HTTP: passwords at sign-in and every token cross the network unencrypted.

`lan` is built for Apple `container`; under Docker and Podman a start with it refuses.

## Local network access

A stack's containers reach each other through your machine's own address, so the container runtime must be allowed to use the local network:

- **macOS with Apple `container`:** the first start prompts for permission. If you dismissed it, enable it under **System Settings → Privacy & Security → Local Network** for `container-runtime-linux`.
- **macOS with Docker Desktop or Podman:** the same prompt, granted to `com.docker.gateway` or `podman-mac-helper` in the same panel.
- **Linux and Windows:** no prompt.

## Where things are kept

- **The knowledge base** is its own directory: content, `.semiont/config.yaml`, the stack's documents in `.semiont/stack/`, and the event log. See [Project Layout](PROJECT-LAYOUT.md).
- **Everything a stack derives or needs to run** is outside it, in a directory the launcher keeps per knowledge base: the databases, the graph, the vectors, the job queue, the views, and the secrets the launcher generated. [Where the launcher keeps its files](../../apps/launcher/README.md#where-the-launcher-keeps-its-files) says where on each system, and `semiont status --verbose` prints the paths and what each store takes on disk.
- **Logs** go to each container's output. `semiont logs` reads them; there are no log files to find.

## Images built from source

The documents in `.semiont/stack/` name the image each service runs, and the launcher pulls none tagged `:local`. To run images built from a checkout of this repository instead of the published ones, build them with [`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh), name the `:local` images in the documents, and the Browser's and the worker's in their own documents (`semiont settings browser --path` and `semiont settings worker --path` say where they are). See [Local Development](../contributor/LOCAL-DEVELOPMENT.md).

## Related

- [The launcher's README](../../apps/launcher/README.md): every verb and flag
- [The service catalog](services/OVERVIEW.md): what is running, and on which ports
- [Troubleshooting](administration/TROUBLESHOOTING.md): when a start fails or a service is unhealthy
- [Maintenance](administration/MAINTENANCE.md): upgrades, disk, and protecting the event log
