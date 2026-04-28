# State Units

`@semiont/sdk` is built on top of a single foundational pattern — a *state unit*. The flow state machines (`createMarkVM`, `createGatherVM`, `createMatchVM`, …), the worker adapters (`createSmelterActorVM`, `createJobClaimAdapter`, …), the search pipeline, and the per-feature page state machines in `@semiont/react-ui` are all instances of it.

This document defines the pattern. It's worth reading before writing a new flow VM, a new worker adapter, or a new page state machine — and it's worth keeping in mind when reviewing one.

## What a state unit is

A state unit is a stateful, lifecycled object with an RxJS-shaped public surface, constructed by a factory function, with internal state held in a closure. It models *some bounded chunk of state and behavior over time* — a long-running flow, a worker's claim/process loop, a search input's debounce-and-fetch dance — and it exposes that state to consumers as Observables.

The minimal interface every state unit implements:

```ts
interface ViewModel {
  dispose(): void;
}
```

(The interface is named `ViewModel` historically; the name is fine for the contract — consumers and tests rely on it. The directory housing them in `@semiont/sdk` is `state/`, not `view-models/`, because none of the contents presume a UI. See "Why 'state unit' and not 'view-model'" below.)

A canonical state unit factory looks like this:

```ts
export interface FooVM extends ViewModel {
  loading$: Observable<boolean>;
  error$: Observable<Error | null>;
  result$: Observable<Result | null>;
  trigger(input: Input): void;
}

export function createFooVM(client: SemiontClient): FooVM {
  const loading$ = new BehaviorSubject<boolean>(false);
  const error$ = new BehaviorSubject<Error | null>(null);
  const result$ = new BehaviorSubject<Result | null>(null);

  const subs: Subscription[] = [];

  const trigger = (input: Input): void => {
    loading$.next(true);
    error$.next(null);
    subs.push(
      client.someFlow.run(input).subscribe({
        next: (r) => result$.next(r),
        error: (e) => { error$.next(e); loading$.next(false); },
        complete: () => loading$.next(false),
      }),
    );
  };

  return {
    loading$: loading$.asObservable(),
    error$: error$.asObservable(),
    result$: result$.asObservable(),
    trigger,
    dispose: () => {
      subs.forEach((s) => s.unsubscribe());
      loading$.complete();
      error$.complete();
      result$.complete();
    },
  };
}
```

The shape is consistent across every state unit in the codebase. Once you've seen one, you can read any of them.

## The axioms

These are organized as **must-holds** (the contract), **non-axioms** (deliberate degrees of freedom), and **anti-axioms** (prohibitions). A new state unit should satisfy every must-hold; should consciously decide each non-axiom; and should never violate an anti-axiom.

### Must-holds (A1–A7)

#### A1 — Closure-based identity

A state unit is a *factory function* (`createMarkVM`, `createJobClaimAdapter`) that returns a plain object conforming to a TypeScript interface. The "instance" is the closure capturing private state in lexically-scoped variables.

- No `class`. No `this`. No `extends`. No `implements` for inheritance reasons.
- The factory's body *is* the constructor; there is no separate one.
- Every `let` / `const` declared inside the factory and referenced by the returned object is part of the unit's private state.

This rules out subclass hierarchies and constructor games. It also makes the unit easier to read — there's exactly one place where state is declared and one place where it's exposed.

#### A2 — Public surface is reactive

Every piece of state a consumer cares about is exposed as `Observable<T>` (or one of the awaitable subclasses: `StreamObservable<T>`, `CacheObservable<T>`, `UploadObservable`). Not as a getter, not as a snapshot method, not as a callback.

```ts
// ✅ axiom-compliant
loading$: Observable<boolean>;

// ❌ violates A2 — synchronous getter for state-over-time
get loading(): boolean { return loading$.value; }

// ❌ violates A2 — callback-shape for progress
onProgress(callback: (e: ProgressEvent) => void): void;
```

Consumers subscribe; they don't poll. This is what makes them "RxJS-shaped."

