# Running a local stack

The [`semiont` launcher](../../apps/launcher/README.md) runs a stack on your own machine, for the knowledge base in the directory you run it from. If this is your first time, follow the [Quick Start](../../README.md#quick-start): it goes from install to a first annotation. This page covers what the Quick Start leaves out.

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

For a new one, `semiont init` creates a knowledge base in the current directory first ([Quick Start](../../README.md#quick-start)).

`semiont start` pulls the images, starts the infrastructure and then the services in [order](services/OVERVIEW.md#start-order), waits for each to be healthy, and exits. The stack keeps running. A new stack has no accounts: `semiont useradd` creates the first one, and every one after it, and prompts for the password.

## Choose a config

A knowledge base can ship several configs under `.semiont/semiontconfig/`, usually one per inference provider:

```bash
semiont start --list-configs        # the configs this knowledge base has
semiont start --config anthropic    # start on one of them
semiont settings config anthropic   # make it this knowledge base's default
```

- **With local models (Ollama)**, no key is needed. The first start downloads the models the config names, which can take several minutes and several gigabytes. The launcher uses an Ollama already installed on your machine when there is one, and runs one in a container when there is not.
- **With Anthropic**, the config references `${ANTHROPIC_API_KEY}`. Tell the launcher where the key lives with `semiont settings secret set ANTHROPIC_API_KEY`, or export the variable. See [Secrets](services/SECRETS.md).

What a config can say is in [Configuration](administration/CONFIGURATION.md).

## Day to day

```bash
semiont status                      # each service's state and health
semiont logs                        # follow the Semiont services
semiont logs --service gateway      # follow one, infrastructure included
semiont start --service gateway     # restart one service
semiont stop                        # take the stack down; its data stays
semiont clean                       # delete the stack's data; the knowledge base is untouched
semiont start --dry-run             # print what a start would run, and run nothing
```

`--service` takes one of [the launcher's names](services/OVERVIEW.md#the-launchers-names). `semiont stop` keeps every store, so the next start picks up where this one left off; `semiont clean` is the only command that deletes them, and it never touches the knowledge base's own directory.

## The Browser

Any start also makes sure the Browser is running, at `http://localhost:3000`. It is not part of the stack: one Browser serves every knowledge base on the machine, local or forwarded from a codespace, and lists them under **Found on this machine**. So `semiont stop` leaves it running, and `semiont stop --service browser` closes it. `semiont start --service browser --port <n>` moves it to another port.

To use the Browser without running a stack, see [Get the Browser](../analyst/README.md#get-the-browser).

## Ports

A local stack publishes these on `localhost`:

| Port | What |
|---|---|
| 3000 | The Browser |
| 4000 | The gateway: the knowledge base's address |
| 8080 | Keycloak, where people sign in |
| 16686, 9090 | Jaeger and Prometheus ([Observability](administration/OBSERVABILITY.md)) |

The services' own ports and the infrastructure's are in [the service catalog](services/OVERVIEW.md). `semiont start` checks that every port it needs is free before it starts anything.

## Local network access

A stack's containers reach each other through your machine's own address, so the container runtime must be allowed to use the local network:

- **macOS with Apple `container`:** the first start prompts for permission. If you dismissed it, enable it under **System Settings → Privacy & Security → Local Network** for `container-runtime-linux`.
- **macOS with Docker Desktop or Podman:** the same prompt, granted to `com.docker.gateway` or `podman-mac-helper` in the same panel.
- **Linux and Windows:** no prompt.

## Where things are kept

- **The knowledge base** is its own directory: content, `.semiont/config`, the configs, and the event log. See [Project Layout](PROJECT-LAYOUT.md).
- **Everything a stack derives or needs to run** is outside it, in a directory the launcher keeps per knowledge base: the databases, the graph, the vectors, the job queue, the views, and the secrets the launcher generated. [Where the launcher keeps its files](../../apps/launcher/README.md#where-the-launcher-keeps-its-files) says where on each system, and `semiont status --verbose` prints the paths and what each store takes on disk.
- **Logs** go to each container's output. `semiont logs` reads them; there are no log files to find.

## Images built from source

To run images built from a checkout of this repository instead of the published ones, build them with [`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) and start with `SEMIONT_VERSION=local semiont start`. See [Local Development](../contributor/LOCAL-DEVELOPMENT.md).

## Related

- [The launcher's README](../../apps/launcher/README.md): every verb and flag
- [The service catalog](services/OVERVIEW.md): what is running, and on which ports
- [Troubleshooting](administration/TROUBLESHOOTING.md): when a start fails or a service is unhealthy
- [Maintenance](administration/MAINTENANCE.md): upgrades, disk, and protecting the event log
