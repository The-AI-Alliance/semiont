# semiont-worker

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-worker)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

**The worker claims queued jobs and runs them against a model**: the detection passes, the
generation and the other long-running work that a request cannot wait on. It is a Python
service, answers for its health on port 24100, and is started with the rest of a knowledge
base's stack by the [launcher](../../apps/launcher/README.md) (`semiont start`). One worker
can serve several knowledge bases at once, each apart from the others.

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

At each knowledge base its document names:

- **The issuer**, to sign in as its account there.
- **The bus**, through that knowledge base's gateway: SSE in, for `job:queued`, and
  `POST /bus/emit` out, for claims and a job's lifecycle.
- **The [gateway](../gateway/README.md)**, for a resource's bytes (`GET /resources/{id}`) and
  a PDF's text (`GET /resources/{id}/anchored-text`). The gateway is the only address of the
  knowledge base it holds.

And **an inference provider** for each engine, for its model.

**It pulls.** At every moment it becomes idle (start, settle, a matching `job:queued` while
parked, reconnect) it asks the [dispatcher](../dispatcher/README.md) for the next job among
those it claims, and parks when told nothing is pending. `job:queued` is a wake-up with no
memory, not a reservation. Claims are atomic, so several workers can run against one queue
without coordination.

## An agent at each knowledge base, an engine for each provider and model

The worker is **an agent at each knowledge base** of its document: there, the account its
entry's `identity` names at that knowledge base's issuer, signed in once. The token the issuer
grants is its bearer at that gateway, and the DID the gateway names it by
(`GET /api/users/me`) is what that bus stamps on every event it emits. Each knowledge base has
its own sign-in, stream, claims, profile and limits, and none waits on another.

At each it runs **one engine for each entry of that knowledge base's `engines`**: a provider
and a model, and the jobs it does with that engine there. The engines of one knowledge base
work at once, over the agent's one stream there, and each holds one job at a time. Two
knowledge bases that name one engine share its provider's client. An engine is no part of who
the agent is: the `generator` on everything a job makes names the agent by its DID at the
knowledge base the job came from and the engine that made it, so `_userId` on the bus and the
`generator` on every annotation refer to the same agent.

What the agent is called is its profile. At each knowledge base, once the stream is open, it
first asks which knowledge base it is (`browse:kb-requested`) and goes on only at the domain
its entry names. Then, before any engine claims, it says it is called by that knowledge base's
`identity.clientId`, on `principal:profile`, and readers name it from that, as they name a
person. The `generator` carries no name.

## One knowledge base's trouble is its own

Each knowledge base is `starting`, `working` or `refused`, and what happens at one happens
there alone.

- **Refused**: its issuer refuses the sign-in, or its gateway refuses to name the agent, with
  an answer the SDK does not try again; it answers `browse:kb-requested` with another domain,
  or with `browse:kb-failed`; or a claim there is refused as `unauthorized`, because the grant
  is gone. It is said once in the log (`Knowledge base refused the worker`, at `error`), its
  stream is closed, and it stays refused until the service is started again.
- **Trouble**: a sign-in that gets no answer, or one the SDK would try again; no answer to
  `browse:kb-requested` in time; its stream closed for good; a held job that stalls. Its work
  ends, failing a job still held there, and it is started again, signed in afresh, after the
  SDK's `reconnectMs`, twice that each further time up to `maxReconnectMs`
  (`Knowledge base in trouble — starting it again`, at `warn`, with `waitMs`). A stream that
  drops is not trouble: the SDK opens it again by itself.

When every knowledge base has refused it, the service exits with status 1. If none was ever
confirmed it says so on stderr as it says every refusal to start; if one was, its log has
said each refusal already.

## Nothing wedges, nothing restarts from zero

Each call to the model is given **ten minutes**, and while one is under way the job reports
where it stands every fifteen seconds. A held job that stalls starts its knowledge base again,
loudly; and a running job nothing has touched for long enough is recovered by the dispatcher's
sweep ([JOBS.md](../../docs/protocol/JOBS.md#periodic-work)).

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
metrics), so a run's cost, yield and precision can be queried. Its own spans and metrics
name, as `semiont.kb`, the knowledge base whose job it was; what a provider's driver
counts of a generation (`semiont.inference.*`) names none.
See [Observability](../../docs/operator/administration/OBSERVABILITY.md) for the full
inventory and where the metrics flow.

## Configuration

A JSON document, named by `--config` (the image passes `/etc/semiont/worker.json`), whose
schema is [`WorkerConfig`](../../specs/src/components/schemas/WorkerConfig.json). The worker
defaults nothing in it.

| Member | |
| --- | --- |
| `knowledgeBases` | the knowledge bases it serves, at least one, no two of one `domain`; each as below |
| `knowledgeBases[k].domain` | the domain that knowledge base says it is |
| `knowledgeBases[k].gatewayUrl` | its gateway's URL |
| `knowledgeBases[k].identity.issuer`, `.clientId` | the issuer its account there signs in at, and the client that account is |
| `knowledgeBases[k].engines` | its engines: each a provider and a model, the jobs it claims with it there, the provider's address, and the variable holding its key |
| `modelCatalogue` | the path of the model catalogue |
| `port` | the health port |
| `logLevel`, `logFormat` | how it logs |

It reads no configuration of a knowledge base: the launcher resolves the machine's WorkerPool
document and the knowledge base's Inference document
([Configuration](../../docs/operator/administration/CONFIGURATION.md#the-worker)) into this
document for the worker it starts, and a worker started some other way is given the same
document.

Its environment is `SEMIONT_OIDC_CLIENT_KEY`, the RSA key it proves itself with at every
knowledge base, and each variable its document names, such as `ANTHROPIC_API_KEY`. Each
knowledge base's issuer holds the key's public half on the client that knowledge base's
`identity.clientId` names. No secret is sent: each sign-in carries an assertion signed with the
key. It mounts nothing but the document.

Started without `--config`, with a document that does not validate or that names one domain
twice, without the key, or with a named variable unset, it refuses to start before it dials
anything: one line on stderr that begins `[fatal] ` and says which, and exit status 1. The
[service catalog](../../docs/operator/services/OVERVIEW.md) states this beside the other
services.

`GET /health` answers once a knowledge base is confirmed, with a
[`WorkerHealth`](../../specs/src/components/schemas/WorkerHealth.json):
`{"status": "ok", "knowledgeBases": [...]}`, each knowledge base in the document's order with
its `domain` and `state` (`starting`, `working` or `refused`), and, while it is `working`, the
agent's `did` there and its `engines`. Each engine is its `engine` (`provider` and `model`),
the `jobs` it claims, and what its claims say of themselves: `lastQueuedEventAt`,
`lastClaimAt`, `lastFinishedAt` and `lastActivityAt`, each an instant or `null`, `activeJob`,
`null` or the held job's `jobId`, `type` and `since`, and `jobsCompleted`.

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
document ([`WorkerEngineConfig`](../../specs/src/components/schemas/WorkerEngineConfig.json))
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
