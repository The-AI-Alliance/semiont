# @semiont/sdk

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+sdk%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=sdk)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=sdk)
[![npm version](https://img.shields.io/npm/v/@semiont/sdk.svg)](https://www.npmjs.com/package/@semiont/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/sdk.svg)](https://www.npmjs.com/package/@semiont/sdk)
[![License](https://img.shields.io/npm/l/@semiont/sdk.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The TypeScript SDK for [Semiont](https://github.com/The-AI-Alliance/semiont), an open platform for building
trusted AI knowledge bases: a shared workspace where humans and AI agents
annotate, connect and govern a corpus of documents.

This package is the client. With it a program reads and writes one knowledge
base: it adds resources, annotates and links them, searches them, gathers
context for a model, and hears what the other participants do as they do it.
A person's application and an AI agent use the same client. The SDK does not
tell them apart.

It has the same namespaces, methods and behaviour as the
[Rust SDK](https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk-rust) ([`semiont`](https://crates.io/crates/semiont) on crates.io)
and the [Python SDK](https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk-python) ([`semiont`](https://pypi.org/project/semiont/) on PyPI),
and the three are held to the same [conformance suite](https://github.com/The-AI-Alliance/semiont/tree/main/tests/conformance/sdk).
New to Semiont? The [Introduction](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/INTRODUCTION.md)
explains the domain and the ideas the API falls out of.

## Install

```bash
npm install @semiont/sdk
```

It runs in a browser and in Node. A client speaks to a running knowledge base.
The [Quick Start](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/QUICK-START.md) sets one up on
your own machine.

## Connect

Sign-in happens at the knowledge base's identity provider, never at the gateway. A script uses
the device grant: it prints a URL, the person approves in any browser, and the session comes
back live. `SemiontSession` owns the token lifecycle (proactive refresh at the issuer, storage,
disposal); `kb.id` is the storage key, so distinct scripts use distinct ids. There is no
client-level signIn: the issuer decides how long an access token lives and it is short — minutes,
not hours — so anything that outlives one token needs a session to renew it.

```ts
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const session = await SemiontSession.signInDevice({
  kb: httpKb({ id: 'my-watcher', label: 'My Watcher',
               host: 'localhost', port: 4000, protocol: 'http' }),
  storage: new InMemorySessionStorage(),
  onCode: ({ verificationUri, userCode }) => console.log(`Open ${verificationUri} and enter ${userCode}`),
});
const { resources } = await session.client.browse.resources({ limit: 10 }).fresh();
```

Already hold tokens? `SemiontSession.fromIssuedSession(...)` takes the access and refresh pair.
`SemiontSession.fromHttp(...)` takes a bare access token and the `refresh` that renews it.
`SemiontClient.fromHttp({ baseUrl, token })` takes a bare token and never renews it, which suits
a one-shot script that finishes inside one token's life.

## Eight verbs

Every operation belongs to one of eight flows: verbs for what a participant
does with a shared corpus. Four write, three read, and one directs
attention. Each is a namespace of the client.

| | Verb | What it does | Among its methods |
|---|---|---|---|
| Writing | `yield` | Introduce a resource, uploaded or generated from gathered context | `yield.resource`, `yield.delegate` |
| | `mark` | Annotate a resource | `mark.annotation`, `mark.delegate`, `mark.updateEntityTypes`, `mark.archive` |
| | `bind` | Resolve an ambiguous reference to a specific resource | `bind.body`, `bind.initiate` |
| | `frame` | Define and grow the schema vocabulary | `frame.addEntityTypes`, `frame.addTagSchema` |
| Reading | `browse` | Navigate, read and observe, including who is here | `browse.resource`, `browse.annotations`, `browse.agents`, `browse.click` |
| | `match` | Search the corpus: resources by text, and candidates for a reference | `match.resources`, `match.search` |
| | `gather` | Assemble grounding context around a resource or an annotation, and list what refers to a resource | `gather.resource`, `gather.annotation`, `gather.referencedBy` |
| Attention | `beckon` | Direct attention across participants | `beckon.hover`, `beckon.sparkle`, `beckon.openResource` |

Beside the eight are `job`, and `auth` and `system` when the client has a
gateway. What each flow means is in
[docs/protocol/flows](https://github.com/The-AI-Alliance/semiont/tree/main/docs/protocol/flows).

## A first program

From a signed-in session, this ingests a paper, has a model mark the concepts
it mentions, gathers the context around it, and generates a summary grounded
in that context. Those are the [Quick Start](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/QUICK-START.md)'s
last two steps, from code, and the two that come next. [Connect](#connect) is
how a session comes to be signed in.

```ts
// Ingest: the paper's bytes become a resource.
const { resourceId } = await session.client.yield.resource({
  name: 'Attention Is All You Need',
  file,                                   // a browser File or a Node Buffer
  format: 'application/pdf',
  storageUri: 'file://papers/attention-is-all-you-need.pdf',
});

// Annotate: a model reads it and marks each mention of a concept.
await session.client.mark.delegate(resourceId, { motivation: 'linking', entityTypes: ['Concept'] });

// Gather: the paper, its annotations, and what the knowledge base holds around it.
const context = await session.client.gather.resource(resourceId);

// Generate: a new resource, grounded in that context and linked to its source.
const done = await session.client.yield.delegate({
  title: 'Attention Is All You Need: a summary',
  storageUri: 'file://generated/attention-summary.md',
  context,
  task: 'summary',
});
if (done.result && 'resourceId' in done.result) {
  console.log('The summary is', done.result.resourceId);
}

await session.dispose();
```

Both resources, and every annotation the model made, are in the knowledge base
for the next participant, person or agent, to read and build on.

Where to go from here:

- The [Developer Guide](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/DEVELOPER-GUIDE.md) has
  each of these steps as a recipe, and the ones after them: reading, searching,
  annotating by hand, reacting to what others do, and testing.
- The [agent skills](https://github.com/The-AI-Alliance/semiont/tree/main/docs/builder/skills) are whole scripts on
  this SDK, one per task, for an AI coding assistant to load: ingesting a
  corpus, annotating it, linking it, and the layers built on those.

## One call, two ways to consume

Every long-lived value is an `Observable` with an explicit one-shot path — from the same
call, take the value once or keep it live:

```ts
const resource = await client.browse.resource(rId).fresh();   // one-shot fresh read — no rxjs import
client.browse.resource(rId).subscribe((st) => {               // live — same call, typed states
  if (st.status === 'ready') render(st.value);                // pending | ready | failed
});
const found = await client.match.search(rId, refId, ctx);     // bounded streams ARE awaitable
```

Methods return one of: `Promise<T>` (atomic gateway ops), `StreamObservable` /
`UploadObservable` (bounded progress — thenable, `await` resolves the final value),
`DelegationObservable` (a delegated job — thenable, `await` resolves the job's completion, typed by its verb),
`CacheObservable` (live queries — `.subscribe(...)` for `CacheState` emissions,
`.fresh()` for the explicit network read; deliberately NOT thenable, so a cache read can
never silently become a round trip), `ClaimsObservable` (a worker's claims — below), a count
(wire drives — below), or `void` (local signals). The
per-method table and the `.run()` rule for progress-plus-result live in
[`docs/builder/REACTIVE-MODEL.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/REACTIVE-MODEL.md).

## Directing attention

Directing attention is protocol-level coordination, not browser-app fluff. An agent calls
`beckon.attention(resourceId, annotationId)` and every connected person's viewer scrolls to
the passage; `beckon.sparkleAll` lights it up; `beckon.openResource` opens a resource on
their screens. Each of these wire drives resolves with how many clients it reached.

The `void` signals (`beckon.hover`, `bind.initiate`, `mark.request`) are different: they stay
on one client's own bus, where its interface coordinates itself.

## A worker

A worker claims jobs from a knowledge base's queue, does each one, and says what became of
it. `client.job.claim` is its side of the queue. It is given what the worker accepts, each a
`JobFilter`: the `mark` jobs of one motivation, or the `yield` jobs. The `ClaimsObservable` it
returns hands out the jobs the worker comes to hold, one at a time, and a held job says its
own lifecycle.

```ts
const claims = client.job.claim({
  accepts: [{ jobType: 'mark', params: { motivation: 'highlighting' } }],
});
claims.refused$.subscribe((refusal) => console.error(`claim refused: ${refusal.message}`));
claims.subscribe(async (job) => {
  // A completion is its verb's, so the verb is checked before `complete` is called.
  if (job.jobType !== 'mark') return job.fail(`this worker runs no ${job.jobType} job`);
  await job.start();
  await job.progress({ percentage: 50 });
  await job.complete({ found: 0, persisted: 0 });             // settles: the next job is claimed
});
```

- **A worker is an agent.** Its process signs in with a service account and is given the
  agent its work is attributed to: `startAgentSession` does both, and keeps the token fresh.
- **Its stream names `JOB_CLAIM_CHANNELS`**, and the reply channels of whatever else it
  awaits. A client whose stream does not is refused at once, as `bus.unsubscribed`.
- **A held job commits for itself**: `job.commit(resourceId, annotations)` sends the batch
  as `mark:commit`, citing the job, and resolves once the record has it. When no
  acknowledgement arrives it asks whether the batch's last annotation is on the resource,
  and a commit that is not established rejects with the failure of its unanswered request.
  The job says how its commits were established when it settles. A worker that commits
  names `JOB_COMMIT_CHANNELS` in its stream as well.
- **A held job settles once**: `complete`, `fail` or `cancel`. Each says the outcome and
  lets the job go, and the worker claims the next. `claims.stop()` fails a job still held,
  so the queue runs it again at once.
- **Each job has a trace of its own.** A claim is made in no trace, whatever span the job
  before it was settled in, and a job is handed over in the trace its reply arrived in,
  which is its claim's: the span a worker that exports telemetry opens around a job, and
  what the job sends from inside it, continue that trace.

The [`semiont-worker` skill](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/skills/semiont-worker/SKILL.md)
is a whole worker, sign-in to shutdown, and
[`docs/protocol/WORKER-CONTRACT.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/WORKER-CONTRACT.md)
is what a worker promises the dispatcher.

## Any transport

`SemiontClient` is built against the `ITransport` / `IContentTransport` contracts from
`@semiont/core`, not any particular wire. The HTTP adapter is re-exported here for convenience.

## What is in the package

- **`SemiontClient`** — the verb-oriented coordinator: the eight flow namespaces, plus `job`
  (always present) and `auth`/`system` (present when constructed with gateway operations).
- **Annotation readers** — `getAnnotationExactText`, `getBodySource`, `getTargetSource`,
  `getEntityTypes`, `isStubReference`, `getTagCategory` and their siblings read an
  annotation whose target is an id or an object, whose selector is one or a list, and whose
  body is absent, one item or a list, so a script checks none of that itself. One table,
  `specs/src/annotations/reader-cases.json`, holds every SDK's readers to the same answers.
- **A worker's side of the job queue** — `job.claim`, the held jobs it hands out,
  `startAgentSession` for a worker's sign-in, and `JOB_CLAIM_CHANNELS` and
  `JOB_COMMIT_CHANNELS` for its stream.
- **Session layer** — `SemiontSession` (per-KB auth, proactive token refresh, lifecycle),
  `SemiontBrowser` (multi-KB orchestration), `SessionStorage` adapters, and the `httpKb`
  helper for endpoint shapes.
- **Flow state machines** — closure-based factories (`createMarkStateUnit`, `…Gather…`,
  `…Match…`, `…Yield…`, `…Beckon…`) wrapping each long-running flow with `loading$`/`error$`/
  progress observables; UI-shape-agnostic ([`docs/builder/STATE-UNITS.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/STATE-UNITS.md)).
- **KB discovery** — the consumer side of the launcher's published KB view:
  `httpDiscovery` (polls the Browser origin's `DISCOVERY_URL_PATH` with ETag/304),
  `textDiscovery` (bring-your-own IO — the sdk never imports `fs`), and
  `subscribeDiscovery` (a polling diff stream with a typed absent-vs-managed state).
  Descriptors only; auth stays per-KB. Types (`DiscoveredKB`, `DiscoveryDocument`) come
  from `@semiont/core`'s generated schema.
- **Helpers & types** — the cache primitive behind live queries
  ([`docs/protocol/CACHE-SEMANTICS.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/CACHE-SEMANTICS.md)),
  `createSearchPipeline`, branded ids, and the unified error hierarchy (`SemiontError`,
  `BusRequestError`) re-exported so you catch every SDK error from one package. (The
  request/reply primitive itself, `busRequest`, lives in `@semiont/core`.)

This is everything a non-web consumer (TUI, mobile, daemon, agent) needs — nothing
page-shaped. Page-level state machines and components, including the **embeddable
`ResourceViewer`**, live in [`@semiont/react-ui`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/react-ui).

## Documentation

The builder docs start at [`docs/builder/README.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/README.md):
who the SDK is for, where it goes, and the docs in reading order.

- **[`docs/builder/DEVELOPER-GUIDE.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/DEVELOPER-GUIDE.md) — start here to build.** Task-ordered recipes, connect through teardown.
- [`docs/builder/Usage.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/Usage.md) — per-namespace API tour with concrete examples, plus SSE and error handling.
- [`docs/builder/REACTIVE-MODEL.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/REACTIVE-MODEL.md) — the Promise-shape-over-Observable design.
- [`docs/builder/STATE-UNITS.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/STATE-UNITS.md) — the state-unit pattern and its enforced axioms.
- [`docs/protocol/CACHE-SEMANTICS.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/CACHE-SEMANTICS.md) — the cache primitive's numbered behavioral contract.
- [`docs/protocol/TRANSPORT-CONTRACT.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/TRANSPORT-CONTRACT.md) — what every `ITransport` must honor; HTTP specifics in [TRANSPORT-HTTP.md](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/TRANSPORT-HTTP.md). New transports implement the `@semiont/core` interfaces directly — no inheritance from `HttpTransport`.

## Related packages

- [`semiont`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk-rust) — the Rust SDK, a full peer of this one, on [crates.io](https://crates.io/crates/semiont)
- [`semiont`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk-python) — the Python SDK, on [PyPI](https://pypi.org/project/semiont/)
- [`@semiont/core`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/core) — domain types, `ITransport` contract, `busRequest`, OpenAPI-derived schemas
- [`@semiont/http-transport`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/http-transport) — HTTP transport (`HttpTransport`, `HttpContentTransport`)
- [`@semiont/make-meaning`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/make-meaning) — the knowledge-base actors and the entry points of the four services that run them
- [`@semiont/observability`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/observability) — OpenTelemetry tracing the SDK propagates across the bus
- [`@semiont/react-ui`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/react-ui) — the embeddable `ResourceViewer` (bring-your-own-session) plus React hooks (`useResourceLoader`, `useMediaToken`, `useObservable`) and the web `SessionStorage`; its docs cross-link the [Developer Guide](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/DEVELOPER-GUIDE.md)

## License

Apache-2.0 — see [LICENSE](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE).
