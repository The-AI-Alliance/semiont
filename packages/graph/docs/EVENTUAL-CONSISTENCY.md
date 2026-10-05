# Eventual Consistency in Graph Projections

## Overview

The graph database is an **eventually consistent read-only projection** of the Event Store. This document explains how the graph handles concurrent events, race conditions, and achieves order-independent, idempotent operations.

## Core Principles

1. **Events are the source of truth** - The graph is derived from events
2. **Projections can be rebuilt** from events at any time
3. **Operations are idempotent** - Applying the same event twice yields the same result
4. **Order independence** - Events can arrive and process in any order (with reasonable constraints)
5. **Temporary inconsistency is acceptable** - Eventual consistency is the goal

## Event Processing Architecture

### Fire-and-Forget Publication

After appending to the log, the event store publishes each event to the Core EventBus (`packages/event-sourcing/src/event-store.ts`):

```typescript
const envelope = { correlationId: options?.correlationId };
this.coreEventBus.emit(publishEvent.type, publishEvent, envelope);

if (resourceId !== SYSTEM_SCOPE) {
  this.coreEventBus.scope(resourceId).emit(publishEvent.type, publishEvent, envelope);
}
```

The bus is an RxJS subject per event type — publication is fire-and-forget from the store's perspective. `emit` is typed by its channel, so subscribers see `EventMap[K]` rather than a widened `StoredEvent`. This means:
- Event processing is **non-blocking** for the writer
- Multiple events can process **in parallel**
- There is **no guarantee of cross-resource ordering**

### Per-Resource Sequential Processing

The Weaver (`packages/make-meaning/src/weaver.ts`) is handed one event stream, which `weaverFanIn` (`packages/make-meaning/src/weaver-fan-in.ts`) merges from the 9 graph-relevant channels (`yield:created`, `mark:added`, etc.). No other event reaches the pipeline.

Relevant events are piped through an RxJS pipeline with adaptive burst buffering:

```typescript
eventSubject.pipe(
  groupBy(se => se.resourceId ?? SYSTEM_SCOPE),         // One stream per resource
  mergeMap(group => group.pipe(                         // Cross-resource parallelism
    burstBuffer({ burstWindowMs: 50, maxBatchSize: 500, idleTimeoutMs: 200 }),
    concatMap(eventOrBatch => /* process sequentially */)  // Per-resource ordering
  ))
)
```

The `burstBuffer` operator passes the first event through immediately (zero latency for interactive use), then batches subsequent events during bursts. Batched events use bulk graph operations where available (e.g., `batchCreateResources` with Neo4j UNWIND).

**Key insight**: Events for the **same resource** are sequential (`concatMap`), but events for **different resources** process in parallel (`mergeMap` over groups).

## The Race Condition Problem

### Scenario: Creating and Linking Resources

When creating a new resource and immediately linking it via annotation:

1. Browser creates new resource → `yield:created` event (Resource B)
2. Browser updates annotation → `mark:body-updated` event (Resource A)
3. Both events published via fire-and-forget
4. Events process in parallel (different resources)

**Race condition**: Annotation body update may try to create REFERENCES edge before Resource B node exists.

### Traditional Approach (Order-Dependent)

```cypher
MATCH (a:Annotation {id: $annotationId})
MATCH (target:Resource {id: $targetResourceId})  -- FAILS if target doesn't exist
MERGE (a)-[:REFERENCES]->(target)
```

**Problem**: Query matches 0 nodes if target resource hasn't been created yet. Edge creation silently fails.

## The Solution: Order-Independent Operations

Make both node creation and edge creation **idempotent and order-independent** using MERGE semantics.

### Node Creation: MERGE + SET Pattern

**Before** (order-dependent):
```cypher
CREATE (r:Resource {id: $id, name: $name, ...})
```
- Fails if node already exists
- Not idempotent
- Order-dependent

**After** (order-independent):
```cypher
MERGE (r:Resource {id: $id})
SET r.name = $name,
    r.entityTypes = $entityTypes,
    r.archived = $archived,
    r.created = $created,
    r.stub = false
RETURN r
```

