# Worker-service conformance suite

A black-box suite for the Worker service: the process a worker image runs. It
starts the service from a command, with a configuration document and an
environment, and meets it only where the rest of Semiont does: on the bus and
at the gateway's HTTP surface, at its provider, at its health port, and in
what it writes and how it exits. It checks what the service does against
[docs/protocol/WORKER-SERVICE.md](../../../docs/protocol/WORKER-SERVICE.md).

The [worker suite](../worker/README.md) beside it holds an SDK's claiming to
[the worker contract](../../../docs/protocol/WORKER-CONTRACT.md), through a
driver. This one holds the service: how it boots, what it claims, what it asks
a model, what it commits, how it ends a job, how it stops.

The suite imports nothing from a Worker service. The lines that name one are
`WORKER_SERVICES` in [harness/paths.ts](../harness/paths.ts): today Semiont's
own, the Python service of `images/worker`, `python -P -m semiont_worker` by the
interpreter of its project's environment (`images/worker/.venv`). Every case
runs against every entry.

## The world around a Worker service

Each file runs its cases in a world of its own
([harness/worker-service-world.ts](../harness/worker-service-world.ts)). Its
knowledge base, which every case's service serves, is the suite's own
identity in [`kb-identity/cases.json`](../../../specs/src/kb-identity/cases.json),
and a case of a service of two knowledge bases has it serve the world's
second beside it, another case of that table. Each knowledge base has:

- the trusted issuer, which holds the public half of the service's key on a
  client of that knowledge base's own (the two clients are named apart), and
  grants that account the service and worker roles and marks it an agent's:
  the gateway names the service by that account, as one agent there,
  whatever engines it runs. A case can have it fail a grant first, answered
  503 or its connection ended unanswered;
- a real gateway, on the in-process plane, with the harness's stand-in
  Archivist behind it for a resource's bytes, for uploads, and for a
  resource's anchored text, the text the Smelter read out of a PDF: a case
  scripts what the Archivist answers a read of it, and a resource it scripts
  nothing for is one the Archivist does not know;
- a recording proxy in front of the gateway, which that knowledge base's
  `gatewayUrl` names in the service's document: everything the service sends
  the gateway is read from it as a transcript, in order (its sign-in, the
  stream it opens and what that stream carries, each emit, each read of bytes
  or of anchored text, each upload), and a case can end the service's
  connections through it, which the service meets as a stream that drops;
- the suite itself on the gateway's bus, as the two parties a worker asks
  things of there. As the dispatcher it answers `job:claim` from the jobs a
  case queued at that knowledge base, with `none-pending` when no queued job
  matches the claim's filters. As the record it answers `browse:kb-requested`
  with that knowledge base's domain, or as a case scripts it (another domain,
  `browse:kb-failed`, or no answer until the case lets it give one), and
  `browse:resource-requested`, `mark:commit` (an annotation is recorded once,
  by its id) and `browse:annotation-requested`.

Beside them, shared by every knowledge base's engines:

- the engines a case's service runs, two of Ollama and two of Anthropic, the
  world's own fixtures;
- a stand-in Ollama ([harness/ollama.ts](../harness/ollama.ts)), which the
  `baseUrl` of an Ollama engine names. It answers `POST /api/show` with the
  context length a case set, or refuses it, or ends the connection
  unanswered, and `POST /api/generate` with what the case scripted, and
  records every request as it was sent;
- a stand-in Anthropic ([harness/anthropic.ts](../harness/anthropic.ts)),
  which the `baseUrl` of an Anthropic engine names. It plays the provider
  under version 2026-10-21 of its API: it takes a request only with the key
  as `Authorization: Bearer <key>`, and refuses with 400, on every model, a
  generation that carries `temperature`, `top_p` or `top_k`. It answers `GET
  /v1/models/{model}` with what a case said of the model, and `POST
  /v1/messages` with what the case scripted: an answer, as one message or as
  the stream of events the request asked for, a refusal, a held answer, or a
  connection ended unanswered. A refusal may carry headers, and so may one
  of the Models API. It records every request with its headers.
  Its key reaches the service in the variable the engine's `apiKeyEnv` names,
  which is none the provider's own library reads.

No dispatcher, no Archivist, no Smelter and no model runs. This is the tier
that sees every message the service sends.

The service's key is the world's own, in `SEMIONT_OIDC_CLIENT_KEY`; which
client it signs in as at each knowledge base is its document's. A case starts
a fresh service, which is stopped when the case ends.

## What every case holds a Worker service to

Whatever a case is about, it also fails a service that:

- asks a gateway for anything the gateway refuses: each gateway is the real
  one, and holds every emit to its channel's schema and every route to its
  rules;
- asks a provider for a generation the case did not script, or for any path
  but the two of Ollama's and the two of Anthropic's above;
- asks the stand-in Anthropic for anything without the key, or about a model
  the case has not described, or for a generation that carries
  `temperature`, `top_p` or `top_k`;
