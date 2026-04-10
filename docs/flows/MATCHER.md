# Matcher Flow

**Purpose**: Resolve reference annotations to candidate resources using multi-source retrieval and composite scoring. Given a gathered context, the Matcher searches the knowledge base and ranks candidates by structural signals and optional LLM semantic scoring.

**Related Documentation**:
- [Bind Flow](./BIND.md) - Consumer: triggers search, receives scored results, updates annotation body
- [Gather Flow](./GATHER.md) - Producer: assembles the GatheredContext passed to the Matcher
- [W3C Web Annotation Data Model](../../specs/docs/W3C-WEB-ANNOTATION.md) - Reference annotation and SpecificResource body structure
- [@semiont/make-meaning Architecture](../../packages/make-meaning/docs/architecture.md) - Matcher actor and KnowledgeBase
- [Make-Meaning API Reference](../../packages/make-meaning/docs/api-reference.md) - Matcher methods

## Overview

The Matcher resolves entity mentions to concrete resources. Given a `GatheredContext` — the passage, entity type tags, and graph neighborhood assembled by the Gatherer — the Matcher retrieves candidates from multiple knowledge base sources, scores them using a composite of structural signals (entity type overlap, graph connectivity, citation weight, name match quality, recency), and optionally re-ranks the top candidates via LLM-based semantic scoring. AI agents retrieve and rank candidates, performing coreference resolution and grounding; human collaborators review the ranked list and select the correct match. Hallucination — binding to a nonexistent or incorrect referent — is the primary failure mode and the reason human review of low-confidence results is important.

The Matcher handles only the read side of resolution. Writing the chosen link (adding a `SpecificResource` body item to the annotation) is done by the Bind flow via `client.updateAnnotationBody`.

## Using the API Client

**Via the SSE Matcher endpoint** — preferred for full composite scoring:

```typescript
import { SemiontApiClient, resourceId, annotationId } from '@semiont/api-client';
import { EventBus } from '@semiont/core';

const client = new SemiontApiClient({ baseUrl: 'http://localhost:4000' });

// Gather context first (see Gather flow)
const { context } = await client.getAnnotationLLMContext(rId, annId, { contextWindow: 2000 });

const eventBus = new EventBus();

const results = await new Promise<any[]>((resolve, reject) => {
  eventBus.get('bind:search-results').subscribe(e => resolve(e.results));
  eventBus.get('bind:search-failed').subscribe(({ error }) => reject(error));

  client.sse.bindSearch(rId, {
    referenceId: annotation.id,
    context,
    limit: 10,
    useSemanticScoring: true,
  }, {
    auth: client.accessToken,
    eventBus,
  });
});

eventBus.destroy();

// results are sorted by score descending; each has .score and .matchReason
const top = results[0];
console.log(`Best match: ${top?.name} (score ${top?.score}, reason: ${top?.matchReason})`);
```

**Via the api-client namespace** — Observable with scored results:

```typescript
semiont.match.search(resourceId, referenceId, gatheredContext, {
  limit: 10,
  useSemanticScoring: true,
}).subscribe((result) => {
  console.log('Results:', result.response);
});
```

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `bind:search-requested` | `{ referenceId, context: GatheredContext, limit?, useSemanticScoring?, correlationId }` | Trigger a Matcher search |
| `bind:search-results` | `{ referenceId, results, correlationId }` | Scored, sorted candidate list from the Matcher |
| `bind:search-failed` | `{ referenceId, error, correlationId }` | Search failed |
| `bind:referenced-by-requested` | `{ correlationId, resourceId, motivation? }` | Query which annotations reference a given resource |
| `bind:referenced-by-result` | `{ correlationId, response }` | Referenced-by results |

## Candidate Retrieval

The Matcher retrieves candidates in parallel from three sources, then deduplicates by resource ID:

1. **Name match** — `graph.searchResources(searchTerm)` — text search against resource names
2. **Entity type filter** — `graph.listResources({ entityTypes })` — resources sharing entity types with the annotation
3. **Graph neighborhood** — resources connected to the source resource, from `context.graphContext.connections`

Candidates found by more than one source receive a multi-source bonus at scoring time.

