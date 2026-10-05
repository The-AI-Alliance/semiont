# Graph Architecture

What the graph is for, what it holds, and how it stays right when events reach it in no fixed order. How to make a store and query it is the [API reference](API.md). The contract every store implements is [`src/interface.ts`](../src/interface.ts).

## A projection, never the record

The graph is derived from a knowledge base's record. Everything in it can be made again from the events, and nothing in it is the source of truth.

One process writes it: the Weaver, in [`@semiont/make-meaning`](../../make-meaning/docs/architecture.md#weaver-projection-pipeline-standalone-process), which applies the record's events to the graph. Every other user of this package reads.

The graph answers what crosses documents:

- what refers to a resource, and what a resource is connected to;
- resources by name, by path or by entity type;
- the candidates the Matcher finds for a reference;
- the neighbourhood of a resource that a gathered context includes.

It is not asked for anything about a single document. A resource, its annotations, their history, and every write are served from the record and its views.

## What the graph holds

| Vertex | |
|---|---|
| `Resource` | A resource's description: its name, entity types, format, storage URI, and whether it is archived |
| `Annotation` | An annotation. In Neo4j it also carries a label for its motivation (`:Linking`, for one), so a query by motivation is a label match |
| `EntityType` | One per entity type in use |
| `TagCollection` | The knowledge base's entity-type vocabulary |

| Edge | From, to |
|---|---|
| `BELONGS_TO` | An annotation, to the resource it annotates |
| `REFERENCES` | An annotation, to the resource it links to, once the reference is resolved |
| `TAGGED_AS` | An annotation, to each of its entity types |

The graph is not a copy of the views. It stores what its queries need and no more: an annotation's attribution, for one, is on almost every annotation in the record and is not written here. So whether the graph is right cannot be checked by comparing it with a view. `intendedGraphAnnotation(annotation)` in [`src/annotation-codec.ts`](../src/annotation-codec.ts) is the statement of what the graph should hold for an annotation, and is what a check compares against.

## Writes that take any order

The Weaver applies one resource's events in order, and the events of different resources side by side. A person who creates a resource and links an annotation to it produces two events, on two resources. The link can reach the graph before the resource it points at.

The Neo4j store is written so that this does not matter. A link makes its target if the target is not there, and marks it a stub:

```cypher
MATCH (a:Annotation {id: $annotationId})
MERGE (target:Resource {id: $targetResourceId})
ON CREATE SET target.stub = true
MERGE (a)-[:REFERENCES]->(target)
```

Creating a resource fills in whatever is there, stub or nothing:

```cypher
MERGE (d:Resource {id: $id})
SET d.name = $name, d.entityTypes = $entityTypes, d.stub = false
```

Whichever event is applied first, the graph ends the same: a whole resource, and an edge to it. Applying either event again changes nothing. A listing of resources leaves stubs out, so a resource is not seen before its own event has been applied.

A stub lasts as long as it takes to apply the other event. One that stays means an event was not applied:

```cypher
MATCH (r:Resource) WHERE r.stub = true RETURN r.id
```

**This is the Neo4j store's design, and only its.** The in-memory store keeps a link as part of the annotation, so it has no target to wait for. The Neptune and JanusGraph stores add the edge to a resource vertex that must already be there. They make no stub, and no test applies events to them out of order.

## When the graph is behind, or away

A stack needs a graph: the Weaver, the Archivist and the Librarian each connect to it when they start. While it is running:

- **Behind.** A read of one resource by id that misses in the graph is answered from the view, which is ahead of it. A gathered context waits for the Weaver to have applied what it needs, up to a bound, and is assembled without its graph neighbourhood past that bound.
- **Away.** Writes and reads of a single document carry on, since they do not touch the graph. Queries only the graph can answer fail.

Nothing is lost either way, because the record is elsewhere. When the Weaver starts it catches up from where it had got to. To rebuild from nothing, the `weave:rebuild` command tells a running Weaver to clear the graph and replay the record:

```bash
npm run rebuild-graph --workspace=@semiont/make-meaning                   # everything
npm run rebuild-graph --workspace=@semiont/make-meaning -- <resourceId>   # one resource
```

How the Weaver orders, batches and checkpoints its work is in [`@semiont/make-meaning`'s architecture](../../make-meaning/docs/architecture.md#weaver-projection-pipeline-standalone-process).
