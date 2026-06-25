# Examples

Common use cases and patterns for `@semiont/make-meaning`.

## Setup

All examples assume the service is started:

```typescript
import { startMakeMeaning, ResourceOperations, AnnotationOperations } from '@semiont/make-meaning';
import { EventBus, userId } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { firstValueFrom, filter, timeout, race } from 'rxjs';

const eventBus = new EventBus();
const makeMeaning = await startMakeMeaning(new SemiontProject(projectRoot), config, eventBus, logger);
const { kb } = makeMeaning.knowledgeSystem;
```

## Creating Resources

Write content to the content store first, then register it via `createResource` (returns the new `ResourceId`):

```typescript
import { deriveStorageUri } from '@semiont/content';

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
  userId('user-123'),
  eventBus,
);

console.log(`Resource ID: ${rId}`);
```

## Querying Resources

### Getting Resource Metadata

```typescript
import { ResourceContext } from '@semiont/make-meaning';

const resource = await ResourceContext.getResourceMetadata(resourceId, kb);
if (resource) {
  console.log(`Resource: ${resource.name}`);
  console.log(`Created: ${resource.dateCreated}`);
  console.log(`Format: ${resource.format}`);
}
```

### Listing Resources

```typescript
import { ResourceContext } from '@semiont/make-meaning';

const resources = await ResourceContext.listResources({
  createdAfter: '2024-01-01',
  mimeType: 'text/markdown',
  limit: 10,
}, kb);

const withPreviews = await ResourceContext.addContentPreviews(resources, kb);
for (const resource of withPreviews) {
  console.log(`${resource.name}: ${resource.content.substring(0, 100)}...`);
}
```

## Working with Annotations

### Creating Annotations

```typescript
import { userToAgent } from '@semiont/core';

const result = await AnnotationOperations.createAnnotation(
  {
    motivation: 'commenting',
    target: {
      type: 'SpecificResource',
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
  userId('user-123'),
  userToAgent({ id: userId('user-123'), name: 'Test User', email: 'test@example.com', domain: 'example.com' }),
  eventBus,
);

console.log(`Created annotation: ${result.annotation.id}`);
```

### Getting Annotations

```typescript
import { AnnotationContext } from '@semiont/make-meaning';

// By motivation
const annotationsByType = await AnnotationContext.getResourceAnnotations(resourceId, kb);
console.log(`Highlights: ${annotationsByType.highlighting?.length || 0}`);
console.log(`Comments: ${annotationsByType.commenting?.length || 0}`);

// Flat list
const allAnnotations = await AnnotationContext.getAllAnnotations(resourceId, kb);
```

### Building LLM Context

```typescript
import { AnnotationContext } from '@semiont/make-meaning';

const context = await AnnotationContext.buildLLMContext(
  annotationId,
  resourceId,
  kb,
  { contextWindow: 1000 },
);

// buildLLMContext returns an annotation-focus GatheredContext
if (context.focus.kind === 'annotation') {
  console.log(`Selected: "${context.focus.selected?.text}"`);
  console.log(`Before: "${context.focus.selected?.before}"`);
  console.log(`After: "${context.focus.selected?.after}"`);
}
```

## Using the SDK (Recommended)

The simplest way to interact with the knowledge system is the [`@semiont/sdk`](../../sdk/README.md) client:

```typescript
import { SemiontClient } from '@semiont/sdk';
import { resourceId, annotationId } from '@semiont/core';

const semiont = await SemiontClient.signInHttp({
  baseUrl: 'http://localhost:4000',
  email,
  password,
});

// The SDK is RxJS-native, but its return values are PromiseLike — `await` works directly.
const resource = await semiont.browse.resource(resourceId('doc-123'));
const annotations = await semiont.browse.annotations(resourceId('doc-123'));
const content = await semiont.browse.resourceContent(resourceId('doc-123'));
const events = await semiont.browse.resourceEvents(resourceId('doc-123'));

// Gather LLM context, then search for candidate matches
const context = await semiont.gather.annotation(annotationId('ann-1'), resourceId('doc-123'));
const results = await semiont.match.search(resourceId('doc-123'), annotationId('ref-1'), context);
```

Reach for `.subscribe(...)` only when you want progress events or live updates.

## Gathering Context via EventBus (Low-Level)

For callers that need direct EventBus control, use `correlationId` for matching:

```typescript
import { firstValueFrom, merge } from 'rxjs';
import { filter, map, take, timeout } from 'rxjs/operators';

const correlationId = crypto.randomUUID();

const result$ = merge(
  eventBus.get('gather:complete').pipe(
    filter(e => e.correlationId === correlationId),
    map(e => ({ ok: true as const, response: e.response })),
  ),
  eventBus.get('gather:failed').pipe(
    filter(e => e.correlationId === correlationId),
    map(e => ({ ok: false as const, error: new Error(e.message) })),
  ),
).pipe(take(1), timeout(30_000));

eventBus.get('gather:requested').next({
  correlationId,
  annotationId,
  resourceId,
  options: { contextWindow: 1000 },
});

const result = await firstValueFrom(result$);
if (!result.ok) throw result.error;
```

## Graph Traversal

```typescript
import { GraphContext } from '@semiont/make-meaning';

// Find backlinks
const backlinks = await GraphContext.getBacklinks(resourceId, kb);
console.log(`Found ${backlinks.length} backlinks`);

// Search resources
const results = await GraphContext.searchResources('neural networks', kb, 10);

// Find paths between resources
const paths = await GraphContext.findPath(fromId, toId, kb, 3);
```

## Candidate Search via EventBus (Low-Level)

The match flow finds candidate resources for a reference. Use `correlationId` to thread the response back:

```typescript
import { filter, take, timeout } from 'rxjs/operators';

const correlationId = crypto.randomUUID();

const results$ = eventBus.get('match:search-results').pipe(
  filter(e => e.correlationId === correlationId),
  take(1),
  timeout(10_000),
);

eventBus.get('match:search-requested').next({
  correlationId,
  resourceId,
  referenceId: annotationId,
  context: gatheredContext,
});

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
- [Scripting](./SCRIPTING.md) — Direct scripting without HTTP backend
