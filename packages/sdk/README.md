# @semiont/sdk

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+sdk%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=sdk)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=sdk)
[![npm version](https://img.shields.io/npm/v/@semiont/sdk.svg)](https://www.npmjs.com/package/@semiont/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/sdk.svg)](https://www.npmjs.com/package/@semiont/sdk)
[![License](https://img.shields.io/npm/l/@semiont/sdk.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The TypeScript SDK for [Semiont](https://github.com/The-AI-Alliance/semiont) — a programmable
surface for **collaborative knowledge work**. A browser app where humans annotate and link, an
AI agent that gathers context and generates grounded answers, a daemon that ingests sources, a
one-shot query script: all reach the same verb namespaces, the same collaboration primitives,
the same lifecycle observables. Humans and AI agents are peers — the SDK does not distinguish.

> ## 📖 Start with the [Developer Guide](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/DEVELOPER-GUIDE.md)
>
> Task-ordered recipes — connect → ingest → enrich → gather → generate (grounded Q&A with
> inline citations) → annotate → react live → tear down — each a short explanation plus the
> exact SDK lines. **This README is the map; the guide is the road.** For protocol-level
> framing (the eight flows, the core tenets), see
> [`docs/protocol/README.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/README.md);
> daemon authors also want the [skill packs](https://github.com/The-AI-Alliance/semiont/tree/main/docs/protocol/skills).

## Four ideas that hold the surface together

### 1. Eight verbs

Every operation belongs to one of eight *flows* — verbs describing what a participant does
with a shared corpus. Learn them once and the surface stays small.

| Verb | What it does | Example methods |
|---|---|---|
| **frame** | Define and evolve the schema vocabulary (entity types, tag schemas) | `frame.addEntityTypes`, `frame.addTagSchema` |
| **yield** | Introduce new resources — uploaded or generated from gathered context | `yield.resource`, `yield.fromResource`, `yield.fromAnnotation` |
| **mark** | Add structured metadata to resources | `mark.annotation`, `mark.assist`, `mark.updateEntityTypes`, `mark.archive` |
| **match** | Search the corpus for candidate resources | `match.search` |
| **bind** | Resolve ambiguous references to specific resources | `bind.body`, `bind.initiate` |
| **gather** | Assemble grounding context around a resource or an annotation | `gather.resource`, `gather.annotation` |
| **browse** | Navigate, read, observe — including who's here to collaborate | `browse.resource`, `browse.annotations`, `browse.agents`, `browse.click` |
| **beckon** | Coordinate attention across participants | `beckon.hover`, `beckon.sparkle` |

Each flow is a namespace on `SemiontClient` (`client.mark.X(...)`); the verb is the unit of
mental model. Frame is the schema-layer flow — the others operate within the vocabulary it
manages. Per-flow contracts: [`docs/protocol/flows`](https://github.com/The-AI-Alliance/semiont/tree/main/docs/protocol/flows).

### 2. One call, two ways to consume

Every long-lived value is an `Observable` that *also* implements `PromiseLike<T>` — `await`
it for the final value, `.subscribe(...)` it for progress or live updates, from the same call.

```ts
const resource = await client.browse.resource(rId);          // one-shot — no rxjs import
client.browse.resource(rId).subscribe((r) => render(r));     // live — same call
```

Methods return one of: `Promise<T>` (atomic backend ops), an awaitable Observable subclass
(`StreamObservable` for bounded progress, `CacheObservable` for live queries,
`UploadObservable` for uploads), or `void` (collaboration signals — below). The per-method
table and the `.run()` rule for progress-plus-result live in
[`docs/REACTIVE-MODEL.md`](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/REACTIVE-MODEL.md).

### 3. Collaboration primitives

The `void`-returning signals are protocol-level coordination, not browser-app fluff: a human
hovers an annotation (`beckon.hover(id)`) and an AI agent across the bus reacts; an agent
sparkles an annotation and the human's UI lights up. Observers reach the same signals via
`session.subscribe(channel, handler)` or `client.bus.get(channel)`.

### 4. Transport agnosticism

`SemiontClient` is built against the `ITransport` / `IContentTransport` contracts from
`@semiont/core`, not any particular wire — the same surface runs over HTTP or in-process. The
HTTP adapter is re-exported here for convenience; the in-process transport is
`LocalTransport` from `@semiont/make-meaning`.

## What's in the box

- **`SemiontClient`** — the verb-oriented coordinator: the eight flow namespaces, plus `job`
  (always present) and `auth`/`admin` (present when constructed with backend operations).
- **Session layer** — `SemiontSession` (per-KB auth, proactive token refresh, lifecycle),
  `SemiontBrowser` (multi-KB orchestration), `SessionStorage` adapters, and the `httpKb`
  helper for endpoint shapes.
- **Flow state machines** — closure-based factories (`createMarkStateUnit`, `…Gather…`,
  `…Match…`, `…Yield…`, `…Beckon…`) wrapping each long-running flow with `loading$`/`error$`/
  progress observables; UI-shape-agnostic ([`docs/STATE-UNITS.md`](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/STATE-UNITS.md)).
- **`WorkerBus`** — the transport-neutral bus interface worker adapters consume (the adapters
  live with their domains: `@semiont/jobs`, `@semiont/make-meaning`).
- **Helpers & types** — the cache primitive behind live queries
  ([`docs/CACHE-SEMANTICS.md`](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/CACHE-SEMANTICS.md)),
  `createSearchPipeline`, branded ids, and the unified error hierarchy (`SemiontError`,
  `BusRequestError`) re-exported so you catch every SDK error from one package. (The
  request/reply primitive itself, `busRequest`, lives in `@semiont/core`.)

This is everything a non-web consumer (TUI, mobile, daemon, agent) needs — nothing
page-shaped. Page-level state machines and components, including the **embeddable
`ResourceViewer`**, live in [`@semiont/react-ui`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/react-ui).

## Install & connect

```bash
npm install @semiont/sdk
```

One-shot script — credentials-first, one line:

```ts
import { SemiontClient } from '@semiont/sdk';

const semiont = await SemiontClient.signInHttp({
  baseUrl: 'http://localhost:4000',
  email: 'me@example.com',
  password: 'pwd',
});
const resources = await semiont.browse.resources({ limit: 10 });
semiont.dispose();
```

Long-running script — `SemiontSession` adds proactive refresh, storage, and disposal; `kb.id`
is the storage key, so distinct scripts use distinct ids:

```ts
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const session = await SemiontSession.signInHttp({
  kb: httpKb({ id: 'my-watcher', label: 'My Watcher', email: 'me@example.com',
               host: 'localhost', port: 4000, protocol: 'http' }),
  storage: new InMemorySessionStorage(),
  baseUrl: 'http://localhost:4000',
  email: 'me@example.com',
  password: 'pwd',
});
const resources = await session.client.browse.resources({ limit: 10 });
await session.dispose();
```

Already hold a token? `SemiontClient.fromHttp({ baseUrl, token })` /
`SemiontSession.fromHttp(...)` skip the auth round-trip. In-process (CLI, tests, embedded) —
same surface, no network:

```ts
import { SemiontClient } from '@semiont/sdk';
import { startMakeMeaning, LocalTransport, LocalContentTransport } from '@semiont/make-meaning';

const ks = await startMakeMeaning(project, config, eventBus, logger);
const client = new SemiontClient(
  new LocalTransport({ knowledgeSystem: ks.knowledgeSystem, eventBus, userId }),
  new LocalContentTransport(ks.knowledgeSystem),
);
```

From here, the [Developer Guide](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/DEVELOPER-GUIDE.md)
takes over — every recipe assumes exactly this setup.

## Documentation

- **[`docs/DEVELOPER-GUIDE.md`](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/DEVELOPER-GUIDE.md) — start here to build.** Task-ordered recipes, connect through teardown.
- [`docs/Usage.md`](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/Usage.md) — per-namespace API tour with concrete examples, plus SSE and error handling.
- [`docs/REACTIVE-MODEL.md`](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/REACTIVE-MODEL.md) — the Promise-shape-over-Observable design.
- [`docs/STATE-UNITS.md`](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/STATE-UNITS.md) — the state-unit pattern and its enforced axioms.
- [`docs/CACHE-SEMANTICS.md`](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/CACHE-SEMANTICS.md) — the cache primitive's behavioral contract (B1–B16).
- [`docs/protocol/TRANSPORT-CONTRACT.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/TRANSPORT-CONTRACT.md) — what every `ITransport` must honor; HTTP specifics in [TRANSPORT-HTTP.md](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/TRANSPORT-HTTP.md). New transports implement the `@semiont/core` interfaces directly — no inheritance from `HttpTransport`.

## License

Apache-2.0 — see [LICENSE](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE).

## Related packages

- [`@semiont/core`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/core) — domain types, `ITransport` contract, `busRequest`, OpenAPI-derived schemas
- [`@semiont/http-transport`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/http-transport) — HTTP transport (`HttpTransport`, `HttpContentTransport`)
- [`@semiont/make-meaning`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/make-meaning) — in-process transport (`LocalTransport`) and the actor model behind it
- [`@semiont/observability`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/observability) — OpenTelemetry tracing the SDK propagates across the bus
- [`@semiont/react-ui`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/react-ui) — the embeddable `ResourceViewer` (bring-your-own-session) plus React hooks (`useResourceLoader`, `useMediaToken`, `useObservable`) and the web `SessionStorage`; its docs cross-link the [Developer Guide](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/DEVELOPER-GUIDE.md)
