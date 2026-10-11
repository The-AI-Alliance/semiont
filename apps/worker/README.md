# semiont-worker

**Claims queued jobs and runs them against a model.** Detection passes, generation, and the
other long-running work that a request cannot wait on.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-worker` |
| Port | 24100 |
| Command | `python -P -m semiont_worker --config /etc/semiont/worker.json` |
| Code | Python, in this directory: [`src/semiont_worker`](./src/semiont_worker/) |
| Package indexes | not published — container only |

What the service does is written rule by rule in
[WORKER-SERVICE.md](../../docs/protocol/WORKER-SERVICE.md), and the
[worker-service conformance suite](../../tests/conformance/worker-service/README.md) holds a
Worker service to each rule. This page is the image, and how it is run.

## What the image carries

The service, and the three Python packages of this repository it runs on: the SDK
([`packages/sdk-python`](../../packages/sdk-python/)), its client of the gateway; the
inference drivers ([`packages/inference-python`](../../packages/inference-python/)), which
ask a model provider; and what every Python service is built on
([`packages/service-python`](../../packages/service-python/)), which reads its configuration,
answers for its health, writes its log and exports its telemetry. All four are built into
the image from the commit it is published from, and carry
[`version.json`](../../version.json)'s version. Everything else in its
environment is what [`uv.lock`](./uv.lock) pins. Nothing is built, installed or fetched when
the container starts.

**Every provider's library is in it.** The drivers ask each provider through that provider's
own library, which their package brings as an extra named for the provider
([what an install has](../../packages/inference-python/README.md#what-an-install-has)). The
image is built with every extra, so it is not rebuilt to be pointed at another provider.

**The service can be configured for two providers today:** `anthropic` and `ollama`, the two
the protocol names. An agent of its document
([`WorkerAgentConfig`](../../specs/src/components/schemas/WorkerAgentConfig.json)) names one
of them, and a document that names another is refused when the service starts.

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
RUN uv sync --project apps/worker --locked --no-dev --no-editable --extra anthropic
```

An image for Ollama alone names none: Ollama is asked with what every install has. A
service whose document names a provider its image has no library for refuses to start, and
names the drivers' extra that brings it.

## One service, an agent for each provider and model

A Worker service works as **one agent for each entry of its document's `agents`**: a
provider and a model, and the jobs that pair serves. The agents of one service work at
once, and each holds one job at a time.

Each agent signs in for **its own identity** via `/api/tokens/agent`, and that token is
what the bus stamps on every event it emits. So `_userId` on the bus and the `generator` on
every annotation it creates refer to the same software peer — attribution is a consequence
of the identity, not a field someone remembered to set.

## What it runs

A job by its `jobType` and, for a `mark` job, by its motivation: a highlighting, commenting,
assessing, linking or tagging pass for a `mark` job, and generation for a `yield` job. The
service claims the job, reads the resource, asks its model, commits what the answer gives,
and reports where the job stands.

## What it talks to

The bus (SSE in for `job:queued`, `POST /bus/emit` out for claims and lifecycle), the gateway's
`GET /resources/{id}` for a resource's bytes and `GET /resources/{id}/anchored-text` for a PDF's
text, and an inference provider. The gateway is the only address of the knowledge base it holds.
It **pulls**: at every moment it becomes
idle — start, settle, a matching `job:queued` while parked, reconnect — it asks the dispatcher
for the next job among those it serves, and parks when told nothing is pending. `job:queued` is a
wake-up with no memory, not a reservation. Claims are atomic, so several workers can run against
one queue without coordination. A claim refused with `unauthorized` — this credential is not a
worker's — exits the process for restart rather than parking forever; the launcher's preflight
names the repair.

## Nothing wedges, nothing restarts from zero

A generation is given **ten minutes**, and while one is under way the job reports where it
stands every fifteen seconds. A held job that stalls ends the service, loudly, for whatever
supervises it to restart; and a running job nothing has touched for long enough is recovered
by the dispatcher's sweep ([JOBS.md](../../docs/protocol/JOBS.md#periodic-work)).

A text is asked about in pieces sized from the model's limits. A piece whose answer cannot
be used for its size is **asked again in halves** before it is allowed to fail the job.

When a job does fail, the service classes the failure: a deterministic one (an identical
retry cannot succeed) is not retried, and neither is an answer the model's provider withheld
(a refusal, a content filter), which is classed `withheld` so that it reads as the
provider's choice and not as the job breaking; a transient one is retried — and the retry
**resumes from the checkpoint** the failed attempt left, paying only for what is left.

Each of these is a rule of [WORKER-SERVICE.md](../../docs/protocol/WORKER-SERVICE.md), under
Pieces, Failures and Resuming.

## What it reports

With `OTEL_EXPORTER_OTLP_ENDPOINT` set it exports, as `semiont-worker`, the rows
[`specs/src/service-telemetry/telemetry.json`](../../specs/src/service-telemetry/telemetry.json)
lists for the worker: a span and an outcome for every job, every generation, and every
detection call with its items, tokens and anchoring outcomes (the `semiont.detection.*`
metrics), so a run's cost, yield and precision are queryable rather than log archaeology.
See [Observability](../../docs/operator/administration/OBSERVABILITY.md) for the full
inventory and where the metrics flow.

## Configuration

A JSON document, named by `--config` (the image passes `/etc/semiont/worker.json`), whose
schema is [`WorkerConfig`](../../specs/src/components/schemas/WorkerConfig.json). It states
the gateway's URL, the issuer, the health port, the log level and format, and `agents`: each
a provider and a model, the jobs that agent claims, the provider's address, and the name of
the variable holding its key. The worker defaults nothing and reads no config of the
knowledge base: the launcher resolves the knowledge base's `workers` and `inference`
sections into this document for the worker it starts, and a worker started some other way is
given the same document.

Its environment is `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET`, its own service
account at the knowledge base's issuer, and each variable its document names, such as
`ANTHROPIC_API_KEY`. It mounts nothing but the document.

Started without `--config`, with a document that does not validate, or with a named variable
unset, it refuses to start: one line on stderr that begins `[fatal] ` and says which, and
exit status 1. The [service catalog](../../docs/operator/services/OVERVIEW.md) states this
beside the other services.

## Building it

From the repository root, on the Python [`scripts/ci/python-floor.sh`](../../scripts/ci/python-floor.sh)
prints:

```bash
docker build --build-arg PYTHON_FLOOR=$(scripts/ci/python-floor.sh) \
  --file apps/worker/Dockerfile --tag ghcr.io/the-ai-alliance/semiont-worker:local .
```

[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) builds it so with the other
images, and [`scripts/container/check-python-image.sh`](../../scripts/container/check-python-image.sh)
checks what a built one promises.

## Related

- [WORKER-SERVICE.md](../../docs/protocol/WORKER-SERVICE.md) — what a Worker service does, rule by rule
- [WORKER-CONTRACT.md](../../docs/protocol/WORKER-CONTRACT.md) — the contract every worker keeps
- [JOBS.md](../../docs/protocol/JOBS.md) — the job protocol, and the dispatcher's side of it
- [`semiont-worker` skill](../../docs/builder/skills/semiont-worker/SKILL.md) — building your own job-claim daemon
- [Adding a kind of job](../../docs/contributor/ADDING-A-JOB.md) — the path of a new kind of job through the spec, the SDKs, the dispatcher, this service, its suite and its rules
