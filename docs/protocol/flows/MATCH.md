# Match

Match searches the knowledge base: for what a reference could refer to, ranking the candidates, and for resources by text. It is one of the three reading verbs, with [Browse](BROWSE.md) and [Gather](GATHER.md). It changes nothing: attaching the chosen resource is [Bind](BIND.md).

## Operations

| SDK method | Returns | On the wire | Answered by |
|---|---|---|---|
| `match.search` | a stream that gives the ranked candidates | `match:search-requested` | the librarian |
| `match.resources` | a live query that gives a page of the resources a text finds, with the total: `limit` resources (a hundred when none is stated) after the first `offset` (none when none is stated) | `match:resources-requested` | the librarian |

`match.search` takes the reference and the context [Gather](GATHER.md) assembled around it. Its options are a limit on the number of candidates, and whether a model re-ranks them.

The reply is `match:search-results`, or `match:search-failed`. Each candidate carries a score and a `matchReason` naming the signals that produced it.

`match.resources` takes the text to search for. Its filters are an entity type, whether the resources are archived, and a limit on the page. On the wire the request may also carry an `offset`; the SDK asks for the first page. It is kept current as a [live query](../CACHE-SEMANTICS.md) is.

The reply is `match:resources-result`, or `match:resources-failed`. It carries the page of resources, the `total` of everything the text found, and a `matchKind`.

The librarian also answers `match:limits-requested`, with the [limits](../LIBRARIAN.md#limits) of the model that scores candidates. `browse.agents` asks it.

## How candidates are found and ranked

Candidates come from four sources, and are deduplicated. The resource the reference is on is never one of them.

1. **By name**: the reference's text against each resource's name, its location and its entity types.
2. **By entity type**: resources that share entity types with the reference.
3. **By neighborhood**: resources already connected to the source resource in the graph.
4. **By meaning**: resources the vector index finds close to the reference's text.

Each candidate is scored on structural signals: entity types in common (rare types count for more), how well its name matches, whether it is already connected to the source and in which directions, how recent it is, how close the vector index found it, and how many of the sources found it.

With semantic scoring on, a model then scores the twenty candidates that rank highest on those signals against the passage. If the model fails, the structural ranking stands.

Scores are sums of points, not probabilities. They order candidates; they are not bounded at one. The weights are the librarian's: see [The score](../LIBRARIAN.md#the-score).

## How resources are found by text

The text is matched first against each resource's name, its location and its entity types, and the resources that match are ordered by how directly the name answers and then by how recent they are. The reply's `matchKind` is `lexical`.

When nothing matches by text, the answer is the resources that discuss the query, found through the vector index, and `matchKind` is `semantic`. The filters hold there too: a search kept to an entity type finds only resources of that type, and a search for archived resources is answered by text alone, since archived resources are not in the vector index.

A limit below 1 is refused, for either search.

## Rules

**Match reads only.** It records nothing and binds nothing.

**For a reference, the context is the query.** `match.search` is driven by the gathered context it is given: the passage, the entity types and the graph around it.

**The model's scoring can be turned off.** With `useSemanticScoring: false`, `match.search` ranks on the structural signals alone. A librarian is given a model for it all the same: see [Settings](../LIBRARIAN.md#settings). `match.resources` calls no model.

**A text search says what kind of answer it gives.** Every `match.resources` reply carries `matchKind`, so resources that discuss the query are never taken for resources the text matched.

**Match is retrieval.** It answers from the graph and the vector index. Listing the resources with no text to search for is [Browse](BROWSE.md), which answers from the record.

## Example

```typescript
semiont.match.search(resourceId, referenceId, gatheredContext, {
  limit: 10,
  useSemanticScoring: true,
}).subscribe({
  next: (result) => console.log('Candidates:', result.response),
});

// Resources by text
const found = await semiont.match.resources('Paris', { entityType: 'Location', limit: 20 }).fresh();
console.log(found.matchKind, found.resources.map((r) => r.name));
```

From the launcher: `semiont match <resourceId> <annotationId>` for a reference's candidates, and `semiont match --search <text>` for resources by text.

## Local signals

`match.requestSearch` publishes `match:search-requested` on the client's own bus, for one viewer's interface to ask its own state to search.

## Where it is implemented

- The SDK namespace: [packages/typescript/sdk/src/namespaces/match.ts](../../../packages/typescript/sdk/src/namespaces/match.ts)
- The Matcher, in the Librarian: [reference_search.py](../../../images/librarian/src/semiont_librarian/reference_search.py)
- The search for resources by text: [text_search.py](../../../images/librarian/src/semiont_librarian/text_search.py)
- The launcher verb: [packages/go/launcher/verbs/match.go](../../../packages/go/launcher/verbs/match.go)
- The channels and their payloads: [specs/src/bus/registry.json](../../../specs/src/bus/registry.json)