## Scoring

Each candidate receives a composite score:

| Signal | Max Points | Condition |
|--------|-----------|-----------|
| Entity type overlap (Jaccard + IDF weighting) | ~35 | Annotation and candidate share entity types; rare types weighted higher |
| Exact name match | 25 | `candidate.name === searchTerm` (case-insensitive) |
| Bidirectional graph connection | 20 | Already connected both ways (strong prior) |
| Prefix name match | 15 | `candidate.name.startsWith(searchTerm)` |
| Single graph connection | 10 | Candidate is in the source resource's neighborhood |
| Contains name match | 10 | `candidate.name.includes(searchTerm)` |
| Citation weight | up to 15 | Well-cited neighborhood candidates score higher |
| Multi-source bonus | 3 per source | Found by more than one retrieval path |
| Recency | up to 5 | Resources created in the last 30 days |

The `matchReason` field on each result lists the signals that contributed to the score (e.g. `"entity types: Person; bidirectional connection; exact name match"`).

## Inference Scoring (Optional)

When an `InferenceClient` is available and `useSemanticScoring` is not `false`, the Matcher batch-scores the top 20 structural candidates via LLM:

- The LLM receives the passage text, entity types, graph connections, and candidate names
- Returns a 0–1 relevance score per candidate
- Scores above 0.5 add `"semantic match"` to the candidate's `matchReason`
- Adds up to 25 points to the composite score
- Gracefully degrades to structural scores if inference fails

This is GraphRAG-style re-ranking: structural retrieval narrows the candidate set, LLM scoring refines the ranking.

## Referenced-By Queries

The Matcher also handles reverse-lookup: given a resource, which annotations reference it?

```typescript
// Via api-client namespace
const referencedBy = await firstValueFrom(semiont.browse.referencedBy(resourceId));

// Or via EventBus directly
eventBus.get('bind:referenced-by-requested').next({
  correlationId: crypto.randomUUID(),
  resourceId: rId,
  motivation: 'linking',
});
// Listen for bind:referenced-by-result
```

Each result includes the annotation ID, source resource name, and the exact text of the annotation target.

## Search in the Bind Wizard

In the UI, Matcher search runs inside the Reference Resolution Wizard:

```
User clicks 🕸️🧙 wizard button on unresolved reference
    |
Gatherer assembles GatheredContext (runs in parallel with wizard render)
    |
gather:complete → Wizard Step 1 shows context preview
    |
User clicks "Bind" → Configure Search (Step 2A)
    |
User submits → bind:search-requested fires with { context, limit, useSemanticScoring }
    |
Matcher retrieves candidates, scores, optionally re-ranks via LLM
    |
bind:search-results → Wizard Step 3A shows ranked candidates
    |
User clicks "Link" → bind:update-body → annotation body updated
```

## Score Interpretation

The Matcher's composite scores are not bounded at 1.0 — they are additive point totals. Rough interpretation:

| Score | Meaning |
|-------|---------|
| ≥ 50 | Strong match — exact name + entity type overlap + graph connection |
| 25–49 | Good match — name match or strong entity type overlap |
| 10–24 | Weak match — partial signals only |
| < 10 | Poor match — incidental overlap; consider generating a new resource |

When `useSemanticScoring: true`, scores in the 25–49 range may shift significantly (±25 pts).

## Implementation

- **Matcher actor**: [packages/make-meaning/src/matcher.ts](../../packages/make-meaning/src/matcher.ts) — retrieval, structural scoring, inference re-ranking, referenced-by
- **SSE route**: [apps/backend/src/routes/resources/routes/bind-search-stream.ts](../../apps/backend/src/routes/resources/routes/bind-search-stream.ts) — bridges HTTP to EventBus
- **API client**: `client.sse.bindSearch` and `client.searchResources` in [@semiont/api-client](../../packages/api-client/README.md)
- **Hook**: [packages/react-ui/src/hooks/useBindFlow.ts](../../packages/react-ui/src/hooks/useBindFlow.ts) — UI integration
- **Event definitions**: [packages/core/src/bus-protocol.ts](../../packages/core/src/bus-protocol.ts) — `MATCH FLOW` section
