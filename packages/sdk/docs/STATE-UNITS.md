# State units

`@semiont/sdk` exposes a single foundational pattern called a **state unit**. The flow state units (`createMarkStateUnit`, `createGatherStateUnit`, `createMatchStateUnit`, `createYieldStateUnit`, `createBeckonStateUnit`), the domain worker adapters in `@semiont/jobs` and `@semiont/make-meaning`, and the per-feature page state units in `@semiont/react-ui` are all instances of it.

This doc covers what state units do, why they help, how they're shaped, and the conventions that keep them composable.

## What state units do

A state unit packages **state that changes over time** behind a **typed, RxJS-shaped surface** with **deterministic teardown**. You construct one with a factory function, subscribe to its Observables, and dispose it when you're done. That's the whole shape.

A state unit might wrap:
- a long-running flow (mark assist with progress + final result)
- a worker's claim / process loop
- a search input's debounce-and-fetch behavior
- a page's coordinated state (open resource + annotations + selected tool)

Whatever the underlying logic, the consumer's view is the same: Observable fields for state, methods for inputs, `dispose()` for cleanup.

## Why use them

State units exist so the same logic runs in many environments without rewriting:

- **Browser apps** consume them via React hooks (`useStateUnit`, `useObservable`).
- **CLIs and MCP servers** await on the awaitable subclasses (`StreamObservable`, `CacheObservable`).
- **Workers and daemons** subscribe directly with RxJS operators.
- **AI agents** observing what a human is doing connect to the same buses and the same units.

None of these consumers know about React. None know about HTTP. None know about your test setup. The state unit is the seam where flow logic stops caring who's consuming it.

The pattern also makes lifecycle predictable. Every state unit owns a bounded set of subscriptions and Subjects, and `dispose()` cleans them up. A tree of state units becomes a tree of `dispose()` calls. Memory leaks and orphaned subscriptions become unusual rather than the default.

## The interface

```ts
interface StateUnit {
  dispose(): void;
}
```

That's the entire structural commitment the type system catches. Implementing this interface is a claim that you're following the pattern; the rest of what makes a state unit a state unit is convention. A reader who sees `extends StateUnit` should expect everything below.

## Anatomy

A canonical factory:

