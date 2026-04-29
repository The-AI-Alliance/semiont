---
name: semiont-worker
description: Build a job-claim worker daemon — claim jobs from the queue, process them, and emit lifecycle events. Cross-package wiring with @semiont/sdk + @semiont/jobs + @semiont/api-client + @semiont/observability.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user build a job-claim worker — a long-running daemon that claims jobs of a given type from the Semiont queue, processes each one, and emits the unified `job:*` lifecycle so other participants (the UI, ops dashboards, an originating CLI command) see progress and outcomes in real time.

This is the daemon shape that matches `semiont-worker` and `semiont-smelter` containers. If your daemon should *react to bus events* rather than *claim queued work*, the [`semiont-session`](../semiont-session/SKILL.md) skill is the right starting point — it covers `session.subscribe(channel, handler)` for arbitrary channels.

## When to reach for this skill

A job-claim worker is right when:

- The work is a discrete, parameterized task that should run *exactly once* across a pool of identical workers (highlight detection, reference linking, summary generation, etc.).
- The system already has a job queue carrying that job type (`@semiont/jobs`'s `FsJobQueue` is the canonical local backing store; jobs are enqueued via the `client.job` namespace).
- Multiple workers may be running concurrently and you need at-most-once claim semantics.

If the work is "react to every event of type X across every resource," that's a watcher daemon — use `semiont-session`.

## The four lifecycle events

Every job claimed by a worker emits the same four events on the bus, regardless of job type:

| Event | When | Purpose |
|---|---|---|
| `job:start` | Worker has claimed the job and is beginning work | Persisted by Stower; subscribers (UI, dashboards) flip to "running" |
| `job:report-progress` | Optional, repeated; ephemeral | Progress percentage + stage; not persisted |
| `job:complete` | Successful exit | Persisted; payload carries the `result` object |
| `job:fail` | Throwing exit | Persisted; payload carries the error message |

Annotation-scoped jobs (e.g. generation triggered by a reference) carry the source `annotationId` through every payload so the UI can attach visual feedback to that annotation. Resource-scoped jobs (bulk detection scanning a whole resource) leave `annotationId` unset.

## Setup

A worker needs a `SemiontSession` (long-running token refresh + lifecycle), a cast of `session.client.transport` to `HttpTransport` (to reach the actor that satisfies `WorkerBus`), the `createJobClaimAdapter` from `@semiont/jobs`, and a process logger from `@semiont/observability`.

Workers are inherently HTTP-bound today — local in-process workers don't make sense as a deployment shape. The cast names the seam.

```typescript
import {
  SemiontSession,
  InMemorySessionStorage,
  type KnowledgeBase,
} from '@semiont/sdk';
import { HttpTransport } from '@semiont/api-client';
import { createJobClaimAdapter, type ActiveJob } from '@semiont/jobs';
import { createProcessLogger } from '@semiont/observability/process-logger';

const logger = createProcessLogger('my-worker');

const apiUrl = process.env.SEMIONT_API_URL ?? 'http://localhost:4000';
const apiUrlObj = new URL(apiUrl);

const kb: KnowledgeBase = {
  id: 'my-worker',                              // unique storage key per worker
  label: 'My job worker',
  email: process.env.SEMIONT_USER_EMAIL!,
  endpoint: {
    kind: 'http',
    host: apiUrlObj.hostname,
    port: Number(apiUrlObj.port || (apiUrlObj.protocol === 'https:' ? 443 : 80)),
    protocol: apiUrlObj.protocol.replace(':', '') as 'http' | 'https',
  },
};

const session = await SemiontSession.signInHttp({
  kb,
  storage: new InMemorySessionStorage(),
  baseUrl: apiUrl,
  email: process.env.SEMIONT_USER_EMAIL!,
  password: process.env.SEMIONT_USER_PASSWORD!,
  // Service-principal sessions usually omit `validate` — they have a token
  // but no associated user record. User-attended workers can populate
  // session.user$ via `async () => session.client.auth!.me()`.
  onError: (err) => logger.error('session error', { code: err.code, message: err.message }),
});

// The adapter consumes a WorkerBus. HttpTransport.actor satisfies it
// structurally. The cast is the documented seam between
// transport-neutral worker code and HTTP-only deployment.
const httpTransport = session.client.transport as HttpTransport;

const adapter = createJobClaimAdapter({
  bus: httpTransport.actor,
  jobTypes: ['highlight-annotation'],   // subscribe to one or more job types
});
```

## Claiming and processing jobs

`adapter.start()` widens the SSE channel set to include `job:queued` (and the other channels the adapter needs); the adapter's reactive contract handles SSE-subscribe, claim, and completion tracking. Subscribe to `adapter.activeJob$` and dispatch:

```typescript
adapter.activeJob$.subscribe((job) => {
  if (!job) return;   // null between active jobs
  logger.info('claimed job', { jobId: job.jobId, type: job.type, resourceId: job.resourceId });
  void handleJob(job).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('job failed', { jobId: job.jobId, error: message });
    // The adapter caller emits job:fail and calls failJob;
    // see `handleJob` below for the canonical pattern.
  });
});

adapter.start();
```

Inside `handleJob`, emit lifecycle events on the same transport, do the work, then complete or fail:

```typescript
async function handleJob(job: ActiveJob): Promise<void> {
  const { jobId, type, resourceId, userId } = job;
  const annotationId = (job.params as { referenceId?: string }).referenceId;
  const lifecycleBase = {
    resourceId, userId, jobId, jobType: type,
    ...(annotationId ? { annotationId } : {}),
  };

  await session.client.transport.emit('job:start', lifecycleBase);

  try {
    // Optional: stream progress to UI / dashboards.
    await session.client.transport.emit('job:report-progress', {
      ...lifecycleBase,
      percentage: 0,
      progress: { stage: 'starting', percentage: 0, message: 'Beginning work' },
    });

    // ── Your work here ──
    const result = await doTheWork(job);

    // job:complete is a resource broadcast — every subscriber on this
    // resource sees it. Pass the resourceId as scope.
    await session.client.transport.emit(
      'job:complete',
      { ...lifecycleBase, result },
      resourceId,
    );

    adapter.completeJob();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await session.client.transport.emit(
      'job:fail',
      { ...lifecycleBase, error: message },
      resourceId,
    );
    adapter.failJob(jobId, message);
    throw err;
  }
}
```

The third argument to `transport.emit` is the resource scope — used for `job:complete` and `job:fail` (both resource broadcasts). Other events are global; pass no scope.

## Pre-built processors

For the standard job types (`highlight-annotation`, `comment-annotation`, `assessment-annotation`, `reference-annotation`, `tag-annotation`, `generation`), `@semiont/jobs` ships extracted, transport-agnostic processors:

```typescript
import {
  processHighlightJob,
  processCommentJob,
  processAssessmentJob,
  processReferenceJob,
  processTagJob,
  processGenerationJob,
  type OnProgress,
} from '@semiont/jobs';

const onProgress: OnProgress = (percentage, message, stage, extra) => {
  void session.client.transport.emit('job:report-progress', {
    ...lifecycleBase,
    percentage,
    progress: { stage, percentage, message, ...(extra ?? {}) },
  });
};

const content = await session.client.browse.resourceContent(resourceId);
const { annotations, result } = await processHighlightJob(
  content, inferenceClient, job.params, userId, generator, onProgress,
);

for (const annotation of annotations) {
  await session.client.transport.emit('mark:create', {
    annotation, userId, resourceId,
  });
}

await session.client.transport.emit('job:complete', { ...lifecycleBase, result }, resourceId);
adapter.completeJob();
```

`processHighlightJob` and friends take an `InferenceClient` (from `@semiont/inference`) plus the job's params, do the LLM work, and return ready-to-emit annotations + a typed result. They're transport-agnostic — your worker chooses how to deliver the events.

If your worker is doing custom work that doesn't match the standard job shapes, write your own processor — the lifecycle protocol (`job:start` → `job:report-progress` → `job:complete` | `job:fail`) is what matters, not the processor implementation.

## Bus debugging

Set `SEMIONT_BUS_LOG=1` to log every transport-level event (`EMIT`, `RECV`, `SSE`, `PUT`, `GET`) as a single grep-friendly line on stdout. This is the fastest way to confirm that:

- `job:queued` events are arriving (the adapter widens the SSE channel set on `start()`, but only after `start()` is called — silently missing this is the most common worker bug).
- Your `job:start` / `job:complete` emits are reaching the backend.
- The correlation IDs line up between request and response.

See [`tests/e2e/docs/bus-logging.md`](../../../../tests/e2e/docs/bus-logging.md) for the full guide. Tier 2 OpenTelemetry spans add a `trace=` suffix to every line when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured, so the grep timeline correlates with the trace UI.

For runtime SSE health, subscribe to `httpTransport.state$`:

```typescript
import type { ConnectionState } from '@semiont/core';

httpTransport.state$.subscribe((state: ConnectionState) => {
  // 'initial' | 'connecting' | 'open' | 'reconnecting' | 'degraded' | 'closed'
  logger.info('transport state', { state });
});
```

`degraded` is the threshold to surface in a status endpoint — it means the SSE has been reconnecting for >`DEGRADED_THRESHOLD_MS` and isn't a brief mount-churn cycle.

## Graceful shutdown

```typescript
async function shutdown() {
  adapter.dispose();             // cancels SSE subscription, completes activeJob$
  await session.dispose();       // cancels refresh timer, disposes the client
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

If your worker is mid-job at shutdown time, the in-flight call should be allowed to finish (or be deliberately cancelled with `adapter.failJob(jobId, 'shutdown')`) before `dispose()`. Otherwise the job will sit in `running` state until another worker re-claims it — the queue's stale-claim recovery is implementation-dependent.

## Guidance for the AI assistant

- **Pick the right skill for the daemon shape.** Job-claim workers use this skill; bus-event watchers use `semiont-session`. Both can run side by side, but the wiring is different.
- **`HttpTransport` cast is intentional.** Workers are HTTP-bound. The transport cast (`session.client.transport as HttpTransport`) names the seam — don't try to abstract it; an in-process worker would build a different `WorkerBus` shim.
- **Always emit the four lifecycle events.** UI consumers and dashboards filter by `jobType` and (optionally) `annotationId`. Skipping `job:start` or `job:complete` makes the UI think the job is stuck.
- **Resource-scope `job:complete` and `job:fail`.** Pass the `resourceId` as the third arg to `transport.emit`. Other events emit globally with no scope.
- **Use the pre-built processors when possible.** `processHighlightJob`, `processCommentJob`, `processAssessmentJob`, `processReferenceJob`, `processTagJob`, and `processGenerationJob` from `@semiont/jobs` cover the six standard job shapes. Custom processors are fine; just keep the lifecycle protocol intact.
- **`createProcessLogger` populates trace IDs automatically.** When OTel is initialized and a span is active, every log line gets `trace_id` / `span_id` fields — Tier 3 correlation between `tail -f` and the trace UI. Use it instead of `console.log`.
- **Set `SEMIONT_BUS_LOG=1` first** when debugging a worker that's silently doing nothing. The most common cause is the SSE channel set not including `job:queued` (which means `adapter.start()` wasn't called, or the cast to `HttpTransport.actor` is wrong).
- **Errors split by surface.** Per-call rejections from namespace methods extend `SemiontError` — narrow to `APIError` (HTTP) or `BusRequestError` (bus-mediated) when needed. Asynchronous session-fatal errors (`session.auth-failed`, `session.refresh-exhausted`) arrive on `SemiontBrowser.error$`; subscribe in long-running workers. See [Error Handling in Usage.md](../../../../packages/sdk/docs/Usage.md#error-handling).
- **For the production worker reference**, see [`packages/jobs/src/worker-main.ts`](../../../../packages/jobs/src/worker-main.ts) — the standalone container entry point. It uses shared-secret auth (worker pool deployment) and a per-job-type inference client map; the skill above is the user-authored equivalent.
