---
name: semiont-wiki
description: Run the knowledge enrichment pipeline on a resource using @semiont/api-client — detect entity references, resolve them against the KB, and generate new resources for unresolved ones
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping implement the Semiont knowledge enrichment pipeline using the `@semiont/api-client` TypeScript SDK. This pipeline transforms a document into a connected wiki: it detects entity mentions, links them to existing resources in the knowledge base, and generates new stub resources for anything that isn't there yet.

The pipeline has five steps:

1. **Mark** — detect entity references via SSE streaming (`client.sse.detectAnnotations`)
2. **Gather** — fetch LLM context for each unresolved reference (`client.getAnnotationLLMContext`)
3. **Match** — search the KB via the Matcher (`client.sse.bindSearch`) using full gathered context
4. **Bind** — link the annotation to the best match (`client.updateAnnotationBody`)
5. **Generate** — if no confident match exists, generate a new resource and bind to it (`client.sse.generateResourceFromAnnotation`)

Steps 3–5 run per annotation in a loop. The threshold between "bind to existing" and "generate new" is configurable.

## Setup

```typescript
import { SemiontApiClient, resourceId, annotationId, entityType, BindSearchStreamRequest } from '@semiont/api-client';
import { EventBus } from '@semiont/core';

const client = new SemiontApiClient({
  baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
  accessToken: process.env.SEMIONT_ACCESS_TOKEN,
});

// Or authenticate inline
await client.authenticateLocal('alice@example.com', verificationCode);
```

## Step 1 — Detect entity references (Mark)

Use `client.sse.detectAnnotations` with an `EventBus` to stream detection progress. Only `text/plain` and `text/markdown` resources are supported; PDFs and images are not yet.

```typescript
import { EventBus } from '@semiont/core';

const eventBus = new EventBus();
const rId = resourceId('doc-123');

await new Promise<void>((resolve, reject) => {
  eventBus.get('detection:complete').subscribe(() => resolve());
  eventBus.get('detection:failed').subscribe(({ error }) => reject(error));

  client.sse.detectAnnotations(rId, {
    entityTypes: [entityType('Location'), entityType('Person')],
  }, {
    auth: client.accessToken,
    eventBus,
  });
});

eventBus.destroy();
```

## Step 2 — List unresolved references

```typescript
const { annotations } = await client.getResourceAnnotations(rId);

const unresolved = annotations.filter(ann =>
  ann.motivation === 'linking' &&
  !ann.body?.some((b: any) => b.type === 'SpecificResource'),
);

console.log(`Found ${unresolved.length} unresolved references`);
```

## Step 3 — Gather context and match

The Match step uses `client.sse.bindSearch`, which routes through the server-side Matcher actor. The Matcher scores candidates using entity type overlap (Jaccard + IDF weighting), graph neighborhood connections, bidirectionality, citation weight, name match quality, recency, and optional LLM semantic scoring. Pass the full `GatheredContext` from step 2 so the Matcher has all signals available.

```typescript
const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 30);

for (const ann of unresolved) {
  const annId = annotationId(ann.id);

  // Gather LLM context for this annotation
  const { context } = await client.getAnnotationLLMContext(rId, annId, {
    contextWindow: 2000,
  });

  const selectedText = context.sourceContext?.selected ?? '';

  // Match via the Matcher actor — full composite scoring
  const searchBus = new EventBus();
  const referenceId = ann.id;

  const results = await new Promise<any[]>((resolve, reject) => {
    searchBus.get('bind:search-results').subscribe(e => resolve(e.results));
    searchBus.get('bind:search-failed').subscribe(({ error }) => reject(error));

    client.sse.bindSearch(rId, {
      referenceId,
      context,
      limit: 10,
      useSemanticScoring: true,
    }, {
      auth: client.accessToken,
      eventBus: searchBus,
    });
  });

  searchBus.destroy();

  const top = results[0];

  if (top && top.score >= MATCH_THRESHOLD) {
    // Step 4 — Bind to existing resource
    await client.updateAnnotationBody(rId, annId, {
      operations: [{
        op: 'add',
        item: {
          type: 'SpecificResource',
          source: top['@id'],
          purpose: 'linking',
        },
      }],
    });
    console.log(`Bound "${selectedText}" → ${top.name} (score ${top.score})`);
  } else {
    // Step 5 — Generate a new resource
    await generateAndBind(client, rId, annId, selectedText);
  }
}
```

## Step 5 — Generate and bind

