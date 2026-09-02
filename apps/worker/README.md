# semiont-worker

**Claims queued jobs and runs inference.** Detection passes, generation, and the other
long-running work that a request cannot wait on.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-worker` |
| Port | 9090 |
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

## Related

- [`@semiont/jobs`](../../packages/jobs/) — the queue, the processors, and this entry point
- [Job Types](../../packages/jobs/docs/JobTypes.md) — params, progress and result per type
- [`semiont-worker` skill](../../docs/protocol/skills/semiont-worker/SKILL.md) — building your own job-claim daemon
