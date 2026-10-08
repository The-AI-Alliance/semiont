---
name: semiont-worker
description: Build a job-claim worker daemon — claim jobs from the queue, process them, and emit lifecycle events. Cross-package wiring with @semiont/sdk, @semiont/core and @semiont/jobs.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user build a worker: a daemon that claims jobs from a Semiont knowledge base's queue, does each one, and reports the job's lifecycle so that whoever asked for it, and anyone watching, sees its progress and its outcome.

It is the shape of Semiont's own `semiont-worker` service. A daemon that reacts to bus events instead of claiming queued work is a watcher, which is [`semiont-session`](../semiont-session/SKILL.md).

## When to build one

- The work is a job the knowledge base queues: a `mark` job, which annotates a resource for one motivation (`highlighting`, `commenting`, `assessing`, `linking` or `tagging`), or a `yield` job, which makes a resource. A worker of your own serves one or more of them with your own logic or your own model. Jobs are created with `job:create`, which is what `mark.delegate` and `yield.delegate` send.
- Each job must run once, however many workers are up. A claim is atomic: of any number of simultaneous claims, exactly one wins each pending job.

The dispatcher holds the queue and answers the `job:*` channels. [JOBS.md](../../../protocol/JOBS.md) is what it does, and [WORKER-CONTRACT.md](../../../protocol/WORKER-CONTRACT.md) is what a worker promises it.

## The lifecycle a worker reports

| Channel | When | What happens to it |
|---|---|---|
| `job:start` | The job is claimed and work begins | Recorded; viewers of the resource see the job running |
| `job:report-progress` | As often as there is something to say | Passed on, not recorded |
| `job:complete` | The work is done | Recorded, with the job's `result`; the dispatcher concludes the job |
| `job:fail` | The work failed | Recorded, with the error; the dispatcher retries the job if its budget allows |

Emit all four with no scope. The dispatcher and the archivist hear them on the global subscription, the caller that created the job picks its own out by `jobId`, and a resource's viewers pick theirs out by `resourceId`. A lifecycle event emitted on a resource's scope reaches none of them, and the job stays `running`.

Two more channels go to the dispatcher: `job:checkpoint` records the units a job has finished, so a retry resumes instead of starting over, and `job:cancel` confirms that the worker stopped a job whose cancellation was requested on `job:cancel-requested`.

## Who a worker is

A worker does not sign in as a person. It has two identities, obtained in two steps:

1. **The process**: a service account at the knowledge base's issuer, proved with the OAuth client-credentials grant. Its client id and secret are `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET`, the same variables Semiont's own services read.
2. **The agent**: the process exchanges its issuer token at the gateway's `POST /api/tokens/agent` for an agent token, naming the model it works with. The agent's DID is what the work is attributed to. One process may hold several, one for each model.

The service account needs two roles at the issuer: `semiont-service`, which lets it buy an agent token, and `semiont-worker`, which the gateway stamps on the agent token and without which the dispatcher refuses every claim. Granting those roles to its client is how an operator admits a worker that is not one of the stack's own.

