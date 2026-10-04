# Match

Match searches the knowledge base for what a reference could refer to, and ranks the candidates. It is one of the three reading verbs, with [Browse](BROWSE.md) and [Gather](GATHER.md). It changes nothing: attaching the chosen resource is [Bind](BIND.md).

## Operations

| SDK method | Returns | On the wire | Answered by |
|---|---|---|---|
| `match.search` | a stream that gives the ranked candidates | `match:search-requested` | the librarian |

`match.search` takes the reference and the context [Gather](GATHER.md) assembled around it. Its options are a limit on the number of candidates, and whether a model re-ranks them.

The reply is `match:search-results`, or `match:search-failed`. Each candidate carries a score and a `matchReason` naming the signals that produced it.

## How candidates are found and ranked

Candidates come from three sources, and are deduplicated:

1. **By name**: the reference's text against each resource's name, its location and its entity types.
2. **By entity type**: resources that share entity types with the reference.
3. **By neighborhood**: resources already connected to the source resource in the graph.

Each candidate is scored on structural signals: entity types in common (rare types count for more), how well its name matches, whether it is already connected to the source and in which directions, how often it is cited, how recent it is, and how many of the three sources found it.

With semantic scoring on, a model then scores the top candidates against the passage. If the model fails, the structural ranking stands.

Scores are sums of points, not probabilities. They order candidates; they are not bounded at one. The weights are the Matcher's and can change: see [packages/make-meaning/src/matcher.ts](../../../packages/make-meaning/src/matcher.ts).

## Rules

**Match reads only.** It records nothing and binds nothing.

**The context is the query.** The search is driven by the gathered context it is given: the passage, the entity types and the graph around it.

**A model is optional.** A search works with no inference provider, on the structural signals alone.

## Example

```typescript
semiont.match.search(resourceId, referenceId, gatheredContext, {
  limit: 10,
  useSemanticScoring: true,
}).subscribe({
  next: (result) => console.log('Candidates:', result.response),
});
```

From the launcher: `semiont match <resourceId> <annotationId>`.

## Local signals

`match.requestSearch` publishes `match:search-requested` on the client's own bus, for one viewer's interface to ask its own state to search.

## Where it is implemented

- The SDK namespace: [packages/sdk/src/namespaces/match.ts](../../../packages/sdk/src/namespaces/match.ts)
- The Matcher: [packages/make-meaning/src/matcher.ts](../../../packages/make-meaning/src/matcher.ts)
- The launcher verb: [apps/launcher/internal/verbs/match.go](../../../apps/launcher/internal/verbs/match.go)
- The channels and their payloads: [specs/src/bus/registry.json](../../../specs/src/bus/registry.json)
