# Examples

Common use cases and patterns for `@semiont/make-meaning`.

## Setup

All examples assume the service is started:

```typescript
import { startMakeMeaning, ResourceOperations, AnnotationOperations } from '@semiont/make-meaning';
import { EventBus, userId } from '@semiont/core';
import { firstValueFrom, filter, timeout, race } from 'rxjs';

const eventBus = new EventBus();
const makeMeaning = await startMakeMeaning(config, eventBus, logger);
const { kb } = makeMeaning;
```

## Creating Resources

```typescript
const result = await ResourceOperations.createResource(
  {
    name: 'My Document',
    content: Buffer.from('# Hello World\n\nThis is a test document.'),
    format: 'text/markdown',
    language: 'en',
  },
  userId('user-123'),
  eventBus,
  config.services.backend.publicURL,
);

console.log(`Created: ${result.resource['@id']}`);
console.log(`Resource ID: ${result.resourceId}`);
```

## Querying Resources

### Getting Resource Metadata

```typescript
import { ResourceContext } from '@semiont/make-meaning';

const resource = await ResourceContext.getResourceMetadata(resourceId, kb);
if (resource) {
  console.log(`Resource: ${resource.name}`);
  console.log(`Created: ${resource.created}`);
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
      source: resourceUri,
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
  config.services.backend.publicURL,
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
  annotationUri,
  resourceId,
  kb,
  { contextLines: 10, includeMetadata: true },
);

console.log(`Selected: "${context.selected}"`);
console.log(`Before: "${context.before}"`);
console.log(`After: "${context.after}"`);
```

## Gathering Context via EventBus

For routes and actors that communicate through the EventBus:

```typescript
// Request context for an annotation
eventBus.get('gather:requested').next({
  annotationUri,
  resourceId,
  options: { contextLines: 5 },
});

// Await the Gatherer's response
const result = await firstValueFrom(
  race(
    eventBus.get('gather:complete').pipe(filter(e => e.annotationUri === annotationUri)),
    eventBus.get('gather:failed').pipe(filter(e => e.annotationUri === annotationUri)),
  ).pipe(timeout(30_000)),
);
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

## Entity Resolution via EventBus

```typescript
// Search for matching resources
eventBus.get('bind:search-requested').next({
  referenceId: annotationId,
  searchTerm: 'quantum computing',
});

// Await the Binder's response
const results = await firstValueFrom(
  eventBus.get('bind:search-results').pipe(
    filter(e => e.referenceId === annotationId),
    timeout(10_000),
  ),
);
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