```typescript
import { discoverIssuer, type HttpEndpoint } from '@semiont/sdk';
import { serviceAccountToken, isObject, isString } from '@semiont/core';

async function mintAgentToken(endpoint: HttpEndpoint, gatewayUrl: string): Promise<{ token: string; did: string }> {
  const clientId = process.env.SEMIONT_OIDC_CLIENT_ID;
  const clientSecret = process.env.SEMIONT_OIDC_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SEMIONT_OIDC_CLIENT_ID and SEMIONT_OIDC_CLIENT_SECRET are required');
  }

  // Step 1: the process proves who it is. The knowledge base names its issuer.
  const { issuer } = await discoverIssuer(endpoint);
  const serviceToken = await serviceAccountToken({ issuer, clientId, clientSecret });

  // Step 2: it buys the agent identity its work is attributed to.
  const response = await fetch(`${gatewayUrl}/api/tokens/agent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', model: 'gemma3:4b' }),
  });
  if (!response.ok) throw new Error(`The gateway refused the agent token: ${response.status}`);

  const minted: unknown = await response.json();
  if (!isObject(minted) || !isString(minted.token) || !isString(minted.did)) {
    throw new Error('The gateway answered without a token');
  }
  return { token: minted.token, did: minted.did };
}
```

An agent token lives an hour and has no refresh token. The session renews it by running both steps again.

## Claiming jobs

`createJobClaimAdapter` from `@semiont/jobs` runs the claim protocol on the session's connection: give it `session.client.transport` as its `bus`, and the jobs it takes as `accepts`. Each entry of `accepts` is a `JobFilter`, a partial job description: `{ jobType: 'mark', params: { motivation } }` for the `mark` jobs of one motivation, or `{ jobType: 'yield' }`. A job matches a filter when every field the filter states equals the job's, and the adapter is handed only jobs that match one of its filters. It pulls: it claims when the connection opens, again each time a job settles, on a matching `job:queued` while idle, and on every reconnect, and it parks when the dispatcher answers that nothing is pending. `job:queued` is a wake-up, not a reservation.

- `adapter.activeJob$` emits each claimed job, and `null` between jobs.
- `adapter.refused$` emits a claim the dispatcher refused for a reason other than an empty queue. `bus.unauthorized` means this credential can never claim: exit, so the operator sees it.
- `adapter.completeJob()` and `adapter.failJob(jobId, message)` settle the job in hand and pull the next.

## Doing a job

Emit `job:start`, do the work, then emit `job:complete` with the job's result, or `job:fail`.

A completion is its verb's. It states its `jobType`, and its `result` is what that verb reports: a `mark` job's counts or a decline, the resource a `yield` job made or a decline. The gateway refuses a completion whose result is the other verb's. Every `mark` job reports the same counts, whatever its motivation: `found`, what the model proposed, and `persisted`, what the log holds. The worker below claims `mark` jobs only, so its completion says `mark`.

```typescript
import type { SemiontSession } from '@semiont/sdk';
import type { ActiveJob, JobClaimAdapter } from '@semiont/jobs';

/** Your work. A `mark` job reports how many passages the model proposed and how many were written. */
type Work = (session: SemiontSession, job: ActiveJob) => Promise<{ found: number; persisted: number }>;

async function runJob(session: SemiontSession, adapter: JobClaimAdapter, job: ActiveJob, work: Work): Promise<void> {
  const { transport } = session.client;
  // Nothing here says who the job is for. The gateway stamps this worker's
  // identity on every emit, and the knowledge base derives who asked from the job.
  const base = { resourceId: job.resourceId, jobId: job.jobId, jobType: job.type };

  await transport.emit('job:start', base);
  try {
    await transport.emit('job:report-progress', {
      ...base,
      percentage: 10,
      progress: { percentage: 10, message: { code: 'analyzing' } },
    });

    const { found, persisted } = await work(session, job);

    await transport.emit('job:complete', {
      ...base,
      jobType: 'mark',
      result: { found, persisted },
    });
    adapter.completeJob();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await transport.emit('job:fail', { ...base, error });
    adapter.failJob(job.jobId, error);
  }
}
```

A progress message is a code, not a sentence: each client renders it in its reader's language. The codes are in [`JobProgressMessage`](../../../../specs/src/components/schemas/JobProgressMessage.json).

A `job:fail` may say `willRetry: true` when the queue will run the job again. Without it, whoever is following the job treats the failure as final.

## Writing what a job produces

A worker reads the resource through the same client as any script: `session.client.browse.resourceContent(job.resourceId)` for its text, `job.params` for what the caller asked.

It writes annotations with `mark:commit`: one batch, answered only when every annotation is in the event log, and citing the job it fulfils. The knowledge base derives who the annotations are for from that job, so the batch says what produced them (`generator`) and never who asked. A batch that names a `creator` is refused, and so is one from a worker that cites no job.

```typescript
import { busRequest, type BusRequestPrimitive } from '@semiont/core';
import type { Annotation } from '@semiont/sdk';
import type { ActiveJob } from '@semiont/jobs';

