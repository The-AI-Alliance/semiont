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

Events are published to consumers using a fire-and-forget pattern (`event-sourcing/src/subscriptions/event-subscriptions.ts:105`):

```typescript
Promise.resolve(callback(event))  // No await - non-blocking
```

This means:
- Event processing is **non-blocking**
- Multiple events can process **in parallel**
- There is **no guarantee of cross-resource ordering**

### Per-Resource Sequential Processing

The GraphDBConsumer (`apps/backend/src/events/consumers/graph-consumer.ts`) processes events:

```typescript
// Sequential processing PER resource
const previousProcessing = this.processing.get(resourceId);
if (previousProcessing) {
  await previousProcessing;  // Wait for previous event on SAME resource
}
```

**Key insight**: Events for the **same resource** are sequential, but events for **different resources** process in parallel.

## The Race Condition Problem

### Scenario: Creating and Linking Resources

When creating a new resource and immediately linking it via annotation:

1. Frontend creates new resource → `resource.created` event (Resource B)
2. Frontend updates annotation → `annotation.body.updated` event (Resource A)
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
    r.dateCreated = $dateCreated,
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
- Stub enriched when `resource.created` arrives
- Idempotent (MERGE finds existing edge)

## How It Works: Two Scenarios

### Scenario 1: Edge Created First (Race Condition)

1. `annotation.body.updated` processes first
2. MERGE creates stub Resource node `{id: "xyz", stub: true}`
3. MERGE creates REFERENCES edge
4. `resource.created` processes later
5. MERGE finds existing stub, SET enriches it `{id: "xyz", name: "...", stub: false}`
6. **Final state**: Complete Resource node + REFERENCES edge ✓

### Scenario 2: Resource Created First (Normal Order)

1. `resource.created` processes first
2. MERGE creates full Resource node `{id: "xyz", name: "...", stub: false}`
3. `annotation.body.updated` processes later
4. MERGE finds existing Resource node (not a stub)
5. MERGE creates REFERENCES edge
6. **Final state**: Complete Resource node + REFERENCES edge ✓

**Both scenarios produce identical final state** - order independent!

## Idempotence Guarantees

Running events multiple times produces the same result:

| Event | Runs | Result |
|-------|------|--------|
| `resource.created` | 1x | Full node created |
| `resource.created` | 2x | SET overwrites with same values (idempotent) |
| `annotation.body.updated` | 1x | Edge + stub created |
| `annotation.body.updated` | 2x | MERGE finds existing edge (idempotent) |
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
- Missing `resource.created` event (bug in event emission)
- Event processing failure
- Consumer crashed before processing

### Automatic Detection

Add monitoring to alert if stub count exceeds threshold:

```typescript
const stubCount = await session.run(
  'MATCH (r:Resource {stub: true}) RETURN count(r) AS count'
);

if (stubCount > 10) {
  console.warn('[Graph] Orphaned stub nodes detected - may indicate missing events');
}
```

## Implementation Details

### File: `packages/graph/src/implementations/neo4j.ts`

**createResource() - Lines ~185-227**:
```typescript
async createResource(resource: ResourceDescriptor): Promise<void> {
  // MERGE instead of CREATE - idempotent and enriches stub nodes
  await session.run(
    `MERGE (r:Resource {id: $id})
     SET r.name = $name,
         r.stub = false
         // ... other properties
     RETURN r`,
    { id, name, /* ... */ }
  );
}
```

**updateAnnotation() - Lines ~544-568**:
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
- If `resource.created` never arrives (bug), stub persists
- Relies on rebuild to detect/fix orphaned stubs

## Rebuild Operations

The graph can be rebuilt from events to fix any inconsistencies:

### Single Resource Rebuild

```typescript
import { getGraphConsumer } from '@semiont/graph';

const consumer = await getGraphConsumer(config);
await consumer.rebuildResource('resource-id-123');
```

### Full Graph Rebuild

Uses two-pass approach to ensure nodes before edges:

```typescript
await consumer.rebuildAll();
```

**Process**:
1. **Pass 1**: Create all nodes (skip `annotation.body.updated`)
2. **Pass 2**: Create all edges (process only `annotation.body.updated`)

This guarantees all resource nodes exist before any REFERENCES edges are created.

## Related Frontend Cache Issue

The backend eventual consistency fix solved the graph race condition, but revealed a **frontend caching issue**.

**Problem**: React Query served stale `referencedBy` data because the cache wasn't invalidated when annotation bodies were updated.

**Solution**: Invalidate target resource's `referencedBy` cache when links are created.

See `packages/react-ui/src/lib/api-hooks.ts` for implementation details.

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
- [ROBUST-GRAPH.md](../../../ROBUST-GRAPH.md) - Complete design document
