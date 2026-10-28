# State units

A **state unit** is a piece of state that changes over time, held behind a surface its consumers read but cannot write, with one commitment: `dispose`. Every SDK is built from them, holds its units to the same axioms, and runs one table of what each of the SDK's units does.

The pattern is the same in every language. What differs is what a language reads state with: RxJS Observables in TypeScript, `tokio::sync::watch` receivers and streams in Rust, a `Watched[T]` read with `async for` in Python, a `Watched[T]` ranged over with `for` in Go. This doc states the pattern first, then each language's form of it.

## What state units do

A state unit packages **state that changes over time** behind a **typed surface a consumer reads but cannot write**, with **deterministic teardown**. You construct one, read its state as it changes, call its methods, and dispose it when you're done. That's the whole shape.

A state unit might wrap:
- a long-running flow (a delegated mark with progress + final result)
- a worker's claim / process loop
- a search input's debounce-and-fetch behavior
- a page's coordinated state (open resource + annotations + selected tool)

Whatever the underlying logic, the consumer's view is the same: state to read, methods for inputs, `dispose()` for cleanup.

## Why use them

State units exist so the same logic runs in many environments without rewriting:

- **Applications** hold them as the state a UI renders.
- **Scripts and CLIs** await their results.
- **Workers and daemons** read their streams.
- **AI agents** observing what a human is doing connect to the same buses and the same units.

None of these consumers know about React. None know about HTTP. None know about your test setup. The state unit is the seam where flow logic stops caring who's consuming it.

The pattern also makes lifecycle predictable. Every state unit owns a bounded set of things it must release, and `dispose()` releases them. A tree of state units becomes a tree of `dispose()` calls. Memory leaks and orphaned subscriptions become unusual rather than the default.

## What every state unit keeps

These hold in every SDK. The ids are the axioms' names in both test harnesses.

1. **Consumers read; they never write.** A unit hands out views of its state. Whatever writes that state stays private to the unit, so nothing outside can write past its logic.
2. **State and events are different surfaces.** State is what is true now: a reader gets the current value and each one after it. Events are what happened: a reader gets each one, in order.
3. **Inputs go through methods.** Nothing outside the unit assigns to its state.
4. **`dispose` is idempotent and total** (A5). Any number of calls is safe, and the first releases everything the unit allocated.
5. **A disposed unit is inert** (A5b). Its methods no longer act, and nothing more reaches a reader.
6. **Every reader sees the end** (A6). A reader attached before `dispose` is told the surface has ended.
7. **Compose by parameter, not ownership** (A7). A unit never disposes what it was given, and always disposes what it made.
8. **No state outside an instance** (X3). Two units never move each other.

## In TypeScript

`@semiont/sdk` exposes a single foundational pattern called a **state unit**. The flow state units (`createMarkStateUnit`, `createGatherStateUnit`, `createMatchStateUnit`, `createYieldStateUnit`, `createBeckonStateUnit`), the connection actor `@semiont/http-transport` keeps inside each transport, and the per-feature page state units in `@semiont/react-ui` are all instances of it.

A unit's surface is RxJS. Its state is a `Watched<T>` field: an `Observable` that also gives its value now (`getValue()`), a disposed unit's too. Its events are `Observable` fields. What writes either is a `Subject` held in the unit's closure. The SDK's units and the session's signals hand out their state as `Watched`; `@semiont/react-ui`'s page units and the HTTP transport's actor hand out plain `Observable` views.

### Who consumes them

- **Browser apps** consume them via React hooks (`useSessionStateUnit` for session-scoped units — it recreates the unit when the session changes; `useStateUnit` only for browser-lifetime shell units; `useObservable` for individual streams).
- **CLIs and MCP servers** await on the awaitable subclasses (`StreamObservable`, `CacheObservable`).
- **Workers and daemons** subscribe directly with RxJS operators.

### The interface

```ts
interface StateUnit {
  dispose(): void;
}
```