async function commit(bus: BusRequestPrimitive, job: ActiveJob, annotations: Annotation[]): Promise<void> {
  if (annotations.length === 0) return;
  await busRequest(bus, 'mark:commit', { resourceId: job.resourceId, annotations, jobId: job.jobId });
}
```

Pass `session.client.transport` as `bus`. Give each annotation a deterministic id, so that committing a batch again after a retry changes nothing. `buildTextAnnotation` in [`packages/jobs/src/processors.ts`](../../../../packages/jobs/src/processors.ts) is how Semiont's worker builds one.

`@semiont/jobs` also exports the processors Semiont's worker runs: `processHighlightJob`, `processCommentJob`, `processAssessmentJob`, `processReferenceJob`, `processTagJob` and `processGenerationJob`. Each takes the text, an inference client, the job's params and callbacks for progress and for committing each chunk, and returns the job's result. Use them to serve a job with a different model and the same logic. Their signatures are in [the workers guide](../../../../packages/jobs/docs/Workers.md#built-in-jobs).

## Complete worker

```typescript
import {
  SemiontSession, InMemorySessionStorage, discoverIssuer, type HttpEndpoint,
} from '@semiont/sdk';
import { serviceAccountToken, isObject, isString } from '@semiont/core';
import { createJobClaimAdapter, type ActiveJob } from '@semiont/jobs';

const gatewayUrl = process.env.SEMIONT_API_URL ?? 'http://localhost:4000';
const url = new URL(gatewayUrl);
const endpoint: HttpEndpoint = {
  kind: 'http',
  host: url.hostname,
  port: Number(url.port || 4000),
  protocol: url.protocol === 'https:' ? 'https' : 'http',
};

