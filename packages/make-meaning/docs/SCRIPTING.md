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
    // makeMeaning.kb          — Knowledge Base (views, content, graph, eventStore)
    // makeMeaning.jobQueue    — Job queue
    // makeMeaning.stower      — Write gateway actor
    // makeMeaning.gatherer    — Context assembly actor
    // makeMeaning.binder      — Entity resolution actor
    // makeMeaning.graphDb     — Graph database

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

## Differences from HTTP API

| Aspect | HTTP API | Direct Scripting |
|--------|----------|-----------------|
| **Transport** | HTTP REST + SSE | Direct function calls |
| **Authentication** | JWT tokens, sessions | Not needed |
| **Events** | SSE stream to frontend | EventBus subscriptions |
| **Error handling** | HTTP status codes | Exceptions |
| **Deployment** | Backend server required | Standalone script |

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
