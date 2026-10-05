# Examples

Common use cases and patterns for `@semiont/make-meaning`.

## Setup

All examples assume the service is started:

```typescript
import { startMakeMeaning, AnnotationOperations, asBusRequestPrimitive } from '@semiont/make-meaning';
import { EventBus, ResourceOperations, userId } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { firstValueFrom, filter, timeout, race } from 'rxjs';

const eventBus = new EventBus();
const makeMeaning = await startMakeMeaning(new SemiontProject(projectRoot, { anchoredTextDir: process.env.SEMIONT_ANCHORED_TEXT_DIR! }), config, eventBus, logger);
const { kb } = makeMeaning.knowledgeSystem;
```

## Creating Resources

Write content to the content store first, then register it via `createResource` (returns the new `ResourceId`):

```typescript
import { deriveStorageUri } from '@semiont/core';

const uri = deriveStorageUri('my-document', 'text/markdown');
const stored = await kb.content.store(Buffer.from('# Hello World\n\nThis is a test document.'), uri);

const rId = await ResourceOperations.createResource(
  {
    name: 'My Document',
    storageUri: stored.storageUri,
    contentChecksum: stored.checksum,
    byteSize: stored.byteSize,
    format: 'text/markdown',
    language: 'en',
  },
  { did: userId('did:web:example.com:users:user-123'), roles: [] },
  asBusRequestPrimitive(eventBus),
);

console.log(`Resource ID: ${rId}`);
```

## Querying Resources

### Getting Resource Metadata

```typescript
import { ResourceContext } from '@semiont/make-meaning';
import { getPrimaryMediaType } from '@semiont/core';

const resource = await ResourceContext.getResourceMetadata(resourceId, kb);
if (resource) {
  console.log(`Resource: ${resource.name}`);
  console.log(`Created: ${resource.dateCreated}`);
  console.log(`Format: ${getPrimaryMediaType(resource)}`);
}
```

### Listing Resources

```typescript
import { ResourceContext } from '@semiont/make-meaning';

// `total` is the size of the whole match set, not of the returned page.
// The third argument powers the semantic fallback for empty lexical searches:
// the embedding provider comes from the composition root (`createEmbeddingProvider`
// from @semiont/vectors) and the floor from `config.search.semanticFloor`.
// `matchKind` reports whether the answer is 'lexical' or 'semantic'.
const { resources, total, matchKind } = await ResourceContext.listResources({
  search: 'lovelace',
  entityType: 'Person',
  archived: false,
  offset: 0,
  limit: 10,
}, kb, { embeddingProvider, semanticFloor: config.search.semanticFloor, logger });

const withPreviews = await ResourceContext.addContentPreviews(resources, kb);
for (const resource of withPreviews) {
  console.log(`${resource.name}: ${resource.content.substring(0, 100)}...`);
}
```

## Working with Annotations

### Creating Annotations

```typescript
const result = await AnnotationOperations.createAnnotation(
  {
    motivation: 'commenting',
    target: {
      source: resourceId,
      selector: [
        { type: 'TextPositionSelector', start: 0, end: 50 },
        { type: 'TextQuoteSelector', exact: 'Hello World', prefix: '# ', suffix: '\n' },
      ],
    },
    body: [
      { type: 'TextualBody', value: 'Great intro!', purpose: 'commenting', format: 'text/plain' },
    ],
  },
  userId('did:web:example.com:users:user-123'),
  eventBus,
  kb,  // views.get — the annotatability gate reads the target's media type
);

console.log(`Created annotation: ${result.annotation.id}`);
```

### Getting Annotations

```typescript
import { AnnotationContext } from '@semiont/make-meaning';

// The resource's annotation projection — a flat list with a version stamp
const projection = await AnnotationContext.getResourceAnnotations(resourceId, kb);
console.log(`Annotations: ${projection.annotations.length} (projection v${projection.version})`);

// Just the annotations
const allAnnotations = await AnnotationContext.getAllAnnotations(resourceId, kb);
```

### Building LLM Context

`AnnotationContext.buildLLMContext` is the Gatherer's engine; it takes the Pick-derived
`AnnotationGatherReads` slice (its `content` capability is ResourceId-keyed, not the raw
working tree) plus a mandatory `EmbeddingProvider`. Callers reach it through the gather
flow — `semiont.gather.annotation(...)` in the SDK, or `gather:requested` on the bus
(see below) — which returns an annotation-focus `GatheredContext`:

```typescript
const { response: context } = await semiont.gather.annotation(resourceId, annotationId);

if (context.focus.kind === 'annotation') {
  console.log(`Selected: "${context.focus.selected?.text}"`);
  console.log(`Before: "${context.focus.selected?.before}"`);
  console.log(`After: "${context.focus.selected?.after}"`);
}
```

## Using the SDK (Recommended)

The simplest way to interact with the knowledge system is the [`@semiont/sdk`](../../sdk/README.md) client:

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';
import { resourceId, annotationId } from '@semiont/core';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
const session = await SemiontSession.signInDevice({
  kb: httpKb({
    id: 'script', label: 'Semiont',
    host: url.hostname, port: Number(url.port || 4000),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  }),
  storage: new InMemorySessionStorage(),
  onCode: ({ verificationUri, userCode }) => console.log(`Open ${verificationUri} and enter ${userCode}`),
});
const semiont = session.client;

// The SDK is RxJS-native. Streams and uploads are PromiseLike — `await` works directly;
// a Browse live query is read once with `.fresh()`.
const resource = await semiont.browse.resource(resourceId('doc-123')).fresh();
const annotations = await semiont.browse.annotations(resourceId('doc-123')).fresh();
const content = await semiont.browse.resourceContent(resourceId('doc-123'));
const events = await semiont.browse.resourceEvents(resourceId('doc-123'));

// Gather LLM context, then search for candidate matches
const { response: context } = await semiont.gather.annotation(resourceId('doc-123'), annotationId('ann-1'));
const results = await semiont.match.search(resourceId('doc-123'), annotationId('ref-1'), context);
```

Reach for `.subscribe(...)` only when you want progress events or live updates.

## Gathering Context via EventBus (Low-Level)

For callers that need direct EventBus control, match on the frame's `correlationId`, which rides the envelope and not the payload:

```typescript
import { firstValueFrom, merge } from 'rxjs';
import { filter, map, take, timeout } from 'rxjs/operators';

const correlationId = crypto.randomUUID();

const result$ = merge(
  eventBus.frames('gather:complete').pipe(
    filter(f => f.correlationId === correlationId),
    map(f => ({ ok: true as const, response: f.payload.response })),
  ),
  eventBus.frames('gather:failed').pipe(
    filter(f => f.correlationId === correlationId),
    map(f => ({ ok: false as const, error: new Error(f.payload.message) })),
  ),
).pipe(take(1), timeout(30_000));

eventBus.emit(
  'gather:requested',
  { annotationId, resourceId, options: { contextWindow: 1000 } },
  { correlationId },
);

const result = await firstValueFrom(result$);
if (!result.ok) throw result.error;
```

## Graph Traversal

Direct graph queries go through the `GraphDatabase` interface, and read what a Weaver has
projected into the configured graph — the Weaver is a standalone service, which
`startMakeMeaning()` does not start. (Bus clients get referenced-by lookups from the
Browser via `browse:referenced-by-requested`.)

```typescript
// Find backlinks (incoming links)
const backlinks = await kb.graph.getResourceReferencedBy(resourceId);
console.log(`Found ${backlinks.length} backlinks`);

// Search resources
const { resources: results } = await kb.graph.listResources({
  search: 'neural networks',
  limit: 10,
});

// Find paths between resources
const paths = await kb.graph.findPath(fromId, toId, 3);
```

## Candidate Search via EventBus (Low-Level)

The match flow finds candidate resources for a reference. Use `correlationId` to thread the response back:

```typescript
import { filter, map, take, timeout } from 'rxjs/operators';

const correlationId = crypto.randomUUID();

const results$ = eventBus.frames('match:search-results').pipe(
  filter(f => f.correlationId === correlationId),
  map(f => f.payload),
  take(1),
  timeout(10_000),
);

eventBus.emit(
  'match:search-requested',
  { resourceId, referenceId: annotationId, context: gatheredContext },
  { correlationId },
);

const results = await firstValueFrom(results$);
```

## Cleanup

```typescript
await makeMeaning.stop();
eventBus.destroy();
```

## See Also

- [API Reference](./api-reference.md) — Complete API documentation
- [Architecture](./architecture.md) — Actor model and data flow
- [Scripting](./SCRIPTING.md) — Direct scripting without HTTP gateway
