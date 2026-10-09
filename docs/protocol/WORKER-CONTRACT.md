# Worker Contract

What a worker promises the dispatcher and everyone who follows a job. A
**worker** is any party that takes jobs and says how each one went: the
Worker service, or one written on an SDK by somebody else, in any language.
What the dispatcher does with a worker's messages is [JOBS.md](./JOBS.md).
How to write a worker is the
[`semiont-worker` skill](../builder/skills/semiont-worker/SKILL.md).

If the code deviates from what is written here, the code is wrong, or this
document is wrong and is corrected deliberately. There is no third option.

**How this document is held.** Each rule ends with *Held by* and what fails
when a worker breaks it: a case of the worker conformance suite
([`tests/conformance/worker`](../../tests/conformance/worker/README.md),
which every SDK with a worker's surface runs), a file of the dispatcher suite
([`tests/conformance/dispatcher`](../../tests/conformance/dispatcher/README.md)),
or another test in the repository. A rule marked "Held by no case" is one
nothing checks. `npm run lint:transport-contract` fails when something named
here does not exist, and when a case of the worker suite is named by no rule.

## What a worker is

A worker signs in as an agent whose token carries the `semiont-worker` role;
the dispatcher refuses a claim from anyone else
([JOBS.md § `job:claim`](./JOBS.md#jobclaim)). It holds one job at a time. A
process that runs several jobs at once runs several workers.

A worker does three things, and this document is about those three: it
**claims** a job, it reports the job's **lifecycle**, and it stays
**live** while it holds one. The work itself (reading a resource, calling a
model, deciding what to annotate) is the worker's own and is not specified
here, except for one thing every worker that commits annotations must do
([Committing annotations](#committing-annotations)), and for the trace a
worker that exports telemetry runs a job in ([Traces](#traces)).

## The stream

- **S1.** A worker's stream names the reply channels of the operations it
  awaits, and two broadcasts: `job:queued` and `job:cancel-requested`. It
  names no channel it does not read.
  *Held by `worker/claim-on-start`.*

## Claiming

A claim is `job:claim` with `accepts`: one or more filters, each a partial
job description. The dispatcher answers with the next pending job that
matches one of them, or with `none-pending`.

- **C1.** A worker claims when it becomes idle, and at no other time. It
  becomes idle when it starts and its stream is open, when it settles a job,
  when a `job:queued` that matches its claim arrives while it holds nothing,
  and when its stream opens again after a drop.
  *Held by `worker/claim-on-start`, `worker/lifecycle`, `worker/claim-on-announcement`, `worker/claim-on-reopen`.*
- **C2.** One claim is in flight at a time.
  *Held by `worker/one-claim-in-flight`.*
- **C3.** A `job:queued` that arrives while a claim is in flight earns
  exactly one more claim, made when the first is answered with no job.
  *Held by `worker/one-claim-in-flight`.*
- **C4.** A `job:queued` that arrives while a job is held is ignored. The
  settle claims.
  *Held by `worker/announcement-while-held`.*
- **C5.** A `job:queued` that matches none of the worker's filters causes
  no claim. The worker compares an announcement with its filters as the
  dispatcher compares a job with a claim, and
  [`filter-cases.json`](../../specs/src/jobs/filter-cases.json) is the table
  both answer alike.
  *Held by `worker/claim-on-announcement`, `packages/core/src/__tests__/job-filter.test.ts`.*
- **C6.** `none-pending` is not a fault. The worker waits for its next idle
  moment and reports the answer to nobody.
  *Held by `worker/none-pending`.*
- **C7.** Any other refusal is reported with its code, and the worker waits
  for its next idle moment. `unauthorized` is reported as such: a credential
  that cannot claim will not be able to later.
  *Held by `worker/refusal`.*
- **C8.** A stream that hands over to a new connection without closing has
  not opened again, and causes no claim.
  *Held by `worker/handover`.*
- **C9.** A reply to a claim that names no job id, no job type or no
  parameters is refused where it arrives, reported as a refusal, and never
  run. The worker goes on claiming.
  *Held by `worker/malformed-reply`.*
- **C10.** A claim waits `jobClaimTimeoutMs`
  ([`timing.json`](../../specs/src/client/timing.json)) for its answer. One
  not answered by then is reported as a refusal.
  *Held by `worker/claim-timeout`.*

## The claimed record

- **R1.** The job's id, its type, its parameters and its retry budget are
  the claimed record's: `metadata.id`, `metadata.type`, `params`,
  `metadata.retryCount` and `metadata.maxRetries`.
  *Held by `worker/claim-on-start`.*
- **R2.** `metadata.completedUnits` and `metadata.unitCursors` are the
  checkpoint earlier attempts left, and a worker resumes from them: a
  finished unit is not done again, and an unfinished one continues from its
  cursor. Absent, each reads as none. A worker reads them as the dispatcher
  states them and repairs nothing; what the dispatcher keeps of a checkpoint
  is [JOBS.md § Checkpoints](./JOBS.md#checkpoints).
  *Held by `worker/checkpoint-read`, `dispatcher/progress.test.ts`.*

## The lifecycle

- **L1.** `job:start` is emitted once, after the claim and before any other
  lifecycle message, with `resourceId`, `jobId`, `jobType` and `attempt`,
  and `annotationId` when the job is anchored to one.
  *Held by `worker/lifecycle`.*
- **L2.** While it works a worker may emit `job:report-progress` and
  `job:checkpoint`, any number of each. A progress report carries what
  `job:start` carried. A checkpoint carries `jobId`, the units finished, and
  a cursor for each unit begun and not finished. Each one emitted counts as
  activity ([Liveness](#liveness)).
  *Held by `worker/lifecycle`, `worker/stall`.*
- **L3.** A worker settles each job it claimed exactly once, with one of
  `job:complete`, `job:fail` or `job:cancel`.
  *Held by `worker/lifecycle`.*
- **L4.** `job:fail` carries the error; the failure's class, when the worker
  knows it; the checkpoint, when there is one; and `willRetry`, which is
  what [`retry-cases.json`](../../specs/src/jobs/retry-cases.json) answers
  for the claimed record's retry budget and that class. The dispatcher
  applies the same table, so a follower told `willRetry` is told what the
  queue will do.
  *Held by `worker/fail-will-retry`, `worker/fail-final`.*
- **L5.** Every lifecycle message is emitted globally. None carries a scope.
  *Held by `worker/lifecycle`.*
- **L6.** After it settles, a worker is idle ([C1](#claiming)).
  *Held by `worker/lifecycle`.*
- **L7.** `job:complete` states the job's `jobType` and a result that is that
  verb's: a `mark` job's counts or a decline, a `yield` job's resource or a
  decline. The gateway refuses any other, and the record passes over a
  completion of another verb than the job's.
  *Held by `worker/lifecycle`, `dispatcher/conclude.test.ts`, `tests/conformance/archivist/jobs.test.ts`, `scripts/spec/check-jobs.mjs`.*
- **L8.** A worker that stops while it holds a job fails the job first:
  `job:fail`, with an error saying that the worker stopped, no failure class,
  and `willRetry` as [L4](#the-lifecycle) states it. The queue then retries
  the job at once, if its budget allows. A worker that is killed, or dies,
  says nothing: the job stays `running` until the dispatcher's sweep of
  running jobs concludes it ([JOBS.md § Periodic work](./JOBS.md#periodic-work)).
  *Held by `worker/stop-while-held`.*

## Committing annotations

A worker that makes annotations commits them with `mark:commit`, a batch at
a time, for the job it holds. A held job commits for itself: an SDK's held job
has the call, and what follows is what that call does.

- **A1.** A commit by a worker cites the job it fulfils, in `jobId`. One
  that cites none is refused.
  *Held by `worker/commit-acknowledged`, `tests/conformance/archivist/jobs.test.ts`.*
- **A2.** A worker supplies the `id` of every annotation it commits. An
  annotation is recorded once, by its `id`: one whose `id` the resource
  already holds is not recorded again. So a worker derives each `id` from
  what the annotation is (its resource, its motivation, where it is
  anchored, its body) and from nothing about the attempt, and a job that is
  retried or resumed commits the same annotations under the same ids. An
  `id` made afresh on each attempt records every annotation again.
  *Held by `tests/conformance/archivist/annotations.test.ts`, `packages/jobs/src/__tests__/annotation-idempotence.test.ts`.*
- **A3.** An annotation committed with no `id` is not recorded.
  *Held by no case.*
- **A4.** A commit is established when the record acknowledges it
  (`mark:commit-ok`), and not before: the gateway taking the message says
  nothing of the record. A worker waits for the acknowledgement, for
  `markCommitTimeoutMs`, and counts nothing of the batch as done until it is
  established. A batch of no annotations is no commit: nothing is sent.
  *Held by `worker/commit-acknowledged`, `worker/commit-empty`.*
- **A5.** When no acknowledgement arrives in that time, the worker asks
  whether the batch's last annotation is on the resource
  (`browse:annotation-requested`), and waits as long again for the answer.
  The record appends a batch in order and stops at the first annotation it
  cannot append, so the last being there says all of it is. Answered with the
  annotation, the commit is established. Answered that it is not there, or not
  answered, it is not, and the worker's commit fails with the failure of its
  unanswered `mark:commit`. A commit the record refuses (`mark:commit-failed`)
  fails with the record's reason, and nothing is asked.
  *Held by `worker/commit-ack-lost`, `worker/commit-probe-refused`, `worker/commit-probe-unreachable`, `worker/commit-refused`.*
- **A6.** A held job says how its commits were established, in `durability`,
  when it settles, and it says what it observed, never a conclusion. Each
  commit observes one of: `acknowledged`; `probe-confirmed`, established by
  asking; `probe-refused`, answered that the annotation is not there;
  `probe-unreachable`, not answered. The job remembers the weakest of them,
  in that order, the last two being equally weak and the first of them seen
  kept. `job:complete` states it. `job:fail` states it when it is one of the
  last two, which is when a commit was not established. A job that committed
  nothing, or whose only failed commit the record refused, states none.
  *Held by `worker/commit-acknowledged`, `worker/commit-ack-lost`, `worker/commit-probe-refused`, `worker/commit-probe-unreachable`, `worker/commit-refused`, `worker/commit-empty`.*

## Cancellation

The dispatcher does not stop a running job. It relays the request, and the
worker stops.

- **X1.** A `job:cancel-requested` that names the held job is signalled to
  the work. When the work stops, the worker emits `job:cancel`, with the
  units it finished, and is idle.
  *Held by `worker/cancel`.*
- **X2.** A `job:cancel-requested` that names another job is ignored.
  *Held by `worker/cancel`.*

## Liveness

- **V1.** A worker can say, at any moment: when it last received a
  `job:queued`, matching or not; when it last claimed a job; when it last
  settled one; when it was last active; the job it holds and since when; and
  how many jobs it has completed.
  *Held by `worker/vitals`.*
- **V2.** A held job that shows no activity for `heldJobStallMs` is stalled.
  A worker looks every `heldJobStallCheckMs`
  ([`timing.json`](../../specs/src/client/timing.json)) and reports a stall
  when it finds one; what its host does then is the host's. An idle worker
  is never stalled, and neither is a job that keeps reporting, however long
  it runs. A worker too wedged to look is caught by the dispatcher's own
  sweep of running jobs ([JOBS.md § Periodic work](./JOBS.md#periodic-work)).
  *Held by `worker/stall`.*

## Traces

A worker that exports telemetry sends each message in the trace of the work
that sent it, and receives each frame in the trace it was sent under
([`specs/src/sdk-telemetry/telemetry.json`](../../specs/src/sdk-telemetry/telemetry.json)).
A dispatcher that exports answers a claim in the trace of the claim
([`dispatcher/environment.test.ts`](../../tests/conformance/dispatcher/environment.test.ts)).

- **T1.** A claim begins a trace of its own: it is in the trace of no job
  the worker held before it. Whatever a worker's code was doing when it
  settled a job, the claim the SDK makes next starts from no span of that
  job. The job a claim hands over is run in the trace of that claim:
  what reads `job:claimed` and gives the job to the worker's code does so in
  the context of the reply that carried it, so a worker's span for the job
  continues that trace. So each job a worker runs has a trace of its own: its
  claim, the reply that handed it over, the worker's span for it, and every
  message the job sends. Where a language carries no context from the code
  that hands a job over to the code that is handed it, the held job states the
  trace its reply arrived in, and the worker's code opens its span in that
  trace.
  *Held by `worker/job-trace`.*