- puts on the bus, or has the gateway ask the Archivist for, what the spec
  does not allow.

The suite must hand a service only what the spec allows, too: a job it queues
is held to `JobClaimedResult`, and an anchored text it scripts to
`AnchoredTextAnswer`, as everything the stand-in Archivist answers is held to
the Archivist's spec.

## What a case compares, and how

- **Prompts** are files in [prompts/](prompts/): each is the exact text of one
  prompt, less its one final line end. A case holds the whole body of each
  request to the provider and the order the requests arrive in: of Ollama,
  the model, the prompt, `stream`, `think`, the three `options` and the
  `format`; of Anthropic, the model, `max_tokens`, the one message, the
  `output_config` and, of a long generation, `stream`, and no
  `temperature`.
- **Annotations** are compared whole: `id`, selectors, body and `generator`,
  in the batches they were committed in. `created` must be an instant and is
  otherwise the service's own. The annotations a `yield` job commits are on,
  or point at, a resource the case learns of only as it runs, so a case works
  their ids out from what they are, by the rule of
  [`id-cases.json`](../../../specs/src/annotations/id-cases.json).
- **Messages a service waits on** (the claim, `job:start`, the read of the
  description and of the bytes or the anchored text, each commit and each
  checkpoint, the settle, the next claim) are compared in the order the
  gateway received them. What a service says at a knowledge base as it
  starts there (its sign-in, its stream, the question of which knowledge base
  this is, and what the agent is called) is compared apart, against the
  frames its stream carried, on the one clock the proxy keeps.
- **Health** is held to the spec's `WorkerHealth` each time a case reads it,
  and then compared as the case needs.
- **Progress reports** are compared as a set with repeats: every report, as
  often as it was made, in no order. A service does not wait for the gateway
  to take one before it goes on, so where they fall among the other messages
  is not fixed.
- **A cancellation** is asked for while the provider's answer is held, and
  the answer is let go only when the service has had the cancellation: its
  stream carries frames in the order they were sent, so its answer to a
  request sent after the cancellation says the cancellation has arrived.
- **Text** in most fixtures is of the Basic Multilingual Plane, with
  characters outside ASCII ahead of most spans: an offset counted in bytes
  fails. The texts of `code-points` have characters outside that plane ahead
  of their spans, inside them, and throughout the pieces of a long text: an
  offset or a length counted in UTF-16 code units fails.

## The cases

| Case | File | Rules of WORKER-SERVICE.md |
|---|---|---|
| `boot` | `boot.test.ts` | B1 to B7, R5 |
| `started` | `started.test.ts` | G1 to G5, H1 |
| `knowledge-bases` | `knowledge-bases.test.ts` | G1, G4, G5, H1, R1 to R4 |
| `limits` | `limits.test.ts` | M1 to M3, M5 |
| `highlighting` | `highlighting.test.ts` | J1, J2, D1 to D3, D8, D9, D11 to D13, D15 to D17, K1 |
| `commenting` | `commenting.test.ts` | D8, D9, D12, D17, K2 |
| `assessing` | `assessing.test.ts` | D5, D12, D17, K3 |
| `linking` | `linking.test.ts` | D8, D12 to D15, D18, K4 to K6 |
| `tagging` | `tagging.test.ts` | D9, D12, D14, D15, D19, K7 |
| `anchoring` | `anchoring.test.ts` | D8 |
| `prompts` | `prompts.test.ts` | D2, D3, K1 to K4, K7 |
| `chunks` | `chunks.test.ts` | D3 to D6, D13, D17 |
| `code-points` | `code-points.test.ts` | D3 to D5, D9, D12, D13, D17 |
| `pdf` | `pdf.test.ts` | J2, D10, D12, N1, N2, N4, N5 |
| `declines` | `declines.test.ts` | J2, N1, N3, N6 to N8 |
| `failures` | `failures.test.ts` | D3, F1 to F5, F7, F8, F14 |
| `halved` | `halved.test.ts` | F6 |
| `resume` | `resume.test.ts` | D13 to D15, D18, U1 to U3 |
| `cancel` | `cancel.test.ts` | Q1 to Q5 |
| `yield` | `yield.test.ts` | J3, Y1 to Y8 |
| `telemetry` | `telemetry.test.ts` | T1 to T4 |
| `environment` | `environment.test.ts` | E1 to E11 |
| `output` | `output.test.ts` | O1 |
| `stop` | `stop.test.ts` | P1 to P3, R2, R5 |
| `anthropic` | `anthropic.test.ts` | M5, D20, D21, K8, F3 to F5, F10 to F14, Q4, Y3, Y9, T3, P2 |

`npm run lint:transport-contract` holds the two to each other: every case a
rule names exists, and every case is named by a rule.

## What the suite cannot show

