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

The librarian answers two more requests on the wire. `gather:summary-requested` names an annotation and its resource, and is answered with [a model's summary of the annotation](../LIBRARIAN.md#an-annotations-summary); no SDK method asks it. `gather:limits-requested` is answered with the [limits](../LIBRARIAN.md#limits) of the model Gather uses; `browse.agents` asks it.

## The gathered context

`gather.annotation` and `gather.resource` give a `GatheredContext`:

| Part | Holds |
|---|---|
| `focus` | What the context is about. For an annotation: the annotation, its resource, and the selected text with what comes before and after it. For a resource: the resource |
| `graph` | The neighborhood as a graph: resources and annotations as nodes, typed and directed edges between them |
| `metadata` | The language and the kind of resource. For an annotation, also its entity types and how common each entity type is across the knowledge base |
| `semanticContext` | Passages elsewhere that are semantically similar, when the vector index has them |
| `inferredRelationshipSummary` | For an annotation, a sentence or two from a model on how the passage relates to its neighborhood |

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

**The optional parts are optional.** The relationship summary, and a resource's summary, are absent when the model fails or there is no text to give it. With no vectors for a passage there is no semantic context. A gathered context is complete without them.

**Gather waits for what was just written, briefly.** A resource that was only just written may not be in the graph or the vector index yet. Gather waits for the graph, within a bound, and fails if the graph does not catch up. A gather around a resource also waits for the vector index to settle, within a bound, and gives the context without `semanticContext` if it does not. See [The two waits](../LIBRARIAN.md#the-two-waits).

**The context is independently useful.** [Match](MATCH.md) searches with it and [Yield](YIELD.md) generates from it, and nothing ties it to either.

## Options

`gather.annotation` takes the size of the window of surrounding text: how much on each side of the annotation, counted in Unicode code points, 2,000 when none is stated. It also takes whether to include the text of the annotation's source (`includeSourceContext`) and of the resource it links to (`includeTargetContext`). Each is sent only when stated, `false` as well as `true`: see [Gathering around an annotation](../LIBRARIAN.md#gathering-around-an-annotation).

`gather.resource` takes how many resources to take, whether to include their text, whether to ask a model for a summary, and entity types to leave out. It also takes `depth`, 1 to 3: how many links out from the resource the graph reaches, following both what a resource links to and what cites it. The SDKs send 2 when none is stated. A depth of 1 is the resource's own neighborhood; each further link out adds the resources those link to and are cited by, nearest first, as resource nodes joined by `link` edges. Beyond the first link out the graph takes no more resources once it holds 200, and states `truncated` when it left one out. The resources whose text is read, up to `maxResources`, are the nearest. See [The knowledge graph](../LIBRARIAN.md#the-knowledge-graph).

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
for (const ref of references) console.log(`${ref.resourceName ?? ref.target.source}: "${ref.target.selector.exact}"`);
```

From the launcher: `semiont gather <resourceId>` for a resource, and `semiont gather <resourceId> <annotationId>` for an annotation.

## Where it is implemented

- The SDK namespace: [packages/typescript/sdk/src/namespaces/gather.ts](../../../packages/typescript/sdk/src/namespaces/gather.ts)
- The Gatherer, in the Librarian: [annotation_gather.py](../../../images/librarian/src/semiont_librarian/annotation_gather.py) and [resource_gather.py](../../../images/librarian/src/semiont_librarian/resource_gather.py)
- What refers to a resource: [referenced_by.py](../../../images/librarian/src/semiont_librarian/referenced_by.py)
- The launcher verb: [packages/go/launcher/verbs/gather.go](../../../packages/go/launcher/verbs/gather.go)
- The channels and their payloads: [specs/src/bus/registry.json](../../../specs/src/bus/registry.json)