**Benefits**:
- Creates node if doesn't exist
- **Enriches existing node** with full properties
- Idempotent (SET overwrites with same values)
- Marks complete nodes with `stub = false`

### Edge Creation: MERGE for Target Node

**Before** (order-dependent):
```cypher
MATCH (a:Annotation {id: $annotationId})
MATCH (target:Resource {id: $targetResourceId})  -- Fails if missing
MERGE (a)-[:REFERENCES]->(target)
```

**After** (order-independent):
```cypher
MATCH (a:Annotation {id: $annotationId})
MERGE (target:Resource {id: $targetResourceId})  -- Creates stub if needed
ON CREATE SET target.stub = true
MERGE (a)-[:REFERENCES]->(target)
```

**Benefits**:
- Creates **stub node** if target doesn't exist yet
- Marks incomplete nodes with `stub = true`
- Stub enriched when `yield:created` arrives
- Idempotent (MERGE finds existing edge)

## How It Works: Two Scenarios

### Scenario 1: Edge Created First (Race Condition)

1. `mark:body-updated` processes first
2. MERGE creates stub Resource node `{id: "xyz", stub: true}`
3. MERGE creates REFERENCES edge
4. `yield:created` processes later
5. MERGE finds existing stub, SET enriches it `{id: "xyz", name: "...", stub: false}`
6. **Final state**: Complete Resource node + REFERENCES edge ✓

### Scenario 2: Resource Created First (Normal Order)

1. `yield:created` processes first
2. MERGE creates full Resource node `{id: "xyz", name: "...", stub: false}`
3. `mark:body-updated` processes later
4. MERGE finds existing Resource node (not a stub)
5. MERGE creates REFERENCES edge
6. **Final state**: Complete Resource node + REFERENCES edge ✓

**Both scenarios produce identical final state** - order independent!

## Idempotence Guarantees

Running events multiple times produces the same result:

| Event | Runs | Result |
|-------|------|--------|
| `yield:created` | 1x | Full node created |
| `yield:created` | 2x | SET overwrites with same values (idempotent) |
| `mark:body-updated` | 1x | Edge + stub created |
| `mark:body-updated` | 2x | MERGE finds existing edge (idempotent) |
| Both | Any order, any count | Same final graph |

## Temporary Inconsistency

**Acceptable temporary states**:
- Stub nodes with only `id` and `stub: true` properties
- Incomplete data during event processing window (milliseconds)

**Final consistency guaranteed**:
- All nodes complete once events processed
- Graph matches event store state
- Can rebuild from events at any time

## Monitoring Stub Nodes

Query to find stub nodes (indicates in-flight or missing events):

```cypher
MATCH (r:Resource)
WHERE r.stub = true
RETURN r.id, r
```

**Stub nodes should be transient**. If they persist, it indicates:
- Missing `yield:created` event (bug in event emission)
- Event processing failure
- Consumer crashed before processing

### Automatic Detection

Add monitoring to alert if stub count exceeds threshold:

```typescript
// A neo4j-driver session.
const session = driver.session();
const result = await session.run(
  'MATCH (r:Resource {stub: true}) RETURN count(r) AS count'
);
const stubCount = result.records[0].get('count').toNumber();

if (stubCount > 10) {
  console.warn('[Graph] Orphaned stub nodes detected - may indicate missing events');
}
```

## Implementation Details

### File: `packages/graph/src/implementations/neo4j.ts`

**createResource()**:
```typescript
async createResource(resource: ResourceDescriptor): Promise<ResourceDescriptor> {
  // MERGE instead of CREATE - idempotent and enriches stub nodes
  await session.run(
    `MERGE (d:Resource {id: $id})
     SET d.name = $name,
         d.stub = false
         // ... other properties
     RETURN d`,
    { id, name, /* ... */ }
  );
}
```

**updateAnnotation()**:
```typescript
// Create REFERENCES edge with stub creation
await session.run(
  `MATCH (a:Annotation {id: $annotationId})
   MERGE (target:Resource {id: $targetResourceId})
   ON CREATE SET target.stub = true
   MERGE (a)-[:REFERENCES]->(target)
   RETURN a, target, target.stub AS wasStub`,
  { annotationId, targetResourceId }
);
```

## Benefits

