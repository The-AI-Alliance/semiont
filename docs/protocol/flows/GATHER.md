# Gather

Gather assembles context: the passage, what surrounds it, and what the knowledge base knows about its neighborhood. The result is what a model is given to work from, and what a person is shown before deciding. It is one of the three reading verbs, with [Browse](BROWSE.md) and [Match](MATCH.md).

Gather also lists what refers to a resource: the references elsewhere that are bound to it.

Gather adds no knowledge. It finds and assembles what is already there.

## Operations

| SDK method | Returns | On the wire | Answered by |
|---|---|---|---|
| `gather.annotation` | a stream that gives the context around one annotation | `gather:requested` | the librarian |
| `gather.resource` | the context around a whole resource | `gather:resource-requested` | the librarian |
| `gather.referencedBy` | a live query that gives the annotations elsewhere that refer to a resource | `gather:referenced-by-requested` | the librarian |

The replies are `gather:complete`, `gather:resource-complete` and `gather:referenced-by-result`, or their `-failed` counterparts.

## The gathered context

`gather.annotation` and `gather.resource` give a `GatheredContext`:

| Part | Holds |
|---|---|
| `focus` | What the context is about. For an annotation: the annotation, its resource, and the selected text with what comes before and after it. For a resource: the resource |
| `graph` | The neighborhood as a graph: resources and annotations as nodes, typed and directed edges between them |
| `metadata` | The entity types in play and how common each is across the knowledge base, the language, the kind of resource |
| `semanticContext` | Passages elsewhere that are semantically similar, when the vector index has them |
| `inferredRelationshipSummary` | A sentence or two from a model on how the passage relates to its neighborhood, when a model is configured |

The lists a consumer usually wants (connected resources, what cites the source, sibling entity types) are derived from `graph` rather than stored beside it.

`focus.kind` says which of the two it is, and what [Yield](YIELD.md) does with a context depends on it.

## What refers to a resource

`gather.referencedBy` gives one entry for each reference bound to the resource, read from the graph:

| Part | Holds |
|---|---|
| `id` | The annotation |
| `resourceName` | The name of the resource the annotation is on |
| `target.source` | The resource the annotation is on |
| `target.selector.exact` | The text the annotation covers |

On the wire the request names the resource, and may name a `motivation` to keep to annotations of that kind. It is kept current as a [live query](../CACHE-SEMANTICS.md) is.

## Rules

**Gather reads only.** It records nothing.

**Every excerpt is attributable.** Each passage in a context is tied to the resource, and where it applies the annotation, it came from. That is what lets a generation cite its sources.

**The optional parts are optional.** With no model configured there is no summary. With no vectors for a passage there is no semantic context. A gathered context is complete without them.

**Gather waits for the index, briefly.** A resource that was only just written may not be in the vector index yet. Gather waits for it to settle, within a bound, and gives the context without `semanticContext` if it does not.

**The context is independently useful.** [Match](MATCH.md) searches with it and [Yield](YIELD.md) generates from it, and nothing ties it to either.

## Options

`gather.annotation` takes the size of the window of surrounding text: how much on each side of the annotation, counted in Unicode code points. `gather.resource` takes how many links deep to follow, how many resources to take, and entity types to leave out.

## Example

```typescript
// Around one annotation
semiont.gather.annotation(resourceId, annotationId, { contextWindow: 2000 }).subscribe({
  next: (complete) => console.log('Context:', complete.response),
});

// Around a whole resource
const context = await semiont.gather.resource(resourceId, {
  depth: 2,
  maxResources: 10,
  excludeEntityTypes: ['Draft'],
});

// What refers to a resource
const references = await semiont.gather.referencedBy(resourceId).fresh();
for (const ref of references) console.log(`${ref.resourceName}: "${ref.target.selector.exact}"`);
```

From the launcher: `semiont gather <resourceId>` for a resource, and `semiont gather <resourceId> <annotationId>` for an annotation.

## Where it is implemented

- The SDK namespace: [packages/sdk/src/namespaces/gather.ts](../../../packages/sdk/src/namespaces/gather.ts)
- The Gatherer: [packages/make-meaning/src/gatherer.ts](../../../packages/make-meaning/src/gatherer.ts)
- What refers to a resource: [packages/make-meaning/src/referenced-by.ts](../../../packages/make-meaning/src/referenced-by.ts)
- The launcher verb: [apps/launcher/internal/verbs/gather.go](../../../apps/launcher/internal/verbs/gather.go)
- The channels and their payloads: [specs/src/bus/registry.json](../../../specs/src/bus/registry.json)
