# Cache Semantics

This document specifies the behavior of the read-through cache in
`BrowseNamespace` (and, by extension, any future cache primitive in
`api-client`). It is the behavioral contract that implementation must
satisfy and that tests must verify.

## Why write this down

The cache is implemented by hand because `api-client` is
framework-agnostic (React, CLI, MCP, worker all consume it), and no
off-the-shelf library fits the RxJS + ViewModel idiom without
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
  [tests/e2e/](../../../tests/e2e/).
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
| **Observer** | A caller who holds an `Observable<V \| undefined>` returned from a live-query method (e.g. `browse.resource(id)`). Observers receive the current value and every subsequent change. |
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
   flight?" Observers get the first as `V | undefined`. The second is
   the private `fetching*` guard and is not exposed.
3. **Empty is terminal only until an observer or invalidate acts.**
   A permanent fetch failure does not auto-retry.

## Core behaviors

Each behavior is numbered for cross-reference from tests and code.

### B1 — First observation triggers a fetch

The first call to a live-query method for a key that is `empty` and
not `fetching` MUST trigger exactly one fetch. The returned
`Observable` MUST emit `undefined` until the fetch resolves, then emit
the value.

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
`Map<K, Observable<V | undefined>>` in `BrowseNamespace`.)

### B5 — Fetch success updates the store atomically

On successful fetch, the new value MUST be written in a single
`BehaviorSubject.next(newMap)` transition. Observers see the old
value, then the new value; never a transient `undefined`.

### B6 — Fetch failure leaves the previous state intact

On failed fetch, the entry MUST NOT be cleared or marked with an
error state. If the entry was previously `empty`, it remains
`empty`. If it was previously `fresh`, it remains `fresh` with the
stale value. The `fetching*` guard MUST be released in all cases
(success, failure, cancellation) via the `finally` block.

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
observation: triggers one fetch, observers see `undefined` until it
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
845c6b24.

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
For now, the full cache lifetime matches a `SemiontApiClient`
instance, which matches a browser tab or a CLI process — so the
leak is strictly bounded.

## Bus-event-driven invalidation

Cache entries are also invalidated by incoming bus events. The
behavior above (B7–B9) applies identically. The only additional
constraint is:

### B12 — Bus-event handlers must be additive

Adding a new bus event → invalidation mapping MUST NOT change the
effect of any existing mapping. This is a structural rule: each
`bus.get('X').subscribe(...)` handler in the cache's
`subscribeToEvents()` is independent. Debugging becomes tractable
only if we can read one handler at a time and understand its full
effect.

### B13a — Remove is distinct from invalidate

Some bus events signal that the underlying entity no longer exists
(`mark:delete-ok`, `mark:removed`). For these, the cache entry
should be **dropped**, not invalidated. Dropping means:

1. Clear the in-flight guard.
2. Delete the entry from the store (via copy-on-write; A3).
3. Do NOT re-fetch.

Conventional method name: `remove<Entity>(key)` (not `invalidate`).

This is distinct from B7 (invalidate = SWR): invalidate keeps the
value and refetches; remove drops the value and does not.

Mixing the two was the original sin of the hand-rolled cache —
`invalidateAnnotationDetail` deleted without refetching (which is
the remove semantic) while being named `invalidate` (which suggests
refetch). Consumers that assumed refetch broke; consumers that
assumed removal worked by accident.

### B13b — Update-in-place for entities whose new value is known

Some bus events carry the full new entity in their payload
(`mark:body-updated` with the annotation). For these, the cache
should be updated with the known value directly — no fetch needed.

Conventional method name: `update<Entity>InPlace(key, value)`.

This satisfies B5 (atomic update, no transient `undefined`) and
avoids the roundtrip of an invalidate-triggered refetch. It also
ensures both related caches stay in sync when a handler has reason
to update more than one.

### B13 — Reconnect gap-detection is server-driven, not edge-driven

A bare `connected$: false → true` transition does NOT trigger cache
invalidation. The server stamps every persisted event on
`/bus/subscribe` with `id: p-<scope>-<seq>`; the client sends the
last seen id as `Last-Event-ID` on reconnect; the server replays
persisted events missed during the gap. The usual reconnect path
(mount-churn, scope-change, brief network blip) finishes with
**zero events missed** — no cache invalidation needed.

When the server can't cover the gap — retention window exceeded,
`Last-Event-ID` unparseable, scope mismatch — it emits a
`bus:resume-gap` event. On that event, the cache MUST invalidate:

- If `scope` is provided: every key related to that scope
  (`annotationList[scope]`, `resourceDetail[scope]`,
  `resourceEvents[scope]`, `referencedBy[scope]`) plus the KB-wide
  `entityTypes`.