async function mintAgentToken(): Promise<{ token: string; did: string }> {
  const clientId = process.env.SEMIONT_OIDC_CLIENT_ID;
  const clientSecret = process.env.SEMIONT_OIDC_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SEMIONT_OIDC_CLIENT_ID and SEMIONT_OIDC_CLIENT_SECRET are required');
  }
  const { issuer } = await discoverIssuer(endpoint);
  const serviceToken = await serviceAccountToken({ issuer, clientId, clientSecret });

  const response = await fetch(`${gatewayUrl}/api/tokens/agent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', model: 'gemma3:4b' }),
  });
  if (!response.ok) throw new Error(`The gateway refused the agent token: ${response.status}`);

  const minted: unknown = await response.json();
  if (!isObject(minted) || !isString(minted.token) || !isString(minted.did)) {
    throw new Error('The gateway answered without a token');
  }
  return { token: minted.token, did: minted.did };
}

/** Your work: read the resource, find the passages, commit them. */
async function highlight(session: SemiontSession, job: ActiveJob): Promise<{ found: number; persisted: number }> {
  const text = await session.client.browse.resourceContent(job.resourceId);
  console.log(`job ${job.jobId}: ${text.length} characters to read`);
  return { found: 0, persisted: 0 };
}

async function main(): Promise<void> {
  const agent = await mintAgentToken();
  console.log(`working as ${agent.did}`);

  const session = SemiontSession.fromHttp({
    kb: { id: 'my-worker', label: 'My job worker', endpoint },
    storage: new InMemorySessionStorage(),
    baseUrl: gatewayUrl,
    token: agent.token,
    refresh: async () => (await mintAgentToken()).token,
    onError: (err) => console.error('session error:', err.code, err.message),
  });
  await session.ready;

  // The claim protocol runs on the session's own connection.
  const { transport } = session.client;
  const adapter = createJobClaimAdapter({
    bus: transport,
    accepts: [{ jobType: 'mark', params: { motivation: 'highlighting' } }],
  });

  adapter.refused$.subscribe((refusal) => {
    console.error(`claim refused (${refusal.code}): ${refusal.message}`);
    if (refusal.code === 'bus.unauthorized') process.exit(1);
  });

  adapter.activeJob$.subscribe((job) => {
    if (!job) return;   // null between jobs
    const base = { resourceId: job.resourceId, jobId: job.jobId, jobType: job.type };

    (async () => {
      await transport.emit('job:start', base);
      try {
        const { found, persisted } = await highlight(session, job);
        await transport.emit('job:complete', {
          ...base,
          jobType: 'mark',
          result: { found, persisted },
        });
        adapter.completeJob();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await transport.emit('job:fail', { ...base, error });
        adapter.failJob(job.jobId, error);
      }
    })().catch((err) => console.error(`job ${job.jobId}: could not report its outcome:`, err));
  });

  adapter.start();

  async function shutdown(): Promise<void> {
    adapter.dispose();
    await session.dispose();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Let a job in hand finish before shutting down, or fail it deliberately with `job:fail` and `adapter.failJob(jobId, 'shutdown')`. A job abandoned mid-run stays `running` until the dispatcher's sweep finds it with no progress or checkpoint for 30 minutes, and then re-queues it if its retry budget allows ([JOBS.md](../../../protocol/JOBS.md#periodic-work)).

## When a worker does nothing

Set `SEMIONT_BUS_LOG=1` in the worker's environment. Every emit, reply and stream frame is then logged as one line, and the claim protocol can be read off the log:

- **No `job:claim` at all**: `adapter.start()` was never called, or the connection never opened. Watch the connection with `session.streamState$`.
- **Every claim answered `job:claim-failed`, saying the caller is not a worker**: the service account lacks the `semiont-worker` role, so the agent token carries no worker capability. `refused$` reports it as `bus.unauthorized`. On a launcher stack, `semiont identity sync` repairs the roles of the stack's own clients.
- **Claims answered with nothing pending**: the worker is healthy and the queue has no job its claim matches.

```typescript
session.streamState$.subscribe((state) => console.log(`connection: ${state}`));
```

`degraded` means the stream has been reconnecting for more than three seconds, which is the state worth reporting from a health endpoint.

## Guidance for the AI assistant

- **Worker or watcher.** A worker claims queued jobs. A watcher reacts to events and is [`semiont-session`](../semiont-session/SKILL.md). One process can be both.
- **Report all four lifecycle events, with no scope.** A job with no `job:start` looks stuck, and one with no `job:complete` or `job:fail` is stuck until the dispatcher's sweep.
- **Settle every job.** Each claimed job ends in `adapter.completeJob()` or `adapter.failJob(...)`. The adapter holds one job at a time and pulls the next only when the one in hand settles.
- **Exit on `bus.unauthorized`.** A credential that cannot claim will never be able to. A crash the operator can see is better than a worker that idles forever.
- **Never state who a job is for.** Not in a lifecycle event and not in what the worker writes. The knowledge base derives it from the job.
- **Use Semiont's processors when the logic is Semiont's.** Write your own when the logic is the point.
- **The reference implementation** is Semiont's own worker: [`worker-main.ts`](../../../../packages/jobs/src/worker-main.ts) for the process, [`worker-runtime.ts`](../../../../packages/jobs/src/worker-runtime.ts) for identity and the session, and [`worker-process.ts`](../../../../packages/jobs/src/worker-process.ts) for checkpoints, cancellation and what it does when a commit's acknowledgement is lost.
- **Errors.** A call rejects with a `SemiontError`: catch it and route on its `code`. A failure of the session itself arrives at `onError` as a `SemiontSessionError`. See [Error Handling](../../Usage.md#error-handling).
