---
name: semiont-wiki
description: Run the knowledge enrichment pipeline on a resource using @semiont/sdk — detect entity references, resolve them against the KB, and generate new resources for unresolved ones
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping implement the Semiont knowledge enrichment pipeline using `@semiont/sdk`. This pipeline transforms a document into a connected wiki: it detects entity mentions, links them to existing resources in the knowledge base, and generates new stub resources for anything that isn't there yet.

This skill is the canonical implementation of the **Canonicalize mentions** archetype — it builds **Layer #3 (Canonical Nodes)** of the layered data model. Scattered mentions of the same entity (every "Prometheus" reference, every "U.S.C. § 552" citation, every "the property owner" descriptive reference) get clustered, matched against existing canonical resources, and either bound to the existing one or used to synthesize a new canonical resource. The output is a node in the KB's graph: a resource whose purpose is to *be referred to*. (For aggregate resources whose purpose is to *be read* — Investigations, PlotArcs, DoctrinalTraces — see [`semiont-aggregate`](../semiont-aggregate/SKILL.md) instead.)

The pipeline has five steps:

1. **Mark** — detect entity references (`semiont.mark.assist`)
2. **Gather** — fetch LLM context for each unresolved reference (`semiont.gather.annotation`)
3. **Match** — search the KB using the gathered context (`semiont.match.search`)
4. **Bind** — link the annotation to the best match (`semiont.bind.body`)
5. **Yield** — if no confident match exists, generate a new resource and bind to it (`semiont.yield.fromAnnotation`)

Steps 3-5 run per annotation in a loop. The threshold between "bind to existing" and "generate new" is configurable.

## Prerequisite: declare the entity-type vocabulary

The `entityTypes` parameter you pass to `mark.assist` (Step 1) and the entity types stamped on resources synthesized in Step 5 must already be in the KB's **published entity-type vocabulary** — declared via `semiont.frame.addEntityTypes([...])`. This is normally done once, at corpus ingest, by the [`semiont-ingest`](../semiont-ingest/SKILL.md) skill. Skipping the declaration "works" in the lenient sense (entity-type strings still get stamped on annotations and resources), but `browse.entityTypes()` will then return an accumulated drift instead of a coherent published set, and a stricter backend would reject unknown types. Declare the vocabulary upfront.

If you are running this pipeline on a corpus that wasn't ingested via `semiont-ingest`, declare the vocabulary explicitly before the first `mark.assist` call:

```typescript
await semiont.frame.addEntityTypes(['Location', 'Person', 'Organization', 'Concept']);
```

## Client setup

All steps share one `SemiontClient` constructed via `SemiontClient.signInHttp(...)`. For long-running scripts that may span token expiry, swap in `SemiontSession.signInHttp(...)` — it owns refresh, validation, and storage; the lighter pattern here is right for one-shot work. If you already have an access token (cached from a prior auth, or supplied by an embedding host), use `SemiontClient.fromHttp({ baseUrl, token })` to skip the auth round-trip.

```typescript
import {
  SemiontClient,
  annotationId,
  entityType,
  resourceId,
  type GatheredContext,
} from '@semiont/sdk';

const semiont = await SemiontClient.signInHttp({
  baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
  email: process.env.SEMIONT_USER_EMAIL!,
  password: process.env.SEMIONT_USER_PASSWORD!,
});
```

## Step 1 — Detect entity references (Mark)

`semiont.mark.assist(...)` handles SSE streaming, progress tracking, and timeout (180 s without progress) internally. The returned `StreamObservable` is awaitable directly — `await` resolves with the final progress event.

```typescript
const rId = resourceId('doc-123');

const markProgress = await semiont.mark.assist(rId, 'linking', {
  entityTypes: [entityType('Location'), entityType('Person')],
});
console.log(`Detected ${markProgress.progress?.createdCount ?? 0} references`);
```

## Step 2 — List unresolved references

`semiont.browse.annotations(...)` returns a `CacheObservable` — `await` resolves with the loaded annotation list (skipping the initial `undefined` "loading" state).

```typescript
const annotations = await semiont.browse.annotations(rId);

const unresolved = annotations.filter(
  (ann) => ann.motivation === 'linking' &&
           !ann.body?.some((b) => b.type === 'SpecificResource'),
);

console.log(`Found ${unresolved.length} unresolved references`);
```

## Steps 3-5 — Gather, match, bind or generate

For each unresolved reference: gather context, match against the KB, and either bind to the best match (if confident) or generate a new resource and bind to that. Brand the annotation id once at the top of the loop and reuse `annId` everywhere — `gather.annotation`, `match.search`, `bind.body`, and `yield.fromAnnotation` all take a branded `AnnotationId`.

```typescript
const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 30);

for (const ann of unresolved) {
  const annId = annotationId(ann.id);
  const selectedText = ann.target?.selector?.exact ?? '';

  // Step 3 — Gather LLM context
  const gatherComplete = await semiont.gather.annotation(annId, rId, { contextWindow: 2000 });
  const context = gatherComplete.response as GatheredContext;

  // Step 4 — Match against the KB
  const matchResult = await semiont.match.search(rId, annId, context, {
    limit: 10,
    useSemanticScoring: true,
  });
  const top = matchResult.response[0];

  if (top && (top.score ?? 0) >= MATCH_THRESHOLD) {
    // Step 5a — Bind to existing resource
    await semiont.bind.body(rId, annId, [{
      op: 'add',
      item: { type: 'SpecificResource', source: top['@id'], purpose: 'linking' },
    }]);
    console.log(`Bound "${selectedText}" -> ${top.name} (score ${top.score})`);
  } else {
    // Step 5b — Generate a new resource and bind
    const yieldProgress = await semiont.yield.fromAnnotation(rId, annId, {
      title: selectedText,
      storageUri: `file://generated/${selectedText.toLowerCase().replace(/\s+/g, '-')}.md`,
      context,
    });
    const newResourceId = yieldProgress.result?.resourceId;
    if (!newResourceId) throw new Error('yield.fromAnnotation did not return a resourceId');

    await semiont.bind.body(rId, annId, [{
      op: 'add',
      item: { type: 'SpecificResource', source: newResourceId, purpose: 'linking' },
    }]);
    console.log(`Generated "${selectedText}" -> ${newResourceId}`);
  }
}

