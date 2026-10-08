---
name: semiont-worker
description: Build a job-claim worker daemon — claim jobs from the queue, process them, and report each one's lifecycle. In TypeScript on @semiont/sdk and @semiont/core, in Rust on the semiont and semiont-http-transport crates, or in Python on the semiont package.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user build a worker: a daemon that claims jobs from a Semiont knowledge base's queue, does each one, and reports the job's lifecycle so that whoever asked for it, and anyone watching, sees its progress and its outcome.

It is the shape of Semiont's own `semiont-worker` service. A daemon that reacts to bus events instead of claiming queued work is a watcher, which is [`semiont-session`](../semiont-session/SKILL.md).

The worker is built up below in TypeScript. [The same worker in Rust](#the-same-worker-in-rust) and [in Python](#the-same-worker-in-python) follow it. The queue, the lifecycle, who a worker is and what it promises are the same in all three.

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

A held job says all four itself, with no scope. The dispatcher and the archivist hear them on the global subscription, the caller that created the job picks its own out by `jobId`, and a resource's viewers pick theirs out by `resourceId`.

Two more channels go to the dispatcher: `job:checkpoint` records the units a job has finished, so a retry resumes instead of starting over, and `job:cancel` confirms that the worker stopped a job whose cancellation was requested on `job:cancel-requested`.

## Who a worker is

A worker does not sign in as a person. It has two identities, obtained in two steps:

1. **The process**: a service account at the knowledge base's issuer, proved with the OAuth client-credentials grant. Its client id and secret are `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET`, the same variables Semiont's own services read.
2. **The agent**: the process exchanges its issuer token at the gateway's `POST /api/tokens/agent` for an agent token, naming the model it works with. The agent's DID is what the work is attributed to. One process may hold several, one for each model.

The service account needs two roles at the issuer: `semiont-service`, which lets it buy an agent token, and `semiont-worker`, which the gateway stamps on the agent token and without which the dispatcher refuses every claim. Granting those roles to its client is how an operator admits a worker that is not one of the stack's own.

`startAgentSession` does both steps, and keeps the agent's token fresh for as long as the process runs. An agent token lives an hour and has no refresh token: the session renews it by signing in again. The client is built over what it holds.

```typescript
import {
  HttpContentTransport, HttpTransport, JOB_CLAIM_CHANNELS, SemiontClient,
  discoverIssuer, startAgentSession, type AgentSession, type HttpEndpoint,
} from '@semiont/sdk';
import { baseUrl, replyChannelsFor } from '@semiont/core';

async function signIn(endpoint: HttpEndpoint, gatewayUrl: string): Promise<{ agent: AgentSession; client: SemiontClient }> {
  const clientId = process.env.SEMIONT_OIDC_CLIENT_ID;
  const clientSecret = process.env.SEMIONT_OIDC_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SEMIONT_OIDC_CLIENT_ID and SEMIONT_OIDC_CLIENT_SECRET are required');
  }

  // The knowledge base names its issuer. The process proves who it is there,
  // and is given the agent identity its work is attributed to.
  const { issuer } = await discoverIssuer(endpoint);
  const agent = await startAgentSession({
    baseUrl: gatewayUrl,
    credential: { issuer, clientId, clientSecret },
    provider: 'ollama',
    model: 'gemma3:4b',
    logger: console,
  });

  const transport = new HttpTransport({
    baseUrl: baseUrl(gatewayUrl),
    token$: agent.token$,
    tokenRefresher: agent.refresh,
    // What this worker's stream names: what claiming reads, and the replies
    // of each operation the worker awaits. Here that is its commit.
    channels: [...JOB_CLAIM_CHANNELS, ...replyChannelsFor(['mark:commit'])],
  });
  return { agent, client: new SemiontClient(transport, new HttpContentTransport(transport), transport) };
}
```

`agent.did` is the agent's DID, as the gateway minted it.

**The stream must name `JOB_CLAIM_CHANNELS`.** `job:queued` and `job:cancel-requested` reach only a stream that names them, and a client made with no `channels` does not. `job.claim` refuses such a client at once, with `bus.unsubscribed`, where it would otherwise claim once and never be woken. A worker also names the reply channels of each bus operation it awaits (`replyChannelsFor`), and nothing else: every other client's replies are traffic it would only parse and drop.

## Claiming jobs

`client.job.claim({ accepts })` runs the claim protocol on the client's connection. Each entry of `accepts` is a `JobFilter`, a partial job description: `{ jobType: 'mark', params: { motivation } }` for the `mark` jobs of one motivation, or `{ jobType: 'yield' }`. A job matches a filter when every field the filter states equals the job's, and the worker is handed only jobs that match one of its filters. It pulls: it claims when the connection opens, again each time a job settles, on a matching `job:queued` while idle, and on every reconnect, and it waits when the dispatcher answers that nothing is pending. `job:queued` is a wake-up, not a reservation.

What it returns is the worker's claims:

- Subscribing starts the claiming, and each value is a **held job**: the next one arrives when the one in hand is settled. The claims are read once.
- `claims.refused$` emits a claim the dispatcher refused for a reason other than an empty queue. `bus.unauthorized` means this credential can never claim: exit, so the operator sees it.
- `claims.stalled$` emits when the held job has shown no activity for fifteen minutes. A worker that never settles never claims again, so the usual answer is to exit and be restarted.
- `claims.vitals()` is what the worker can say of itself: when it last heard an announcement, claimed, was active and settled, the job it holds, and how many it has completed. It is what a health endpoint reports.
- `claims.stop()` stops the claiming, and fails a job still held so that the queue retries it at once.

## Doing a job

A held job says its own lifecycle: `job.start()`, then `job.progress(...)` and `job.checkpoint(...)` as often as there is something to say, then exactly one of `job.complete(result)`, `job.fail(message)` and `job.cancel()`. Each of those three says the outcome and releases the job in one call, and a second is refused. Progress and checkpoints count as activity.

A completion is its verb's. Its `result` is what that verb reports: a `mark` job's counts or a decline, the resource a `yield` job made or a decline, and the gateway refuses a completion whose result is the other verb's. So a held job is typed by its verb, and `job.jobType` is narrowed before `complete` is called. Every `mark` job reports the same counts, whatever its motivation: `found`, what the model proposed, and `persisted`, what the log holds.

```typescript
import type { HeldMarkJob, SemiontClient } from '@semiont/sdk';

/** Your work. A `mark` job reports how many passages the model proposed and how many were written. */
type Work = (client: SemiontClient, job: HeldMarkJob) => Promise<{ found: number; persisted: number }>;

async function runJob(client: SemiontClient, job: HeldMarkJob, work: Work): Promise<void> {
  // Nothing here says who the job is for. The gateway stamps this worker's
  // identity on every message, and the knowledge base derives who asked from the job.
  await job.start();
  try {
    await job.progress({ percentage: 10, message: { code: 'analyzing' } });

    const { found, persisted } = await work(client, job);

    await job.complete({ found, persisted });
  } catch (err) {
    // A completion the gateway did not take has released the job already.
    if (job.settled) throw err;
    await job.fail(err instanceof Error ? err.message : String(err));
  }
}
```

A progress message is a code, not a sentence: each client renders it in its reader's language. The codes are in [`JobProgressMessage`](../../../../specs/src/components/schemas/JobProgressMessage.json).

`job.fail` says whether the queue will run the job again (`willRetry`), from the retry budget on the record the worker claimed. Tell it the failure's class when you know it: `job.fail(message, { failureClass: 'deterministic' })` for a failure no second attempt can change, which the queue then does not retry. `job.cancelled` is an `AbortSignal`, aborted when a cancellation names the held job: stop where the work can, and say `job.cancel()`.

## Writing what a job produces

A worker reads the resource through the same client as any script: `client.browse.resourceContent(job.resourceId)` for its text, `job.params` for what the caller asked.

It writes annotations with `mark:commit`: one batch, answered only when every annotation is in the event log, and citing the job it fulfils. The knowledge base derives who the annotations are for from that job, so the batch says what produced them (`generator`) and never who asked. A batch that names a `creator` is refused, and so is one from a worker that cites no job.

```typescript
import { busRequest } from '@semiont/core';
import type { Annotation, HeldJob, SemiontClient } from '@semiont/sdk';

async function commit(client: SemiontClient, job: HeldJob, annotations: Annotation[]): Promise<void> {
  if (annotations.length === 0) return;
  await busRequest(client.transport, 'mark:commit', { resourceId: job.resourceId, annotations, jobId: job.jobId });
}
```

The worker's stream must name the commit's reply channels, as the sign-in above does. Give each annotation a deterministic id, so that committing a batch again after a retry changes nothing. `buildTextAnnotation` in [`packages/jobs/src/processors.ts`](../../../../packages/jobs/src/processors.ts) is how Semiont's worker builds one.

`@semiont/jobs` also exports the processors Semiont's worker runs: `processHighlightJob`, `processCommentJob`, `processAssessmentJob`, `processReferenceJob`, `processTagJob` and `processGenerationJob`. Each takes the text, an inference client, the job's params and callbacks for progress and for committing each chunk, and returns the job's result. Use them to serve a job with a different model and the same logic. Their signatures are in [the workers guide](../../../../packages/jobs/docs/Workers.md#built-in-jobs).

## Complete worker

```typescript
import {
  HttpContentTransport, HttpTransport, JOB_CLAIM_CHANNELS, SemiontClient,
  discoverIssuer, startAgentSession, type HeldMarkJob, type HttpEndpoint,
} from '@semiont/sdk';
import { baseUrl } from '@semiont/core';

const gatewayUrl = process.env.SEMIONT_API_URL ?? 'http://localhost:4000';
const url = new URL(gatewayUrl);
const endpoint: HttpEndpoint = {
  kind: 'http',
  host: url.hostname,
  port: Number(url.port || 4000),
  protocol: url.protocol === 'https:' ? 'https' : 'http',
};

/** Your work: read the resource, find the passages, commit them. */
async function highlight(client: SemiontClient, job: HeldMarkJob): Promise<{ found: number; persisted: number }> {
  const text = await client.browse.resourceContent(job.resourceId);
  console.log(`job ${job.jobId}: ${text.length} characters to read`);
  return { found: 0, persisted: 0 };
}

async function main(): Promise<void> {
  const clientId = process.env.SEMIONT_OIDC_CLIENT_ID;
  const clientSecret = process.env.SEMIONT_OIDC_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SEMIONT_OIDC_CLIENT_ID and SEMIONT_OIDC_CLIENT_SECRET are required');
  }

  const { issuer } = await discoverIssuer(endpoint);
  const agent = await startAgentSession({
    baseUrl: gatewayUrl,
    credential: { issuer, clientId, clientSecret },
    provider: 'ollama',
    model: 'gemma3:4b',
    logger: console,
  });
  console.log(`working as ${agent.did}`);

  // This worker awaits nothing but its claims, so its stream names nothing else.
  const transport = new HttpTransport({
    baseUrl: baseUrl(gatewayUrl),
    token$: agent.token$,
    tokenRefresher: agent.refresh,
    channels: JOB_CLAIM_CHANNELS,
  });
  const client = new SemiontClient(transport, new HttpContentTransport(transport), transport);

  const claims = client.job.claim({
    accepts: [{ jobType: 'mark', params: { motivation: 'highlighting' } }],
  });

  claims.refused$.subscribe((refusal) => {
    console.error(`claim refused (${refusal.code}): ${refusal.message}`);
    if (refusal.code === 'bus.unauthorized') process.exit(1);
  });
  claims.stalled$.subscribe((stall) => {
    console.error(`job ${stall.jobId} has been silent for ${stall.silentForMs} ms`);
    process.exit(1);
  });

  claims.subscribe({
    next: (job) => {
      (async () => {
        // The claim accepts `mark` jobs only, and a completion is its verb's.
        if (job.jobType !== 'mark') {
          await job.fail(`this worker runs no ${job.jobType} job`);
          return;
        }
        await job.start();
        try {
          const { found, persisted } = await highlight(client, job);
          await job.complete({ found, persisted });
        } catch (err) {
          if (job.settled) throw err;
          await job.fail(err instanceof Error ? err.message : String(err));
        }
      })().catch((err) => console.error(`job ${job.jobId}: could not report its outcome:`, err));
    },
    error: (err) => {
      console.error('cannot claim:', err);
      process.exit(1);
    },
  });

  async function shutdown(): Promise<void> {
    // A job still held is failed by the stop, and the queue retries it at once.
    await claims.stop();
    agent.stop();
    client.dispose();
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

Let a job in hand finish before shutting down, or stop the claims, which fails it. A job whose worker simply died stays `running` until the dispatcher's sweep finds it with no progress or checkpoint for 30 minutes, and then re-queues it if its retry budget allows ([JOBS.md](../../../protocol/JOBS.md#periodic-work)).

## The same worker in Rust

The Rust SDK is two crates: `semiont`, whose client has `job.claim`, and `semiont-http-transport`, which signs the worker in. `AgentToken::sign_in` does both steps of [who a worker is](#who-a-worker-is), and keeps the agent's token fresh for as long as the process holds it.

```rust
// A worker signs in as a daemon does: with its service account, as the
// agent its work is attributed to.
let agent = AgentToken::sign_in(
    gateway,
    Agent {
        provider: "ollama".to_owned(),
        model: "gemma3:4b".to_owned(),
    },
    ServiceToken::new(credential, http.clone()),
    http.clone(),
)
.await?;
println!("working as {}", agent.did());
let client = client(
    HttpTransportConfig {
        base_url: agent.gateway().to_owned(),
        token: agent.token(),
        refresher: Some(agent.clone()),
        // Its stream names what claiming reads. This worker awaits
        // nothing else, so it names nothing else.
        channels: Some(JOB_CLAIM_CHANNELS.map(str::to_owned).to_vec()),
        http,
        timing: Timing::default(),
        bookmarks: None,
    },
    ClientOptions::default(),
);

// What it accepts: the `mark` jobs of one motivation.
let highlighting = MarkJobFilter::new(MarkJobFilterParams {
    motivation: Motivation::Highlighting,
});
let claims = client
    .job
    .claim(ClaimOptions::new(vec![highlighting.into()]));

// Each job the worker comes to hold, one at a time. The next is claimed
// when this one settles.
while let Some(handed) = claims.next().await {
    match handed {
        Ok(HeldJob::Mark(job)) => {
            job.start().await?;
            // Your work: read the resource, find the passages, commit them.
            job.progress(JobProgress::new(50.0)).await?;
            let result = JobDetectionResult::new(0, 0);
            // A settle takes the job, so it cannot be settled twice. A
            // job dropped unsettled is failed, and the queue retries it.
            job.complete(result.into(), None).await?;
        }
        Ok(HeldJob::Yield(job)) => {
            let never = JobFailure {
                failure_class: Some(FailureClass::Deterministic),
                ..JobFailure::default()
            };
            job.fail("this worker runs no yield job", never).await?;
        }
        Err(refusal) => {
            eprintln!("claim refused: {}", refusal.message);
            // This credential can never claim. Stop, so that whoever
            // runs the worker sees it.
            if refusal.code == Some(BusRequestErrorCode::Unauthorized) {
                break;
            }
        }
    }
}
// Stopping fails a job the worker still holds.
claims.stop().await;
```

`gateway` is the gateway's origin as text, `credential` is the service account (a `Credential`: its issuer, client id and client secret), and `http` is the process's `reqwest::Client`. [The transport's README](../../../../packages/http-transport-rust/README.md#a-daemon) has what surrounds this block, and [the SDK's](../../../../packages/sdk-rust/README.md#a-worker) has the rules it keeps.

What differs from TypeScript is what the language gives:

- `claims.next().await` gives the next held job, or `Err` with a claim that was refused. A stream that does not name `JOB_CLAIM_CHANNELS` is one refusal, `Unsubscribed`, and then the claims end.
- A held job is matched by its verb, `HeldJob::Mark` or `HeldJob::Yield`, before `complete` is called.
- `complete`, `fail` and `cancel` take the job by value, so settling twice does not compile. A job dropped unsettled is failed.
- `job.cancelled()` and `claims.stalled()` are `tokio::sync::watch` receivers: the first turns true when a cancellation names the held job, and the second holds the last stall.

## The same worker in Python

The Python SDK is one package, `semiont`. `AgentToken`, held with `async with`, does both steps of [who a worker is](#who-a-worker-is), and keeps the agent's token fresh until its block is left.

```python
from semiont.claims import JOB_CLAIM_CHANNELS, ClaimRefusal, HeldMarkJob, HeldYieldJob
from semiont.client import SemiontClient
from semiont.http import AgentToken, Credential, HttpTransport, ServiceToken
from semiont.types import JobDetectionResult, JobProgress, MarkJobFilter, MarkJobFilterParams


async def highlight(job: HeldMarkJob) -> JobDetectionResult:
    """Your work: read the resource, find the passages, commit them."""
    await job.progress(JobProgress(percentage=50))
    return JobDetectionResult(found=0, persisted=0)


async def work(gateway: str, issuer: str, client_id: str, secret: str) -> None:
    # The process proves who it is at the issuer, and is given the agent its work is attributed to.
    service = ServiceToken(Credential(issuer=issuer, client_id=client_id, client_secret=secret))
    accepts = [MarkJobFilter(job_type="mark", params=MarkJobFilterParams(motivation="highlighting"))]
    async with (
        AgentToken(gateway, provider="ollama", model="gemma3:4b", service=service) as agent,
        # Its stream names what claiming reads. This worker awaits nothing else, so it names nothing else.
        HttpTransport(gateway, token=agent.token, refresher=agent.refresh, channels=JOB_CLAIM_CHANNELS) as transport,
        SemiontClient(transport, transport.content, transport) as client,
        # Leaving this block stops the worker: a job it still holds is failed first, and the queue retries it.
        client.job.claim(accepts) as claims,
    ):
        # Each job the worker comes to hold, one at a time. The next is claimed when this one settles.
        async for handed in claims:
            match handed:
                case ClaimRefusal(code="bus.unauthorized"):
                    # This credential can never claim. Stop, so that whoever runs the worker sees it.
                    raise PermissionError(handed.message)
                case ClaimRefusal():
                    print(f"claim refused: {handed.message}")
                case HeldYieldJob():
                    await handed.fail("this worker runs no yield job", failure_class="deterministic")
                case HeldMarkJob():
                    # A job left unsettled at the end of this block is failed.
                    async with handed as job:
                        await job.start()
                        try:
                            result = await highlight(job)
                        except Exception as error:
                            await job.fail(str(error))
                        else:
                            await job.complete(result)
```

`gateway` is the gateway's origin and `issuer` is the issuer the knowledge base trusts. Nothing in the package reads the environment: the process reads its own `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET`, and passes what it found. [The package's README](../../../../packages/sdk-python/README.md#a-worker) has the rules this program keeps.

What differs from TypeScript is what the language gives:

- `async for` over the claims gives each held job, or a `ClaimRefusal`. A stream that does not name `JOB_CLAIM_CHANNELS` raises at the first read, as `bus.unsubscribed`.
- A held job is a `HeldMarkJob` or a `HeldYieldJob`, told apart before `complete` is called.
- `async with job` fails a job its block left unsettled. Leaving the claims' block, or `await claims.aclose()`, stops the worker and fails the job it still holds.
- `job.cancelled` and `claims.stalled` are watched values: `.value` now, and `async for` each value after it.
- A process is stopped by cancelling the task that runs `work`: the blocks it leaves on the way out stop the worker and close the client.

## When a worker does nothing

Set `SEMIONT_BUS_LOG=1` in the worker's environment. Every emit, reply and stream frame is then logged as one line, and the claim protocol can be read off the log:

- **No `job:claim` at all**: the claims were never subscribed to, or the connection never opened. Watch the connection with `client.state$`.
- **Every claim answered `job:claim-failed`, saying the caller is not a worker**: the service account lacks the `semiont-worker` role, so the agent token carries no worker capability. `refused$` reports it as `bus.unauthorized`. On a launcher stack, `semiont identity sync` repairs the roles of the stack's own clients.
- **Claims answered with nothing pending**: the worker is healthy and the queue has no job its claim matches.

```typescript
semiont.state$.subscribe((state) => console.log(`connection: ${state}`));
```

`degraded` means the stream has been reconnecting for more than three seconds, which is the state worth reporting from a health endpoint.

## Guidance for the AI assistant

- **Write the worker in the language of the user's project.** Take the TypeScript, the Rust or the Python worker above as it stands. Each is a program its SDK's tests compile and run, so do not translate one into another by hand: the names differ where the languages do.
- **Worker or watcher.** A worker claims queued jobs. A watcher reacts to events and is [`semiont-session`](../semiont-session/SKILL.md). One process can be both.
- **Say the whole lifecycle through the held job.** A job with no `job.start()` looks stuck, and one never settled is stuck until the dispatcher's sweep. Never emit a `job:*` message on the transport yourself.
- **Settle every job, once.** Each held job ends in `job.complete(...)`, `job.fail(...)` or `job.cancel()`. The worker holds one job at a time and claims the next only when the one in hand settles.
- **Give the transport its channels.** `JOB_CLAIM_CHANNELS`, and the reply channels of whatever else the worker awaits.
- **Exit on `bus.unauthorized`.** A credential that cannot claim will never be able to. A crash the operator can see is better than a worker that idles forever.
- **Never state who a job is for.** Not in a lifecycle event and not in what the worker writes. The knowledge base derives it from the job.
- **Use Semiont's processors when the logic is Semiont's.** Write your own when the logic is the point.
- **The reference implementation** is Semiont's own worker: [`worker-main.ts`](../../../../packages/jobs/src/worker-main.ts) for the process, [`worker-runtime.ts`](../../../../packages/jobs/src/worker-runtime.ts) for identity and the client, and [`worker-process.ts`](../../../../packages/jobs/src/worker-process.ts) for checkpoints, cancellation and what it does when a commit's acknowledgement is lost.
- **Errors.** A call rejects with a `SemiontError`: catch it and route on its `code`. See [Error Handling](../../Usage.md#error-handling).
