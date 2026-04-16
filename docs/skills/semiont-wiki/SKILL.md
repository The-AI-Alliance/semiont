---
name: semiont-wiki
description: Run the knowledge enrichment pipeline on a resource using @semiont/api-client ViewModels — detect entity references, resolve them against the KB, and generate new resources for unresolved ones
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping implement the Semiont knowledge enrichment pipeline using `@semiont/api-client` ViewModels. This pipeline transforms a document into a connected wiki: it detects entity mentions, links them to existing resources in the knowledge base, and generates new stub resources for anything that isn't there yet.

The pipeline has five steps:

1. **Mark** — detect entity references via MarkVM (`createMarkVM`)
2. **Gather** — fetch LLM context for each unresolved reference via GatherVM (`createGatherVM`)
3. **Match** — search the KB via MatchVM (`createMatchVM`) using full gathered context
4. **Bind** — link the annotation to the best match via BindVM (`createBindVM`)
5. **Yield** — if no confident match exists, generate a new resource and bind to it via YieldVM (`createYieldVM`)

Steps 3-5 run per annotation in a loop. The threshold between "bind to existing" and "generate new" is configurable.

## Setup

```typescript
import {
  SemiontApiClient,
  createMarkVM,
  createGatherVM,
  createMatchVM,
  createBindVM,
  createYieldVM,
  resourceId,
  annotationId,
} from '@semiont/api-client';
import { EventBus, entityType } from '@semiont/core';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';

const client = new SemiontApiClient({
  baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
  accessToken: process.env.SEMIONT_ACCESS_TOKEN,
});
```

## Step 1 — Detect entity references (Mark)

Use `createMarkVM` to manage the assist lifecycle. The MarkVM handles SSE streaming, progress tracking, and timeout (180s without progress triggers failure).

```typescript
const rId = resourceId('doc-123');
const eventBus = new EventBus();
const markVM = createMarkVM(client, eventBus, rId);

eventBus.get('mark:assist-request').next({
  motivation: 'linking',
  options: {
    entityTypes: [entityType('Location'), entityType('Person')],
  },
});

await firstValueFrom(
  eventBus.get('mark:assist-finished').pipe(
    filter((e) => e.motivation === 'linking'),
  ),
);

markVM.dispose();
eventBus.destroy();
```

## Step 2 — List unresolved references

```typescript
const annotations = await firstValueFrom(
  client.browse.annotations(rId).pipe(
    filter((a) => a !== undefined),
  ),
);

const unresolved = annotations.filter(ann =>
  ann.motivation === 'linking' &&
  !ann.body?.some(b => b.type === 'SpecificResource'),
);

console.log(`Found ${unresolved.length} unresolved references`);
```

## Step 3 — Gather context and match

The GatherVM assembles LLM context around an annotation. The MatchVM searches the KB using composite scoring (entity type overlap, graph neighborhood, name quality, optional LLM semantic scoring). Pass the full `GatheredContext` so the Matcher has all signals available.

```typescript
const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 30);

for (const ann of unresolved) {
  const annId = annotationId(ann.id);
  const selectedText = ann.target?.selector?.exact ?? '';

  // Gather LLM context via GatherVM
  const gatherBus = new EventBus();
  const gatherVM = createGatherVM(client, gatherBus, rId);

  gatherBus.get('gather:requested').next({
    correlationId: crypto.randomUUID(),
    annotationId: ann.id,
    resourceId: rId as string,
    options: { contextWindow: 2000 },
  });

  const context = await firstValueFrom(
    gatherVM.context$.pipe(filter((c) => c !== null)),
  );
  gatherVM.dispose();
  gatherBus.destroy();

  // Match via the Matcher actor
  const searchResult = await firstValueFrom(
    client.match.search(rId, ann.id, context, {
      limit: 10,
      useSemanticScoring: true,
    }),
  );
  const results = (searchResult as { response: { results: unknown[] } }).response.results;
  const top = results[0] as { '@id': string; name: string; score: number } | undefined;

  if (top && top.score >= MATCH_THRESHOLD) {
    // Step 4 — Bind to existing resource
    const bindBus = new EventBus();
    const bindVM = createBindVM(client, bindBus, rId);

    bindBus.get('bind:update-body').next({
      annotationId: ann.id,
      operations: [{
        op: 'add',
        item: { type: 'SpecificResource', source: top['@id'], purpose: 'linking' },
      }],
    });

    bindVM.dispose();
    bindBus.destroy();
    console.log(`Bound "${selectedText}" -> ${top.name} (score ${top.score})`);
  } else {
    // Step 5 — Generate a new resource
    await generateAndBind(client, rId, annId, selectedText, context);
  }
}
```

