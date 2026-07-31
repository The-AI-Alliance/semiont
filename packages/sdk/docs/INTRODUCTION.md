# Introduction: Semiont for builders

This is the orientation chapter — read it before any other doc in this
directory. It installs the mental model and the map, then points you at the
[DEVELOPER-GUIDE](./DEVELOPER-GUIDE.md) to start building. It assumes you build
web apps for a living; it does not assume you've built AI apps, or that
"annotation" and "knowledge graph" mean anything to you yet.

## What Semiont is

Semiont is a knowledge base: a server that holds documents *and everything
anyone has noticed about them* — where "anyone" includes both the humans on a
project and the AI agents working alongside them. Highlights, comments,
cross-references, AI-proposed links, generated answers: all first-class data,
all live, all shared between every connected client.

The problem it exists to solve: AI that answers from your documents is easy to
demo and hard to trust. Semiont's answer is structural — every generated claim
is grounded in material the system can point back to, and the pointing is a
thing you can click. Not "sources: [1] [2]" at the bottom of a blob of text;
each claim anchored to the exact passage that supports it, as data your app can
render, traverse, and audit.

## Three ideas that make the rest make sense

### One wire, not many endpoints

A typical web app calls a REST endpoint per action and re-fetches to learn what
changed. A Semiont client opens one persistent connection to an **event bus**.
Requests are messages with correlated replies; changes — yours, another user's,
an AI job's — arrive as events on the same wire. This is the idea to *unlearn
around*: everything that looks unusual downstream (live data without polling,
jobs you watch, multiple clients agreeing in real time) falls out of it.

### Annotations are data, not decoration

An **annotation** is a comment, highlight, or link anchored to an exact span of
text — think of a GitHub PR review comment promoted to first-class data. It has
a standard shape: a *target* (which document, which character range, the quoted
text), a *motivation* (`commenting`, `highlighting`, `linking`, …), and a
*body* (for a link, a pointer to another document). The shape follows the W3C
Web Annotation model, so it isn't a Semiont invention you have to trust.

Once spans in one document link to other documents, your pile of files is a
**graph**. That's all "knowledge graph" means here: documents are nodes,
annotations are edges, and both are ordinary data you can query.

### AI work is a job you watch

AI operations are slow, so they're **jobs**: you create one ("generate an
answer," "find every Person referenced in this doc"), then progress and
completion arrive as bus events — the same pattern as watching a CI run. And
generation is grounded by the graph: before answering, the client *gathers*
context by traversing links outward from a starting document, with vector
similarity as one input to that assembly rather than the whole retrieval
strategy — what similarity found arrives as inspectable data in the gathered
context, not as invisible retrieval you have to hope got it right.

## The stack, and where your code sits

```
your app            (product logic, routing, composition)
   │
framework binding   @semiont/react-ui — React components + hooks
   │
language SDK        @semiont/sdk (TypeScript) · sdk-go · more planned
   │
the contract        bus protocol, annotation model, job lifecycle
   │
Semiont backend
```

Three claims about this picture, in decreasing order of how often people
believe them at first:

1. **The contract is the product.** The bus protocol, the annotation model, and
   the job lifecycle are specified independently of any language (see
   [`docs/protocol/`](../../../docs/protocol/)). Everything above that line is
   a projection of the contract.

2. **Language SDKs are peers.** This book uses `@semiont/sdk` — the
   TypeScript/npm SDK, the most complete — as its vehicle. A Go SDK
   (`sdk-go`) exists today; Python, Java, and Swift SDKs are planned. The
   concepts in these docs transfer across SDKs; the syntax doesn't. If you're
   reading this from another language, treat the TypeScript as pseudocode with
   a working implementation.

3. **Framework bindings sit above the SDK, not inside it.**
   [`@semiont/react-ui`](../../react-ui/) is the one supported binding today.
   But the SDK is deliberately framework-free — plain classes and observables,
   no React anywhere — so a Vue or Svelte binding is a seam awaiting an author,
   not a rearchitecture.

One house rule follows from the picture: **your app never calls the backend's
HTTP API directly.** The SDK is the boundary. If the SDK doesn't expose
something you need, that's an SDK gap to raise, not a reason to reach around
it.

The SDK's own shape, in one sentence: you open a **session** (sign-in and token
refresh handled for you) and get a **client** whose namespaces are **the eight
verbs of the protocol** — one per flow, listed here in the canonical order used
throughout [`docs/protocol/flows/`](../../../docs/protocol/flows/):