semiont.dispose();
```

## Complete script skeleton

```typescript
import {
  SemiontClient,
  annotationId,
  entityType,
  resourceId,
  type GatheredContext,
} from '@semiont/sdk';

const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 30);
const ENTITY_TYPES = (process.env.ENTITY_TYPES ?? 'Location')
  .split(',')
  .map((t) => entityType(t.trim()));

async function runWikiPipeline(resourceIdStr: string): Promise<void> {
  const semiont = await SemiontClient.signInHttp({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });
  const rId = resourceId(resourceIdStr);

  // Step 1 — Detect entity references
  console.log('Detecting entity references...');
  await semiont.mark.assist(rId, 'linking', { entityTypes: ENTITY_TYPES });

  // Step 2 — Find unresolved references
  const annotations = await semiont.browse.annotations(rId);
  const unresolved = annotations.filter(
    (ann) => ann.motivation === 'linking' &&
             !ann.body?.some((b) => b.type === 'SpecificResource'),
  );
  console.log(`Found ${unresolved.length} unresolved references`);

  // Steps 3-5 — per annotation
  for (const ann of unresolved) {
    const annId = annotationId(ann.id);
    const selectedText = ann.target?.selector?.exact ?? '';

    const gatherComplete = await semiont.gather.annotation(annId, rId, { contextWindow: 2000 });
    const context = gatherComplete.response as GatheredContext;

    const matchResult = await semiont.match.search(rId, annId, context, {
      limit: 10,
      useSemanticScoring: true,
    });
    const top = matchResult.response[0];

    if (top && (top.score ?? 0) >= MATCH_THRESHOLD) {
      await semiont.bind.body(rId, annId, [{
        op: 'add',
        item: { type: 'SpecificResource', source: top['@id'], purpose: 'linking' },
      }]);
      console.log(`Bound "${selectedText}" -> ${top.name} (score ${top.score})`);
    } else {
      const yieldProgress = await semiont.yield.fromAnnotation(rId, annId, {
        title: selectedText,
        storageUri: `file://generated/${selectedText.toLowerCase().replace(/\s+/g, '-')}.md`,
        context,
      });
      const newResourceId = yieldProgress.result?.resourceId;
      if (!newResourceId) throw new Error('yield.fromAnnotation did not return a resourceId');

      await semiont.bind.body(rId, annId, [{
        op: 'add',
        item: { type: 'SpecificResource', source: newResourceId, purpose: 'linking' },
      }]);
      console.log(`Generated "${selectedText}" -> ${newResourceId}`);
    }
  }

  semiont.dispose();
  console.log('Pipeline complete.');
}

const target = process.argv[2];
if (!target) {
  console.error('Usage: tsx pipeline.ts <resourceId>');
  process.exit(1);
}
runWikiPipeline(target).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

## Guidance for the AI assistant

- **Find the resource ID first** if the user gives a name: use `semiont.browse.resources({ search: '<name>' })` and pick from results.
- **Entity types are a key parameter.** Ask which types to detect (Location, Person, Organization, Concept, etc.) or run once per type.
- **The threshold is in Matcher score units, not 0-1.** The Matcher returns composite scores (name match alone can be 25 pts, entity type overlap up to ~35 pts, etc.). A threshold of 30 is selective; 15 is permissive. Set to 0 to always bind to the top result if one exists.
- **`useSemanticScoring: true`** enables LLM batch-scoring of the top 20 candidates — adds up to 25 pts and improves precision significantly. Set to `false` if inference cost is a concern.
- **Generated resources should be reviewed.** They are AI-generated stubs, not finished articles.
- **Check results** with `semiont.browse.annotations(rId)` — filter for `motivation === 'linking'` and check which now have a `SpecificResource` body item.
- **To run on multiple resources**, loop over results from `semiont.browse.resources()` and call `runWikiPipeline` per resource.
- **If detection produces no annotations**, the document may not contain the requested entity types, or the format may not be supported (`text/plain` and `text/markdown` only; PDFs and images not yet supported).
- **Timeout handling is built into the namespace methods.** `mark.assist` times out after 180 s without progress; `gather.annotation` completes on the `gather:complete` bus event; `yield.fromAnnotation` handles 300 s-per-progress timeout and polling fallback. No manual timeout code is needed.
- **Progress observability** — if a caller wants to watch progress during a long step, call `.subscribe(...)` on the returned `StreamObservable` instead of awaiting it. Each emission is a progress snapshot; the Observable completes on success and errors on failure. Awaiting yields the final emission only.
- **Errors** — every SDK throw extends `SemiontError` (re-exported from `@semiont/sdk`). Catch on it broadly, or narrow to `APIError` (HTTP, with `status`) or `BusRequestError` (bus-mediated, with codes like `bus.timeout` and `bus.rejected`). See [Error Handling in Usage.md](../../../../packages/sdk/docs/Usage.md#error-handling) for the full table.