#### A3 — Internal state lives in `Subject` / `BehaviorSubject`; public Observables are read-only views

The Observable on the public surface is a *view* (`subject$.asObservable()`) over a private Subject held in the closure. The unit's logic is the only writer.

```ts
const loading$ = new BehaviorSubject<boolean>(false);   // private — closure-scoped
return {
  loading$: loading$.asObservable(),                    // public — read-only view
  // ...
};
```

This is capability discipline applied to RxJS: the Subject is the authority; the Observable view is the attenuation. Consumers receive *exactly* the capability they need (subscribe), not the full power (`next`, `error`, `complete`).

#### A4 — Inputs come through methods or upstream subscriptions, never direct property assignment

State changes happen *through the unit's logic*. A consumer either calls a method (`vm.cancelImport()`) or pushes onto an input subject the unit observes (`searchPipeline.setQuery('foo')`).

```ts
// ✅ axiom-compliant — input goes through the unit's logic
vm.trigger(input);

// ❌ violates A4 — direct property assignment
vm.input = input;
```

The factory captures the contract; consumer code can't slip past it.

#### A5 — `dispose(): void` is idempotent and total

Every state unit implements `ViewModel.dispose()`. Dispose:

1. Completes every Subject the unit owns (subscribers see `complete` notifications).
2. Unsubscribes every subscription the unit holds on upstream Observables.
3. Releases any timers, abort controllers, network handles, or other side-effect resources.

After `dispose()`, the unit is dead. Subsequent emissions don't happen, subsequent method calls are no-ops or rejected. Calling `dispose()` twice is safe — the second call is a no-op.

```ts
let disposed = false;
return {
  // ...
  dispose: () => {
    if (disposed) return;
    disposed = true;
    subs.forEach((s) => s.unsubscribe());
    loading$.complete();
    error$.complete();
    result$.complete();
  },
};
```

#### A6 — No leaked subscriptions

Any subscription the unit creates internally — to `client.bus.get(channel)`, to a flow Observable, to a timer — is tracked (in a disposer, a `Subscription[]`, or a closure variable) and released on `dispose()`. The unit's resource cost ends with its lifetime.

A common pattern:

```ts
const subs: Subscription[] = [];
subs.push(client.bus.get('mark:added').subscribe((event) => { /* react */ }));
subs.push(someUpstream$.subscribe((v) => internal$.next(v)));
// dispose: subs.forEach((s) => s.unsubscribe());
```

Or use the `createDisposer()` helper from `@semiont/sdk` for a slightly cleaner pattern.

#### A7 — Composition is by parameter, not ownership

When a state unit takes another unit as input, the passed-in unit is *not* owned by the outer one. Disposal does not propagate down.

```ts
// ✅ axiom-compliant — browseVM is owned externally; we just consume it
export function createComposePageVM(
  client: SemiontClient,
  browseVM: ShellVM,
  params: ComposeParams,
): ComposePageVM {
  // ...
  return {
    // ...
    dispose: () => {
      // tear down our own state; do NOT call browseVM.dispose()
      ourSubs.forEach((s) => s.unsubscribe());
    },
  };
}
```

Whoever constructs a `ShellVM` is responsible for its disposal. State units don't form ownership trees through composition; they form *reference* trees through composition. (Exception: a unit that constructs a child internally — e.g. `createResourceViewerPageVM` constructs its own `MarkVM` / `GatherVM` / `MatchVM` — *does* own those and disposes them.)

### Non-axioms (deliberate degrees of freedom)

These are the legitimate decision points each unit makes for itself.

#### N1 — Activation timing is the unit's call

Some units start work as soon as the factory returns:

```ts
// MarkVM subscribes to bus channels immediately on construction.
subs.push(client.bus.get('mark:requested').subscribe(/* … */));
```

Others have an explicit `start()` and don't do anything until called:

```ts
// JobClaimAdapter waits for `start()` before claiming jobs.
return {
  start: () => { /* subscribe to job:queued */ },
  stop:  () => { /* unsubscribe but don't dispose */ },
  dispose: () => { /* full teardown */ },
  // …
};
```

The contract is silent on which is right. The unit decides based on whether eager work is wasteful when nobody's subscribed yet. Either way, `dispose()` must work.

#### N2 — Hot vs. cold is per-surface

Most public Observables are hot (BehaviorSubject- or Subject-backed) so multiple subscribers share state. Some are cold (`new Observable((subscriber) => ...)`) when each subscriber should get fresh execution.

`yield.resource` is cold per-call: each upload is a separate operation, so each subscriber to the returned `UploadObservable` triggers its own POST. `MarkVM.pendingAnnotation$` is hot: the current pending state is shared.

The unit picks honestly per slot.

#### N3 — Synchronous snapshots are allowed *via the BehaviorSubject*

A consumer that needs the current value without subscribing can read `.value` on a `BehaviorSubject` *that the unit chooses to hold in scope they have access to*. The pattern is mostly internal:

```ts
// Inside the closure — fine.
if (loading$.value) return;

// Outside the closure — A2 still applies; the public `loading$` is
// `Observable<boolean>`, not `BehaviorSubject<boolean>`, so the consumer
// can't `.value`-poke. They subscribe.
```

Tests sometimes exercise the inside view (constructing the unit and reading `.value` on the underlying Subject). This is a legitimate one-way capability split between the closure interior and the public surface — the inside view sees full reflection, the outside view sees only events.

#### N4 — Imperative methods are allowed for explicit side-effect entry points

`setQuery` on a search pipeline, `notifySessionExpired` on session signals, `claim` on a job adapter. These aren't "observable mutators" — they're entry points for consumer code that knows what side-effect it wants to trigger. The axiom isn't "purely declarative"; it's "side effects go *through* the unit's logic" (A4). Methods are how that logic is invoked.

### Anti-axioms (prohibitions)

#### X1 — No raw `Subject` on the public surface

Exposing `loading$: BehaviorSubject<boolean>` would let consumers `next()` arbitrary values, bypassing the unit's logic and breaking A4.

```ts
// ❌
return {
  loading$: loading$,   // raw Subject — anyone can next()
  // …
};

// ✅
return {
  loading$: loading$.asObservable(),
  // …
};
```

#### X2 — No Promise-shaped methods on long-running operations

If the operation has progress events, a final value, *and* a "loading" intermediate state, it's `StreamObservable<T>` / `CacheObservable<T>` / `UploadObservable`, not `Promise<T>`. Mixing Promise and Observable on the same conceptual operation breaks the four-shape return-type discipline (see [REACTIVE-MODEL.md](./REACTIVE-MODEL.md)).

The PromiseLike sugar lets one-shot consumers `await`; the underlying surface stays reactive.

#### X3 — No module-scoped mutable state

All state lives in the closure. No module-level `let inFlightMap = new Map()` shared across all instances. No singletons (other than constants). No registries.

This is enforceable by inspection: open the file, look at top-level declarations. Constants and types are fine. Anything mutable is a bug.

```ts
// ❌ at module scope
const inFlightRefreshes = new Map<string, Promise<string>>();

// ✅ inside the factory closure
export function createSomeFactory() {
  const inFlightRefreshes = new Map<string, Promise<string>>();
  return (opts) => { /* … uses inFlightRefreshes … */ };
}
```

#### X4 — No constructor side effects that can't be undone by `dispose()`

If the factory subscribes to something, `dispose()` must unsubscribe. If it starts a timer, `dispose()` must clear it. If it acquires a resource (file handle, DB connection, remote subscription), `dispose()` must release it.

The lifecycle is bounded. A state unit that leaks anything across `dispose()` is broken.

#### X5 — No `Promise<void>` for fire-and-forget signals

When a method's only purpose is to emit on the bus and return — `beckon.hover`, `mark.changeShape`, `bind.initiate` — the return type is `void`, not `Promise<void>`. `Promise<void>` implies an ack ("the operation completed"); collaboration signals don't have an ack; they fan out on the bus and the caller doesn't wait.

