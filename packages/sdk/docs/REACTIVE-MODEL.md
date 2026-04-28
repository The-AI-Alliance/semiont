# Reactive Model

`@semiont/sdk` is the SDK for collaborative **knowledge work** — humans and AI agents working as peers on a shared corpus across one or many machines. That collaboration shapes the SDK's design: live queries, progress streams, and cross-participant attention signals are all first-class, not data-API afterthoughts.

The SDK uses RxJS as its substrate (because the collaboration model needs reactive primitives) but exposes a Promise-shaped surface for the cases that don't need the reactive view (because the consumer who just wants a value shouldn't have to learn RxJS first). This doc explains how that works, why it works, and where RxJS is still visible by design.

If you only want to *use* the SDK, [Usage.md](./Usage.md) is the per-namespace tour. Read this if you're curious about the design, deciding between `await` and `.subscribe(...)` for a given call site, looking for the naming convention to predict a method's return type, or trying to figure out which path to the bus is right for your use case.

## The shape of values over time

Most SDK calls have a "current value" to return. Some genuinely have *values over time* — the progress of a long-running job, a live query that re-emits when the underlying resource changes, a hover signal another participant just emitted across the bus. Promise can express the first; Observable can express the others.

The choice for `@semiont/sdk` was to use Observable as the primitive — multicast, pipeable, native to live queries and cross-actor coordination — and to layer Promise-shaped sugar on top so callers who only want the final answer can `await` and move on.

The result: a script that just wants to read a resource never imports anything from `rxjs`. A browser app rendering a loading state subscribes to the same call. An AI agent observing what its human partner just hovered uses `.subscribe(...)` on the same shape. A data pipeline that needs to filter and map composes with operators. Four idiomatic shapes on the same return values.

## The substrate: RxJS

Everything reactive in the SDK is an RxJS Observable:

- **Live queries** (`browse.resource`, `browse.resources`, `browse.annotations`, etc.) — values that re-emit when bus events fire (including events from other participants).
- **Bounded streams** (`mark.assist`, `gather.annotation`, `match.search`, `yield.fromAnnotation`, `yield.resource`) — progress events plus a final result.
- **Collaboration signals on the bus** — `mark.changeShape`, `beckon.hover`, `bind.initiate`, `browse.click`, etc. emit; participants observe via `client.bus.get(channel)` or `session.subscribe(channel, handler)`. Fire-and-forget at the call site, fan-out across participants on the bus.
- **Lifecycle state** (`client.transport.state$`, `client.transport.errors$`, `session.token$`, `session.user$`, `session.errors$`) — synchronous-snapshot `BehaviorSubject`s and the transport's error stream.
- **Bus subscriptions** (`session.subscribe(channel, handler)`, `client.bus.get(channel)`) — raw fan-out of typed events; the channel-by-name escape hatch when no namespace method covers the case.

Observable is the right primitive for all of these. Promise has no "second value." The cache primitive behind Browse — multicast, per-key dedup, stale-while-revalidate — composes cleanly only because the substrate supports the operators that make it possible. Forcing Promise here would require parallel `observe()` / `get()` methods on every namespace and would lose the collaboration story entirely.

## The sugar: PromiseLike on top

A consumer that doesn't care about progress shouldn't have to learn RxJS to use the SDK.

Two Observable subclasses live in [`packages/sdk/src/awaitable.ts`](../src/awaitable.ts). Both extend `Observable<T>` and implement `PromiseLike<T>` via a `then()` method:

```ts
export class StreamObservable<T> extends Observable<T> implements PromiseLike<T> {
  then(onfulfilled, onrejected) {
    return lastValueFrom(this).then(onfulfilled, onrejected);
  }
}

export class CacheObservable<T> extends Observable<T | undefined> implements PromiseLike<T> {
  then(onfulfilled, onrejected) {
    return firstValueFrom(this.pipe(filter((v): v is T => v !== undefined)))
      .then(onfulfilled, onrejected);
  }
}
```

The asymmetric `then()` semantics are deliberate:

- **`StreamObservable.then`** resolves to the **last** value on completion. Bounded progress streams have a final answer — the search result, the generated resource, the assembled context.
- **`CacheObservable.then`** resolves to the **first non-undefined** value. Cache reads start in a "loading" state (`undefined`) and transition to the loaded value; `await` skips the loading state.

The subclass name documents which semantics apply. `.subscribe(...)` works on both — yields the full sequence including loading states or progress events. `.pipe(...)` returns a plain `Observable<T>` and loses the thenable; once you compose with operators you've explicitly opted into RxJS, and `lastValueFrom` from `rxjs` is the right bridge.

A third subclass — `UploadObservable` — is shaped specifically for `yield.resource`. Subscribers see the full upload-progress lifecycle (`started` → optional `progress` → `finished`); awaiting resolves to `{ resourceId }` extracted from the `'finished'` event, preserving the awaited shape from before progress events existed.

## Method naming convention — predict the shape from the name

Namespace method return types follow four shapes. The naming convention lets you predict the shape from the method name:

| Shape | Naming | Examples |
|---|---|---|
| **Atomic backend op** — `Promise<T>` | past-tense or short noun | `mark.annotation`, `bind.body`, `yield.resource`*, `auth.password`, `frame.addEntityType` |
| **Long-running stream** — `StreamObservable<T>` (or `UploadObservable` for `yield.resource`) | plain verb | `mark.assist`, `match.search`, `gather.annotation`, `yield.fromAnnotation` |
| **Live query** — `CacheObservable<T>` | plain noun | `browse.resource`, `browse.resources`, `browse.annotations`, `browse.entityTypes` |
| **Collaboration signal** — `void` | imperative or progressive verb | `beckon.hover`, `bind.initiate`, `mark.changeShape`, `browse.click`, `mark.toggleMode` |