1. **No blocking/retries** - Events process immediately
2. **No cross-resource coupling** - Each event is independent
3. **Architecturally sound** - Embraces eventual consistency
4. **Simple implementation** - Uses built-in Neo4j semantics
5. **Debuggable** - Stub property tracks incomplete nodes
6. **Idempotent** - Safe to replay events
7. **Order-independent** - Works regardless of arrival order

## Trade-offs

**Pros**:
- True order independence
- Simple implementation
- No retry complexity
- No cross-resource dependency tracking
- Matches event sourcing best practices

**Cons**:
- Temporary incomplete Resource nodes (stub state)
- Queries during inconsistency window see incomplete data
- If `yield:created` never arrives (bug), stub persists
- Relies on rebuild to detect/fix orphaned stubs

## Rebuild Operations

The graph can be rebuilt from events to fix any inconsistencies:

### Single Resource Rebuild

The `Weaver` lives in `@semiont/make-meaning` (`packages/make-meaning/src/weaver.ts`) and runs as its own service (`weaver-main`). It rebuilds on the `weave:rebuild` bus command, which `packages/make-meaning/src/cli/rebuild-graph.ts` sends to a running stack. With a resource id, the command reaches `Weaver.rebuildResource()`:

```bash
npm run rebuild-graph --workspace=@semiont/make-meaning -- resource-id-123
```

### Full Graph Rebuild

Without a resource id, the command reaches `Weaver.rebuildAll()`, which uses a two-pass approach to ensure nodes before edges:

```bash
npm run rebuild-graph --workspace=@semiont/make-meaning
```

**Process**:
1. **Pass 1**: Create all nodes (skip `mark:body-updated`)
2. **Pass 2**: Create all edges (process only `mark:body-updated`)

This guarantees all resource nodes exist before any REFERENCES edges are created.

### Recovery across all derived stores

The graph is one of three derived read models in the Semiont knowledge base. Each is recovered from the record at startup, by the service that owns it:

| Derived store | Startup recovery | Owned by |
|---|---|---|
| Graph (Neo4j) | `Weaver.catchUp()`, from its checkpoint | `@semiont/make-meaning` |
| Vectors (Qdrant) | `Smelter.reconcile()`, against the catalog | `@semiont/make-meaning` |
| Materialized views | `ViewManager.rebuildAll(eventLog)` | `@semiont/event-sourcing` |

Only the views are rebuilt before a request is served: the Archivist awaits `ViewManager.rebuildAll` before it starts answering. The Weaver and the Smelter are separate services that catch up after they start, so the graph and the vectors may trail the event log for a moment. The same correctness argument applies to all three — replaying events 1..N produces the same final state regardless of whether they arrive over time or all at once.

See [`@semiont/event-sourcing`'s STORAGE-LAYOUT.md](../../event-sourcing/docs/STORAGE-LAYOUT.md#ephemerality-and-rebuild) for the views-layer ephemerality model.

## Browser Consistency

The Browser reads `referencedBy` data as a live query of the SDK (`client.browse.referencedBy(resourceId)` in `packages/react-ui/src/features/resource-viewer/state/resource-viewer-page-state-unit.ts`). The SDK caches each answer per resource, and `specs/src/client/refresh.json` says when it asks again: for `referencedBy`, on `bus:resume-gap` only. An open view therefore shows the graph projection as it stood when the query was last asked; a link created afterwards appears the next time it is asked.

## Best Practices

1. **Never write directly to graph** - Always use event-driven updates
2. **Design for idempotence** - Use MERGE + SET patterns
3. **Monitor stub nodes** - Alert on orphaned stubs
4. **Plan for replay** - Events may be processed multiple times
5. **Accept temporary inconsistency** - Eventual consistency is the goal
6. **Use rebuild for recovery** - Fix inconsistencies via event replay

## References

- [Event Sourcing Pattern](https://martinfowler.com/eaaDev/EventSourcing.html)
- [Neo4j MERGE Documentation](https://neo4j.com/docs/cypher-manual/current/clauses/merge/)
- [Eventually Consistent Projections](https://www.eventstore.com/blog/what-is-a-projection)
- [Graph Architecture](./ARCHITECTURE.md)