## Step 5 — Generate and bind

Uses `createYieldVM` for generation. The YieldVM handles SSE streaming with 300s timeout per progress emission.

```typescript
async function generateAndBind(
  client: SemiontApiClient,
  rId: ReturnType<typeof resourceId>,
  annId: ReturnType<typeof annotationId>,
  title: string,
  context: GatheredContext,
): Promise<void> {
  const yieldBus = new EventBus();
  const yieldVM = createYieldVM(client, yieldBus, rId, process.env.LANGUAGE ?? 'en');

  yieldVM.generate(annId as string, {
    title,
    storageUri: `file://generated/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    context,
  });

  const finished = await firstValueFrom(
    yieldBus.get('yield:finished'),
  );

  const newResourceId = finished.resourceId;
  yieldVM.dispose();
  yieldBus.destroy();

  // Bind the annotation to the newly generated resource
  const bindBus = new EventBus();
  const bindVM = createBindVM(client, bindBus, rId);

  bindBus.get('bind:update-body').next({
    annotationId: annId as string,
    operations: [{
      op: 'add',
      item: { type: 'SpecificResource', source: newResourceId, purpose: 'linking' },
    }],
  });

  bindVM.dispose();
  bindBus.destroy();

  console.log(`Generated "${title}" -> ${newResourceId}`);
}
```

## Complete script skeleton

```typescript
import {
  SemiontApiClient,
  createMarkVM,
  createGatherVM,
  createBindVM,
  createYieldVM,
  resourceId,
  annotationId,
} from '@semiont/api-client';
import { EventBus, entityType } from '@semiont/core';
import type { GatheredContext } from '@semiont/core';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';

const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 30);
const ENTITY_TYPES = (process.env.ENTITY_TYPES ?? 'Location').split(',').map(t => entityType(t.trim()));

async function runWikiPipeline(resourceIdStr: string): Promise<void> {
  const client = new SemiontApiClient({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    accessToken: process.env.SEMIONT_ACCESS_TOKEN,
  });

  const rId = resourceId(resourceIdStr);

  // Step 1: Detect entity references via MarkVM
  console.log('Detecting entity references...');
  const markBus = new EventBus();
  const markVM = createMarkVM(client, markBus, rId);

  markBus.get('mark:assist-request').next({
    motivation: 'linking',
    options: { entityTypes: ENTITY_TYPES },
  });

  await firstValueFrom(
    markBus.get('mark:assist-finished').pipe(
      filter((e) => e.motivation === 'linking'),
    ),
  );
  markVM.dispose();
  markBus.destroy();

  // Step 2: Find unresolved references
  const annotations = await firstValueFrom(
    client.browse.annotations(rId).pipe(filter((a) => a !== undefined)),
  );
  const unresolved = annotations.filter(ann =>
    ann.motivation === 'linking' &&
    !ann.body?.some(b => b.type === 'SpecificResource'),
  );
  console.log(`Found ${unresolved.length} unresolved references`);

  // Steps 3-5: Gather + Match + Bind/Generate per annotation
  for (const ann of unresolved) {
    const annId = annotationId(ann.id);
    const selectedText = ann.target?.selector?.exact ?? '';

    // Gather context
    const gatherBus = new EventBus();
    const gatherVM = createGatherVM(client, gatherBus, rId);
    gatherBus.get('gather:requested').next({
      correlationId: crypto.randomUUID(),
      annotationId: ann.id,
      resourceId: rId as string,
      options: { contextWindow: 2000 },
    });
    const context = await firstValueFrom(
      gatherVM.context$.pipe(filter((c) => c !== null)),
    );
    gatherVM.dispose();
    gatherBus.destroy();

    // Match
    const searchResult = await firstValueFrom(
      client.match.search(rId, ann.id, context, {
        limit: 10,
        useSemanticScoring: true,
      }),
    );
    const results = (searchResult as { response: { results: unknown[] } }).response.results;
    const top = results[0] as { '@id': string; name: string; score: number } | undefined;

    if (top && top.score >= MATCH_THRESHOLD) {
      // Bind to existing
      const bindBus = new EventBus();
      const bindVM = createBindVM(client, bindBus, rId);
      bindBus.get('bind:update-body').next({
        annotationId: ann.id,
        operations: [{ op: 'add', item: { type: 'SpecificResource', source: top['@id'], purpose: 'linking' } }],
      });
      bindVM.dispose();
      bindBus.destroy();
      console.log(`Bound "${selectedText}" -> ${top.name} (score ${top.score})`);
    } else {
      // Generate and bind
      await generateAndBind(client, rId, annId, selectedText, context);
    }
  }

  console.log('Pipeline complete.');
}

