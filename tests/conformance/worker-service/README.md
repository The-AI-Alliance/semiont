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
`WORKER_SERVICES` in [harness/paths.ts](../harness/paths.ts): today the
TypeScript service, `node packages/jobs/dist/worker-main.js`. Every case runs
against every entry.

## The world around a Worker service

Each file runs its cases in a world of its own
([harness/worker-service-world.ts](../harness/worker-service-world.ts)):

- the trusted issuer, which grants the service's account the service and
  worker roles;
- a real gateway, on the in-process plane, with the harness's stand-in
  Archivist behind it for a resource's bytes and for uploads;
- a recording proxy in front of the gateway, which the service's `gatewayUrl`
  names: everything the service sends the gateway is read from it as a
  transcript, in order (each sign-in, each stream it opens, each emit, each
  read of bytes, each upload);
- a stand-in Ollama ([harness/ollama.ts](../harness/ollama.ts)), which the
  service's `baseUrl` names. It answers `POST /api/show` with the context
  length a case set and `POST /api/generate` with what the case scripted, and
  records every request as it was sent;
- the suite itself on the bus, as the three parties a worker asks things of.
  As the dispatcher it answers `job:claim` from the jobs a case queued, with
  `none-pending` when no queued job matches the claim's filters. As the record
  it answers `browse:resource-requested`, `mark:commit` (an annotation is
  recorded once, by its id) and `browse:annotation-requested`. As the Smelter
  it answers `browse:anchored-text-requested`.

No dispatcher, no Archivist and no model runs. This is the tier that sees
every message the service sends.

A case starts a fresh service, which is stopped when the case ends.

## What every case holds a Worker service to

Whatever a case is about, it also fails a service that:

- asks the gateway for anything the gateway refuses: the gateway is the real
  one, and holds every emit to its channel's schema and every route to its
  rules;
- asks its provider for a generation the case did not script, or for any path
  but the two an Ollama driver uses;
- puts on the bus, or has the gateway ask the Archivist for, what the spec
  does not allow.

The suite must hand a service only what the spec allows, too: a job it queues
is held to `JobClaimedResult`, and a Smelter's answer to
`BrowseAnchoredTextResult`.

## What a case compares, and how

- **Prompts** are files in [prompts/](prompts/): each is the exact text of one
  prompt, less its one final line end. A case holds the whole body of each
  request to the provider (the model, the prompt, `stream`, `think`, the
  three `options` and the `format`) and the order the requests arrive in.
- **Annotations** are compared whole: `id`, selectors, body and `generator`,
  in the batches they were committed in. `created` must be an instant and is
  otherwise the service's own. The annotations a `yield` job commits are on,
  or point at, a resource the case learns of only as it runs, so a case works
  their ids out from what they are, by the rule of
  [`id-cases.json`](../../../specs/src/annotations/id-cases.json).
- **Messages a service waits on** (the claim, `job:start`, the read of the
  description and of the bytes, each commit and each checkpoint, the settle,
  the next claim) are compared in the order the gateway received them.
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
| `boot` | `boot.test.ts` | B1 to B6 |
| `started` | `started.test.ts` | G1 to G4, H1 |
| `limits` | `limits.test.ts` | M1 to M3 |
| `highlighting` | `highlighting.test.ts` | J1, J2, D1 to D3, D8, D9, D11 to D13, D15 to D17, K1 |
| `commenting` | `commenting.test.ts` | D8, D9, D12, D17, K2 |
| `assessing` | `assessing.test.ts` | D5, D12, D17, K3 |
| `linking` | `linking.test.ts` | D8, D12 to D15, D18, K4, K5 |
| `tagging` | `tagging.test.ts` | D9, D12, D14, D15, D19, K7 |
| `anchoring` | `anchoring.test.ts` | D8 |
| `prompts` | `prompts.test.ts` | D2, D3, K1 to K4, K7 |
| `chunks` | `chunks.test.ts` | D3 to D6, D13, D17 |
| `code-points` | `code-points.test.ts` | D3 to D5, D9, D12, D13, D17 |
| `pdf` | `pdf.test.ts` | J2, D10, D12, N1, N2, N4, N5 |
| `declines` | `declines.test.ts` | J2, N1, N3, N6 to N8 |
| `failures` | `failures.test.ts` | D3, F1 to F5, F8 |
| `halved` | `halved.test.ts` | F6 |
| `resume` | `resume.test.ts` | D13 to D15, D18, U1 to U3 |
| `cancel` | `cancel.test.ts` | Q1 to Q5 |
| `yield` | `yield.test.ts` | J3, Y1 to Y8 |
| `telemetry` | `telemetry.test.ts` | T1, T2 |
| `environment` | `environment.test.ts` | E1 to E11 |
| `output` | `output.test.ts` | O1 |
| `stop` | `stop.test.ts` | P1 to P3 |

`npm run lint:transport-contract` holds the two to each other: every case a
rule names exists, and every case is named by a rule.

## What the suite cannot show

| What | Why no case holds it |
|---|---|
| A job on Anthropic | Its driver streams its answer. A stand-in for it is a second step |
| A `yield` job to PDF, and the citations of a generated PDF | It needs the `typst` binary in the suite's environment |
| A real dispatcher, Archivist or Smelter | The suite plays them, so that it can hand a service answers a correct one never gives and see every message |
| M4, F9, P4: the clocks | 1.5 seconds for a provider's limits, ten minutes for a generation, fifteen minutes for a stalled job. A service takes them from no document a case could shorten |
| D7, the size of a piece following the provider's usage | On a model whose window is shared, as the stand-in's is, the ceiling of a piece is where it opens unless the window is far over what any fixture fills |
| F7 and K6, a piece asked again in halves for another reason than a cut-off answer | Not written: `halved.test.ts` holds the halving itself |
| The commit whose acknowledgement is lost | [WORKER-CONTRACT A5](../../../docs/protocol/WORKER-CONTRACT.md#committing-annotations), held by the worker suite: a service waits a minute for an acknowledgement |

## Adding an implementation

Add its command to `WORKER_SERVICES` in
[harness/paths.ts](../harness/paths.ts), and what builds it to
[harness/worker-service-setup.ts](../harness/worker-service-setup.ts). It is
started as the TypeScript one is: `<command> --config <document>`, with the
variables [WORKER-SERVICE.md § Environment](../../../docs/protocol/WORKER-SERVICE.md#environment)
names, any variable its document's `apiKeyEnv` names, and `PATH`. It passes
every case unchanged.

## Running it

It needs a built gateway, `nats-server` (2.10 or later) on `PATH`, and the
packages built:

```bash
cargo build --release -p semiont-gateway
npm run build:packages
cd tests/conformance
npm ci
npm run test:worker-service
```
