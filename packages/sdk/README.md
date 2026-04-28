# @semiont/sdk

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+sdk%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=sdk)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=sdk)
[![npm version](https://img.shields.io/npm/v/@semiont/sdk.svg)](https://www.npmjs.com/package/@semiont/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/sdk.svg)](https://www.npmjs.com/package/@semiont/sdk)
[![License](https://img.shields.io/npm/l/@semiont/sdk.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The TypeScript SDK for [Semiont](https://github.com/The-AI-Alliance/semiont) — a programmable surface for **collaborative knowledge work**. Whether you're building a browser app where humans annotate documents and propose links, an AI agent that gathers context and matches candidate references, a daemon that ingests new sources, or a one-shot script that queries an established knowledge base, you reach the same verb namespaces, the same collaboration primitives, the same lifecycle observables.

The seven flows — *yield, mark, match, bind, gather, browse, beckon* — describe what participants *do* when they work with a shared corpus. The SDK exposes them uniformly across surfaces. A human in a browser hovers an annotation; an AI agent at the other end of the bus sees the hover and reacts; a daemon ingests new text and every connected participant sees the corpus grow live. Humans and AI agents are peers — the SDK does not distinguish.

The SDK is **transport-agnostic**: it consumes the `ITransport` and `IContentTransport` contracts from [`@semiont/core`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/core). For HTTP backends, the canonical wire adapter is re-exported here for convenience. For in-process operation (CLI, agentic worker, embedded use), use `LocalTransport` from [`@semiont/make-meaning`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/make-meaning).

## What's in the box

- **`SemiontClient`** — the verb-oriented coordinator over a wire transport.
- **Verb namespaces** — `browse`, `mark`, `bind`, `gather`, `match`, `yield`, `beckon`, `job`, `auth`, `admin`. Typed methods that wrap the bus protocol; consumers never touch raw channel strings.
- **Collaboration primitives** — fire-and-forget signals on the verb namespaces (`beckon.hover`, `bind.initiate`, `mark.changeShape`, `browse.click`, ...) coordinate attention and intent across participants. Not afterthoughts, not browser-app fluff: they're how a multi-participant session stays coherent.
- **Session layer** — `SemiontSession` (per-KB authentication, token refresh, lifecycle), `SemiontBrowser` (multi-KB orchestration), and `SessionStorage` adapters (`InMemorySessionStorage`, plus a browser-backed one in `@semiont/react-ui`).
- **View-models** — RxJS-based MVVM factories that any view layer can subscribe to. The React bindings live in `@semiont/react-ui`; the VMs themselves are framework-neutral.
- **Helpers** — `bus-request` (correlation-ID request/reply) and the cache primitive backing live queries.

## Installation

```bash
npm install @semiont/sdk
```

## Quick start (HTTP)

For one-shot scripts, `SemiontClient.signIn(...)` is the credentials-first one-line construction:

```ts
import { SemiontClient } from '@semiont/sdk';

const semiont = await SemiontClient.signIn({
  baseUrl: 'http://localhost:4000',
  email: 'me@example.com',
  password: 'pwd',
});

const resources = await semiont.browse.resources({ limit: 10 });
console.log(resources);

semiont.dispose();
```

For long-running scripts that need to survive token expiry, use `SemiontSession.signIn(...)` — same credentials shape, plus proactive refresh, validation, storage-adapter wiring, and disposal. `kb` is required; its `id` is the storage key for this session, so distinct scripts must use distinct ids:

```ts
import { SemiontSession, InMemorySessionStorage, type KnowledgeBase } from '@semiont/sdk';

const kb: KnowledgeBase = {
  id: 'my-watcher',
  label: 'My Watcher',
  protocol: 'http',
  host: 'localhost',
  port: 4000,
  email: 'me@example.com',
};

const session = await SemiontSession.signIn({
  kb,
  storage: new InMemorySessionStorage(),
  baseUrl: 'http://localhost:4000',
  email: 'me@example.com',
  password: 'pwd',
});

// session.client is the same SemiontClient surface; the session manages
// the token$ lifecycle around it (default refresh callback wired automatically).
const resources = await session.client.browse.resources({ limit: 10 });

await session.dispose();
```

If you already have an access token (CLI cached-token path, env-var token, embedded auth flow), use `SemiontClient.fromHttp({ baseUrl, token })` or `SemiontSession.fromHttp({ baseUrl, token, storage, kb, refresh, ... })` to skip the auth round-trip.

## Quick start (in-process)

When you want the SDK without an HTTP backend — e.g. in a CLI, a unit test, or an Electron-style desktop app — wire `LocalTransport` directly to a knowledge system:

```ts
import { SemiontClient } from '@semiont/sdk';
import {
  startMakeMeaning,
  LocalTransport,
  LocalContentTransport,
} from '@semiont/make-meaning';

const ks = await startMakeMeaning(project, config, eventBus, logger);
const transport = new LocalTransport({
  knowledgeSystem: ks.knowledgeSystem,
  eventBus,
  userId,
});
const client = new SemiontClient(
  transport,
  new LocalContentTransport(ks.knowledgeSystem),
);
```

Same `SemiontClient`, same verb namespaces — no network involved. There is no `fromLocal` factory because the in-process transport's dependencies (knowledgeSystem, eventBus, userId) are not boilerplate the SDK can hide.

## Verb namespaces

All ten namespaces hang off `SemiontClient`. Method return types follow four shapes — predictable from the method name once you know the convention:

| Shape | Convention | Examples |
|---|---|---|
| **Atomic backend op** — `Promise<T>` | past-tense or short noun | `mark.annotation`, `bind.body`, `auth.password` |
| **Long-running stream** — `StreamObservable<T>` | plain verb | `mark.assist`, `match.search`, `gather.annotation`, `yield.fromAnnotation` |
| **Live query** — `CacheObservable<T>` | plain noun | `browse.resource`, `browse.annotations`, `browse.entityTypes` |
| **Collaboration signal** — `void` | imperative or progressive verb | `beckon.hover`, `bind.initiate`, `mark.changeShape`, `browse.click` |

Both Observable subclasses implement `PromiseLike<T>`, so consumers can `await` them directly. Reactive consumers `.subscribe(...)` exactly as with a plain Observable. The bus is invisible to callers — channel strings, correlation IDs, and reconnection are internal.

```ts
// Browse — live queries; await yields the loaded value, subscribe yields
// loading-then-loaded.
const resources = await client.browse.resources({ limit: 10 });
client.browse.resource(resourceId).subscribe(/* ... */);

// Mark / Bind — atomic operations return Promise<T>.
const { annotationId } = await client.mark.annotation(request);
await client.bind.body(rid, aid, [{ op: 'add', item: { /* W3C body */ } }]);

// Gather / Match — bounded streams; await yields the final value, subscribe
// yields every progress emission.
const ctx = await client.gather.annotation(rid, aid);
client.match.search(rid, refId, ctx, { limit: 10 }).subscribe(/* ... */);

// Yield — author new resources. Returns an UploadObservable; await yields
// { resourceId }, subscribe yields the upload-progress lifecycle.
const { resourceId } = await client.yield.resource({
  name, file, format, storageUri,
});

// Beckon, Bind, Browse, Mark — collaboration signals (void). Fire-and-
// forget; fan out to other participants over the bus.
client.beckon.hover(annotationId);
client.bind.initiate({ annotationId });
client.browse.click(annotationId, 'linking');
```

The verb-by-verb walkthroughs live in [docs/protocol/flows](https://github.com/The-AI-Alliance/semiont/tree/main/docs/protocol/flows).

The SDK is RxJS-native, but its return values implement `PromiseLike<T>` — `await` works directly. Reach for `.subscribe(...)` when you want progress events, live updates, or to observe a collaboration signal another participant emitted; `.pipe(...)` only when you want operator composition (which loses the thenable). See [`docs/REACTIVE-MODEL.md`](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/REACTIVE-MODEL.md) for the four return-shape categories, the naming convention, the three legitimate paths to the bus, and the design rationale.

## Documentation

- [`docs/Usage.md`](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/Usage.md) — per-namespace tour with concrete examples for Browse, Mark, Bind, Gather, Match, Yield, Beckon, Auth, Admin, Job, plus SSE and error handling.
- [`docs/REACTIVE-MODEL.md`](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/REACTIVE-MODEL.md) — the Promise-shape-over-Observable design: how `await` works on the SDK's return values without learning RxJS, and where RxJS is still visible by design.
- [`docs/CACHE-SEMANTICS.md`](https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/docs/CACHE-SEMANTICS.md) — the cache primitive's behavioral contract.
- [`docs/protocol/TRANSPORT-CONTRACT.md`](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/TRANSPORT-CONTRACT.md) — the transport interface every `ITransport` must honor.

## Behavioral contract

The guarantees every `ITransport` implementation must honor — what `subscribe()` does on disconnect, what `LastEventId` replay must look like, what `puts` must be idempotent — are documented in [docs/protocol/TRANSPORT-CONTRACT.md](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/TRANSPORT-CONTRACT.md). HTTP-specific guarantees (the `/bus/emit` gateway, SSE reconnect, `Last-Event-ID` replay window) live in [docs/protocol/TRANSPORT-HTTP.md](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/TRANSPORT-HTTP.md).

When implementing a new transport (gRPC, WebSocket, IPC, …), implement those interfaces from `@semiont/core` directly — there is no inheritance from `HttpTransport`.

## License

Apache-2.0 — see [LICENSE](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE).

## Related packages

- [`@semiont/core`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/core) — domain types, `ITransport` contract, OpenAPI-derived schemas
- [`@semiont/api-client`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/api-client) — HTTP transport (`HttpTransport`, `HttpContentTransport`)
- [`@semiont/make-meaning`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/make-meaning) — in-process transport (`LocalTransport`) and the actor model behind it
- [`@semiont/observability`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/observability) — OpenTelemetry tracing the SDK propagates across the bus
- [`@semiont/react-ui`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/react-ui) — React bindings (`useViewModel`, web `SessionStorage`)