\* `yield.resource` historically returned `Promise<{ resourceId }>`; after Phase 18 it returns `UploadObservable` (still awaitable to `{ resourceId }` so `await` consumers don't change).

The fourth row — collaboration signals — is the surface most data-processing SDKs don't have. They're the SDK's contribution to multi-participant coordination: a participant calls `client.beckon.hover(annotationId)` and other participants subscribed to `beckon:hover` see it; an agent calls `client.bind.initiate(...)` and the human's UI lights up the binding flow. They look fire-and-forget at the call site; on the bus they fan out across participants. They earn first-class slots on the verb namespaces because they're not browser-app leakage — they're how a multi-participant session stays coherent.

The convention is enforceable. A namespace method's return type should be one of:

- `Promise<T>`
- `StreamObservable<T>` (or `UploadObservable` / future bounded-stream subclasses)
- `CacheObservable<T>`
- `void`

Plain `Observable<T>` does not appear on the public verb-namespace surface. (It still appears on the lifecycle / escape-hatch surfaces — `client.transport.state$`, `client.transport.errors$`, `client.bus.get(channel)` — see "Plain Observables" below.) A future CI lint can enforce the rule at build time; the discipline already holds in the current code.

## What this looks like at the call site

```ts
import { SemiontClient } from '@semiont/sdk';

const semiont = await SemiontClient.signIn({ baseUrl, email, password });

// 1. Just want the value? await.
const resource = await semiont.browse.resource(rId);
const result = await semiont.match.search(rId, refId, ctx);

// 2. Want to render a loading state or live updates? subscribe.
semiont.browse.resource(rId).subscribe((r) => {
  if (r === undefined) showSkeleton();
  else render(r);
});

// 3. Want progress events from a stream? subscribe.
semiont.mark.assist(rId, 'linking').subscribe((event) => {
  if (event.type === 'progress') updateProgress(event);
  else if (event.type === 'finished') celebrate();
});

// 4. Want to compose with operators? pipe (and bridge back when you await).
import { filter, map } from 'rxjs/operators';
import { lastValueFrom } from '@semiont/sdk';

const names = await lastValueFrom(
  semiont.browse.resources()
    .pipe(filter((rs): rs is ResourceDescriptor[] => rs !== undefined))
    .pipe(map((rs) => rs.map((r) => r.name)))
);
```

Four idiomatic shapes, all on the same return value. The script-author who's never heard of RxJS uses the first; the React component uses the second; the live-progress UI uses the third; the data-pipeline author uses the fourth.

## Method-by-method assignment

**`StreamObservable<T>`** (bounded; `then` resolves on completion):

- `mark.assist`
- `gather.annotation`
- `match.search`
- `yield.fromAnnotation`

**`CacheObservable<T>`** (multicast cache; `then` resolves on first non-undefined emission):

- `browse.resource`
- `browse.resources`
- `browse.annotations`
- `browse.annotation`
- `browse.referencedBy`
- `browse.events`
- `browse.entityTypes`

**Collaboration signals** (return `void`; emit on the bus, fan out to other participants):

- `mark.request`, `mark.requestAssist`, `mark.submit`, `mark.cancelPending`, `mark.dismissProgress`
- `mark.changeSelection`, `mark.changeClick`, `mark.changeShape`, `mark.toggleMode`
- `bind.initiate`
- `browse.click`, `browse.navigateReference`
- `match.requestSearch`
- `yield.clone`
- `beckon.hover`, `beckon.attention`, `beckon.sparkle`

These produce no return value at the call site — observation happens on the bus side via `session.subscribe(channel, handler)` or `client.bus.get(channel)`. A frontend VM emits `mark.changeShape('rectangle')`; a different participant subscribed to `mark:shape-changed` reacts.

**Plain `Observable<T>` / `BehaviorSubject<T>`** (no thenable wrapper, by design — observed continuously, not awaited):

- `client.transport.state$` — connection-state machine
- `client.transport.errors$` — transport-level error stream (`APIError` for HTTP, etc.)
- `session.token$` — current access token
- `session.user$` — current authenticated user
- `session.streamState$` — connection state at session scope
- `session.errors$` — re-publishes `client.transport.errors$` for session consumers
- `client.bus.get(channel)` — raw bus subscription (the channel-by-name escape hatch — see "Three paths to the bus" below)
- `session.subscribe(channel, handler)` — typed-channel subscription via `SemiontSession`

These stay reactive without a thenable for two reasons. First, `BehaviorSubject` has `.value` for synchronous snapshots; `firstValueFrom` is the explicit wait when you want one. Awaiting a BehaviorSubject directly is ambiguous — current value? next emit? next non-undefined emit? — and rarely what consumers want. Second, lifecycle observables and bus subscriptions are *meant* to be observed continuously; the consumer of `state$` or `mark:added` always wants the stream, never one snapshot.

## Three paths to the bus

The bus is the SDK's substrate for cross-participant coordination. Three legitimate paths reach it; each serves a distinct case. Picking the right one keeps the call site honest.

### 1. Typed namespace method — preferred

```ts
client.beckon.hover(annotationId);
client.mark.changeShape('rectangle');
const ctx = await client.gather.annotation(rId, aId);
```

The verb namespace knows the channel name, the payload schema, and (where applicable) the correlation pattern. IntelliSense guides you; types catch mistakes; the bus wiring is internal.

This is the right path **when a namespace method exists** for what you want. It covers all the canonical operations — every flow's commands, every CRUD operation, every collaboration signal that's been canonicalized as part of the protocol.

### 2. `session.subscribe(channel, handler)` — channel-by-name observation

```ts
const unsub = session.subscribe('mark:added', (event) => {
  console.log('Annotation added:', event.annotation);
});
// later: unsub();
```

The escape hatch for **observing a channel that doesn't have a typed namespace getter**. Common cases:

- React hooks like `useEventSubscription` that take a channel name as a prop.
- Daemons reacting to domain events (`mark:added`, `yield:created`, etc.) that no namespace exposes a typed listener for.
- Agentic code subscribing to collaboration signals from other participants (`mark:shape-changed`, `beckon:hover`) to drive its own behavior.

This path is sanctioned. It's typed against `EventMap` from `@semiont/core`, so the channel name and payload type stay aligned. The disposer cleans up on call.

### 3. Direct `client.bus.get(channel)` / `client.transport.emit(channel, ...)` — advanced

```ts
client.bus.get('mark:added').pipe(...).subscribe(...);
await client.transport.emit('match:search-requested', { ... });
```

The lowest-level path. Reach for it when:

- You're building a worker or actor that handles channels directly (Stower, Gatherer, etc. inside `@semiont/make-meaning` use this pattern — they *are* the handlers; namespaces wrap callers, not handlers).
- You need RxJS operator composition on a channel stream (`.pipe(filter(...), map(...), shareReplay())`).
- A new operation isn't yet wrapped by a namespace method, and you're prototyping.

If you find yourself reaching for `transport.emit` from application code repeatedly, the right move is usually to add a namespace method. The bus exposure is *not* `@internal` — it's a real surface for advanced use — but the typed namespaces are the canonical entry point for everything else.

## Bridging back to RxJS

`@semiont/sdk` re-exports `firstValueFrom` and `lastValueFrom` from RxJS. They're not load-bearing for the typical call site — `await semiont.X.Y(...)` works directly on the thenable subclasses — but they save an import line for the operator-composition case:

```ts
import { lastValueFrom } from '@semiont/sdk';
import { filter } from 'rxjs/operators';

const result = await lastValueFrom(
  semiont.match.search(rId, refId, ctx)
    .pipe(filter((e) => e.score > 0.9))
);
```

`.pipe(...)` returns plain `Observable<T>` — losing the thenable is correct, because pipe is composition, and the result no longer has the well-defined "final value" or "first defined emission" semantics that the subclasses encoded.

## Why this design

1. **Live queries are genuinely reactive.** Browse reads represent "the current value of this resource, which changes when bus events fire." Promise can't express that. Observable can.
2. **The `Cache<K,V>` primitive is a real architectural building block.** Multicast, per-key dedup, stale-while-revalidate. The subclass approach lets us keep it without leaking it through the public surface. See [CACHE-SEMANTICS.md](./CACHE-SEMANTICS.md) for the cache's behavioral contract.
3. **Lifecycle state is BehaviorSubject-shaped.** `token$`, `user$`, `state$` are state over time with synchronous snapshots. Native primitive.
4. **Sugar costs ~50 lines.** Two subclasses; `then` defined per the JS thenable spec. No alternative shape (Promise-only API, dual-API per method, AsyncIterable conversion) is cheaper or cleaner.
5. **No information loss.** A Promise-typed return would force a choice between progress and final value for streaming methods. A thenable Observable lets the consumer pick — `await` for final, `subscribe` for progress, both can compose.
6. **Composes correctly with RxJS.** `.subscribe(...)` works. `.pipe(...)` works (and falls back to plain Observable, which is the right behavior because pipe is composition). No fight with idiomatic RxJS.
7. **Pattern has precedent.** Apollo's `ObservableQuery`, zen-observable's awaitable subclass. Known shape; just not the stock-RxJS default.

The integrator writing a simple script doesn't know `@semiont/sdk` uses RxJS until they reach for `.subscribe(...)` to render progress, and even then they don't have to import from `rxjs/operators` until they reach for `.pipe(...)`. The reactive primitive is preserved as a load-bearing architectural choice; the user-facing surface looks Promise-shaped.

## See also

- [Usage.md](./Usage.md) — per-namespace tour with concrete examples
- [CACHE-SEMANTICS.md](./CACHE-SEMANTICS.md) — the `Cache<K,V>` primitive's behavioral contract behind `CacheObservable`
- [`packages/sdk/src/awaitable.ts`](../src/awaitable.ts) — the awaitable Observable subclasses' implementation
- [docs/protocol/EVENT-BUS.md](../../../docs/protocol/EVENT-BUS.md) — channel naming, scoping, correlation; the protocol layer the SDK wraps
- [docs/protocol/CHANNELS.md](../../../docs/protocol/CHANNELS.md) — channel inventory: persisted events, ephemeral signals, correlation responses, resource broadcasts
- [docs/protocol/TRANSPORT-CONTRACT.md](../../../docs/protocol/TRANSPORT-CONTRACT.md) — the `ITransport` behavioral guarantees underlying every namespace method, including `errors$`