| What | Why no case holds it |
|---|---|
| The budget of an Anthropic model whose own ceiling on what it writes leaves it 64 tokens or fewer to read | The document does not cover it. A model with 37 tokens of room fails its job where one with none is asked, and no case holds either until it is settled which is meant |
| Which of a generation's two token counts is what the model read (T3) | The receiver keeps a metric's values apart from its attributes. `anthropic.test.ts` holds that the two counts are the two the provider reported, and that both directions are counted |
| A stream that ends partway | Not written: the stand-in Anthropic ends a connection only before it answers |
| A wait of two minutes that is waited, and a wait stated as a date (F11) | A case cannot wait two minutes. `anthropic.test.ts` holds a wait of two seconds as waited, and one of two minutes and a second as not waited, by `retry-after` and by `retry-after-ms`. The edge and the date are held by each driver's own tests, which move a clock |
| A request of Anthropic refused with 408 or 409 (F10) | Not written. `anthropic.test.ts` holds 429, 500, 529 and a connection that ends as asked for three times, and 400 as asked for once. A 409 is asked for three times and then fails its job as deterministic ([F3](../../../docs/protocol/WORKER-SERVICE.md#failures)): whether both are meant is not settled |
| A `yield` job to PDF, and the citations of a generated PDF | It needs the `typst` binary in the suite's environment |
| A real dispatcher, Archivist or Smelter | The suite stands in for them, so that it can hand a service answers a correct one never gives and see every message |
| How long a knowledge base in trouble waits after its first start again, and its ceiling (R3) | The first wait is stated in the log and held as waited; the doubling and `maxReconnectMs` take seconds to a minute that a case cannot shorten. `images/worker/tests/test_service.py` holds them, on a clock it moves |
| A knowledge base whose confirmation is not answered in time (R1, R3) | The request's deadline is the SDK's `busRequestTimeoutMs`, thirty seconds, which a case cannot shorten. `knowledge-bases.test.ts` holds a confirmation held unanswered for less, and, as the trouble that is started again, a grant its issuer answers 503 or ends unanswered |
| A sign-in, or the gateway's naming of the agent, accepted and never answered (R3) | Its deadline is the SDK's `httpRequestTimeoutMs`, thirty seconds, which a case cannot shorten. `knowledge-bases.test.ts` holds a grant whose connection ends unanswered |
| A knowledge base whose stream is closed, so that nothing more can be claimed there (R3) | Nothing outside a service closes its stream: a transport's stream is `closed` only once its client is disposed ([TRANSPORT-CONTRACT § State](../../../docs/protocol/TRANSPORT-CONTRACT.md#state)). One a case ends through the proxy drops and is opened again, which `knowledge-bases.test.ts` holds as no trouble |
| A knowledge base whose gateway refuses to name the agent (R2), or answers its naming with a status the `refresh` rule tries again (R3) | Not written: `knowledge-bases.test.ts` holds an issuer that refuses the sign-in, and one that answers it 503 or not at all, and `stop.test.ts` a claim refused as unauthorized |
| M4, F9, P4 and R3's stalled job: the clocks | 1.5 seconds for a provider's limits, ten minutes for a generation and every asking of it, fifteen minutes for a stalled job. A service takes them from no document a case could shorten |
| D7, the size of a piece following the provider's usage | Not written. On a model whose window is shared, as the stand-in Ollama's is, the ceiling of a piece is where it opens unless the window is far over what any fixture fills. A model of the stand-in Anthropic has two ceilings, and a case on it could hold the rule |
| K6 for a piece taken to have missed mentions that can be cut smaller, and F7 for an answer not had in time or unreadable for a reason the provider does not state | Not written: `linking.test.ts` holds a count that answers no count, `halved.test.ts` holds the halving of a piece whose answer is cut off, and `failures.test.ts` that of one whose model finished and could not be read. A generation not had in time takes the ten minutes of F9 |
| The commit whose acknowledgement is lost | [WORKER-CONTRACT A5](../../../docs/protocol/WORKER-CONTRACT.md#committing-annotations), held by the worker suite: a service waits a minute for an acknowledgement |

## Adding an implementation

Add its command to `WORKER_SERVICES` in
[harness/paths.ts](../harness/paths.ts), and what builds it to
[harness/worker-service-setup.ts](../harness/worker-service-setup.ts). It is
started as the one there is: `<command> --config <document>`, with the
variables [WORKER-SERVICE.md § Environment](../../../docs/protocol/WORKER-SERVICE.md#environment)
names, any variable its document's `apiKeyEnv` names, and `PATH`. It passes
every case unchanged.

## Running it

It needs a built gateway, `nats-server` (2.10 or later) on `PATH`,
`@semiont/core` built, and the Python service's environment made with every
provider's library, as its image has them, which needs `uv` and Python 3.12
or later on `PATH`:

```bash
cargo build --release -p semiont-gateway
npm run build --workspace=@semiont/core
uv sync --locked --no-dev --all-extras --project images/worker
cd tests/conformance
npm ci
npm run test:worker-service
```