The honest type documents the semantics. (This applies to namespace methods more than state unit factories, but the same discipline shows up in both places.)

#### X6 — No mixing the bus and direct method calls for the same state

If a flow's progress is observable both via `client.bus.get('mark:assist-progress').subscribe(...)` and via `markVM.progress$`, consumers shouldn't have to choose between the two for the same data. The unit picks one path and exposes it consistently. Two paths to the same value invites consumers to subscribe to both, which then needs synchronization, which then needs invariants, which then breaks.

## Why "state unit" and not "view-model"

The "view-model" name comes from MVVM (Model-View-ViewModel), an architecture where the ViewModel adapts a Model into a UI-friendly shape *for a View to render*. The name presumes a View.

In `@semiont/sdk`, none of the contents presume a UI:

- **Flow state machines** model the state of a flow over time. A web app subscribes; so does a TUI; so does a daemon running a marking pipeline; so could an AI agent observing what a human is currently marking. None of those is a "View" in the MVVM sense.
- **Worker adapters** are headless event multiplexers. The consumers today are all worker processes (`packages/jobs/`).
- **Substrate** (`createSearchPipeline`, the `WorkerBus` interface) is RxJS plumbing.

What unifies them is being *stateful, lifecycled, RxJS-shaped units*. "State" captures that without claiming UI specificity.

Page-shaped state machines that *do* presume a View — `createComposePageVM`, `createResourceViewerPageVM`, the admin VMs — live in `@semiont/react-ui` next to the components that render them. There, calling them view-models would be honest; the SDK keeps the broader, neutral framing.

The `ViewModel` interface itself stays named — it's a one-method contract (`{ dispose(): void }`) implemented by both view-shaped and view-shape-neutral units. The interface name is a historical convention; renaming every `extends ViewModel` for terminology purity isn't worth the churn. The directory was the load-bearing distinction.

## Writing a new state unit — checklist

1. **Decide the surface.** What state does the consumer need to observe? Each piece becomes an `Observable<T>` field. What inputs does the consumer push? Each becomes a method or an input Subject the unit observes.
2. **Hold the state in private Subjects.** `BehaviorSubject<T>` for current-value semantics; `Subject<T>` for event-stream semantics.
3. **Expose `.asObservable()` on the public surface.** Never expose the raw Subject.
4. **Decide activation timing (N1).** Does the factory return ready-to-subscribe, or does it need an explicit `start()`? Either is fine; `dispose()` must work either way.
5. **Track every internal subscription.** Use a `Subscription[]` or `createDisposer()`. On `dispose()`, unsubscribe all of them and complete every Subject you own.
6. **Compose by parameter, not by ownership.** Take collaborators as arguments. Don't dispose passed-in collaborators.
7. **No module-scoped state.** Everything mutable lives in the closure.
8. **Test the lifecycle.** Construct, subscribe, dispose. Verify subscribers see `complete`. Verify subsequent emissions don't happen. Verify `dispose()` is idempotent.

## Lineage

The pattern isn't original. Variants recur in reactive frameworks under various names — Flutter's BLoC is the closest match (stream-typed inputs and outputs, dispose lifecycle, no UI presumption); Apollo's `ObservableQuery` is the cache-shaped variant. Worth knowing the shape isn't unique to Semiont; the axioms above are what you actually need.

## See also

- [REACTIVE-MODEL.md](./REACTIVE-MODEL.md) — the four return-shape categories (Promise / StreamObservable / CacheObservable / void) and the naming convention. State unit method returns follow the same convention.
- [CACHE-SEMANTICS.md](./CACHE-SEMANTICS.md) — the `Cache<K,V>` primitive backing live queries, which is itself a state unit specialized for keyed multicast caches.
- [Usage.md](./Usage.md) — per-namespace tour with concrete examples; many namespace methods return state unit observables or trigger state unit reactions internally.