```ts
export interface FooStateUnit extends StateUnit {
  readonly loading$: Observable<boolean>;
  readonly error$: Observable<Error | null>;
  readonly result$: Observable<Result | null>;
  trigger(input: Input): void;
}

export function createFooStateUnit(client: SemiontClient): FooStateUnit {
  // Internal state — Subjects held in the closure.
  const loading$ = new BehaviorSubject<boolean>(false);
  const error$ = new BehaviorSubject<Error | null>(null);
  const result$ = new BehaviorSubject<Result | null>(null);

  // Subscriptions to upstream sources, tracked for cleanup.
  const subs: Subscription[] = [];

  // Inputs come through methods.
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
    // Public surface — read-only Observable views.
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

Six things in this code recur in every state unit:

1. **Factory function, not class.** The "instance" is a closure capturing private state.
2. **Internal state in Subjects.** `BehaviorSubject<T>` for current-value semantics; `Subject<T>` for event streams.
3. **Public surface is `.asObservable()` views.** Consumers can subscribe but can't push values.
4. **Inputs go through methods.** No direct property assignment; fields are `readonly`.
5. **Subscriptions tracked.** Anything subscribed gets unsubscribed in `dispose()`.
6. **`dispose()` is idempotent.** Safe to call twice; the second call is a no-op.

Once you've seen one state unit, you can read any of them.

## Lifecycle

`dispose()`:

1. Completes every Subject the unit owns. Subscribers see `complete`.
2. Unsubscribes every internal subscription on upstream Observables.
3. Releases timers, abort controllers, network handles.
4. Is a no-op on subsequent calls.

After dispose, the unit is dead: methods become no-ops or throw, no more emissions reach subscribers. Code consuming a state unit can rely on this — once you've called `dispose()`, no stray emit will arrive later.

**Activation timing is the unit's call.** Most state units start work when the factory returns (subscribe to bus channels, wire up internal logic). Some have explicit `start()` / `stop()` for cases where eager work is wasteful — the job-claim adapter waits to be told to start claiming, for example. Either way, `dispose()` works the same.

**Hot vs. cold is per-surface.** Most public Observables are hot (BehaviorSubject- or Subject-backed) so multiple subscribers share state. Some are cold — `yield.resource` returns an `UploadObservable` that triggers a fresh upload per subscriber. The unit picks honestly per slot.

## Composition

State units compose by **parameter**, not **ownership**.

When an outer state unit takes an inner state unit as a constructor argument, the outer **does not own** the inner. Disposing the outer must NOT dispose the inner. The caller who constructed both is responsible for both.

```ts
// ✅ outer takes inner as a parameter — does not own it
export function createComposePageStateUnit(
  client: SemiontClient,
  shellStateUnit: ShellStateUnit,  // owned by caller
  params: ComposeParams,
): ComposePageStateUnit {
  // ...
  return {
    // ...
    dispose: () => {
      // tear down own state; do NOT call shellStateUnit.dispose()
      ourSubs.forEach((s) => s.unsubscribe());
    },
  };
}
```

The exception: a state unit that **constructs its own children internally** does own them. Page state units like `createResourceViewerPageStateUnit` build their own `MarkStateUnit` / `GatherStateUnit` / `MatchStateUnit` and dispose those children explicitly when the page itself disposes.

Rule of thumb: passed in → not yours to dispose. Constructed inside → yours to dispose.

## Conventions

The rules below describe how state units are written. They're organized by topic.

### Closure-based identity

A state unit is a factory function returning a plain object — not a class. No `class`. No `this`. No `extends`. The factory body is the constructor; the closure is the instance. This rules out subclass hierarchies and constructor games and makes each unit easy to read: there's exactly one place where state is declared and one place where it's exposed.

All state lives in the closure. **No module-scoped mutable state** — no module-level `let cache = new Map()` shared across instances, no singletons (other than constants). Two factory calls produce two fully independent units.

### Reactive surface

Every piece of state a consumer cares about is exposed as `Observable<T>` — not as a getter, not as a snapshot method, not as a callback. Consumers subscribe; they don't poll.

```ts
// ✅
loading$: Observable<boolean>;

// ❌ — synchronous getter for state-over-time
get loading(): boolean { return loading$.value; }

