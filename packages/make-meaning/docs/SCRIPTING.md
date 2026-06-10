# Direct Scripting Guide

Use `@semiont/make-meaning` directly in TypeScript scripts without requiring a running HTTP backend.

## When to Use Direct Scripting

- **Batch processing** — analyze or modify multiple resources efficiently
- **Data migration** — import resources from external systems
- **Custom workflows** — domain-specific automation
- **Testing** — integration tests without HTTP layer
- **Maintenance** — rebuild projections or reprocess content

## Basic Setup

```typescript
#!/usr/bin/env tsx

import { EventBus } from '@semiont/core';
import { startMakeMeaning } from '@semiont/make-meaning';
import { loadEnvironmentConfig, findProjectRoot } from '@semiont/cli/config-loader';
import { createLogger } from '@semiont/core';

async function main() {
  const projectRoot = findProjectRoot();
  const environment = process.env.SEMIONT_ENV || 'local';
  const config = loadEnvironmentConfig(projectRoot, environment);
  const logger = createLogger('script');

  // EventBus is created outside make-meaning
  const eventBus = new EventBus();

  // Start make-meaning service (initializes KB, actors, workers)
  const makeMeaning = await startMakeMeaning(config, eventBus, logger);

  try {
    // Access components:
    // makeMeaning.kb                 — Knowledge Base (views, content, graph, eventStore)
    // makeMeaning.jobQueue           — Job queue
    // makeMeaning.stower             — Write gateway actor
    // makeMeaning.gatherer           — Read actor (browse, gather, entity types)
    // makeMeaning.matcher             — Search/link actor
    // makeMeaning.cloneTokenManager  — Clone token actor
    // makeMeaning.graphDb            — Graph database

    console.log('Script running...');
  } finally {
    await makeMeaning.stop();
    eventBus.destroy();
  }
}

main().catch(console.error);
```

### Running

```bash
export SEMIONT_ROOT=/path/to/your/project
tsx scripts/your-script.ts
```

## Creating Resources

```typescript
import { ResourceOperations } from '@semiont/make-meaning';
import { userId } from '@semiont/core';

const result = await ResourceOperations.createResource(
  {
    name: 'My Document',
    content: Buffer.from('Document content here'),
    format: 'text/plain',
    language: 'en',
  },
  userId('script-user'),
  eventBus,
  config.services.backend.publicURL,
);

console.log(`Created: ${result.resource['@id']}`);
```

## Queuing Detection Jobs

```typescript
import { resourceId, userId, entityType } from '@semiont/core';
import { jobId } from '@semiont/api-client';
import type { PendingJob, DetectionParams } from '@semiont/jobs';

const job: PendingJob<DetectionParams> = {
  status: 'pending',
  metadata: {
    id: jobId(`job-${Date.now()}`),
    type: 'reference-annotation',
    userId: userId('script-user'),
    userName: 'Script User',
    userEmail: 'script@example.com',
    userDomain: 'example.com',
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 1,
  },
  params: {
    resourceId: resourceId(rId),
    entityTypes: [
      entityType('Person'),
      entityType('Organization'),
    ],
  },
};

await makeMeaning.jobQueue.createJob(job);
```

## Monitoring Job Progress

Subscribe to EventBus events before creating the job:

```typescript
import { firstValueFrom, filter, timeout } from 'rxjs';

// Subscribe before creating job
const completionPromise = firstValueFrom(
  eventBus.get('job:complete').pipe(
    filter(e => e.jobId === job.metadata.id),
    timeout(5 * 60 * 1000),
  ),
);

// Create the job
await makeMeaning.jobQueue.createJob(job);

// Wait for completion
await completionPromise;
console.log('Job complete!');
```

## Querying the Knowledge Base

```typescript
import { ResourceContext, AnnotationContext, GraphContext } from '@semiont/make-meaning';

const { kb } = makeMeaning;

// Get resource metadata
const resource = await ResourceContext.getResourceMetadata(resourceId, kb);

// Get annotations
const annotations = await AnnotationContext.getAllAnnotations(resourceId, kb);

// Search resources via graph
const results = await GraphContext.searchResources('query text', kb, 10);

// Get graph stats
const stats = await makeMeaning.graphDb.getStats();
console.log(`Total resources: ${stats.resourceCount}`);
```

## Batch Processing

```typescript
const resourceIds = await makeMeaning.kb.eventStore.log.getAllResourceIds();

console.log(`Processing ${resourceIds.length} resources...`);

for (const rId of resourceIds) {
  const annotations = await AnnotationContext.getAllAnnotations(rId, kb);
  console.log(`${rId}: ${annotations.length} annotations`);
}
```

## Using the SDK (Recommended)

For most scripting use cases, the `@semiont/sdk` `SemiontClient` with verb namespaces is the simplest approach:

```typescript
import { SemiontClient } from '@semiont/sdk';
import { resourceId, annotationId } from '@semiont/core';

const semiont = await SemiontClient.signInHttp({
  baseUrl: 'http://localhost:4000',
  email,
  password,
});

// The SDK is RxJS-native, but its return values are PromiseLike — `await` works directly.

// Browse resources
const resource = await semiont.browse.resource(resourceId('doc-123'));
const content = await semiont.browse.resourceContent(resourceId('doc-123'));
const events = await semiont.browse.resourceEvents(resourceId('doc-123'));

// Mark annotations / register entity types
await semiont.mark.annotation({ /* CreateAnnotationInput: target, motivation, body */ });
await semiont.frame.addEntityType('Person');

// Gather LLM context
const context = await semiont.gather.annotation(annotationId('ann-1'), resourceId('doc-123'));

// Bind references
await semiont.bind.body(resourceId('doc-123'), annotationId('ann-1'), operations);
```

Use the context modules directly (`ResourceContext`, `AnnotationContext`, `GraphContext`) only when you need lower-level control.

## Differences from Direct Context Modules

| Aspect | SemiontClient (SDK) | Direct Context Modules |
|--------|------------------|----------------------|
| **Transport** | HTTP REST + SSE | Direct function calls |
| **Authentication** | JWT tokens via `getToken` | Not needed |
| **Events** | Observable return types | EventBus subscriptions |
| **Error handling** | HTTP status codes / Observable errors | Exceptions |
| **Deployment** | Backend server required | Standalone script |
| **API surface** | Full (all 8 verbs + auth, admin) | Low-level KB access |

## Troubleshooting

### "SEMIONT_ROOT environment variable is not set"

Set SEMIONT_ROOT before running:

```bash
export SEMIONT_ROOT=/path/to/your/project
tsx scripts/your-script.ts
```

### Script Hangs

Ensure you call `makeMeaning.stop()` and `eventBus.destroy()` in a `finally` block. Add a timeout as fallback:

```typescript
setTimeout(() => {
  console.error('Timeout - forcing exit');
  process.exit(1);
}, 10 * 60 * 1000);
```

### "Cannot find module" Errors

Run from the monorepo root with packages built:

```bash
npm run build:packages
tsx scripts/your-script.ts
```

## See Also

- [Architecture](./architecture.md) — Actor model and data flow
- [Examples](./examples.md) — Common use cases
- [Make-Meaning Service](../src/service.ts) — Service implementation