| Verb | What it does |
|---|---|
| `browse` | read and navigate — documents, annotations, who else is here |
| `bind` | resolve an ambiguous reference to a specific document |
| `yield` | create documents — uploaded, or generated from gathered context |
| `mark` | annotate — highlight, comment, link, or run an AI pass that does |
| `frame` | define the schema vocabulary (entity types, tag schemas) |
| `gather` | assemble the context that grounds generation and search |
| `match` | search the corpus for candidate documents |
| `beckon` | coordinate attention across participants |

Plus `job` for tracking long-running work, and `auth` / `admin` when the client
is built against an HTTP backend. Learn all eight once and the surface stays
small — but you only need three in your first hour: `yield` to put a document
in, `gather` to collect what's related, `browse` to read it all back.

## Live data is the default

Reading data feels like a React Query where the invalidation problem is solved
server-side. `browse.resources()` returns a **live cache query**, not a
promise. Subscribe to it — in React, via react-ui's `useObservable` — and you
get a `CacheState`:

```tsx
import { useObservable } from '@semiont/react-ui';

const state = useObservable(session.client.browse.resources());
// state: { status: 'pending' }
//      | { status: 'ready',  value: ResourceDescriptor[] }
//      | { status: 'failed', error: Error }
//      | undefined   ← react-ui's hook, on the very first render (see below)
```

That discriminated union is exactly the shape you'd hand-roll to model fetch
state, so your component renders all three cases honestly — including failure,
which arrives *in-band* as a state, never as a stream error that kills the
subscription. When anyone adds a document, the bus invalidates, the cache
re-emits, your list updates. No polling, no `invalidateQueries` bookkeeping.

(The `undefined` is the React binding, not the SDK: `useObservable` subscribes
in an effect, so the first render happens before the query's synchronous
`pending` arrives. Treat it as pending — `if (!state || state.status ===
'pending')` — and the three-outcome contract holds from there.)

The one escape hatch is `.fresh()`: an explicit one-shot fetch for "I want the
latest, right now." The division of labor is deliberate — a cache read and a
backend request are different types, so "which one am I doing?" is impossible
to get wrong. The full behavioral contract, numbered and test-cited, is
[CACHE-SEMANTICS](./CACHE-SEMANTICS.md); the design rationale is
[REACTIVE-MODEL](./REACTIVE-MODEL.md).

## A chat turn in one page

The heart of a document-grounded chat app, abridged from a real one. Watch the
verbs compose:

```ts
import { SemiontSession } from '@semiont/sdk';

const session = await SemiontSession.signInHttp({ kb, storage, baseUrl, email, password });
const { client } = session;

// 1. Persist the question as a document in its own right.
const { resourceId: questionId } = await client.yield.resource({
  name: question,
  file: new File([question], 'question.md', { type: 'text/markdown' }),
  format: 'text/markdown',
  storageUri: 'file://questions/question.md',
  entityTypes: ['Question'],
});

// 2. Gather context: assemble material around the question — graph
//    traversal plus vector similarity — excluding prior questions so
//    they never ground an answer.
const context = await client.gather.resource(questionId, {
  excludeEntityTypes: ['Question'],
});

// 3. Generate the answer as a new document — a job, streaming progress.
//    `cite: true` grounds each claim as it's written: the worker mints
//    linking annotations from claim spans to their cited sources.
const generation = client.yield.fromResource(questionId, {
  title: question,
  storageUri: 'file://generated/answer.md',
  context,
  task: 'answer',
  structure: 'prose',
  cite: true,
  prompt: 'Be direct and concise.',
});
// The generation streams progress events and completes with the answer's
// resource id — subscribe for progress, or just await the terminal.
```

Rendering the answer is react-ui's half: its viewer takes the same `session`
as a prop, renders the document with its annotations *anchored* — citations
highlighted on the exact claim spans, hovercards on the links — and hands
navigation back to your app through callbacks (`onOpenResource`,
`onLinkClick`) instead of hijacking your router. The hard UI you'd never want
to build ships as components; your app keeps the routing and the product
logic.

Every step here is a recipe in the [DEVELOPER-GUIDE](./DEVELOPER-GUIDE.md);
every method's options are in [Usage](./Usage.md).

## Testing is part of the contract

The SDK ships its own test double, and it's not a mock: `@semiont/sdk/testing`
gives you a **real** client and session over a scriptable fake transport.
Script the replies; drive your code; then assert what your app *actually sent*
off the transport's request log:

```ts
import { createTestSession } from '@semiont/sdk/testing';

const { session, transport } = createTestSession({
  transport: { makeResponse: (op) => (op === 'job:create' ? { jobId: 'job-1' } : {}) },
});

// ... drive your orchestrator with `session` ...

const jobs = transport.requestLog.filter((e) => e.channel === 'job:create');
// each entry carries the payload snapshot that went on the wire
```

Because react-ui components take the session as a prop, the same test session
drives component tests too. No hand-rolled mock of the data layer anywhere —
which matters, because a mock encodes its author's beliefs about the SDK, and
green tests against wrong beliefs are worse than no tests. The recipe is in the
DEVELOPER-GUIDE's testing section.

## Could your coding agent just build this?

A fair question to ask before adopting anything in 2026. What a coding agent
can produce quickly is a demo that *gestures* at the shape — a documents
table, a comments field, a websocket. Semiont's actual shape is another
matter. The protocol registry alone defines more than 170 bus channels and
over thirty correlated request/reply operations; the wire carries nearly two
hundred schemas; around them sit a launcher that runs the fleet in containers
and codespaces, a browser app full of painstaking interface decisions, and a
deliberate split between the framework-free SDK and the react-ui binding
above it. Any one app exercises a fraction of that surface — but *which*
fraction is something you learn by building, and the expensive parts run
through every fraction. An agent can generate any one of those decisions
cheaply; it cannot make them *cohere* — and incoherent decisions are exactly
as expensive to live with as they were cheap to produce.

And the decisions you can't see from the surface are harder still: a live
cache whose behavior is a numbered contract with tests citing the numbers;
delivery semantics that survive reconnects — per-scope resumption for events,
deadline-bounded retention for replies; liveness properties like "no
subscription silently pends forever," enforced by property-based test
harnesses; an annotation model that follows a W3C standard instead of
inventing one. Nearly every clause of those contracts was paid for by a
subtle bug or a hard design call. A scaffolded lookalike re-encounters them
one production incident at a time.

That's the trade Semiont offers a team building a custom AI or knowledge
application: the plumbing — transport, caching, live collaboration, grounding,
job lifecycle — arrives designed, contracted, and tested, which is months you
don't spend before your product exists. And the decisions that make your
product *yours* stay open: your domain model, your UX, your framework above
the SDK, which verbs your app leans on and how. Semiont is deliberately
unopinionated exactly where product teams need to differ.

To be fair about the easy case: if all you need is one user asking questions
over a static pile of documents, simpler tools will get you a demo sooner.
The difference is what your corpus is when the demo is over. Chunks in an
index can be retrieved; a typed, traversable graph of entities, links, and
schema vocabulary can be *reasoned over*. And the graph is made of standards,
not inventions — annotations follow the W3C Web Annotation model, and a
resource is named and typed the way the web already works: URIs and media
types, not a proprietary notion of "document." That's a deliberate trajectory
bet. Data in standard shapes is data every future tool can pick up without
translation — including the document-grounded reasoning this substrate is
built to carry.

For some teams, that trajectory isn't optional. In work where every claim
must trace to its source — regulated filings, evidence-backed research, legal
and policy analysis — grounding isn't a feature, it's the job, and today it's
enforced by process: review passes, citation checks, humans auditing humans.
Semiont's bet is that the discipline belongs in the substrate. When
provenance is recorded by construction, the oversight that's heroic today
becomes ordinary review.

And the question this section opened with has a happier inverse: this SDK is
good raw material *for* AI coding tools. Typed verb namespaces, discriminated-union states, numbered
behavioral contracts, and a real test double are precisely the context a
coding agent needs to write correct consumer code — and honest tests — on the
first pass. Point your agent at these docs and build fast. The short version:
vibe-code your app on Semiont; don't vibe-code your own Semiont.

## What you need, and where to go next

You need Node and a running Semiont backend to point at.

Where to go by goal:

- **Build something now** — [DEVELOPER-GUIDE](./DEVELOPER-GUIDE.md), top to
  bottom; keep [Usage](./Usage.md) open as the reference.
- **Understand why the API is shaped this way** —
  [REACTIVE-MODEL](./REACTIVE-MODEL.md), then
  [STATE-UNITS](./STATE-UNITS.md).
- **Depend on exact behavior** — [CACHE-SEMANTICS](./CACHE-SEMANTICS.md) and
  the wire-level contracts in [`docs/protocol/`](../../../docs/protocol/).
- **Not a React shop? Not a TypeScript shop?** The concepts here and in the
  explanation docs are yours as-is; treat the binding- and language-specific
  material as a worked example of a pattern your stack will repeat.