- If `scope` is omitted: every live key in every cache (the
  pre-resumption blanket behavior).

The `entityTypes` singleton always refetches on any gap because the
resumption protocol currently covers only resource-scoped events.

With B7 (SWR), these invalidations are not destructive — observers
keep seeing their stale data until the refetches return. Only
network work is wasted, not UX.

## Mapping: bus events → cache invalidations

The current subscription table in `BrowseNamespace.subscribeToEvents()`.
Updating this table is an API-impact change; keep it in sync with the
code.

| Bus event | Effect |
|---|---|
| `actor.connected$: false → true` | **no effect** — resumption handles the gap (B13) |
| `bus:resume-gap` | scope-targeted invalidation (if `scope`) or full blanket (if not); always refetch `entityTypes` (B13) |
| `mark:delete-ok` | invalidate `annotationDetail[annotationId]` |
| `mark:added` | invalidate `annotationList[resourceId]`, `resourceEvents[resourceId]` |
| `mark:removed` | invalidate `annotationList[resourceId]`, `resourceEvents[resourceId]`, `annotationDetail[annotationId]` |
| `mark:body-updated` | in-place update `annotationList` entry, invalidate `annotationDetail[annotationId]`, `resourceEvents[resourceId]` |
| `mark:entity-tag-added` | invalidate `annotationList[resourceId]`, `resourceDetail[resourceId]`, `resourceEvents[resourceId]` |
| `mark:entity-tag-removed` | invalidate `annotationList[resourceId]`, `resourceDetail[resourceId]`, `resourceEvents[resourceId]` |
| `replay-window-exceeded` | invalidate `annotationList[resourceId]` |
| `yield:create-ok` | write-through fetch of `resourceDetail[resourceId]`, invalidate `resourceList` (entire) |
| `yield:update-ok` | invalidate `resourceDetail[resourceId]`, invalidate `resourceList` (entire) |
| `mark:archived` | invalidate `resourceDetail[resourceId]`, invalidate `resourceList` (entire) |
| `mark:unarchived` | invalidate `resourceDetail[resourceId]`, invalidate `resourceList` (entire) |
| `mark:entity-type-added` | invalidate `entityTypes` |

Observations from this table:

- **`resourceList` (all filters)** is invalidated by wholesale
  replacement (`resourceList$.next(new Map())`), not key-by-key.
  This is because invalidation events don't know which filter
  combinations would be affected. Trade-off: in-flight filter
  variants are refetched lazily on next observation.
- **No events invalidate `annotationList` by annotation-id alone.**
  The only per-annotation cache is `annotationDetail`; changes to an
  annotation always also invalidate the list that contains it. This
  is B10-consistent.
- **`yield:create-ok` uses write-through fetch**, not invalidate.
  Because the resource is new, there's no prior value to preserve;
  the SWR distinction is moot.

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

`invalidateAnnotationDetail` is currently a naming violation: it
implements B13a (remove) while named `invalidate`. Rename to
`removeAnnotationDetail`. For its `mark:body-updated` caller,
switch to a new `updateAnnotationDetailInPlace` (B13b) — the
event payload contains the full annotation, so a refetch is
wasteful.

`invalidateResourceLists` wholesale-replaces the store with an
empty Map. This violates B7: observers see `undefined` until the
next observation. The fix is per-key SWR: iterate the current
filter keys, clear guards, issue refetches, keep values in the
map until refetches return.

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
`Map<K, Observable<V | undefined>>` memoizes the per-key observable.
Without the memo, every live-query call creates a new observable,
breaking B4.

### A5 — Bus-event subscribers never `unsubscribe`

The subscriptions in `subscribeToEvents()` are created once at
construction and live for the cache's lifetime. There is no
tear-down path. This is correct because the cache's lifetime
matches the client's (see B11), but it means a bug that causes
`subscribeToEvents()` to run twice would double every effect.
The constructor is the only call site; audit that constructor runs
once per `SemiontApiClient`.

## Test-parity

A `CACHE-SEMANTICS.test.ts` in `packages/api-client/src/namespaces/__tests__/`
asserts each of B1–B13 against the current implementation. Adding a
new behavior here must be accompanied by a new test case referencing
its number (`// B7 — invalidate preserves stale value`). Removing or
changing a behavior must update both this doc and the test.

## Revision log

- 2026-04-19 — initial spec, written as part of CACHE-LIBRARY.md
  Phase 1. Documents behavior as it exists after the
  `invalidateResourceDetail` SWR fix (test 04).