// ❌ — callback-shape for progress
onProgress(callback: (e: ProgressEvent) => void): void;
```

Public Observables are **read-only views** (`subject$.asObservable()`) over private Subjects held in the closure. The Subject is the authority; the Observable view is the attenuation. Consumers receive exactly the capability they need (subscribe), not the full power (`next`, `error`, `complete`).

**No raw `Subject` on the public surface.** Exposing `BehaviorSubject<T>` would let consumers `next()` arbitrary values, bypassing the unit's logic.

### Inputs

State changes happen through methods or input Subjects, never direct property assignment. A consumer either calls a method (`stateUnit.trigger(input)`) or pushes onto an input Subject the unit observes (`searchPipeline.setQuery('foo')`). Imperative methods are fine — `setQuery`, `notifySessionExpired`, `claim` aren't "observable mutators," they're explicit side-effect entry points. The discipline isn't "purely declarative"; it's "side effects go through the unit's logic."

### Lifecycle

`dispose()` is idempotent and total: completes every owned Subject, unsubscribes every internal subscription, releases all resources. Calling it twice is safe.

Subscribers attached before `dispose()` see a `complete` notification when it fires. After dispose, the unit is inert — methods no-op or throw, no further emissions arrive.

If the factory subscribes to something, `dispose()` must unsubscribe. If it starts a timer, `dispose()` must clear it. If it acquires a resource (file handle, abort controller, remote subscription), `dispose()` must release it. Anything the unit allocates during its lifetime ends with its lifetime.

### Synchronous snapshots

A consumer that needs the current value without subscribing can read `.value` on a `BehaviorSubject` *that the unit chooses to hold in scope they have access to*. The pattern is mostly internal — the public Observable type is `Observable<T>`, not `BehaviorSubject<T>`, so consumer code can't `.value`-poke. Tests sometimes exercise the inside view (constructing the unit and reading `.value` on the underlying Subject) — that's a legitimate one-way capability split between the closure interior and the public surface.

## Anti-patterns

A few specific shapes are wrong and worth calling out:

**No `Promise<T>` on long-running operations.** If the operation has progress events plus a final value plus a "loading" state, return a `StreamObservable<T>`, `CacheObservable<T>`, or `UploadObservable` — not `Promise<T>`. Promise plus Observable on the same conceptual operation breaks the four-shape return-type discipline. (See [REACTIVE-MODEL.md](./REACTIVE-MODEL.md).)

**No `Promise<void>` for fire-and-forget signals.** When a method's only purpose is to emit on the bus and return — `beckon.hover`, `mark.changeShape`, `bind.initiate` — the return type is `void`, not `Promise<void>`. `Promise<void>` implies an ack ("the operation completed"); collaboration signals don't have one; they fan out and the caller doesn't wait. The honest type documents the semantics.

**Don't expose the same state both via the bus and via a state-unit field.** If `markStateUnit.progress$` exists, consumers shouldn't also reach for `client.bus.get('mark:assist-progress')`. Two paths to the same value invites consumers to subscribe to both, then needs synchronization, then needs invariants, then breaks.

## How these rules are enforced

Today, the rules above are enforced by the TypeScript structural check (`dispose()` exists), a small handful of runtime tests in individual state-unit test files, and code review.

Work is in progress to convert the testable subset of these rules into automated enforcement: fast-check property tests for the lifecycle and isolation properties (idempotent dispose, subscriber completion, post-dispose inertness, instance-state isolation) and CI grep scripts for the static structural rules (no `class` declarations in state-unit files, no module-scoped mutable state, no `Promise<void>` on bus-emit methods). Some rules — anything depending on judgment about "long-running" or on cross-namespace consistency — will stay convention-only.

The doc will be updated with explicit per-rule enforcement labels as that work lands.

## Writing a new state unit — checklist

1. **Decide the surface.** What state does the consumer need to observe? Each piece becomes an `Observable<T>` field. What inputs does the consumer push? Each becomes a method or an input Subject the unit observes.
2. **Hold internal state in private Subjects.** `BehaviorSubject<T>` for current-value semantics; `Subject<T>` for event-stream semantics.
3. **Expose `.asObservable()` on the public surface.** Never expose the raw Subject.
4. **Decide activation timing.** Does the factory return ready-to-subscribe, or does it need an explicit `start()`? Either is fine; `dispose()` must work either way.
5. **Track every internal subscription.** Use a `Subscription[]` or `createDisposer()`. On `dispose()`, unsubscribe all of them and complete every Subject you own.
6. **Compose by parameter, not by ownership.** Take collaborators as arguments. Don't dispose passed-in collaborators.
7. **No module-scoped state.** Everything mutable lives in the closure.
8. **Test the lifecycle.** Construct, subscribe, dispose. Verify subscribers see `complete`. Verify subsequent emissions don't happen. Verify `dispose()` is idempotent.

## Why "state unit" and not "view-model"

The MVVM "view-model" name presumes a View — a ViewModel is a Model adapted into a UI-friendly shape *for a View to render*. State units don't presume a UI: a flow state unit is consumed by a web app, a TUI, a daemon running a marking pipeline, or an AI agent watching what a human is doing. Worker adapters are headless. The substrate is RxJS plumbing. "State unit" captures the unifying property — *stateful, lifecycled, RxJS-shaped* — without the UI claim.

## See also

- [REACTIVE-MODEL.md](./REACTIVE-MODEL.md) — the four return-shape categories (Promise / StreamObservable / CacheObservable / void) and the naming convention. State unit method returns follow the same convention.
- [CACHE-SEMANTICS.md](./CACHE-SEMANTICS.md) — the `Cache<K,V>` primitive backing live queries, itself a state unit specialized for keyed multicast caches.
- [Usage.md](./Usage.md) — per-namespace tour with concrete examples; many namespace methods return state-unit Observables or trigger state-unit reactions internally.
