# Reactive Model

`@semiont/sdk` uses RxJS as its underlying substrate but exposes a Promise-shaped surface to consumers who don't need the reactive view. This doc explains how that works, why it works, and where RxJS is still visible by design.

If you only want to *use* the SDK, [Usage.md](./Usage.md) is the per-namespace tour. Read this if you're curious about the design, choosing between `await` and `.subscribe(...)` for a given call site, or composing namespace methods with RxJS operators.

## The shape of values over time

Most SDK calls have a "current value" to return. Some genuinely have *values over time* — the progress of a long-running job, a live query that re-emits when the underlying resource changes. Promise can express the first; Observable can express both.

The choice for `@semiont/sdk` was to use Observable as the primitive — multicast, pipeable, native to live queries — and to layer Promise-shaped sugar on top so callers who only want the final answer can `await` and move on.

The result: a script that just wants to read a resource never imports anything from `rxjs`. A React component that needs a loading state subscribes to the same call. A pipeline that needs to filter and map composes with operators. Three idiomatic shapes on the same return value.

## The substrate: RxJS

Everything multicast in the SDK is an RxJS Observable:

- **Live queries** (`browse.resource`, `browse.resources`, `browse.annotations`, etc.) — values that re-emit when bus events fire.
- **Bounded streams** (`mark.assist`, `gather.annotation`, `match.search`, `yield.fromAnnotation`) — progress events plus a final result.
- **Lifecycle state** (`client.transport.state$`, `session.token$`, `session.user$`) — synchronous-snapshot `BehaviorSubject`s.
- **Bus subscriptions** (`session.subscribe(channel, handler)`, `client.bus.get(channel)`) — raw fan-out of typed events.

Observable is the right primitive for these. Promise has no "second value." The cache primitive at the heart of Browse — multicast, per-key dedup, stale-while-revalidate — composes cleanly only because the substrate supports the operators that make it possible. Forcing Promise here would require parallel `observe()` / `get()` methods on every namespace, sacrificing the reactive composability that makes live queries cheap.

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

**Plain `Observable<T>` / `BehaviorSubject<T>`** (no thenable wrapper, by design):

- `client.transport.state$` — connection-state machine
- `session.token$` — current access token
- `session.user$` — current authenticated user
- `session.streamState$` — connection state at session scope
- `client.bus.get(channel)` — raw bus subscription (sanctioned escape hatch)
- `session.subscribe(channel, handler)` — typed-channel subscription via `SemiontSession`

These stay reactive without a thenable for two reasons. First, `BehaviorSubject` has `.value` for synchronous snapshots; `firstValueFrom` is the explicit wait when you want one. Awaiting a BehaviorSubject directly is ambiguous — current value? next emit? — and rarely what consumers want. Second, lifecycle observables are *meant* to be observed continuously; the consumer of `state$` always wants the stream, never one snapshot.

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
- [CACHE-SEMANTICS.md](./CACHE-SEMANTICS.md) — the `Cache<K,V>` primitive's behavioral contract
- [`packages/sdk/src/awaitable.ts`](../src/awaitable.ts) — the two subclasses' implementation (~50 lines)
- [docs/protocol/EVENT-BUS.md](../../../docs/protocol/EVENT-BUS.md) — channel naming, scoping, correlation; the protocol layer the SDK wraps
- [docs/protocol/TRANSPORT-CONTRACT.md](../../../docs/protocol/TRANSPORT-CONTRACT.md) — the `ITransport` behavioral guarantees underlying every namespace method
