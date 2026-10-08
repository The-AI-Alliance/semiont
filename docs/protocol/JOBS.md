# Job Protocol

This document specifies the job protocol as the dispatcher implements it: the job record and its
states, the nine `job:*` channels the dispatcher answers, the two it emits on its own, its periodic
work, and how it reports health. It describes current behaviour. Behaviour that is a known defect is
not stated as a rule anywhere below; it is listed under [Known defects](#known-defects), and a rule
section that touches one says what happens and links there.

The client side of the two job types is in the flow documents: [Yield](flows/YIELD.md), whose
`yield` job makes a resource, and [Mark](flows/MARK.md), whose `mark` job annotates one. What a
worker promises is [WORKER-CONTRACT.md](WORKER-CONTRACT.md), and how one is built is in the
[`semiont-worker` skill](../builder/skills/semiont-worker/SKILL.md). Channel payloads
are named in [the registry](../../specs/src/bus/registry.json); the bus conventions this document
relies on (`_userId`, `correlationId`, audiences) are in [EVENT-BUS.md](EVENT-BUS.md). The
[dispatcher conformance suite](../../tests/conformance/dispatcher/README.md) checks a running
dispatcher against this document.

## The dispatcher

**The dispatcher is the knowledge base's job control plane.** It holds the queue, admits new jobs,
hands each one to a worker that claims it, and records how it ended. Ids, job types, parameters and
status flow through it. Content never does: a worker reads a resource's bytes on the gateway and
writes its annotations back through the bus, and the dispatcher sees neither.

It is not:

- **a worker.** It runs nothing. A job is performed by a process holding the worker role, which
  claims it.
- **the system of record.** The event log is. The dispatcher's queue is operational state. The
  lifecycle facts that are recorded — `job:started`, `job:assigned`, `job:completed`, `job:failed` —
  are written by the Stower from `job:start`, `job:assign`, `job:complete` and `job:fail`. The
  dispatcher emits none of the four past-tense events.
- **reachable directly.** Its only bus connection is a client of the gateway: an SSE subscription to
  its nine channels (plus the replies to the two reads `job:create` makes) and `POST /bus/emit` for
  what it sends. It authenticates as the software agent `(semiont, dispatcher)`, so everything it
  emits carries that DID as `_userId`. Apart from `/health` it has no HTTP surface. It connects to the
  messaging broker for its queue storage only; workers never touch that storage.

**There is exactly one dispatcher per knowledge base.** It receives every frame on its channels as a
subscriber, not as one member of a competing group, so a second dispatcher would also admit every
`job:create` and answer every `job:claim`. Nothing in the dispatcher enforces this; see
[Known defects](#known-defects).

## Configuration

**The dispatcher reads one document, named by its `--config` flag,** and defaults nothing. The
document is a [`DispatcherConfig`](../../specs/src/components/schemas/DispatcherConfig.json): the
gateway's URL, the issuer its service account signs in at, the broker holding the queue, the port it
answers `/health` on, the queue's clocks, and its log level and format. Its image passes
`--config /etc/semiont/dispatcher.json`, and the launcher writes the document there, resolved from the
knowledge base's config. Started without `--config`, or with a path that names no file, no JSON, or a
document the schema refuses, the dispatcher writes the reason to stderr and exits with status 1 before
it serves.

The document carries no secret. A broker credential is named, as the environment variable that holds
it (`queue.userEnv`, `queue.passwordEnv`), and a named variable that is unset is refused at boot. The
dispatcher's other inputs are the environment variables
[specs/src/service-environment/variables.json](../../specs/src/service-environment/variables.json) lists
for it: its service account, `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET`, the bus log, and
the telemetry variables.

**Access to the job channels is open.** Any authenticated principal may emit any of the nine
channels, and the dispatcher acts on the job the frame names. The one capability check is
`job:claim`'s worker role. This is the system's model — Semiont has no access control
([RBAC.md](RBAC.md)) — not a gap particular to jobs.

## The job record

A job is one record, keyed by its id.

| Field | Present | Value |
|---|---|---|
| `status` | always | `pending`, `running`, `complete`, `failed` or `cancelled` |
| `metadata.id` | always | `job-` followed by 32 lowercase hexadecimal digits, minted at admission |
| `metadata.type` | always | the [`JobType`](../../specs/src/components/schemas/JobType.json): `mark` or `yield` |
| `metadata.userId` | always | the requester: the `_userId` the gateway stamped on the `job:create` |
| `metadata.created` | always | ISO-8601 time of admission |
| `metadata.retryCount` | always | attempts re-queued so far; `0` at admission |
| `metadata.maxRetries` | always | the retry budget: `0` for a `yield` job, `1` for a `mark` job |
| `metadata.completedUnits` | after a checkpoint | units finished by any attempt ([Checkpoints](#checkpoints)) |
| `metadata.unitCursors` | after a checkpoint that leaves a cursor | how far each unfinished unit got |
| `params` | always | the job's params as the dispatcher holds them ([Admission](#jobcreate)) |
| `startedAt` | `running`, `complete`, `failed`; `cancelled` when cancelled while running | ISO-8601 time of the claim |
| `progress` | `running` | the last recorded progress report; `{}` at the claim |
| `completedAt` | `complete`, `failed`, `cancelled` | ISO-8601 time of the terminal transition |
| `result` | `complete` | the `result` of the `job:complete`, or `{}` |
| `error` | `failed` | the `error` of the `job:fail` that ended it |

Beside the record the store keeps a **liveness time**, set to now by every write to the record:
admission, the claim, each recorded progress report, each checkpoint and every transition. The
[dead-worker sweep](#periodic-work) reads it.

There are exactly five states. There is no `claimed`, `retrying` or `declined` state: a claim is
`pending → running`, and a retry is `running → pending` with `retryCount` one higher.

### The state machine

| From | To | Trigger | Recorded | Emitted |
|---|---|---|---|---|
| — | `pending` | `job:create`, admitted | a new record | `job:created` (reply); `job:queued` when the job is delivered ([below](#jobqueued)) |
| `pending` | `running` | `job:claim` | `startedAt`, `progress: {}` | `job:claimed` (reply), then `job:assign` |
| `running` | `running` | `job:report-progress`, not throttled | `progress` replaced whole | nothing |
| `running` | `running` | `job:checkpoint` | `completedUnits` and `unitCursors` merged | nothing |
| `running` | `complete` | `job:complete` | `completedAt`, `result`; `progress` dropped | nothing |
| `running` | `pending` | `job:fail` when a retry is allowed | `retryCount + 1`, checkpoint merged; `startedAt`, `progress` and the error dropped | `job:queued` when the job is redelivered |
| `running` | `failed` | `job:fail` when no retry is allowed | `completedAt`, `error`, checkpoint merged | nothing |
| `running` | `pending` or `failed` | the dead-worker sweep | as `job:fail`, with the sweep's error and no failure class or units | `job:queued` on a retry; otherwise nothing |
| `pending` | `cancelled` | `job:cancel-requested` naming it, by id or by type; or `job:cancel` | `completedAt`; no `startedAt` | `job:cancel-ok` (reply to `job:cancel-requested`) |
| `running` | `cancelled` | `job:cancel` | `completedAt`; `startedAt` kept | nothing |
| `complete`, `failed`, `cancelled` | removed | retention | the record is deleted | nothing |

**Terminal states are absorbing.** No trigger moves a job out of `complete`, `failed` or
`cancelled`; retention only deletes it.

**A command that names a job not in the state it needs has no effect.** `job:complete`,
`job:fail`, `job:report-progress` and `job:checkpoint` act only on a `running` job; `job:cancel` only
on a `pending` or `running` one. For anything else, including an id with no record, nothing is
written, nothing is emitted, and no reply is sent; at most the dispatcher logs it.

The transitions the dispatcher makes on its own — the sweep's, a pending job's cancellation and
retention — emit nothing; see [Known defects](#known-defects).

## Channels

The dispatcher answers nine channels. Four are registry **operations** (one request, one correlated
reply on the result or the failure channel); five are one-way and never replied to.

| Channel | Registry kind | Audience | Reply |
|---|---|---|---|
| `job:create` | operation | — | `job:created` / `job:create-failed` |
| `job:claim` | operation | — | `job:claimed` / `job:claim-failed` |
| `job:cancel-requested` | operation | — | `job:cancel-ok` / `job:cancel-failed` |
| `job:status-requested` | operation | — | `job:status-result` / `job:status-failed` |
| `job:complete` | event | everyone | none |
| `job:fail` | event | everyone | none |
| `job:report-progress` | event | everyone | none |
| `job:checkpoint` | command | declared | none |
| `job:cancel` | command | declared | none |

What holds for all nine:

- **The gateway checks the payload first.** A payload that does not match the channel's schema is
  refused to its emitter with `400` and never reaches the dispatcher. The gateway replaces any
  `_userId` and `_roles` the emitter wrote with the verified principal's DID and roles.
- **A frame that does not decode changes no job.** One that did not pass a gateway may not be its
  channel's payload: a field missing or of another type, or an id its kind refuses
  ([`ResourceId`](../../specs/src/components/schemas/ResourceId.json),
  [`JobId`](../../specs/src/components/schemas/JobId.json),
  [`UserId`](../../specs/src/components/schemas/UserId.json),
  [`AnnotationId`](../../specs/src/components/schemas/AnnotationId.json)), an empty one included.
  The dispatcher decodes a frame before it reads any of it, so such a frame is never acted on in
  part. For the four operations the reply is the failure channel, with no code and the message
  `a <channel> that is not a <payload schema>: <what did not decode>`, before the queue is
  consulted. A one-way command is dropped: nothing is answered, and the dispatcher logs
  `A command that does not decode` with the channel and the reason. An id that is absent is not this
  case: the sections below say what each channel does without one.
- **All nine are emitted globally,** never resource-scoped. `job:complete`, `job:fail` and
  `job:report-progress` reach every client (`audience: everyone`): the dispatcher applies them to the
  queue by `jobId`, a caller that created the job filters by `jobId`, and a resource's viewers filter
  by `resourceId`. A resource-scoped emit of any of the nine reaches only clients joined to that
  resource's scope for that channel, which the dispatcher never is, so the queue does not see it.
- **An operation request that no dispatcher hears is answered by the gateway,** on the operation's
  failure channel with `code: "peer-unavailable"` and the message
  `No subscriber for <channel>: the service that answers it is not connected`.
  A one-way frame that no dispatcher hears is lost: a `job:complete` or `job:fail` the dispatcher
  never receives leaves the job `running` until the [dead-worker sweep](#periodic-work).
- **A failure reply is a `CommandError`**: `message`, and `code` only where the sections below give
  one. Of the dispatcher's own failure replies, only `job:claim`'s carry a code, and `job:create`'s
  when a read it made failed with one.
- **Frames are not serialized.** Two frames for the same job may be handled concurrently. Each
  transition is atomic in the store ([Storage](#storage)), so one of two racing transitions wins and
  the other finds the job no longer in the state it needs.

### `job:create`

Admits a new job. Reads the job description and `_userId`
([`JobCreateCommand`](../../specs/src/components/schemas/JobCreateCommand.json)).

**A job description is its `jobType` and its params.** `jobType` is the verb that asks for the job:
`mark` annotates a resource, `yield` makes one.

| `jobType` | Its resource | `params` |
|---|---|---|
| `mark` | the command's `resourceId` | [`MarkJobParams`](../../specs/src/components/schemas/MarkJobParams.json): one of five schemas, told apart by `motivation` (`highlighting`, `commenting`, `assessing`, `linking`, `tagging`). Each motivation takes its own params and no others; [Mark](flows/MARK.md#delegation) lists them |
| `yield` | none of its own: the one its context focuses on | [`GenerationJobParams`](../../specs/src/components/schemas/GenerationJobParams.json): what to make, and the gathered `context` to make it from. `title`, `storageUri` and `context` are required |

**The gateway refuses what is not a job description,** with `400`, in the schema check every channel
gets. So the dispatcher is never sent:

- a `jobType` that is neither of the two;
- a `mark` job with no `resourceId`, with no `motivation` or one no job has, or with a param its
  motivation does not take;
- a linking job whose `entityTypes` is absent or empty, or a tagging job whose `schemaId` or
  `categories` is;
- a `yield` job that names a `resourceId` beside its params, one whose `title` or `storageUri` is
  absent or empty, or one whose `context` is absent or has no focus the focus rule reads.

A param a `yield` job does not take passes the gateway, because the schema of those params is open.
The dispatcher refuses it (check 4).

**Admission.** The checks run in this order; the first that fails is the reply,
`job:create-failed` with the message below. Only a refusal because a read failed carries a `code`
([The two reads](#jobcreate)).

| # | Applies to | Check | Refusal message |
|---|---|---|---|
| 1 | all | `_userId` is present | `_userId is required (injected by bus gateway)` |
| 2 | `mark`, linking | every member of `params.entityTypes` is a registered entity type (**read 1**) | `Entity type not registered: <a>, <b>` — the unregistered members, comma-separated |
| 3 | `mark`, tagging | `params.schemaId` names a registered tag schema (**read 2**) | `Tag schema not registered: <schemaId>` |
| 4 | `yield` | every param is one `GenerationJobParams` names | `a yield job takes no parameter <a>, <b>` — the params it does not take, comma-separated |
| 5 | `yield` | when `params.entityTypes` is present and not empty: every member is a registered entity type (**read 1**) | `Entity type not registered: <a>, <b>` |
| 6 | all | the store accepts the new record | the store's error message |

**The focus rule** derives a `yield` job's resource from its gathered context,
`params.context.focus`: when `focus.kind` is `"resource"`, the resource is `focus.resource["@id"]`;
when it is `"annotation"`, it is `focus.sourceResource["@id"]`, the resource the focal annotation is
on. A focus of any other kind, or an `@id` that is not a
[`ResourceId`](../../specs/src/components/schemas/ResourceId.json), is not a `JobCreateCommand`. For a
`mark` job the resource is the command's `resourceId`.

**The two reads** ask the Archivist over the bus, as the dispatcher's own requests:
`browse:entity-types-requested` (read 1) and `browse:tag-schemas-requested` (read 2), each with an
empty payload. They are made per `job:create`, only where the table says, after check 1, never
cached. No job needs both. Each waits up to 30 seconds. When a read fails, `job:create` is refused with the read's own message, and with
its `code` when the read's failure carried one. For an Archivist that is not connected the message is
`No subscriber for browse:entity-types-requested: the service that answers it is not connected` (or
the same for `browse:tag-schemas-requested`), the code is `peer-unavailable`, and the refusal arrives at
once. A job that triggers
neither read is admitted without the Archivist.

**The record.** On admission the dispatcher builds the record — a new id, `retryCount: 0`,
`maxRetries` by type, `created` now, `userId` the requester — and holds the job's params as they
came, with what it adds ([`JobParams`](../../specs/src/components/schemas/JobParams.json)):
`resourceId`, the resource derived above, and for a tagging job `schema`, the tag schema its
`schemaId` names, so the worker needs no registry of its own. Nothing the caller sent is changed or
removed: `schemaId` stays beside `schema`.

**Reply.** `job:created` with `{ response: { jobId } }`. The job is stored as `pending` before the
reply is sent. `job:queued` for the new job is emitted when the store delivers it, independently of
the reply, so the order of `job:created` and `job:queued` is not fixed.

### `job:claim`

Hands the caller the next pending job its claim matches. Reads `accepts`, `_roles` and
`_userId` ([`JobClaimCommand`](../../specs/src/components/schemas/JobClaimCommand.json)).

1. **The caller must be a worker.** `_roles` must contain `semiont-worker`, the role the gateway
   stamps from the caller's token. Otherwise the reply is `job:claim-failed`,
   `code: "unauthorized"`, message
   `job:claim refused: the caller is not a worker for this knowledge base`. This is checked before
   the queue is consulted, so a refused caller learns nothing about pending work.
2. **The claim names the jobs it takes, and is atomic.** `accepts` is a list of
   [`JobFilter`](../../specs/src/components/schemas/JobFilter.json), at least one. A filter is a
   partial job description: `{ jobType: "mark", params: { motivation } }` for the `mark` jobs of one
   motivation, or `{ jobType: "yield" }`. A job matches a filter when every field the filter states
   equals the job's at the same path; what the filter leaves out is not compared. The job is compared
   as it is announced ([`job:queued`](#jobqueued)), and
   [`filter-cases.json`](../../specs/src/jobs/filter-cases.json) is the table every implementation
   answers alike. The gateway refuses a claim with no filter, a `mark` filter with no motivation, and
   a filter that states any other field. The dispatcher moves one pending job that matches any of the
   filters to `running`. Of any
   number of simultaneous claims, exactly one wins each pending job. No order among matching pending
   jobs is promised: this dispatcher tries first the jobs whose delivery it holds, in the order
   it received them, then every other stored record.
3. **Nothing to claim is a decline, not an error:** `job:claim-failed`, `code: "none-pending"`,
   message `No pending job matches the claim`.
4. **After the transition,** one check runs before the reply: `_userId` is present, else
   `job:claim missing _userId (gateway injection)`, with no code, and the job is left `running`
   ([Known defects](#known-defects)).
5. **Reply:** `job:claimed` with `{ response: <the running record> }`, then [`job:assign`](#jobassign).

`job:claimed`'s `response` is the whole record as it stands after the claim:

| Field | Value |
|---|---|
| `status` | `"running"` |
| `metadata` | `id`, `type`, `userId` (the requester), `created`, `retryCount`, `maxRetries`, and `completedUnits` / `unitCursors` when a previous attempt checkpointed |
| `params` | as stored at admission |
| `startedAt` | the time of this claim |
| `progress` | `{}` |

A worker reads the job's identity, parameters, retry budget and checkpoint from it. A retried job's
claim carries the checkpoint its earlier attempts left, which is how a retry resumes.

### `job:complete`

Concludes a running job. Reads `jobId`, `jobType` and `result`
([`JobCompleteCommand`](../../specs/src/components/schemas/JobCompleteCommand.json)).

**A completion is its verb's.** `JobCompleteCommand` is one of two, told apart by `jobType`, and
each carries the result its verb reports:

| `jobType` | `result` |
|---|---|
| `mark` | [`MarkJobResult`](../../specs/src/components/schemas/MarkJobResult.json): the job's counts (`found`, `persisted`, and `errors` when some of what was proposed could not be anchored in the text), or a decline |
| `yield` | [`YieldJobResult`](../../specs/src/components/schemas/YieldJobResult.json): the resource the job made, or a decline |

The gateway refuses, with `400`, a completion whose result is the other verb's: it is not the
schema. A completion that is well formed for one verb and names a running job of the other has no
effect: the dispatcher logs `job:complete of another verb than the job's`, and the job stays
`running`. The Archivist records no `job:completed` for it, and logs the same words, when the
resource's stream holds the job's `job:assigned` or `job:started`
([ARCHIVIST.md](ARCHIVIST.md#vocabulary-people-and-jobs)). A `yield` completion may name
`annotationId`, the annotation its context was focused on; a `mark` completion names none.

**What is stored is any verb's.** The job moves to `complete`, and its record holds the result as a
[`JobResult`](../../specs/src/components/schemas/JobResult.json): one of the three, with no field
that says which. The record's `metadata.type` says which job it answers, and the three share no
member. `result` absent is stored as `{}`. `resourceId`, `attempt`, `annotationId`, `durability` and
`_userId` are not read. No reply, nothing emitted.

### `job:fail`

Concludes an attempt that failed. Reads `jobId`, `error`, `completedUnits`, `unitCursors` and
`failureClass` ([`JobFailCommand`](../../specs/src/components/schemas/JobFailCommand.json)). The
checkpoint in the payload is merged into the record ([Checkpoints](#checkpoints)), then the job is
retried or failed ([Retries](#retries)). The payload's `willRetry` is not read; the dispatcher
decides for itself, with the predicate the worker used to compute it. `attempt`, `resourceId`,
`jobType`, `annotationId`, `durability` and `_userId` are not read. No reply, nothing emitted.

### `job:report-progress`

Records progress on a running job. Reads `jobId`, `progress` and `percentage`
([`JobReportProgressCommand`](../../specs/src/components/schemas/JobReportProgressCommand.json));
the record's `progress` is replaced by the payload's `progress`, or by `{ percentage }` when
`progress` is absent. Reports are throttled per job: one arriving within 5 seconds of the last one the
dispatcher accepted for that job is dropped, not deferred, and a dropped report does not refresh the
job's liveness. No reply, nothing emitted.

### `job:checkpoint`

Records a running job's finished units as they finish, so a worker that dies without a `job:fail`
still leaves them. Reads `jobId`, `completedUnits` and `unitCursors`
([`JobCheckpointCommand`](../../specs/src/components/schemas/JobCheckpointCommand.json)) and merges
them into the record ([Checkpoints](#checkpoints)). Never throttled. No reply, nothing emitted.

### `job:cancel-requested`

Asks for a job, or every pending job of one type, to be cancelled. Reads `jobId` and `jobType`
([`JobCancelRequest`](../../specs/src/components/schemas/JobCancelRequest.json)); `jobId`, when present,
takes precedence.

| Request | Effect | `cancelled` |
|---|---|---|
| `jobId`, no such job | none | `0` |
| `jobId`, job `pending` | cancelled now | `1`, or `0` if it left `pending` first |
| `jobId`, job `running` | none by the dispatcher; left to its worker ([Cancellation](#cancellation)) | `1` |
| `jobId`, job terminal | none | `0` |
| `jobType: "mark"` | every pending `mark` job cancelled, whatever its motivation | the number cancelled |
| `jobType: "yield"` | every pending `yield` job cancelled | the number cancelled |
| neither | none | `0` |

**Reply:** `job:cancel-ok` with `{ response: { cancelled } }`. A store error is
`job:cancel-failed` with the store's message and no code.

### `job:cancel`

A worker's confirmation that it stopped the job. Reads `jobId` only
([`JobCancelCommand`](../../specs/src/components/schemas/JobCancelCommand.json)). A `pending` or
`running` job moves to `cancelled`. The payload's `completedUnits` and `unitCursors` are not read
([Known defects](#known-defects)). No reply, nothing emitted.

### `job:status-requested`

Reads one job. Reads `jobId`
([`JobStatusRequest`](../../specs/src/components/schemas/JobStatusRequest.json)).

- No record: `job:status-failed`, message `Job not found`, no code.
- A store error: `job:status-failed` with the store's message, no code.
- Otherwise `job:status-result` with `{ response }`
  ([`JobStatusResponse`](../../specs/src/components/schemas/JobStatusResponse.json)):

| Field | Present when |
|---|---|
| `jobId`, `type`, `status`, `userId` (the requester), `created` | always |
| `startedAt` | `running`, `complete` |
| `completedAt` | `complete`, `failed`, `cancelled` |
| `error` | `failed` |
| `progress` | `running` |
| `result` | `complete` |

`result` is the record's: a result of any verb, or `{}`
([`JobStoredResult`](../../specs/src/components/schemas/JobStoredResult.json)). The response's `type`
says which verb's it is. `retryCount`, `maxRetries`, the checkpoint and `params` are not exposed. A
record is readable until retention deletes it.

#### Following a job

`job:report-progress`, `job:complete` and `job:fail` reach the client that created the job as passing
frames: a stream that is down when one is published does not carry it later, and nothing redelivers
it ([TRANSPORT-CONTRACT.md](./TRANSPORT-CONTRACT.md#delivery)).
`job:status-requested` is how a follower learns what it was not sent. A client that has heard nothing
of a job it follows for `jobSilenceMs` asks for the job's status, and asks again every
`jobStatusPollMs` until the job says something or its status is an end; a status of `complete` or
`failed` is that end, reported as the frame would have been
([`specs/src/client/timing.json`](../../specs/src/client/timing.json)). So is a status of
`cancelled`, which no frame announces: a follower learns of a cancellation here and nowhere else.
*Held by `sdk/live/job-across-drop`, `sdk/live/job-failed-unheard`, `sdk/live/job-cancelled`.*

A follower reads its job's completion as its verb's, whichever way it learns of it: a
`job:complete` frame states its `jobType`, and a status its `type`, with a `result` that must be
that verb's. A completion that is another verb's is not this job's. The follower ends with an
error, and does not report the job as failed.

A follower reports how its job ended under the codes every SDK shares
([`specs/src/errors/codes.json`](../../specs/src/errors/codes.json), `job`). A `job:fail` whose
`willRetry` is `true` is not an end, of a `mark` job or of a `yield` job: the follower reports the
setback and keeps following, and does not ask for the status of the attempt that died. Any other
`job:fail`, and a status of `failed`, end it as `job.failed`, with the worker's message; a status of
`cancelled` ends it as `job.cancelled`. A follower of a `yield` job that has heard nothing for its
stall deadline asks for that job to be cancelled, by its id, and ends as `job.stalled`: a
cancellation by type would end every pending `yield` job in the knowledge base. The deadline is
`generationStallFloorMs`, or `generationStallPerTokenMs` for each token asked for when that is
longer, unless its caller states one. Each frame of the job starts the deadline again, a setback
among them: the attempt that follows one has the whole deadline to say something.
*Held by `sdk/live/job-failed`, `sdk/live/job-failed-unheard`, `sdk/live/job-cancelled`, `sdk/live/job-stalled`, `sdk/live/generation-retried`.*

## What the dispatcher emits on its own

### `job:queued`

**A wake-up, not a reservation.** It tells idle workers that there may be something to claim. It
reserves nothing: a claim names what it takes and no job, so the job a worker receives may differ
from the one announced, and a job may be announced any number of times.

Payload ([`JobQueuedEvent`](../../specs/src/components/schemas/JobQueuedEvent.json)): `jobId`,
`jobType`, `resourceId` (the job's `params.resourceId`), `userId`, the requester, and `params`: the
job description less the job's input. A `mark` job's params are announced whole, as it was created. A
`yield` job's are announced without its `context`
([`GenerationJobRequest`](../../specs/src/components/schemas/GenerationJobRequest.json)). Nothing the
dispatcher added to the params is announced, so a tagging job's carry no `schema`. An announcement
is what a claim's filters are compared with, so the first-party worker checks one against its own
claim and asks only when it would be handed something. Registry kind
`event`, audience `declared`: it reaches the clients that name it, which are workers.

It is emitted:

- each time the store delivers the job to the dispatcher while the job is `pending` — after
  admission, after a retry, and when a restarted dispatcher receives the deliveries its predecessor
  held ([Storage](#storage));
- on each [re-announce tick](#periodic-work), for every pending job whose delivery the dispatcher
  holds.

Workers do not depend on it to find work: a worker claims whenever it is idle — at start, after
finishing a job, on reconnect — and parks only when the claim is declined `none-pending`. `job:queued`
is what un-parks it.

### `job:assign`

The dispatcher's own record of an accepted claim, emitted immediately after each `job:claimed`,
under the dispatcher's identity. Payload
([`JobAssignCommand`](../../specs/src/components/schemas/JobAssignCommand.json)): `jobId`, `jobType`,
`resourceId` (the job's `params.resourceId`), `holder` (the claimant's `_userId`) and `requester`
(the record's `metadata.userId`). Registry kind `command`, audience `declared`. The Stower records it
as `job:assigned` on the resource's log, which is what lets a later write citing the job be checked
against its holder and attributed to its requester. It is emitted for every claim, a retry's
included, and carries no attempt number.

## Periodic work

The intervals below are the document's `timing`; the values shown are the ones the launcher writes.

| Work | Every | What it does |
|---|---|---|
| Re-announce tick | 30 s | emits `job:queued` for each pending job whose delivery the dispatcher holds |
| Dead-worker sweep | the same tick, after the re-announce | concludes each `running` job whose liveness time is 30 minutes or more in the past |
| Retention | 1 h | deletes each terminal record whose `completedAt` is more than 24 hours in the past |

A tick that is still running when the next one is due is skipped.

**The re-announce tick is insurance, not dispatch.** A worker claims at every idle moment, so a job
admitted while every worker is busy is claimed when one finishes, whether or not it is announced.
What the tick covers is an announcement lost on its way to a worker that was already parked and so has
nothing else to wake it. On a healthy stack it changes nothing.

**The dead-worker sweep** treats a running job with no write for 30 minutes as abandoned by a worker
that died. It concludes the job exactly as a `job:fail` would, with the error
`worker presumed dead — no progress within 30 minutes`, no failure class and no units: the job is
retried if its budget allows and failed otherwise, and the checkpoint already on the record is kept
either way. A worker keeps its job alive by reporting progress (outside the throttle) or
checkpointing.

**Retention** keeps a finished job readable by `job:status-requested` for a day. After deletion the
job's id answers `Job not found`. A terminal record whose `completedAt` does not parse as a time is
deleted at the first sweep.

## Checkpoints

A checkpoint is how much of a job is already done, recorded on the job so a later attempt skips it.
It has two parts, merged differently ([`checkpoint.rs`](../../apps/dispatcher/handlers/src/checkpoint.rs)):

- **`completedUnits` is a set, merged by union.** A unit is an entity type for a linking job, a
  category for a tagging job, and the job's own motivation for every other `mark` job. A unit
  once recorded stays recorded.
- **`unitCursors` is merged monotonically per unit.** A cursor
  ([`UnitCursor`](../../specs/src/components/schemas/UnitCursor.json)) says how far an unfinished
  unit got. For each unit, the incoming cursor replaces the stored one only when its `next` is
  strictly greater; otherwise the stored one stays. A cursor is replaced whole — `next`, `size`,
  `found`, `emitted` and `errors` are one observation and never mixed across two cursors — so a
  checkpoint arriving late never moves a unit backward.
- **A finished unit has no cursor.** After the union, every cursor for a unit in `completedUnits` is
  dropped, and incoming cursors for such units are ignored. When no cursor remains, `unitCursors` is
  removed from the record.

The same merge applies to `job:checkpoint` and to the checkpoint on a `job:fail`, whether the job is
then retried or failed. `job:cancel` does not merge its checkpoint.

## Cancellation

**A pending job is cancelled by the dispatcher**, on `job:cancel-requested` naming it by id, on
`job:cancel-requested` naming its type, or on `job:cancel`.

**A running job is cancelled only by its worker.** `job:cancel-requested` naming a running job
changes nothing in the queue and replies `cancelled: 1`. Workers may subscribe to
`job:cancel-requested` too, as the first-party worker does; a worker holding the named job may stop at
a unit boundary and confirm with `job:cancel`, which moves the job to `cancelled`. A worker that does not stop finishes the job, which then ends
`complete` or `failed` as usual. (The first-party worker stops only linking jobs.) A
bulk cancel by type never touches running jobs' records.

## Retries

On `job:fail` (and on the sweep) a retry is allowed exactly when

```text
failureClass !== "deterministic"  and  retryCount < maxRetries
```

evaluated on the record before the failure is applied. A worker evaluates the same predicate, on
the record it claimed, to set `willRetry` on its `job:fail`: `willRetryAfter` in the TypeScript SDK
([`claims.ts`](../../packages/sdk/src/claims.ts)), and `will_retry_after` in the Rust SDK
([`claims.rs`](../../packages/sdk-rust/src/claims.rs)) and the Python SDK
([`claims.py`](../../packages/sdk-python/src/semiont/claims.py)), which a held job's `fail` applies. The
dispatcher's own is the Rust SDK's. An absent `failureClass`
counts as retryable. With the budgets set at admission, a `yield` job is never retried and a
`mark` job is retried at most once.

A retried job is `pending` again with `retryCount` one higher, its checkpoint merged, and no
`startedAt`, `progress` or error. It is redelivered at once, with no delay, and so announced again. A
failed job keeps `startedAt`, records `completedAt` and the payload's `error`, and keeps its
`retryCount`.

## Storage

The queue lives in the messaging broker's JetStream: **a KV bucket** holding one authoritative
record per job, and **a stream** whose messages deliver jobs to the dispatcher. Every transition is a
**compare-and-swap** on the record's revision: the dispatcher reads the record, checks the state the
transition needs, and writes only if nobody wrote in between; on a conflict it reads again, up to 20
times, and then fails the operation with `Job <jobId> transition failed after 20 CAS attempts`.
Admission is the one write that is not a compare-and-swap: it creates the record, failing if the id
exists, and then publishes the job's message, on the subject of its type. The exact layout — bucket, stream, subjects, consumer
and record encoding — is specified machine-readably in [`specs/src/jobs/storage.json`](../../specs/src/jobs/storage.json).

**A stored record that does not decode** — not a
[`JobRecord`](../../specs/src/components/schemas/JobRecord.json), an id its kind refuses included —
fails an operation that names its job, with `job <jobId>'s record: <why>`. A pass over every record
goes on past it: a claim's search, a cancel by type, the tick's re-announcement, the dead-worker
sweep, retention and the queue's counts each log `A stored job record that does not decode` with its id and reason, and
take the next. Such a record is never claimed, cancelled, swept, deleted or counted, and is reported at
every pass until it is removed by hand. A record that decodes but whose params are not its type's
is passed over the same way where an announcement is built, by a delivery and by a claim's search:
the dispatcher logs `A job whose parameters are not its type's`, and the job is never announced and
never claimed.

**A delivered message is the dispatcher's lease on the job.** The dispatcher holds each delivered
message, extends every lease every 7.5 seconds, and settles a lease when the job ends: acknowledged on
`complete`, terminated on `failed` or `cancelled`, returned for immediate redelivery on a retry (or,
when the dispatcher holds no delivery for the job, a new message is published). A
delivery for a job with no record is terminated; one for a terminal job is acknowledged; one for a
running job is held without an announcement. If the dispatcher stops, it settles nothing, and after
30 seconds without an extension the broker redelivers its messages to the next dispatcher, which
announces the pending ones. This recovers from a dispatcher's death; a worker's death is the
dead-worker sweep's.

## Health

The dispatcher answers a request for exactly `/health`, any method, on the document's `port` (24105
as deployed) with `200`, `Content-Type: application/json` and `{"status":"ok","queue":"jetstream"}`
([`DispatcherHealth`](../../specs/src/components/schemas/DispatcherHealth.json)). Any other path is
`404` with an empty body.

It begins answering only after its boot has done everything else, in this order: authenticate as its
service account, connect the queue (within `timing.bootDeadlineMs`, 60 seconds as deployed, or exit
with status 1 so its supervisor restarts it), register the nine handlers, and attach its bus
connection's inbound and outbound paths. A `200` therefore means the queue connected and the
handlers are attached; it does not wait for the SSE subscription to open. The body does not change
while the process runs.

## Known defects

Behaviour that is a defect. Each is described as it happens; none is a rule of the
protocol.

- **Transitions the dispatcher makes on its own are silent.** A job failed by the dead-worker sweep, a
  pending job cancelled, and a terminal record deleted by retention emit nothing, so a client watching
  the job — one told by `willRetry` that a retry is coming, say — never learns the outcome.
- **A claimed job can be stranded in `running`.** A `job:claimed` reply that is lost, or that arrives
  after the worker stopped waiting for it (10 seconds for the first-party worker), leaves the job
  `running` with nobody working on it; so does the refusal `job:claim` makes after the transition.
  Only the dead-worker sweep recovers it, 30 minutes later, and the recovery spends its retry.
- **No attempt fencing.** `job:complete` and `job:fail` are checked against the job being
  `running`, a `job:complete` against the job's verb as well, and neither against the attempt. A late `job:complete` or `job:fail` from an attempt the sweep gave up on concludes the
  next attempt's record. `attempt` is on the wire and ignored.
- **`job:cancel` ignores its checkpoint and cancels pending jobs.** The `completedUnits` and
  `unitCursors` its schema says are recorded are dropped. Because it accepts a `pending` job, a late
  confirmation cancels a job the sweep has already re-queued; it is logged as a cancellation whether
  or not anything moved.
- **Admission writes the record, then publishes.** When the publish fails, the reply is
  `job:create-failed` while a claimable `pending` job exists; having no message, it is never
  announced.
- **A bulk cancel purges the messages of running jobs.** A cancel by type removes every message
  of that type, not only those of the jobs it cancelled: running jobs lose theirs, and a job
  admitted while the cancel runs is left `pending` with no message, claimable but never announced.
- **Broker objects are created if missing but never updated.** A changed stream, consumer or bucket
  setting — the 30-second acknowledgement window among them — takes effect only on a fresh broker.
- **The durable consumer is named `gateway-claims`,** after a component that does not hold it.
  The name is part of the storage layout, and changing it needs a migration.
- **`/health` is static.** It never reports a lost broker connection, while the launcher reads
  `queue` as live. The launcher waits 30 seconds for it; the
  dispatcher allows itself 60 seconds to connect the queue.
- **Retention deletes without a trace.** After 24 hours a finished job answers `Job not found`,
  indistinguishable from an id that never existed.
- **Nothing enforces one dispatcher.** A second dispatcher on the same knowledge base admits every
  `job:create` a second time and answers every `job:claim`, claiming two jobs for one request. Only
  the deployment prevents it.
- **Outside the dispatcher: the Stower honours only the first assignment.** It checks a write against
  the first `job:assigned` for the job, so when a retry is claimed by a different worker, that
  worker's writes are refused. The dispatcher's `job:assign` for the retry is recorded but not
  consulted.