```typescript
async function generateAndBind(
  client: SemiontApiClient,
  rId: ReturnType<typeof resourceId>,
  annId: ReturnType<typeof annotationId>,
  title: string,
): Promise<void> {
  const eventBus = new EventBus();

  const newResourceId = await new Promise<string>((resolve, reject) => {
    eventBus.get('generation:complete').subscribe(result => {
      if (result.resourceId) resolve(result.resourceId);
      else reject(new Error('Generation completed but returned no resourceId'));
    });
    eventBus.get('generation:failed').subscribe(({ error }) => reject(error));

    client.sse.generateResourceFromAnnotation(rId, annId, {
      title,
      language: process.env.LANGUAGE ?? 'en',
    }, {
      auth: client.accessToken,
      eventBus,
    });
  });

  eventBus.destroy();

  await client.updateAnnotationBody(rId, annId, {
    operations: [{
      op: 'add',
      item: {
        type: 'SpecificResource',
        source: newResourceId,
        purpose: 'linking',
      },
    }],
  });

  console.log(`Generated "${title}" → ${newResourceId}`);
}
```

## Complete script skeleton

```typescript
import { SemiontApiClient, resourceId, annotationId, entityType } from '@semiont/api-client';
import { EventBus } from '@semiont/core';

const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 30);
const ENTITY_TYPES = (process.env.ENTITY_TYPES ?? 'Location').split(',').map(t => entityType(t.trim()));

async function runWikiPipeline(resourceIdStr: string): Promise<void> {
  const client = new SemiontApiClient({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    accessToken: process.env.SEMIONT_ACCESS_TOKEN,
  });

  const rId = resourceId(resourceIdStr);

  // Step 1: Detect entity references
  console.log('Detecting entity references...');
  const detectBus = new EventBus();
  await new Promise<void>((resolve, reject) => {
    detectBus.get('detection:complete').subscribe(() => resolve());
    detectBus.get('detection:failed').subscribe(({ error }) => reject(error));
    client.sse.detectAnnotations(rId, { entityTypes: ENTITY_TYPES }, {
      auth: client.accessToken,
      eventBus: detectBus,
    });
  });
  detectBus.destroy();

  // Step 2: Find unresolved references
  const { annotations } = await client.getResourceAnnotations(rId);
  const unresolved = annotations.filter(ann =>
    ann.motivation === 'linking' &&
    !ann.body?.some((b: any) => b.type === 'SpecificResource'),
  );
  console.log(`Found ${unresolved.length} unresolved references`);

  // Steps 3–5: Match or generate per annotation
  for (const ann of unresolved) {
    const annId = annotationId(ann.id);
    const { context } = await client.getAnnotationLLMContext(rId, annId, { contextWindow: 2000 });
    const selectedText = context.sourceContext?.selected ?? '';

    const searchBus = new EventBus();
    const results = await new Promise<any[]>((resolve, reject) => {
      searchBus.get('bind:search-results').subscribe(e => resolve(e.results));
      searchBus.get('bind:search-failed').subscribe(({ error }) => reject(error));
      client.sse.bindSearch(rId, {
        referenceId: ann.id,
        context,
        limit: 10,
        useSemanticScoring: true,
      }, { auth: client.accessToken, eventBus: searchBus });
    });
    searchBus.destroy();

    const top = results[0];

    if (top && top.score >= MATCH_THRESHOLD) {
      await client.updateAnnotationBody(rId, annId, {
        operations: [{ op: 'add', item: { type: 'SpecificResource', source: top['@id'], purpose: 'linking' } }],
      });
      console.log(`Bound "${selectedText}" → ${top.name} (score ${top.score})`);
    } else {
      await generateAndBind(client, rId, annId, selectedText);
    }
  }

  console.log('Pipeline complete.');
}

const target = process.argv[2];
if (!target) { console.error('Usage: tsx pipeline.ts <resourceId>'); process.exit(1); }
runWikiPipeline(target).catch(e => { console.error(e); process.exit(1); });
```

## Guidance for the AI assistant

- **Find the resource ID first** if the user gives a name: `client.listResources(10, false, '<name>')` then pick from results.
- **Entity types are a key parameter.** Ask which types to detect (Location, Person, Organization, Concept, etc.) or run once per type.
- **The threshold is in Matcher score units, not 0–1.** The Matcher returns composite scores (name match alone can be 25 pts, entity type overlap up to ~35 pts, etc.). A threshold of 30 is selective; 15 is permissive. Set to 0 to always bind to the top result if one exists.
- **`useSemanticScoring: true`** enables LLM batch-scoring of the top 20 candidates — adds up to 25 pts and improves precision significantly. Set to `false` if inference cost is a concern.
- **Generated resources should be reviewed.** They are AI-generated stubs, not finished articles.
- **Check results** with `client.getResourceAnnotations(rId)` after the pipeline — filter for `motivation === 'linking'` and check which now have a `SpecificResource` body item.
- **To run on multiple resources**, loop over `client.listResources()` results and call `runWikiPipeline` per resource.
- **If detection produces no annotations**, the document may not contain the requested entity types, or the format may not be supported (text/plain and text/markdown only; PDFs and images not yet supported).
- **SSE streams require an `EventBus` instance.** Always destroy the bus after the stream completes to avoid memory leaks.
