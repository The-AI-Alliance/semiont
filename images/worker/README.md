# semiont-worker

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-worker)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

**The worker claims queued jobs and runs them against a model**: the detection passes, the
generation and the other long-running work that a request cannot wait on. It is a Python
service, answers for its health on port 24100, and is started with the rest of a knowledge
base's stack by the [launcher](../../apps/launcher/README.md) (`semiont start`).

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-worker` |
| Port | 24100 (`/health`, and nothing else) |
| Command | `python -P -m semiont_worker --config /etc/semiont/worker.json` |
| Code | Python, in this directory: [`src/semiont_worker`](./src/semiont_worker/) |
| Specification | [docs/protocol/WORKER-SERVICE.md](../../docs/protocol/WORKER-SERVICE.md) |
| Judged by | [tests/conformance/worker-service](../../tests/conformance/worker-service/README.md) |
| Published | to no package index: the image only |

What the worker does is written rule by rule in
[WORKER-SERVICE.md](../../docs/protocol/WORKER-SERVICE.md), and the
[worker-service conformance suite](../../tests/conformance/worker-service/README.md) holds an
implementation to each rule. This page is the image, and how it is run.

## What it does

It runs a job by its `jobType`. A `mark` job is a highlighting, commenting, assessing,
linking or tagging pass over a resource, as its motivation names; a `yield` job makes a
resource, by generation. For each, it claims the job, reads the resource, asks its model,
commits what the answer gives, and reports where the job stands.

## What it talks to

- **The bus**, through the gateway: SSE in, for `job:queued`, and `POST /bus/emit` out, for
  claims and a job's lifecycle.
- **The [gateway](../gateway/README.md)**, for a resource's bytes (`GET /resources/{id}`) and
  a PDF's text (`GET /resources/{id}/anchored-text`). The gateway is the only address of the
  knowledge base it holds.
- **An inference provider**, for its model.

**It pulls.** At every moment it becomes idle (start, settle, a matching `job:queued` while
parked, reconnect) it asks the [dispatcher](../dispatcher/README.md) for the next job among
those it serves, and parks when told nothing is pending. `job:queued` is a wake-up with no
memory, not a reservation. Claims are atomic, so several workers can run against one queue
without coordination.

**A claim refused with `unauthorized` ends the process**, for restart, rather than leaving it
parked forever: the credential is not a worker's, and the launcher's preflight names the
repair.

## One agent, an engine for each provider and model

The worker is **one agent**: its service account at the knowledge base's issuer, signed in
once. The token the issuer grants is its bearer at the gateway, and the DID the gateway names
it by (`GET /api/users/me`) is what the bus stamps on every event it emits.

It runs **one engine for each entry of `agents`** in its
[configuration document](#configuration): a provider and a model, and the jobs that engine
serves. The engines of one service work at once, over the agent's one stream, and each holds
one job at a time. An engine is no part of who the agent is: the `generator` on everything a
job makes names the agent by its DID and the engine that made it, so `_userId` on the bus and
the `generator` on every annotation refer to the same agent.

## Nothing wedges, nothing restarts from zero

Each call to the model is given **ten minutes**, and while one is under way the job reports
where it stands every fifteen seconds. A held job that stalls ends the service, loudly, for
whatever supervises it to restart; and a running job nothing has touched for long enough is
recovered by the dispatcher's sweep ([JOBS.md](../../docs/protocol/JOBS.md#periodic-work)).

A text is asked about in pieces sized from the model's limits. A piece whose answer cannot
be used for its size is **asked again in halves** before it is allowed to fail the job.

When a job does fail, the service classes the failure:

- **deterministic**, when an identical retry cannot succeed: not retried;
- **`withheld`**, when the provider withheld its answer (a refusal, a content filter): not
  retried, and read as the provider's choice, not as the job breaking;
- **transient**: retried, and the retry **resumes from the checkpoint** the failed attempt
  left, paying only for what is left.

## What it reports

With `OTEL_EXPORTER_OTLP_ENDPOINT` set it exports, as `semiont-worker`, the rows
[`specs/src/service-telemetry/telemetry.json`](../../specs/src/service-telemetry/telemetry.json)
lists for the worker: a span and an outcome for every job, every generation, and every
detection call with its items, tokens and anchoring outcomes (the `semiont.detection.*`
metrics), so a run's cost, yield and precision can be queried.
See [Observability](../../docs/operator/administration/OBSERVABILITY.md) for the full
inventory and where the metrics flow.

## Configuration

A JSON document, named by `--config` (the image passes `/etc/semiont/worker.json`), whose
schema is [`WorkerConfig`](../../specs/src/components/schemas/WorkerConfig.json). The worker
defaults nothing in it.

| Member | |
| --- | --- |
| `gatewayUrl` | the gateway's URL |
| `identity.issuer` | the issuer its service account signs in at |
| `agents` | the engines: each a provider and a model, the jobs it claims, the provider's address, and the variable holding its key |
| `modelCatalogue` | the path of the model catalogue |
| `port` | the health port |
| `logLevel`, `logFormat` | how it logs |

It reads no configuration of the knowledge base: the launcher resolves the knowledge base's
WorkerPool and Inference documents
([Configuration](../../docs/operator/administration/CONFIGURATION.md)) into this document for
the worker it starts, and a worker started some other way is given the same document.

Its environment is `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_KEY`, its own service
account at the knowledge base's issuer and the RSA key it proves itself with, and each variable
its document names, such as `ANTHROPIC_API_KEY`. No secret is sent: each sign-in carries an
assertion signed with the key, which the issuer checks with the public half registered on the
worker's client. It mounts nothing but the document.

Started without `--config`, with a document that does not validate, or with a named variable
unset, it refuses to start: one line on stderr that begins `[fatal] ` and says which, and
exit status 1. The [service catalog](../../docs/operator/services/OVERVIEW.md) states this
beside the other services.

## What the image carries

The service, and the three Python packages of this repository it runs on: the SDK
([`packages/python/sdk`](../../packages/python/sdk/)), its client of the gateway; the
inference drivers ([`packages/python/inference`](../../packages/python/inference/)), which
ask a model provider; and what every Python service is built on
([`packages/python/service`](../../packages/python/service/)), which reads its configuration,
answers for its health, writes its log and exports its telemetry. All four are built into
the image from the commit it is published from, and carry
[`version.json`](../../version.json)'s version. Everything else in its environment is what
[`uv.lock`](./uv.lock) pins. Nothing is built, installed or fetched when the container
starts.

**Every provider's library is in it.** The drivers ask each provider through that provider's
own library, which their package brings as an extra named for the provider
([what an install has](../../packages/python/inference/README.md#what-an-install-has)). The
image is built with every extra, so it is not rebuilt to be pointed at another provider.

**The service can be configured for any of the seven providers the protocol names:**
`anthropic`, `google`, `llamacpp`, `ollama`, `openai`, `together` and `vllm`. An engine of its
document ([`WorkerAgentConfig`](../../specs/src/components/schemas/WorkerAgentConfig.json))
names one of them, and a document that names another is refused when the service starts. A
model of `google`, `openai` or `together` is asked with what the model catalogue says of it,
which the image carries at `/usr/share/semiont/model-catalogue.json` and the document names
(`modelCatalogue`). Only `anthropic` and `ollama` have been run against the real provider.

**Typst ships in the image** (pinned) so generation can produce PDFs with real page geometry
rather than recovered coordinates.

It runs on the oldest Python the repository's Python packages support, on Alpine, as the
user `semiont`. It carries no installer (`pip`, `uv`) and no Node.

### A slimmer image

The one line that decides which providers' libraries an image has is the builder stage's
`uv sync` in the [Dockerfile](./Dockerfile). `--all-extras` asks for every extra of
`semiont-worker`, each of which brings the drivers' extra of the same name. An image for one
provider names that provider's in its place:

```dockerfile
RUN uv sync --project images/worker --locked --no-dev --no-editable --extra anthropic
```

An image for Ollama alone names none: Ollama is asked with what every install has. A
service whose document names a provider its image has no library for refuses to start, and
names the drivers' extra that brings it.

## Working on it

In this directory:

```sh
uv sync --locked
uv run pytest        # needs the `typst` program on PATH
```

The tests of the Typst compiler fail without it rather than skip; CI takes `typst` from the
image the [Dockerfile](./Dockerfile) copies it from. The checkers are `uv run mypy`,
`uv run pyright`, `uv run ruff check` and `uv run ruff format --check`.

## Building it

From the repository root, on the Python [`scripts/ci/python-floor.sh`](../../scripts/ci/python-floor.sh)
prints:

```bash
docker build --build-arg PYTHON_FLOOR=$(scripts/ci/python-floor.sh) \
  --file images/worker/Dockerfile --tag ghcr.io/the-ai-alliance/semiont-worker:local .
```

[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) builds it so with the other
images, and [`scripts/container/check-python-image.sh`](../../scripts/container/check-python-image.sh)
checks what a built one promises.

## Related

- [WORKER-SERVICE.md](../../docs/protocol/WORKER-SERVICE.md) — what the worker does, rule by rule
- [WORKER-CONTRACT.md](../../docs/protocol/WORKER-CONTRACT.md) — the contract every worker keeps
- [JOBS.md](../../docs/protocol/JOBS.md) — the job protocol, and the dispatcher's side of it
- [`semiont-worker` skill](../../docs/builder/skills/semiont-worker/SKILL.md) — building your own job-claim daemon
- [Adding a kind of job](../../docs/contributor/ADDING-A-JOB.md) — the path of a new kind of job through the spec, the SDKs, the dispatcher, this service, its suite and its rules