`StateUnit` lives in `@semiont/core` — so every layer (`@semiont/sdk`, `@semiont/http-transport`, `@semiont/react-ui`, …) implements the same interface without a dependency cycle, and the `@semiont/core/testing/axioms` harness can verify any of them. (App consumers import it from `@semiont/sdk`, which re-exports it — same one-import convenience as the branded types.) That's the entire structural commitment the type system catches. Implementing this interface is a claim that you're following the pattern; the rest is enforced below the type system — by the axiom suite and CI compliance scripts for the testable subset, and by review for the remainder (see [§ How these rules are enforced](#how-these-rules-are-enforced)). A reader who sees `extends StateUnit` should expect everything below.

### Anatomy

A canonical factory:

```ts
export interface FooStateUnit extends StateUnit {
  readonly loading$: Watched<boolean>;
  readonly error$: Watched<Error | null>;
  readonly result$: Watched<Result | null>;
  trigger(input: Input): void;
}

export function createFooStateUnit(session: SemiontSession): FooStateUnit {
  const { client } = session;

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
      client.mark.delegate(input.resourceId, { motivation: 'linking', entityTypes }).subscribe({
        next: (r) => result$.next(r),
        error: (e) => { error$.next(e); loading$.next(false); },
        complete: () => loading$.next(false),
      }),
    );
  };

  return {
    // Public surface — read-only views: subscribed to, or read for the value now.
    loading$: watched(loading$),
    error$: watched(error$),
    result$: watched(result$),
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
   And note the parameter: **session-scoped factories take a `SemiontSession`, not a
   bare `SemiontClient`**. A client can be
   disposed and replaced under a live unit on a KB switch; the session is the stable
   identity, and destructuring `client` inside the factory pins the unit to the client
   it was built for — exchange callbacks and subscriptions then capture that session by
   construction. A CI ratchet (`scripts/compliance/audit-session-typed-factories.sh`)
   keeps new factories on this signature; the only sanctioned `useStateUnit` consumers
   are browser-lifetime shell units.
2. **Internal state in Subjects.** `BehaviorSubject<T>` for current-value semantics; `Subject<T>` for event streams.
3. **Public surface is `watched(...)` views.** Consumers subscribe, or read the value now; they can't push values.
4. **Inputs go through methods.** No direct property assignment; fields are `readonly`.
5. **Subscriptions tracked.** Anything subscribed gets unsubscribed in `dispose()`.
6. **`dispose()` is idempotent.** Safe to call twice; the second call is a no-op.

Once you've seen one state unit, you can read any of them.

### Lifecycle

`dispose()`:

1. Completes every Subject the unit owns. Subscribers see `complete`.
2. Unsubscribes every internal subscription on upstream Observables.
3. Releases timers, abort controllers, network handles.
4. Is a no-op on subsequent calls.

After dispose, the unit is dead: methods become no-ops or throw, no more emissions reach subscribers. Code consuming a state unit can rely on this — once you've called `dispose()`, no stray emit will arrive later.

**Activation timing is the unit's call.** Most state units start work when the factory returns (subscribe to bus channels, wire up internal logic). Some have explicit `start()` / `stop()` for cases where eager work is wasteful — the job-claim adapter waits to be told to start claiming, for example. Either way, `dispose()` works the same.

**Hot vs. cold is per-surface.** Most public Observables are hot (BehaviorSubject- or Subject-backed) so multiple subscribers share state. Some are cold — `yield.resource` returns an `UploadObservable` that triggers a fresh upload per subscriber. The unit picks honestly per slot.

### Composition

State units compose by **parameter**, not **ownership**.

When an outer state unit takes an inner state unit as a constructor argument, the outer **does not own** the inner. Disposing the outer must NOT dispose the inner. The caller who constructed both is responsible for both.

```ts
// ✅ outer takes inner as a parameter — does not own it
export function createComposePageStateUnit(
  session: SemiontSession,
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

### Conventions

The rules below describe how state units are written, organized by topic. Which are automated (the axiom suite and CI compliance scripts) versus review-only is summarized in [§ How these rules are enforced](#how-these-rules-are-enforced).

#### Closure-based identity

A state unit is a factory function returning a plain object — not a class. No `class`. No `this`. No `extends`. The factory body is the constructor; the closure is the instance. This rules out subclass hierarchies and constructor games and makes each unit easy to read: there's exactly one place where state is declared and one place where it's exposed.

All state lives in the closure. **No module-scoped mutable state** — no module-level `let cache = new Map()` shared across instances, no singletons (other than constants). Two factory calls produce two fully independent units.

#### Reactive surface

Every piece of state a consumer cares about is exposed as `Watched<T>`: subscribed to for its value and each change, and read for its value now with `getValue()`. Not as a getter of the unit's own, not as a snapshot method, not as a callback.

```ts sketch
// ✅
loading$: Watched<boolean>;

// ❌ — synchronous getter for state-over-time
get loading(): boolean { return loading$.value; }

// ❌ — callback-shape for progress
onProgress(callback: (e: ProgressEvent) => void): void;
```

Public state is a **read-only view** (`watched(subject$)`) over a private Subject held in the closure. The Subject is the authority; the view is the attenuation. Consumers receive exactly the capability they need (subscribe, and the value now), not the full power (`next`, `error`, `complete`).

**No raw origin `Subject` on the public surface.** Exposing a `new Subject`/`new BehaviorSubject` directly would let consumers `next()` arbitrary values, bypassing the unit's logic — expose `watched(...)`, or `.asObservable()` for events, instead. (A derived `AnonymousSubject` from `shareReplay().pipe(...)` is an inert sink and fine; the X1 check tells them apart by `.source`.)

#### Inputs

State changes happen through methods or input Subjects, never direct property assignment. A consumer either calls a method (`stateUnit.trigger(input)`) or pushes onto an input Subject the unit observes (`searchPipeline.setQuery('foo')`). Imperative methods are fine — `setQuery`, `notifySessionEnded`, `claim` aren't "observable mutators," they're explicit side-effect entry points. The discipline isn't "purely declarative"; it's "side effects go through the unit's logic."

#### Lifecycle

`dispose()` is idempotent and total: completes every owned Subject, unsubscribes every internal subscription, releases all resources. Calling it twice is safe.

Subscribers attached before `dispose()` see a `complete` notification when it fires. After dispose, the unit is inert — methods no-op or throw, no further emissions arrive. A completed `BehaviorSubject` still takes a value from `next`, which `getValue()` then gives, so nothing a disposed unit's methods or leftover callbacks do may call it.

If the factory subscribes to something, `dispose()` must unsubscribe. If it starts a timer, `dispose()` must clear it. If it acquires a resource (file handle, abort controller, remote subscription), `dispose()` must release it. Anything the unit allocates during its lifetime ends with its lifetime.

#### Synchronous snapshots

A consumer that needs the value now, without subscribing, reads `getValue()` on the unit's `Watched` state. A disposed unit's state gives the value it held when the unit ended.

### Anti-patterns

A few specific shapes are wrong and worth calling out:

**No `Promise<T>` on long-running operations.** If the operation has progress events plus a final value plus a "loading" state, return a `StreamObservable<T>`, `DelegationObservable<C>`, `CacheObservable<T>`, or `UploadObservable` — not `Promise<T>`. Promise plus Observable on the same conceptual operation breaks the return-shape discipline. (See [REACTIVE-MODEL.md](./REACTIVE-MODEL.md).)

**No `Promise<void>` for fire-and-forget signals.** When a method's only purpose is to emit on the bus and return — `beckon.hover`, `mark.request`, `bind.initiate` — the return type is `void`, not `Promise<void>`. `Promise<void>` implies an ack ("the operation completed"); collaboration signals don't have one; they fan out and the caller doesn't wait. The honest type documents the semantics.

**Don't expose the same state both via the bus and via a state-unit field.** If `markStateUnit.progress$` exists, consumers shouldn't also reach for `client.bus.on('job:report-progress')`. Two paths to the same value invites consumers to subscribe to both, then needs synchronization, then needs invariants, then breaks.

### Writing a new state unit — checklist

1. **Decide the surface.** What state does the consumer need to observe? Each piece becomes a `Watched<T>` field, and each stream of events an `Observable<T>` one. What inputs does the consumer push? Each becomes a method or an input Subject the unit observes. If the unit touches a session-scoped client, the factory takes `SemiontSession` (destructure `client` inside) — see Anatomy note 1.
2. **Hold internal state in private Subjects.** `BehaviorSubject<T>` for current-value semantics; `Subject<T>` for event-stream semantics.
3. **Expose `watched(subject)` on the public surface** (`.asObservable()` for events). Never expose the raw Subject.
4. **Decide activation timing.** Does the factory return ready-to-subscribe, or does it need an explicit `start()`? Either is fine; `dispose()` must work either way.
5. **Track every internal subscription.** Use a `Subscription[]` or `createDisposer()`. On `dispose()`, unsubscribe all of them and complete every Subject you own.
6. **Compose by parameter, not by ownership.** Take collaborators as arguments. Don't dispose passed-in collaborators.
7. **No module-scoped state.** Everything mutable lives in the closure.
8. **Add the axiom block.** In the unit's test file, call `assertStateUnitAxioms<FooStateUnit>({ setup, surfaces?, invocations?, ownedChildSurfaces? })` from `@semiont/core/testing/axioms`, naming the unit it holds (add `fast-check` to your devDependencies — the doubles at `@semiont/core/testing` need no such thing) — it checks the lifecycle and composition axioms (X1/A5/A5b/A6/X3/A7) for you. Mirror an existing `*-state-unit.test.ts`; see [§ How these rules are enforced](#how-these-rules-are-enforced).

## In Rust

A unit is a struct built over an `Arc<SemiontClient>` it never closes. Its state is read through `tokio::sync::watch` receivers, the value now and each value after it, and its events through streams. The senders stay private to the unit. `dispose` ends it, and so does dropping it.

One TypeScript rule has no Rust form: a unit is a struct, not a closure.

The Rust README lists [the units and what each holds](../../packages/sdk-rust/README.md#state-units), and has [the table that maps each TypeScript shape to its Rust form](../../packages/sdk-rust/README.md#from-the-typescript-sdk).

## In Python

A unit is a class built over a client it never closes, inside a running event loop, and it names `StateUnit` (`semiont.state_unit`) as its base. Each thing it holds is a `Watched[T]` (`semiont.watched`): `.value` is the value now, and `async for` gives that value and then each change, until the unit ends; a reader that falls behind is given the latest. What writes it is a `Variable` the unit keeps to itself. A unit hears the client's own bus from the moment it exists, in the order things were said, and acts a turn of the loop later. `dispose()` ends it, and so does leaving `async with`, by which time what it had running has ended.

As in Rust, a unit is a class, not a closure. The Python README lists [the units and what each holds](../../packages/sdk-python/README.md#state-units), with a program that watches one.

## In Go

A unit is a struct built over a `*semiont.Client` it never closes, made by its constructor (`state.NewYieldStateUnit(client, locale)`), and it declares itself a `semiont.StateUnit` where it is declared (`var _ semiont.StateUnit = (*YieldStateUnit)(nil)`). Each thing it holds is a `semiont.Watched[T]`: `Value()` is the value now, and `Changes(ctx)` gives that value and then each change, until the unit ends or the context is done; a reader that falls behind is given the latest. What writes it is a `semiont.Variable` the unit keeps to itself, handing out only its `Reading()`. A unit hears the client's own bus from the moment it exists, and runs what it starts on goroutines of its own. `Close()` ends it: what it had running stops, and every `Changes` it handed out ends.

As in Rust, a unit is a struct, not a closure. The Go README lists [the units and what each holds](../../packages/sdk-go/README.md#state-units), with a program that watches one.

## How these rules are enforced

The structural contract — `dispose()` exists — is the only part the **type system** catches. Everything else is enforced by an executable axiom suite plus CI compliance scripts (the runtime twin of this doc), with a residue of review-only conventions. The executable spec IS the harness — `assertStateUnitAxioms` from `@semiont/core/testing/axioms`, invoked once from each state unit's test file; its property definitions are the authoritative statements of the axioms below.

That is the TypeScript harness. Rust's (`semiont::testing::axioms`), Python's (`semiont.testing.axioms`) and Go's (`semionttest.AssertStateUnitAxioms`) hold their units under the same ids; the last column says which rules they hold too.

What a unit does is held apart from the axioms. [`specs/src/client/state-units.json`](../../specs/src/client/state-units.json) states it case by case, and every SDK runs each case of the units it has: `packages/sdk/src/__tests__/state-cases.test.ts`, `packages/sdk-rust/tests/state_cases.rs`, `packages/sdk-python/tests/test_state_cases.py` and `packages/sdk-go/state/cases_test.go`.

Five enforcement tiers:

| Tier | Mechanism | Rules | Held in Rust, Python and Go too |
|---|---|---|---|
| **Axioms** — property-based (fast-check) | `assertStateUnitAxioms`, per unit | **A5** idempotent & total dispose · **A5b** post-dispose inertness · **A6** subscribers see `complete` · **X3-runtime** instance isolation | A5, A5b, A6, X3: all three |
| **Liveness axioms** — property-based (fast-check), composition-level | `assertLivenessAxioms` / `assertExactlyOnceDelivery` from `@semiont/core/testing/axioms`, driving `FaultyTransport` (sdk) and the mock-conn SSE harness (http-transport) | **L1** subscriptions never silently pend forever · **L2** every `Bus.request` settles within timeout × retry budget · **L3** exactly-once delivery across handovers (drain-over-abort) · **L4** degraded modes emit breadcrumbs | L1, L2, L3: Rust |
| **Structural assertions** — single-shot | `assertStateUnitAxioms`, per unit | **X1** no raw origin Subject on the surface · **A7-passed** don't dispose injected deps · **A7-owned** do dispose constructed children | A7-passed, A7-owned: all three; X1: Python and Go |
| **Static compliance** — CI grep (`scripts/compliance/`, run by the `compliance-check` job of `ci.yml`) | bash + grep | no `class` in a `*-state-unit.ts` file (TypeScript's convention: its units are made by factories) · **X3-static** no module-scoped mutable state · **X5** no fire-and-forget `Promise<void>` in SDK namespaces · **session-typed factories** — no `!`-asserted factory args; `useStateUnit` confined to the shell allowlist | X3: Rust, as a test that fails any `static` item; Python, as a test that fails module state not marked `Final` |
| **Conventions** — code review only | — | **A3-interior** internal state in Subjects · **X2** no `Promise<T>` on long-running ops · **X6** no dual bus+field exposure of the same state | — |

Every state unit's test carries an `assertStateUnitAxioms<Unit>({...})` block that names its unit — all 17 units across `@semiont/sdk`, `@semiont/http-transport` and `@semiont/react-ui`, `SemiontSession` among them. `lint:state-unit-census` (`scripts/lint/check-state-unit-census.mjs`) fails an interface that extends `StateUnit`, or a class that implements it, with no such block, as `packages/sdk-rust/tests/census.rs` fails a Rust unit with no axiom test, `packages/sdk-python/tests/test_census.py` a Python one, and `packages/sdk-go/units_axioms_test.go` a Go one.

### Rule reference

- **No class in a state-unit file — TypeScript's convention, not an axiom.** TypeScript makes its units by factories returning plain objects, and a static check holds `*-state-unit.ts` files to it. The axioms say how a unit behaves, the same in every SDK; how a unit is represented is each language's (a Rust unit is a struct, a Python unit a class, a Go unit a struct made by its constructor, and TypeScript's `SemiontSession` a class).
- **X1 — no raw origin Subject on the public surface.** A field that is `instanceof Subject` with `.source === undefined` (a `new Subject`/`new BehaviorSubject` — the unit's own state) lets consumers `next()` past the unit's logic; expose `watched(...)`. Derived `AnonymousSubject`s from `shareReplay().pipe(...)` carry a `.source` and are inert sinks — excluded. *TypeScript, Python and Go, whose harness fails a unit that hands out the `Variable` holding a state. Rust has it by construction: a unit's senders are private.*
- **X3 / X3-runtime — instance isolation.** Runtime: driving one instance never moves another's surfaces. Static: no module-scoped `let`/`var` or `const x = new Map/Subject/...`. The two are complementary — the static check catches shapes (e.g. a shared monotonic counter) whose leak doesn't change emission counts, which the runtime check can miss. *Every SDK.*
- **A5 / A5b — dispose is idempotent and total; methods are inert afterward.** *Every SDK.*
- **A6 — every owned Subject completes on dispose** (pre-dispose subscribers see `complete`; post-dispose subscriptions are inert). *Every SDK.*
- **A7-passed / A7-owned — compose by parameter.** Never dispose an injected dependency; always dispose a child you constructed internally. *Every SDK.*
- **X5 — fire-and-forget signals return `void`, not `Promise<void>`.** A thin regression speed-bump: the SDK complies, and the script's allowlist holds the genuinely-awaiting acks (`delete`, `logout`, `addEntityType`, …). *TypeScript only: the rule is about `Promise<void>`.*
- **A3-interior / X2 / X6 — review only.** Internal state held in Subjects, no `Promise<T>` on operations that have progress + a final value, and no exposing the same state on both the bus and a unit field — these resist a cheap static check and are caught in review. *TypeScript.*

### Deferred enforcement

- **AST static checks (A2-static / A4-static / X1-static)** — that every `$`-suffixed field on a `XxxStateUnit` interface is typed `Watched<T>` or `Observable<T>`, every Observable field is `readonly`, and no `Subject<T>` appears in an interface field position. These need the TypeScript compiler API (or ts-morph), not grep; deferred until review is shown to miss them.
- **A6-deep** — A6 attaches *k* subscribers then disposes; the deep version would generate random `subscribe / emit / unsubscribe / dispose` sequences and assert completion plus no post-unsubscribe emission. Deferred until a subscribe/unsubscribe-race bug slips past the shallow version.

## Why "state unit" and not "view-model"

The MVVM "view-model" name presumes a View — a ViewModel is a Model adapted into a UI-friendly shape *for a View to render*. State units don't presume a UI: a flow state unit is consumed by a web app, a TUI, a daemon running a marking pipeline, or an AI agent watching what a human is doing. Worker adapters are headless. The substrate is RxJS plumbing. "State unit" captures the unifying property — *stateful, lifecycled, RxJS-shaped* — without the UI claim.

## See also

- [REACTIVE-MODEL.md](./REACTIVE-MODEL.md) — the four return-shape categories (Promise / StreamObservable / CacheObservable / void) and the naming convention. State unit method returns follow the same convention.
- [CACHE-SEMANTICS.md](../protocol/CACHE-SEMANTICS.md) — the `Cache<K,V>` primitive backing live queries, itself a state unit specialized for keyed multicast caches.
- [Usage.md](./Usage.md) — per-namespace tour with concrete examples; many namespace methods return state-unit Observables or trigger state-unit reactions internally.
- [The Rust SDK's README](../../packages/sdk-rust/README.md) — the Rust units, and the table that maps each TypeScript shape to its Rust form.
- [The Python SDK's README](../../packages/sdk-python/README.md#state-units) — the Python units, and a program that watches one.
- [The Go SDK's README](../../packages/sdk-go/README.md#state-units) — the Go units, and a program that watches one.
