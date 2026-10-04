# Cache Semantics

## The emission vocabulary

Live queries emit **`CacheState<T>`**:

```ts
type CacheState<T> =
  | { status: 'pending' }              // no value yet; a fetch may be in flight
  | { status: 'ready';  value: T }     // a stored value (incl. stale-while-revalidate, B7)
  | { status: 'failed'; error: Error } // terminal failure of a value-less key (B15)
```

Three rules carry most of the contract (all landed 2026-07-29):

1. **`failed` is an EMISSION, not an RxJS error.** The stream never errors
   and never terminates on failure, so one subscription can live through
   `pending → failed`. A key has ONE state, the same for every observer of
   it: a NEW subscription runs the recovery chain, which returns the key to
   `pending` for all of them (see B15).
2. **One-shot reads are `.fresh()`** — the thenable is dead. `await
   client.browse.x(...)` does not compile; the network round trip is always
   spelled explicitly.
3. **Accessors are lazy**: calling a live-query method is pure — safe
   from render — and the fetch decision runs on first subscribe.

Ergonomics: `isReady` / `readyValue` from `@semiont/sdk` unwrap states in
pipes and handlers.

This is the **three-outcome contract** — the name source comments and
tests use for it: a live query has exactly these three observable
outcomes, all visible in the type (a two-state consumer does not
compile), none of them terminal for the stream — and the would-be
fourth outcome, `pending` forever, is a liveness violation the property
suites test for.

This document specifies the behavior of the read-through cache in
`BrowseNamespace` (and the `createCache` primitive in
`@semiont/sdk`). It is the behavioral contract that implementation must
satisfy and that tests must verify.

## Why write this down

The cache is implemented by hand because `@semiont/sdk` is
framework-agnostic (React, CLI, MCP, worker all consume it), and no
off-the-shelf library fits the RxJS + StateUnit idiom without
wrapping. Every bug in the hand-rolled cache so far has been a race
the published libraries already document how to handle. Writing the
expected behavior down so we can test against it — and so future
implementations of the same behavior have a stable target — is the
cheapest way to end the bug cycle.

Known cases that motivated this:

- `invalidate*` that deleted the cached value before refetching, causing
  downstream consumers that watched "is-loaded" to flip to loading —
  which in turn unmounted components whose effects held the very
  subscriptions whose reconnect triggered the invalidation. A 124×
  refetch storm per navigation, surfaced as test 04 in
  [tests/e2e/](../../tests/e2e/).
- `fetching*` guards that were never cleared after a connection-lost
  refetch, leaving the cache empty forever ("Loading resource…" that
  never resolves). Fixed in commit 845c6b24.
- Entity-types lost across a benign (mount-churn) reconnect because
  the same guard+invalidate pattern misfired.

## Vocabulary

| Term | Meaning |
|---|---|
| **Key** | A value identifying one logical cache entry. For `resource(id)` the key is `id`; for `resources(filters)` the key is `JSON.stringify(filters)`; for `entityTypes()` the key is the empty tuple. Keys are per-cache, not global. |
| **Entry** | The current value (or absence) associated with a key. |
| **Observer** | A caller who holds the `Observable<CacheState<V>>` returned from a live-query method (e.g. `browse.resource(id)`). Observers receive the current state and every subsequent change. |
| **Fetch** | An async operation (via `busRequest`) that produces a value to store. |
| **In-flight** | A fetch whose promise has not settled. Each key may have at most one in-flight fetch at a time. |
| **Invalidate** | A caller-initiated signal that the cache entry is out of date and must be refetched. |
| **SWR** | Stale-while-revalidate. The entry continues to be served to observers while the refetch is in flight. When the refetch returns, observers see the new value (or keep seeing the stale one if the refetch failed). |

## Entry lifecycle

Each key independently passes through these states:

```
  (never observed)
        │
        │  first call to a live-query method
        ▼
    ┌────────┐    fetch rejects      ┌─────────┐
    │ empty  │─────────────────────▶│ empty   │
    │(fetching)│◀──┐                │ (idle)  │   (retried by next
    └────────┘   │                  └─────────┘    observer or invalidate)
        │         │
        │ fetch   │
        │resolves │
        ▼         │
    ┌──────────┐ │
    │  fresh   │─┘ (invalidate — keep value, refetch in background)
    └──────────┘
        │
        │  invalidate + fetch succeeds
        ▼
    ┌──────────┐
    │  fresh′  │  (new value replaces old)
    └──────────┘
```

Consequences:

1. **No "stale" or "invalidated" state**. There is no state in which
   the cache has a value AND announces that value as out of date.
   Either we have a value (`fresh`) or we don't (`empty`). Invalidate
   means "schedule a refetch without erasing the current value."
2. **Two orthogonal facts**: "is there a value?" and "is a fetch in
   flight?" Observers get the first as `pending` vs `ready` states. The
   second is the private `fetching*` guard and is not exposed.
3. **Empty is terminal only until an observer or invalidate acts.**
   Each act gets one bounded retry (B14); after that the key goes idle
   until the next act. There is no standing retry loop.

## Two consumption paths

The cache has two read paths with different freshness semantics, and the
numbered behaviors below describe the **`observe` / subscribe** path (the stale-while-revalidate
live view). The second path:

- **`fetch(key)` — one-shot, always fresh.** Forces a fetch (bypassing the
  memo), updates the store so subscribers see it too, and resolves with the
  value — *rejecting* on failure. Concurrent calls for the same key dedup-join
  one in-flight fetch. This backs `CacheObservable.fresh()`
  (`browse.X(id).fresh()`), so a `read → write → read` in one process reflects
  the write rather than serving the memo (#847). A failed `fetch` still leaves
  the store untouched for subscribers (B6); only the `fetch` caller sees the
  rejection.

## Core behaviors

Each behavior is numbered for cross-reference from tests and code. They govern
the `observe` / subscribe path.

### B1 — First observation triggers a fetch

The first SUBSCRIBE to a live-query observable for a key that is `empty`
and not `fetching` MUST trigger exactly one fetch (the accessor call
itself is pure; the fetch decision runs per subscribe). The observable
MUST emit `{ status: 'pending' }` until the fetch resolves, then the
`ready` value.

### B2 — Subsequent observations reuse the cached value

Additional live-query calls for a key that is `fresh` MUST NOT
trigger a fetch. They MUST return an observable that emits the
current value synchronously (via the `distinctUntilChanged` chain
over the store Subject).

### B3 — Concurrent first observations deduplicate

If multiple observers call the live-query method for the same
`empty` key while a fetch is in flight, only one fetch is issued.
All observers MUST see the same resolved value.

### B4 — Observers share one observable per key

Successive live-query calls for the same key MUST return the same
`Observable` instance, so that subscribers compose predictably and
share upstream work. (Implementation: the `*Obs$` memoization
`Map<K, Observable<CacheState<V>>>` in `BrowseNamespace`, plus the
per-source `withScope` memo.)

### B5 — Fetch success updates the store atomically

On successful fetch, the new value MUST be written in a single
`BehaviorSubject.next(newMap)` transition. Observers see the old
`ready` value, then the new one; never a transient `pending`.

### B6 — Fetch failure leaves the previous state intact

On failed fetch, the entry MUST NOT be cleared. If the entry was
previously `fresh`, it remains `fresh` with the stale value
(stale-beats-error). The `fetching*` guard MUST be released in all
cases (success, failure, cancellation) via the `finally` block.

Boundary: stale-beats-error presumes a stale value to serve. A
previously-`empty` key stays `empty` through the B14 retry chain — but
if that chain EXHAUSTS with the key still value-less, B15 applies: the
terminal failure is surfaced to that key's observers as a `failed`
EMISSION, not absorbed into eternal `pending`.

### B7 — Invalidate is stale-while-revalidate

`invalidate(key)` MUST:

1. Clear the in-flight guard for `key` (so a previously-orphaned
   fetch doesn't block the refetch — this is the fix from commit
   845c6b24).
2. Trigger a fresh fetch.
3. NOT write to the store. The existing value (if any) remains
   visible to observers until the refetch resolves.

The result: observers keep seeing the stale value. When the refetch
returns, observers see the new value (or keep the stale one if the
refetch failed). Observers that check "is the value defined" see a
stable `true` across the invalidate — which prevents the
page-remount feedback loop documented above.

### B8 — Invalidate of an empty key is valid

`invalidate(key)` on an `empty` key is equivalent to first
observation: triggers one fetch, observers see `pending` until it
resolves. It is not an error.

### B9 — Invalidate during in-flight fetch does NOT coalesce

If `invalidate(key)` is called while a fetch for `key` is already in
flight, the implementation MUST start a new fetch anyway (and must
not short-circuit on the in-flight guard).

Rationale: an in-flight fetch may be **orphaned** — its SSE response
channel has been torn down (e.g. the reconnect that triggered the
invalidation), so the fetch will never resolve. If invalidate
coalesced with an orphaned fetch, the cache would be stuck with its
old value until the busRequest's 30-second timeout fired. This was
the "Loading resource…" that never resolves bug fixed in commit
845c6b24. (Orphaned in-flight replies are far rarer since correlated-
reply retention landed, 2026-07-29 — but the semantics
here are unchanged: B9 is about not trusting an in-flight guard.)

The cost is that two in-flight fetches for the same key can exist
briefly. Semantics: whichever resolves first writes its result;
whichever resolves second overwrites. "Last-write-wins" for two
legitimate fetches, which is acceptable because either value is
at least as fresh as what was cached before. In the orphaned case,
only the second fetch resolves, and it writes the correct value.

Implementation detail: this is why all `invalidate*` methods clear
the `fetching*` guard before calling the fetch helper.

### B10 — Multiple keys are independent

Fetch, invalidate, and store operations on key A MUST NOT affect
key B in the same cache. This is obviously true of Maps but stated
explicitly because the reconnect gap-detection handler invalidates
many keys in a loop and the independence matters (failure of one
invalidate must not block others).

### B11 — Per-cache observer observables live for the cache's lifetime

The `*Obs$` memoization Map grows with the set of observed keys
and does not shrink within a cache instance's lifetime. This is an
accepted leak trade-off: the number of distinct keys observed in a
session is bounded by user navigation, and the memory cost is
minimal compared to the correctness benefit of stable observable
identities.

A future cache primitive may add subscriber ref-counting and GC.
For now, the full cache lifetime matches a `SemiontClient`
instance, which matches a browser tab or a CLI process — so the
leak is strictly bounded.

### B14 — SWR fetch failure retries once (anti-starvation)

A fetch triggered by the **swallowed** paths — first observation (B1),
`invalidate` (B7/B8), `invalidateAll` — that fails MUST be re-issued
exactly once. If the retry also fails, the key goes idle (B6 state:
empty or stale-fresh) until the next observe/invalidate acts.

Rationale: the swallowed paths hide failures from subscribers by design
(B6), which means a lost one-shot reply — e.g. a `busRequest` whose SSE
result raced a connection swap and timed out
(the 2026-07-05 concurrent-loaders starvation incident) — previously
starved every subscriber of a never-loaded key **silently and
permanently**: no retry, no failure signal, `pending` forever. One
bounded retry converts "reply lost" from permanent starvation into one
slow load, without a standing retry loop hammering a genuinely-down
gateway. (Since correlated-reply retention landed, 2026-07-29, a
reply lost to a genuine disconnect replays on reconnect, so
this retry should fire approximately never; it stays as defense in
depth.)

Boundaries:

1. The `fetch(key)` await path NEVER auto-retries — its caller sees the
   rejection and owns retry policy (unchanged).
2. The retry joins any in-flight fetch another caller has started in the
   meantime (B3 dedup); it never duplicates.
3. An invalidate during a retry chain disowns it (B9) — the chain's
   late success may still write (last-write-wins, same as B9).

Liveness: B14's one-retry budget is pinned by liveness axioms **L1/L2**
(`assertLivenessAxioms` from `@semiont/core/testing/axioms`) — L2's settlement bound on the swallowed
paths is `timeoutMs × (1 + this retry)`, enforced against the real
`BrowseNamespace` + cache + `busRequest` composition by the property
suite ([browse-liveness.property.test.ts](../../packages/sdk/src/__tests__/browse-liveness.property.test.ts)).
Changing the retry count is a policy change that must edit L2's budget
visibly, not drift past it.

### B15 — Terminal failure of a value-less key is its `failed` state

When the B14 retry ALSO fails and the key holds **no cached value**, the
key's state MUST become **`{ status: 'failed', error }`** — never
`pending` forever, and never an RxJS error (the stream does not die).

**A key has one state, held by the cache, and every observer of the key
holds it.** No observer sees `failed` while another sees `pending`.

1. Observers present at exhaustion see `failed`. Their subscription
   stays alive — a later recovery on the same key flows to them without
   resubscribing.
2. An observer ARRIVING at a failed key runs RECOVERY (D3): the
   subscribe-time decision clears the failure and starts a fresh attempt
   chain — so a component remount recovers by construction. The key is
   `pending` again, for the observer arriving and for those already
   present, because a fetch is in flight for all of them. It then becomes
   `ready`, or `failed` with the new chain's error.
3. The failure is also cleared by `invalidate` (the key returns to
   `pending`, B8), `set`, `remove`, or any fetch success. A value arriving
   at a failed key moves it straight to `ready`, with no `pending`
   between. The failed state is always retriable; nothing is latched.
4. Keys WITH a cached value never come here — B6 stale-beats-error is
   unchanged.

Rationale: liveness axiom L1 — found by the property suite
([browse-liveness.property.test.ts](../../packages/sdk/src/__tests__/browse-liveness.property.test.ts))
as the valueless-key starvation bug (2026-07-05).
B14 converted "reply lost" into one slow load when the retry succeeds;
B15 covers the remaining corner — retry ALSO fails — where "idle" was
indistinguishable from the pre-B14 permanent silent starvation for
value-less keys. Delivering failure as an emission rather than a stream
error (2026-07-29) removed the dead-errored-observable hazard:
consumers pattern-match three states on one subscription instead of
wiring error callbacks whose streams then have to be re-created. The
`[cache IDLE]` breadcrumb (L4) is unchanged.

### B16 — Disposal is terminal and inert

`dispose()` completes every per-key observable (subscribers receive
`complete` and detach cleanly — the store AND the failures, both of which
a key's state is computed from), and stuns all later acts:

1. Post-dispose `observe()` returns a stream that completes immediately
   and issues NO fetch. `invalidate`/`invalidateAll`/`set`/`remove` are
   no-ops. `fetch()` rejects with the code `bus.closed`, as a request of
   a closed bus does, without invoking the fetch function — surfaced, not
   silent, since the await path's caller owns retry policy (B14 boundary 1).
2. A fetch/retry chain that STRADDLES disposal dies quietly at its next
   resumption point: no B14 re-issue, no breadcrumb, no B15 failure. The
   `disposed` flag is checked at every async resumption, not just at
   entry — and a late failure would land on a completed subject
   regardless (structural no-op, belt and braces).
3. `dispose()` is idempotent.
4. At the namespace level, `BrowseNamespace.dispose()` (called by
   `SemiontClient.dispose()`) disposes all owned caches (A7-owned: it
   constructed them) and detaches its bus-event subscriptions, so late
   invalidation events cannot refetch into disposed caches.

Rationale: a B14 retry straddling client teardown resolves `bus.closed`
(`busRequest`'s disposed-bus path) — a teardown artifact, not a data
failure. Pre-B16 the B15 failure then reached observers at shutdown
(disposal noise; it escaped as a flaky unhandled rejection in a
make-meaning test — a 2026-07-05 CI escape). B16 makes the push structurally impossible after disposal
instead of special-casing the `bus.closed` error code, which would have
carved a silent exception into liveness axiom L1 (whose standing rule is:
policy changes must edit the axiom visibly, not drift). L1 holds
unconditionally: live client → a terminal failure is the key's state (B15);
disposed client → observers were completed at disposal, so none exist
to starve.

## Bus-event-driven invalidation

Cache entries are also invalidated by incoming bus events. The
behavior above (B7–B9) applies identically. The only additional
constraint is:

### B12 — Bus-event handlers must be additive

Adding a new bus event → invalidation mapping MUST NOT change the
effect of any existing mapping. This is a structural rule: each
`bus.on('X').subscribe(...)` handler in the cache's
`subscribeToEvents()` is independent. Debugging becomes tractable
only if we can read one handler at a time and understand its full
effect.

### B19 — Bus-driven invalidations of one key coalesce

Every invalidation a bus event asks for goes through its key's
**window** (`INVALIDATION_WINDOW_MS`, 1 s):

1. The first invalidation of a key runs at once and opens the window.
   An isolated write is seen without delay.
2. Any more for that key inside the window are **owed**. When the
   window closes, the owed invalidation runs once, and opens the next
   window.
3. Disposal closes every window and drops what it owed (B16).

Why: each refetch is a `browse:*` request, an emit counted against
this session's principal (`emitsPerPrincipal`, 100 a second at the
baseline). Every write by anyone invalidates the keys a session
observes, so another principal's bulk import used to cost each viewer
one refetch per event per observed key. Measured: a 1,000-event
storm, 100 a second, refetched an observed key 1,000 times. The
window caps it at one per key per window, and the owed run means the
last event is always reflected.

This is coalescing at the **source**, not in the cache: B7–B9 hold
unchanged for every `invalidate` call, and the public `invalidate*`
methods stay immediate for direct callers. B9's in-flight guard is not
trusted, and the owed invalidation starts a fresh fetch like any other.

### B20 — A bus event refreshes only what the cache holds

An invalidation a bus event asks for is **dropped** when its key holds no
value, no failure, and has no fetch in flight. Nothing has asked for that
key, so there is nothing to refresh; its first observer fetches it (B1).

1. A key with a value is refreshed whether or not anyone observes it now:
   the cache keeps it for its lifetime (B11), and a kept value must not go
   stale.
2. A failed key is retried (B15), and a key with a fetch in flight gets a
   new one (B9): observers are waiting on both.
3. The public `invalidate*` methods are unaffected. A direct `invalidate`
   of an empty key still fetches (B8): the caller asked.

Why: an event names what changed, not what this client looks at.
`yield:created` reaches every client for every resource anyone creates,
and each used to answer with a `browse:resource-requested` for a resource
it had never opened: a 1,000-resource import cost every viewer 1,000
requests, each counted against its own principal, past anything B19 could
coalesce because every key was distinct. Likewise a `mark:added` on an
open resource fetched its event history for a viewer that never showed
one.

### B13a — Remove ends the key

Some bus events say the underlying entity no longer exists
(`mark:removed`, `mark:delete-ok`). For these the key is **ended**, not
invalidated:

1. Clear the in-flight guard.
2. The key's state becomes `failed`, with the code `bus.not-found`, for
   every observer of it. It goes there straight from `ready`: there is no
   `pending` between, because no request stands behind a removal.
3. Do NOT re-fetch.
4. Only a key the cache holds is ended (B20). An event about an annotation
   nothing has asked for marks nothing.

A removed key is a failed key in every other respect (B15): an observer
arriving at it starts a fresh chain, every observer is `pending` while it
runs, and the service answers for itself. For an entity that is gone it
answers not-found, and the key is `failed` again with the service's own
error.

Conventional method name: `remove<Entity>(key)` (not `invalidate`).

This is distinct from B7 (invalidate = SWR): invalidate keeps the value
and asks again; remove drops the value and asks for nothing.

Why `failed` and not an empty key: an observer left on `pending` with no
request in flight waits for something nothing will send, the state
liveness axiom L1 forbids everywhere else.

### B13b — Update-in-place for entities whose new value is known

Some bus events carry the full new entity in their payload
(`mark:body-updated` with the annotation). For these, the cache
should be updated with the known value directly — no fetch needed.

Conventional method name: `update<Entity>InPlace(key, value)`.

This satisfies B5 (atomic update, no transient `pending`) and
avoids the roundtrip of an invalidate-triggered refetch. It also
ensures both related caches stay in sync when a handler has reason
to update more than one.

### B13 — A stream that reopens

What a client must do when its stream is open again depends on how each
event that feeds its cache is delivered. There are two ways.

**Events with a position.** Every persisted event of a resource is
delivered on that resource's scope under `id: p-<scope>-<seq>`. The client
tracks a watermark PER SCOPE and sends each as `lastEventId` on that
scope's entry in the subscribe-matrix body, and the server replays what
the scope missed. For what these events feed, a reopened stream needs **no
cache action**: the replayed events refresh the cache as live ones do.

When the server cannot cover a scope's gap — retention window exceeded,
watermark unparseable, scope mismatch, the record unreadable — it emits
`bus:resume-gap` naming the scope. On that event the cache asks again for
everything it holds of that scope: the resource, its annotations (the list
and each one held), its event history and what refers to it.

**Events without one.** `yield:created`, `yield:updated`, `yield:cloned`,
`yield:moved`, `frame:entity-type-added` and `frame:tag-schema-added` reach
every client, on no scope, and so carry no position. One published while
the stream is down is lost, and nothing replays it. So when the stream is
open again **after a drop**, the cache asks again for everything those
events feed and it holds: every list of resources, every resource, the
entity types and the tag schemas. The collaborator directory, which no
event feeds, is asked for again here too: a gateway restarted with a
changed roster presents as a drop.

**A handoff is not a drop.** A changed subscription is handed from the old
stream to a new one, and the old delivers until the new is open: nothing
is missed, and the cache does nothing. A transport tells the two apart
by its connection state, which stays `open` across a handoff and leaves it
only for a drop.

Each of these is for a key the cache holds (B20) and goes through that
key's window (B19). With B7 (SWR) they are not destructive: observers keep
what they have until the new value arrives. The cost is requests, never
what is shown.

## What refreshes what

[`specs/src/client/refresh.json`](../../specs/src/client/refresh.json)
is the authority: a row per trigger, saying which live queries it acts on.
A trigger is a channel of the bus, or `reopened`, the stream open again
after a drop (B13). `BrowseNamespace` applies the table generated from it
(`CACHE_REFRESH` in `@semiont/core`), and states for itself only what each
event names: its resource, its annotation, the value it carries.

| A row says | The cache does | Behavior |
|---|---|---|
| `refetches` | asks again, showing what it has meanwhile | B7 |
| `writes` | writes the value the event carries, with no request | B13b |
| `removes` | ends the key as `bus.not-found`, with no request | B13a |

A row's `reach` is `subject`, the keys the event names, or `held`, every
key the cache holds. Every act is on a key the cache holds (B20); each
refetch goes through its key's window (B19); writes and removes do neither.

The SDK conformance suite builds a live case from every row
([`tests/conformance/sdk`](../../tests/conformance/sdk/README.md)), so a
row is a statement every SDK is held to.

Two things the table's shape follows from:

- **Lists of resources are refreshed as a whole.** An event does not say
  which filter combinations it affects, so every list the cache holds is
  asked for again.
- **A list of resources is a query's answer, not a live collection.** It is
  refreshed by the events every client hears (a resource created, updated,
  cloned or moved), by the reopening of a dropped stream, and by
  `mark:archived` and `mark:unarchived` on a resource whose scope the
  client holds. A resource archived or unarchived elsewhere, whose scope
  the client does not hold, does not refresh it: that event is delivered on
  the resource's scope, and a list holds no scopes. A change to a
  resource's entity tags refreshes no list. A list shows such a change when
  it is next asked for: by another event that refreshes it, a reopened
  stream, or a one-shot read. Deliberate: the alternative is every such
  change sent to every client, a cost that grows with the knowledge base's
  writes times its clients, for lists that show a page of it.
- **Nothing refreshes an annotation list by annotation alone.** A change
  to an annotation also refreshes, or writes, the list that contains it
  (B10-consistent).

## Required audits in the implementation

The following audits are checkable against the code; running them
is part of Phase 1's completion.

### A1 — All invalidate* methods follow B7 (SWR)

For each `invalidate*` method, confirm:

1. The in-flight guard is cleared (satisfies the orphaned-fetch
   recovery documented in B7 step 1).
2. The store is NOT written with a deletion before the fetch
   (satisfies B7 step 3 — don't flash empty).
3. A fetch is issued (satisfies B7 step 2).

### A2 — Every fetching* guard is cleared on all exit paths

Every `fetch*` helper must have a `try/finally` that clears the
guard. This was load-bearing for the 845c6b24 fix and remains
required. Grep confirms all current fetchers have the `finally
this.fetchingX.delete(key)` pattern — do not regress.

### A3 — Every BehaviorSubject is updated via copy-on-write

Writing `.next(newMap)` where `newMap = new Map(current)` is the
ritual. Direct mutation of the existing Map and calling `.next(map)`
on the same reference would not trigger `distinctUntilChanged`
downstream and would silently skip updates. Confirm every
`*$.next(...)` call uses a fresh Map.

### A4 — Every cache Map has a matching `*Obs$` memo

For every `Map<K, V>` stored in a `BehaviorSubject`, a matching
`Map<K, Observable<CacheState<V>>>` memoizes the per-key observable.
Without the memo, every live-query call creates a new observable,
breaking B4.

### A5 — Bus-event subscribers never `unsubscribe`

The subscriptions in `subscribeToEvents()` are created once at
construction and live for the cache's lifetime. There is no
tear-down path. This is correct because the cache's lifetime
matches the client's (see B11), but it means a bug that causes
`subscribeToEvents()` to run twice would double every effect.
The constructor is the only call site; audit that constructor runs
once per `SemiontClient`.

## Test-parity

A `cache-semantics.test.ts` in `packages/sdk/src/namespaces/__tests__/`
asserts each behavior against the current implementation. Adding a
new behavior here must be accompanied by a new test case referencing
its number (`// B7 — invalidate preserves stale value`). Removing or
changing a behavior must update both this doc and the test.


### B17 — Persistence is opt-in rehydration, reconciled by resumption

An optional `CachePersister` on `createCache` (and the
`sessionStoragePersister` adapter over the `SessionStorage` seam) gives a
cache durable, per-KB rehydration:

1. **Load-on-construct.** `persister.load()` seeds the store before the
   first observation, so a rehydrated key serves **synchronously** — no
   `pending` flash, no waiting on the wire to paint. (It does issue one
   revalidation request; see B18.)
2. **Rehydrated data is stale-until-reconciled**, and reconciliation is
   **two independent layers** — neither sufficient alone:
   - *Replay*, when it is available: the transport reconnects with each
     scope's persisted watermark (`lastEventId` on that scope's
     subscribe-matrix entry — persisted `p-*` ids only; ephemeral `e-*`
     ids carry no replay meaning and are never saved), replayed events
     invalidate through the normal handlers, and `bus:resume-gap` asks again
     for what is held of its scope (B13). The persisted watermark record is
     COUPLED to the cache flush (`coupledLastEventId`): stashed per
     event under its scope, written only alongside a cache-document
     write, and **only while every persisted cache is quiescent**
     (B17-Q's flush gate) — so the bookmark may lag the persisted caches
     (harmless: replay re-invalidates idempotently) but can never lead
     them and silently skip a reconciling event. Note the transport
     stashes an id only AFTER the event has been applied to subscribers,
     so an id is never flushable before its effects are pending.
   - *Revalidation on rehydrate* (B18), which covers what replay cannot:
     when NO watermark was persisted for a scope, that scope's entry
     carries no `lastEventId` and the server replays **nothing** for it
     — measured as the actual state at failure time in
     the annotation-lost-on-immediate-reload incident (2026-07-24).
3. **Settled values only.** The store never contains B15 failure markers,
   so neither does the persisted document; a previously-failed key
   rehydrates as absent and refetches on first observation.
4. **Saves are debounced** (default 50 ms) and **`dispose()` flushes a
   pending save synchronously before going inert** — the flush is part of
   the disposal act, so a KB switch cannot lose the last write; nothing
   may save after disposal (B16 extends to the persister).
5. **Version-gated.** A stored document whose version doesn't match (or
   that fails to parse) reads as empty — never an error into the cache.
6. **Cross-context sync** rides the persister's `subscribe` (the
   `SessionStorage.subscribe` seam): an external write replaces the store;
   last writer wins.

### B18 — A restored-from-disk value is revalidated on first observation

A value loaded by `persister.load()` is **stale-until-revalidated**: unlike
a value this session fetched, nothing guarantees it reflects server truth.
The first `observe(key)` of such a key therefore:

1. **serves the persisted value immediately** — it is already in the store,
   so subscribers paint instantly (B17's actual win is preserved), and
2. **starts one background revalidation** through the ordinary SWR path,
   rendering the fresher value when it arrives.

Boundaries:

- **Once per key per session.** The mark is cleared as soon as a fetch is
  under way from any path (`observe`'s revalidation, `invalidate`, or the
  `fetch`/await path) and by `set`/`remove`, so a rehydrated key costs at
  most one extra revalidation chain — one request, plus B14's single bounded
  retry if it fails; afterwards B2 applies normally. Only keys that are
  actually observed revalidate — rehydrating 200 entries and looking at one
  costs one chain.
- **Never worse than not revalidating.** A failed revalidation keeps the
  persisted value visible (B6) after B14's bounded retry; B15 cannot fire
  for these keys because the store holds a value.
- **Why it is not redundant with replay.** Replay reconciles only when a
  bookmark exists to resume from. It did not, in the measured failure — the
  flush gate was correctly holding the id pending, so storage contained no
  bookmark at all and the reconnect was live-only. B18 does not depend on
  replay, on the bookmark, or on any timing argument.

**Cost, honestly stated:** this gives back part of what B17 bought — a
reload is no longer request-free. It is not a return to cold-start: the
paint is still immediate and never blocks on the wire; what returns is the
background request per observed key.

## Revision log

- 2026-04-19 — initial spec, written as part of CACHE-LIBRARY.md
  Phase 1. Documents behavior as it exists after the
  `invalidateResourceDetail` SWR fix (test 04).
- 2026-07-05 — B14 added (bounded SWR retry); lifecycle consequence 3
  amended ("a permanent fetch failure does not auto-retry" → one retry
  per act). Part of the concurrent-browse-resource-starvation fix
  (ask 3): a lost one-shot reply must not permanently starve
  subscribers.
- 2026-07-05 — B15 added (terminal failure of a value-less key errors
  its observers, retriable); B6 narrowed to its true scope
  (stale-beats-error requires a stale value). Driven by the
  liveness property suite falsifying L1/L2 against the real
  composition (the valueless-key starvation bug).
- 2026-07-21 — B17 added (opt-in persistence: load-on-construct
  rehydration reconciled by resumption; values-only; flush-then-inert
  dispose; version-gated; cross-context via the SessionStorage seam).
- 2026-07-24 — **B18 added, and B17.1/B17.2 corrected — a declared
  behavior change.** B17 as written promised "a rehydrated key issues NO
  fetch", resting reconciliation entirely on replay. Measurement
  (the annotation-lost-on-immediate-reload incident) showed
  that at failure time there is **no persisted bookmark at all**, so replay
  is not merely late — it does not happen, and the stale document is served
  forever. B18 makes rehydrated values revalidate on first observation
  (instant paint kept, one background request per observed key). B17.2 now
  states the two reconciliation layers and notes B17-Q's flush gate. Also
  in this line of work: the flush gate itself (B17-Q, `persistencePending`/
  `persistenceSettled`) and the transport's apply-before-stash ordering.
  Three pins that encoded the old promise were updated deliberately
  (`cache-persistence`, `cache-rehydration`, and the property teeth).
- 2026-07-29 — **The `CacheState` era, and the doc body
  rewritten in its vocabulary.** Emissions are `CacheState<V>` (`pending` /
  `ready` / `failed`), never `V | undefined`; B15 reframed — terminal failure
  is a `failed` EMISSION (streams never error/terminate) and a late subscriber
  runs RECOVERY, not replay; one-shot reads are `.fresh()` (the thenable is
  dead); accessors are lazy (calling is pure, the fetch decision runs per
  subscribe — B1 restated). Same day: B13/B17 resumption wording moved to the
  per-scope subscribe-matrix watermarks (multi-resource scope), and B9/B14
  notes record that correlated-reply retention makes
  the lost-reply paths defense-in-depth rather than the common case.
- 2026-09-28 — **B19 added: bus-driven invalidations of one key
  coalesce** (leading edge at once, the rest owed to a 1 s window). A
  per-principal emit limit made the cost of uncoalesced refetches
  visible: a 1,000-event import refetched each observed key 1,000
  times. B12's additivity test now waits out the window for its second
  event's refetches: the count it asserts is unchanged, only its timing.
- 2026-10-01 — **B20 added: a bus event refreshes only what the cache
  holds.** Found by the SDK conformance suite's first live case. The
  mapping section already said a `yield:create-ok` invalidate of an
  uncached resource was a no-op; the code fetched it (B8 applied to
  bus-driven invalidations too). Observable difference: an event about a
  key nothing has asked for costs no request. Seven tests that counted
  those requests now observe the keys they count.
- 2026-10-01 — **B15: one state per key.** `failed` was an event pushed to
  the observers present at exhaustion, beside a store that held only
  values, so an observer that stayed held `failed` while one that arrived
  held `pending`. The cache holds the failure now, and a key's state is the
  same for every observer. Observable difference: when recovery starts (an
  observer arrives, or `invalidate` is called), the observers already
  present see `pending` again before the outcome. Nothing else changed:
  an arriving observer still starts recovery and still begins at `pending`.
- 2026-10-01 — **B13 and B13a restated; the mapping table moved to the
  spec.** Three declared behavior changes, each found by a live conformance
  case. (1) B13: a stream that reopens after a drop asks again for what
  events without a position feed (lists of resources, held resources,
  entity types, tag schemas, the collaborator directory). It asked for
  nothing, on the claim that resumption covered every gap, which is true
  only of events delivered on a scope. A handoff still costs nothing, and
  the transport's state now says which is which: it stays `open` across a
  handoff. `bus:resume-gap` refreshes its own scope, the scope's held
  annotations included, and no longer the KB-wide singletons, which the
  reopening covers; its scope-less branch is gone, the gateway never having
  sent one (`scope` is required in the schema). (2) B13a: a removed key is
  `failed` with `bus.not-found`; it was left with no value and no request,
  its observers `pending` for good. An unenriched `mark:body-updated`
  asks again for the annotation instead of removing it: the event says it
  changed, not that it is gone. (3) B16: a one-shot read of a closed
  client rejects as `bus.closed`; it rejected with no code. The "Mapping"
  section is replaced by `specs/src/client/refresh.json`, from which the
  handlers are generated; `keys()` and `invalidateAll()` cover every key
  the cache knows (B20), a failed one included.
- 2026-10-01 — **Stated: a list of resources is a query's answer, not a live
  collection.** No behavior changed. Archive, unarchive and entity-tag
  changes made elsewhere do not refresh a list whose client does not hold
  the resource's scope, and the section "What refreshes what" now says so.

