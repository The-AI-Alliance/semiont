# Worker conformance suite

A black-box suite for workers. A worker written on an SDK is put through one
corpus of cases against a real gateway, with the suite playing the
dispatcher, and must do on the wire, and report to its author, what
[the worker contract](../../../docs/protocol/WORKER-CONTRACT.md) says. The
corpus is data: a case is a JSON file, the same file for every language.
What differs per language is a **worker driver**, a small program that turns
the suite's operations into calls on that SDK's worker surface and writes
back what happened.

The suite imports nothing from an SDK. The lines that name one are the
`worker` entries of `SDK_DRIVERS` in [harness/paths.ts](../harness/paths.ts).
An SDK with no worker surface has no entry, and the suite does not run it.

Its one entry is `worker.test.ts`: every case in [cases/](cases/), for every
SDK that has a worker driver, on each signal plane.

The case format, the steps, the values and the backend directives are the
SDK suite's ([sdk/README.md § A case](../sdk/README.md#a-case)), and so is
the runner ([sdk/case.ts](../sdk/case.ts)). This document states only what
the worker suite adds.

## What every case holds a worker to

A worker's requests are read as a transcript, every one, in order, as a wire
case reads a client's. So whatever a case is about, it also fails a worker
that:

- claims when the case does not expect a claim: while it holds a job, while
  a claim is in flight, or with no idle moment to claim at;
- settles a job twice, or emits any lifecycle message the case does not
  account for;
- emits a lifecycle message under a scope: each is compared whole, and none
  carries one;
- sends a payload the gateway refuses: the gateway is the real one, and holds
  `job:claim`, `job:start`, `job:report-progress`, `job:checkpoint`,
  `job:complete`, `job:fail` and `job:cancel` to their schemas;
- says it claimed a job, was refused, saw a cancellation or stalled when the
  case does not expect it to;
- reports a failure with a code
  [`specs/src/errors/codes.json`](../../../specs/src/errors/codes.json) does
  not list.

## The backend

The gateway is the real one, on each signal plane. **No dispatcher runs.**
The suite's participant listens for `job:claim` and answers each claim as a
case tells it to: with a job, with `none-pending`, with a refusal, with a
reply that names no job, or not at all. It announces jobs (`job:queued`) and
asks for cancellations (`job:cancel-requested`) the same way. So a case can
put a worker in front of an answer a correct dispatcher never gives.

The worker signs in as an agent whose token carries the worker role.

## The worker driver

The protocol is the SDK suite's
([sdk/README.md § The driver protocol](../sdk/README.md#the-driver-protocol)):
one JSON object per line each way, an answer for each operation, and what the
worker observes written as it happens.

| `op` | Arguments | `ok` |
|---|---|---|
| `open` | `baseUrl`, `token`, `timing` | `null`. The stream it opens names what a worker's stream names; a case states which channels those are |
| `close` | | `null` |
| `claim` | `accepts`: the filters of the jobs the worker takes | `null`. The worker begins claiming, and claims from then on at every idle moment |
| `start` | | `null`. The held job's `job:start` |
| `progress` | `percentage`, and `message` when given | `null` |
| `checkpoint` | `completedUnits`, `unitCursors` | `null` |
| `complete` | `result` | `null`. The held job is settled |
| `fail` | `error`, and `failureClass`, `completedUnits`, `unitCursors` when given | `null`. The held job is settled; the worker says whether it will be retried |
| `cancel` | `completedUnits` when given | `null`. The held job is settled as cancelled |
| `vitals` | | the worker's vitals |
| `subscribe-resource` | `resource` | `null`. The worker's stream takes a hold on the resource's scope |
| `sync` | | `null`, after everything the worker reported before it |

It writes, as they happen, beside the transport's `state` and `error` lines:

| Line | Meaning |
|---|---|
| `{"claimed": {"jobId": "...", "jobType": "...", "resourceId": "...", "params": {...}, "completedUnits": [...], "unitCursors": {...}, "retryCount": 0, "maxRetries": 3}}` | the worker holds a job, read from the claimed record |
| `{"refused": {"code": "...", "detail": "..."}}` | a claim was refused; `code` is absent when the worker refused the reply itself |
| `{"signalled": "<jobId>"}` | a cancellation of the held job was signalled to the work |
| `{"stalled": "<jobId>"}` | the held job has stalled |

`open`'s `timing` overrides `jobClaimTimeoutMs`, `heldJobStallMs` and
`heldJobStallCheckMs` of
[`specs/src/client/timing.json`](../../../specs/src/client/timing.json)
beside the transport's `reconnectMs`, `lazyRemoveMs` and `lingerMs`, so a
case does not wait out ten seconds or fifteen minutes.

## Steps a worker case adds

| Step | Meaning |
|---|---|
| `{"claimed": {...}}` | the next job the worker says it holds is this one |
| `{"refused": {...}}` | the next refusal it reports is this one: `{"code": "..."}`, or `{}` for one it made itself |
| `{"signalled": "<jobId>"}` | the next cancellation it says was signalled is of this job |
| `{"stalled": "<jobId>"}` | the next stall it reports is of this job |

By the end of a case the worker has reported none of these that the case
did not expect.

## The cases

| Case | Rules of the contract |
|---|---|
| `claim-on-start` | S1, C1, R1 |
| `claim-on-announcement` | C1, C5 |
| `claim-on-reopen` | C1 |
| `one-claim-in-flight` | C2, C3 |
| `announcement-while-held` | C4 |
| `none-pending` | C6 |
| `refusal` | C7 |
| `handover` | C8 |
| `malformed-reply` | C9 |
| `claim-timeout` | C10 |
| `checkpoint-read` | R2 |
| `lifecycle` | C1, L1, L2, L3, L5, L6, L7 |
| `fail-will-retry`, `fail-final` | L4 |
| `cancel` | X1, X2 |
| `vitals` | V1 |
| `stall` | L2, V2 |

`npm run lint:transport-contract` holds the two to each other: every case is
named by a rule of the contract, and a case's `source` names a section in
which a rule is held by it.

## What the suite cannot show

| Rule | Why no case holds it |
|---|---|
| A1, A2, A3, committing annotations | No driver commits an annotation: building one is the work, which is the worker's own. What the record does with a commit is held by the [Archivist suite](../archivist/README.md). |

**For TypeScript, `handover` cannot fail by a fault in the worker.** Its
transport reports no change of state when a stream hands over, so a worker is
told nothing it could wrongly claim on: one that claims at every `open` it is
told of passes the case. The case holds C8 for an SDK whose transport does
report a handover.

**The TypeScript driver composes the lifecycle.** `@semiont/jobs` has the
claim loop, the claimed record, the vitals, the stall rule and the retry rule,
and those are what the cases reach. It has no held job that emits and
releases in one call: a worker's author emits each lifecycle message on the
transport and then tells the adapter the job is settled. The driver does the
same. So for TypeScript the cases of L1 to L7, X1 and X2 hold that
composition, written in the driver, and not the package.

## Adding an SDK

Write a worker driver over the SDK's worker surface, add it as `worker` to
the SDK's line of `SDK_DRIVERS`, and run the suite. TypeScript's is
[packages/jobs/conformance/driver.ts](../../../packages/jobs/conformance/driver.ts).

## Running it

It needs a built gateway, `nats-server` (2.10 or later) on `PATH`, and the
packages built:

```bash
cargo build --release -p semiont-gateway
npm run build:packages
cd tests/conformance
npm ci
npm run test:worker
```

The suite type-checks the TypeScript driver before it starts: Node runs it
with its types stripped, and would run a mistyped one.
