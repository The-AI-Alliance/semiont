# Gather

Gather assembles context: the passage, what surrounds it, and what the knowledge base knows about its neighborhood. The result is what a model is given to work from, and what a person is shown before deciding. It is one of the three reading verbs, with [Browse](BROWSE.md) and [Match](MATCH.md).

Gather adds no knowledge. It finds and assembles what is already there.

## Operations

| SDK method | Returns | On the wire | Answered by |
|---|---|---|---|
| `gather.annotation` | a stream that gives the context around one annotation | `gather:requested` | the librarian |
| `gather.resource` | the context around a whole resource | `gather:resource-requested` | the librarian |

The replies are `gather:complete` and `gather:resource-complete`, or their `-failed` counterparts.

## The gathered context

Both operations give a `GatheredContext`:

| Part | Holds |
|---|---|
| `focus` | What the context is about. For an annotation: the annotation, its resource, and the selected text with what comes before and after it. For a resource: the resource |
| `graph` | The neighborhood as a graph: resources and annotations as nodes, typed and directed edges between them |
| `metadata` | The entity types in play and how common each is across the knowledge base, the language, the kind of resource |
| `semanticContext` | Passages elsewhere that are semantically similar, when the vector index has them |
| `inferredRelationshipSummary` | A sentence or two from a model on how the passage relates to its neighborhood, when a model is configured |

The lists a consumer usually wants (connected resources, what cites the source, sibling entity types) are derived from `graph` rather than stored beside it.

`focus.kind` says which of the two it is, and what [Yield](YIELD.md) does with a context depends on it.

## Rules

**Gather reads only.** It records nothing.

**Every excerpt is attributable.** Each passage in a context is tied to the resource, and where it applies the annotation, it came from. That is what lets a generation cite its sources.

**The optional parts are optional.** With no model configured there is no summary. With no vectors for a passage there is no semantic context. A gathered context is complete without them.

**Gather waits for the index, briefly.** A resource that was only just written may not be in the vector index yet. Gather waits for it to settle, within a bound, and gives the context without `semanticContext` if it does not.

**The context is independently useful.** [Match](MATCH.md) searches with it and [Yield](YIELD.md) generates from it, and nothing ties it to either.

## Options

`gather.annotation` takes the size of the window of surrounding text. `gather.resource` takes how many links deep to follow, how many resources to take, and entity types to leave out.

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
```

From the launcher: `semiont gather <resourceId>` for a resource, and `semiont gather <resourceId> <annotationId>` for an annotation.

## Where it is implemented

- The SDK namespace: [packages/sdk/src/namespaces/gather.ts](../../../packages/sdk/src/namespaces/gather.ts)
- The Gatherer: [packages/make-meaning/src/gatherer.ts](../../../packages/make-meaning/src/gatherer.ts)
- The launcher verb: [apps/launcher/internal/verbs/gather.go](../../../apps/launcher/internal/verbs/gather.go)
- The channels and their payloads: [specs/src/bus/registry.json](../../../specs/src/bus/registry.json)