async function generateAndBind(
  client: SemiontApiClient,
  rId: ReturnType<typeof resourceId>,
  annId: ReturnType<typeof annotationId>,
  title: string,
  context: GatheredContext,
): Promise<void> {
  const yieldBus = new EventBus();
  const yieldVM = createYieldVM(client, yieldBus, rId, process.env.LANGUAGE ?? 'en');

  yieldVM.generate(annId as string, {
    title,
    storageUri: `file://generated/${title.toLowerCase().replace(/\\s+/g, '-')}.md`,
    context,
  });

  const finished = await firstValueFrom(yieldBus.get('yield:finished'));
  yieldVM.dispose();
  yieldBus.destroy();

  const bindBus = new EventBus();
  const bindVM = createBindVM(client, bindBus, rId);
  bindBus.get('bind:update-body').next({
    annotationId: annId as string,
    operations: [{ op: 'add', item: { type: 'SpecificResource', source: finished.resourceId, purpose: 'linking' } }],
  });
  bindVM.dispose();
  bindBus.destroy();

  console.log(`Generated "${title}" -> ${finished.resourceId}`);
}

const target = process.argv[2];
if (!target) { console.error('Usage: tsx pipeline.ts <resourceId>'); process.exit(1); }
runWikiPipeline(target).catch(e => { console.error(e); process.exit(1); });
```

## Guidance for the AI assistant

- **Find the resource ID first** if the user gives a name: use `client.browse.resources({ search: '<name>' })` Observable, then pick from results.
- **Entity types are a key parameter.** Ask which types to detect (Location, Person, Organization, Concept, etc.) or run once per type.
- **The threshold is in Matcher score units, not 0-1.** The Matcher returns composite scores (name match alone can be 25 pts, entity type overlap up to ~35 pts, etc.). A threshold of 30 is selective; 15 is permissive. Set to 0 to always bind to the top result if one exists.
- **`useSemanticScoring: true`** enables LLM batch-scoring of the top 20 candidates — adds up to 25 pts and improves precision significantly. Set to `false` if inference cost is a concern.
- **Generated resources should be reviewed.** They are AI-generated stubs, not finished articles.
- **Check results** with `client.browse.annotations(rId)` Observable — filter for `motivation === 'linking'` and check which now have a `SpecificResource` body item.
- **To run on multiple resources**, loop over results from `client.browse.resources()` and call `runWikiPipeline` per resource.
- **If detection produces no annotations**, the document may not contain the requested entity types, or the format may not be supported (text/plain and text/markdown only; PDFs and images not yet supported).
- **Each VM manages its own timeout.** MarkVM times out after 180s without progress. GatherVM times out after 60s. YieldVM times out after 300s per progress emission. No manual timeout handling needed.
