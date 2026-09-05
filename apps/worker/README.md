# semiont-worker

**Claims queued jobs and runs inference.** Detection passes, generation, and the other
long-running work that a request cannot wait on.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-worker` |
| Port | 24100 |
| Entry point | `@semiont/jobs/dist/worker-main.js` |
| Code | [`packages/jobs`](../../packages/jobs/) |
| npm | not published — container only |

## One host, N processes, N identities

A worker host runs **one process per distinct `(inferenceProvider, model)`** configured in the
KB's TOML. Job types that share an inference engine share a process; different engines mean
different processes.

Each process authenticates for **its own agent identity** via `/api/tokens/agent`, and that
JWT is what the bus stamps on every event it emits. So `_userId` on the bus and the
`generator` on every annotation it creates refer to the same software peer — attribution is a
consequence of the identity, not a field someone remembered to set.

## What it runs

Job processors from `@semiont/jobs`, dispatched by `jobType`: reference/highlight/assessment/
comment/tag detection, and generation. Processors are transport-agnostic — the worker process
claims the job, fetches content, and handles lifecycle events; the processor just runs the
inference and returns annotations or content.

**Typst ships in the image** (pinned) so generation can produce PDFs with real page geometry
rather than recovered coordinates.

## What it talks to

The bus (SSE in for `job:queued`, `POST /bus/emit` out for lifecycle), an inference provider,
and the Archivist's HTTP surface for bytes. It claims jobs atomically, so several workers can
run against one queue without coordination.

## Nothing wedges, nothing restarts from zero

Layered time bounds, each with one owner: an inference call gets **10 minutes**, and at the
bound it is **aborted at the socket** (measured: milliseconds to rejection — no zombie
requests billing against dead jobs) with an in-flight heartbeat every 15 s while it runs; a
worker whose activity goes quiet for **15 minutes** crashes loudly (stall watchdog) rather
than wedging; a running job untouched for **30 minutes** is recovered by the queue's janitor.

Detection budgets derive from the provider's limits — chunk sizes follow the 1:2
input:output allocation, and **every** provider gets a duration cap at half the call bound
(the published worst-case rate when there is one, a conservative assumed floor for
rate-silent local models), so no call is planned to outlive its own timeout. A chunk that
still fails on size — duration, truncation, unreadable no-stop-reason output, or a flagged
under-report — is **subdivided in place and retried smaller** before it is allowed to fail
the job; an under-report that persists at the smallest size keeps what it found, loudly,
rather than discarding the unit.

Successful-looking extractions are **verified**: where the provider declares it (all real
providers), each chunk's yield is checked against a cheap parallel count call, catching the
silent under-reporting local models exhibit on repetitive text. Entity types run
**concurrently up to the provider's declared capacity** — several at once on a hosted API,
sequentially on a local single-model server, where concurrent requests would only split one
GPU.

When a job does fail, the worker classifies it: deterministic failures (an identical retry
cannot succeed) skip the retry budget; transient ones retry — and the retry **resumes from
the checkpoint** of entity types the failed attempt already persisted, paying only for what
is left.

## What it reports

Every detection model call lands in the `semiont.detection.*` metric family — duration,
items, provider-reported tokens, subdivision depth, and outcome (`success` / `truncated` /
`collapsed` / `timeout` / `error`) — alongside every anchoring outcome
(`semiont.detection.anchors`, by method), so a run's cost, yield, and precision are
queryable rather than log archaeology. See
[Observability](../../docs/system/administration/OBSERVABILITY.md) for the full inventory
and where the metrics flow.

## Related

- [`@semiont/jobs`](../../packages/jobs/) — the queue, the processors, and this entry point
- [Job Types](../../packages/jobs/docs/JobTypes.md) — params, progress and result per type
- [`semiont-worker` skill](../../docs/protocol/skills/semiont-worker/SKILL.md) — building your own job-claim daemon
