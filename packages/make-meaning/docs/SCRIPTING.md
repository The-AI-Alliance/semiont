# Direct Scripting Guide for @semiont/make-meaning

This guide explains how to use `@semiont/make-meaning` directly in TypeScript scripts without requiring a running HTTP backend.

## Table of Contents

- [Overview](#overview)
- [When to Use Direct Scripting](#when-to-use-direct-scripting)
- [Prerequisites](#prerequisites)
- [Basic Setup](#basic-setup)
- [Core Concepts](#core-concepts)
  - [EventBus and Resource Scoping](#eventbus-and-resource-scoping)
  - [Event Types](#event-types)
  - [Job Lifecycle](#job-lifecycle)
- [Common Patterns](#common-patterns)
  - [Creating Resources](#creating-resources)
  - [Detecting Entities](#detecting-entities)
  - [Querying the Knowledge Graph](#querying-the-knowledge-graph)
  - [Batch Processing](#batch-processing)
- [Complete Examples](#complete-examples)
- [Differences from HTTP API](#differences-from-http-api)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

## Overview

The make-meaning package provides all the business logic for resource processing, entity detection, and knowledge graph management. Traditionally, these capabilities are accessed via the HTTP backend API. However, for scripts, automation, and testing, you can call make-meaning directly.

**Direct scripting gives you:**

- No HTTP overhead - direct function calls
- Full subsystem access - EventStore, RepStore, JobQueue, GraphDB
- Real-time events - resource-scoped EventBus for progress monitoring
- Simplified deployment - no backend server required

## When to Use Direct Scripting

Use direct scripting when you need to:

- **Batch processing**: Analyze or modify multiple resources efficiently
- **Data migration**: Import resources from external systems
- **Custom workflows**: Implement domain-specific automation
- **Testing**: Write integration tests without HTTP layer
- **Analysis**: Extract insights from the knowledge graph
- **Maintenance**: Rebuild projections or reprocess content

**Don't use direct scripting for:**

- **Web frontend**: Use `@semiont/api-client` with HTTP backend
- **External integrations**: Use the REST API for better decoupling
- **Real-time user interactions**: HTTP backend provides auth, sessions, etc.

## Prerequisites

### Environment Requirements

1. **Node.js**: v18+ with ESM support
2. **SEMIONT_ROOT**: Environment variable pointing to your project directory
3. **Environment config**: Valid configuration in `environments/{env}.json`

### Dependencies

Your script needs access to:

```json
{
  "dependencies": {
    "@semiont/core": "workspace:*",
    "@semiont/make-meaning": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.7.0",
    "typescript": "^5.6.3"
  }
}
```

### Project Structure

```
your-project/
├── semiont.json                     # Base configuration
├── environments/
│   ├── local.json                   # Local environment config
│   ├── production.json              # Production config
│   └── test.json                    # Test config
└── scripts/
    └── your-script.ts               # Your automation script
```

## Basic Setup

### Minimal Script Template

```typescript
#!/usr/bin/env tsx
/**
 * Example Script
 *
 * Brief description of what this script does.
 */

import { EventBus } from '@semiont/core';
import { startMakeMeaning } from '@semiont/make-meaning';
import { loadEnvironmentConfig, findProjectRoot } from '@semiont/cli/config-loader';

async function main() {
  // 1. Load configuration
  const projectRoot = findProjectRoot();
  const environment = process.env.SEMIONT_ENV || 'local';
  const config = loadEnvironmentConfig(projectRoot, environment);

  // 2. Create EventBus for monitoring
  const eventBus = new EventBus();

  // 3. Start make-meaning service
  const makeMeaning = await startMakeMeaning(config, eventBus);

  try {
    // 4. Your script logic goes here
    console.log('Script running...');

    // Access subsystems:
    // - makeMeaning.eventStore  (domain events)
    // - makeMeaning.repStore    (content storage)
    // - makeMeaning.jobQueue    (async jobs)
    // - makeMeaning.graphDb     (knowledge graph)

  } finally {
    // 5. Cleanup
    await makeMeaning.stop();
    eventBus.destroy();
  }
}

main().catch(console.error);
```

### Running the Script

```bash
# Set SEMIONT_ROOT
export SEMIONT_ROOT=/path/to/your/project

# Run with tsx
tsx scripts/your-script.ts

# Or add to package.json scripts
npm run script:your-name
```

## Core Concepts

### EventBus and Resource Scoping

The EventBus is the primary communication layer for monitoring job progress and domain events.

**Key principle**: All events are scoped to a specific resource using `eventBus.scope(resourceId)`.

```typescript
const eventBus = new EventBus();

// Create resource-scoped bus
const resourceBus = eventBus.scope('resource-123');

// Subscribe to events for this resource only
resourceBus.get('detection:progress').subscribe(progress => {
  console.log(`Progress: ${progress.percentage}%`);
});

// Events from resource-456 won't reach this subscription
```

### Event Types

There are two categories of events:

#### 1. Domain Events (Persisted)

Written to EventStore and auto-published to EventBus:

- `job.started` - Job execution began
- `job.progress` - Progress snapshot
- `job.completed` - Job finished successfully
- `job.failed` - Job encountered error
- `annotation.added` - Annotation created
- `resource.created` - Resource created
- `resource.updated` - Resource modified

Access via EventStore or generic channel:

```typescript
const resourceBus = eventBus.scope(resourceId);

// Generic channel for all domain events
resourceBus.get('make-meaning:event').subscribe(event => {
  console.log(`Domain event: ${event.type}`);
});
```

#### 2. Progress Events (Ephemeral)

Real-time progress notifications, not persisted:

- `detection:started` - Detection job started
- `detection:progress` - Detection progress update
- `detection:completed` - Detection finished
- `detection:failed` - Detection failed
- `generation:started` - Generation job started
- `generation:progress` - Generation progress
- `generation:completed` - Generation finished
- `job:queued` - Job added to queue

```typescript
// Subscribe to ephemeral progress events
resourceBus.get('detection:progress').subscribe(progress => {
  console.log(`Status: ${progress.status}`);
  console.log(`Message: ${progress.message}`);
  console.log(`Processed: ${progress.processedEntityTypes}/${progress.totalEntityTypes}`);
});
```

### Job Lifecycle

Jobs follow this lifecycle:

1. **Queued** - Job created and added to queue → `job:queued` event
2. **Started** - Worker picks up job → `job.started` + `detection:started` events
3. **Progress** - Job reports progress → `job.progress` + `detection:progress` events
4. **Complete** - Job finishes → `job.completed` + `detection:completed` events
   OR
5. **Failed** - Job encounters error → `job.failed` + `detection:failed` events

## Common Patterns

### Creating Resources

```typescript
import { ResourceOperations } from '@semiont/make-meaning';
import { userId } from '@semiont/core';

// Create a text resource
const result = await ResourceOperations.createResource(
  {
    name: 'My Document',
    content: Buffer.from('Document content here'),
    format: 'text/plain',
    language: 'en'
  },
  userId('script-user'),
  makeMeaning.eventStore,
  makeMeaning.repStore,
  config
);

console.log(`Created: ${result.resource['@id']}`);
```

### Detecting Entities

```typescript
import { entityType, userId, resourceId } from '@semiont/core';
import { getResourceId } from '@semiont/api-client';

// Create resource first
const result = await ResourceOperations.createResource(/* ... */);

// Get resource ID properly
const rId = getResourceId(result.resource);

// Subscribe to progress
const resourceBus = eventBus.scope(rId!);

resourceBus.get('detection:progress').subscribe(progress => {
  console.log(`[${progress.status}] ${progress.message || ''}`);
});

// Wait for completion
const completionPromise = new Promise(resolve => {
  resourceBus.get('detection:completed').subscribe(resolve);
});

// Enqueue detection job with proper structure
await makeMeaning.jobQueue.createJob({
  status: 'pending',
  metadata: {
    id: `job-${Date.now()}` as any,
    type: 'detection',
    userId: userId('script-user'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 1
  },
  params: {
    resourceId: resourceId(rId!),
    entityTypes: [
      entityType('Person'),
      entityType('Organization'),
      entityType('Location')
    ]
  }
});

// Wait for it to finish
await completionPromise;

console.log('Detection complete!');
```

### Querying the Knowledge Graph

```typescript
import { resourceUri, uriToResourceId } from '@semiont/core';

// Get a resource by URI
const result = await ResourceOperations.createResource(/* ... */);
const rUri = resourceUri(result.resource['@id']);
const resource = await makeMeaning.graphDb.getResource(rUri);

console.log(`Found resource: ${resource?.name}`);

// Get annotations for a resource
const rId = uriToResourceId(rUri);
const annotations = await makeMeaning.graphDb.getResourceAnnotations(rId);

console.log(`Found ${annotations.length} annotations`);

annotations.forEach(annotation => {
  console.log(`  ${annotation.motivation}: ${annotation['@id']}`);
});

// Search for resources
const searchResults = await makeMeaning.graphDb.searchResources('query text', 10);
searchResults.forEach(r => {
  console.log(`  - ${r.name} (${r.format})`);
});

// Get graph statistics
const stats = await makeMeaning.graphDb.getStats();
console.log(`Total resources: ${stats.resourceCount}`);
console.log(`Total annotations: ${stats.annotationCount}`);
```

### Batch Processing

```typescript
// Get all resources
const resourceIds = await makeMeaning.eventStore.log.getAllResourceIds();

console.log(`Processing ${resourceIds.length} resources...`);

// Track completions
const completions = new Map<string, boolean>();

// Subscribe to completion for each resource
for (const resourceId of resourceIds) {
  const resourceBus = eventBus.scope(resourceId);

  resourceBus.get('detection:completed').subscribe(() => {
    completions.set(resourceId, true);
    console.log(`✓ Completed: ${resourceId} (${completions.size}/${resourceIds.length})`);

    // Check if all done
    if (completions.size === resourceIds.length) {
      console.log('All resources processed!');
      process.exit(0);
    }
  });
}

// Enqueue all jobs
for (const rId of resourceIds) {
  await makeMeaning.jobQueue.createJob({
    status: 'pending',
    metadata: {
      id: `job-${Date.now()}-${rId}` as any,
      type: 'detection',
      userId: userId('batch'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 1
    },
    params: {
      resourceId: resourceId(rId),
      entityTypes: [entityType('Person')]
    }
  });
}

// Wait for completions (with timeout)
setTimeout(() => {
  console.log('Timeout reached');
  process.exit(1);
}, 10 * 60 * 1000); // 10 minutes
```

## Complete Examples

See the test examples in `packages/make-meaning/src/__tests__/scripting-examples/`:

1. **[create-resource.test.ts](../src/__tests__/scripting-examples/create-resource.test.ts)**
   - Basic resource creation
   - Subscribing to domain events
   - Batch resource creation pattern

2. **[detect-entities.test.ts](../src/__tests__/scripting-examples/detect-entities.test.ts)**
   - Entity detection with progress monitoring
   - Parallel detection across multiple resources
   - Custom progress tracking

3. **[query-graph.test.ts](../src/__tests__/scripting-examples/query-graph.test.ts)**
   - Direct graph database queries
   - Traversing relationships
   - Graph statistics

And the real-world example:

4. **[src/__tests__/scripting-examples/batch-detect-entities.test.ts](../src/__tests__/scripting-examples/batch-detect-entities.test.ts)**
   - Batch processing with completion tracking
   - Parallel resource processing
   - Progress monitoring across multiple resources
   - Success and failure handling

## Differences from HTTP API

| Aspect | HTTP API (`@semiont/api-client`) | Direct Scripting |
|--------|----------------------------------|------------------|
| **Transport** | HTTP REST + SSE | Direct function calls |
| **Authentication** | JWT tokens, sessions | Not needed |
| **Events** | SSE stream to frontend | EventBus subscriptions |
| **Error handling** | HTTP status codes | Exceptions |
| **Deployment** | Backend server required | Standalone script |
| **Access control** | Role-based (admin, user) | Direct subsystem access |
| **Use case** | Web frontend, external clients | Automation, testing, batch jobs |

### API Client Pattern (Frontend)

```typescript
// Frontend uses HTTP API client
import { SemiontApiClient } from '@semiont/api-client';

const client = new SemiontApiClient('http://localhost:4000');

// HTTP request
const resource = await client.resources.create({
  name: 'Doc',
  content: Buffer.from('...'),
  format: 'text/plain'
});

// SSE stream for progress
const stream = client.sse.detectReferences(
  resource.id,
  { entityTypes: ['Person'] },
  { auth, eventBus }
);
```

### Direct Scripting Pattern

```typescript
// Script calls make-meaning directly
import { startMakeMeaning, ResourceOperations } from '@semiont/make-meaning';

const makeMeaning = await startMakeMeaning(config, eventBus);

// Direct function call
const resource = await ResourceOperations.createResource(
  { name: 'Doc', content: Buffer.from('...'), format: 'text/plain' },
  userId('script'),
  makeMeaning.eventStore,
  makeMeaning.repStore,
  config
);

// EventBus subscription for progress
const rId = getResourceId(resource.resource);
const resourceBus = eventBus.scope(rId!);
resourceBus.get('detection:progress').subscribe(console.log);

// Enqueue job
await makeMeaning.jobQueue.createJob({
  status: 'pending',
  metadata: {
    id: `job-${Date.now()}` as any,
    type: 'detection',
    userId: userId('script'),
    created: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 1
  },
  params: {
    resourceId: resourceId(rId!),
    entityTypes: [entityType('Person')]
  }
});
```

## Best Practices

### 1. Always Clean Up

```typescript
try {
  // Your script logic
} finally {
  await makeMeaning.stop();
  eventBus.destroy();
}
```

### 2. Use Resource-Scoped EventBus

```typescript
// ✅ Good - scoped to specific resource
const resourceBus = eventBus.scope(resourceId);
resourceBus.get('detection:progress').subscribe(/* ... */);

// ❌ Bad - receives events from ALL resources
eventBus.get('detection:progress').subscribe(/* ... */);
```

### 3. Handle Errors Gracefully

```typescript
try {
  await makeMeaning.jobQueue.createJob(/* ... */);
} catch (error) {
  console.error('Failed to enqueue job:', error);
  process.exit(1);
}
```

### 4. Add Timeouts for Long-Running Jobs

```typescript
const completionPromise = new Promise(resolve => {
  resourceBus.get('detection:completed').subscribe(resolve);
});

await Promise.race([
  completionPromise,
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout')), 5 * 60 * 1000)
  )
]);
```

### 5. Use Environment Variables for Configuration

```typescript
const environment = process.env.SEMIONT_ENV || 'local';
const projectRoot = process.env.SEMIONT_ROOT || findProjectRoot();
```

### 6. Log Progress for Long-Running Scripts

```typescript
resourceBus.get('detection:progress').subscribe(progress => {
  console.log(`[${new Date().toISOString()}] ${progress.status}: ${progress.message}`);
});
```

## Troubleshooting

### "SEMIONT_ROOT environment variable is not set"

**Solution**: Set SEMIONT_ROOT before running your script:

```bash
export SEMIONT_ROOT=/path/to/your/project
tsx scripts/your-script.ts
```

Or use the semiont CLI which sets it automatically:

```bash
semiont run tsx scripts/your-script.ts
```

### "Configuration file not found"

**Solution**: Ensure your environment config exists:

```bash
ls -la $SEMIONT_ROOT/environments/local.json
```

Create one if missing or specify a different environment:

```bash
SEMIONT_ENV=production tsx scripts/your-script.ts
```

### Events Not Received

**Problem**: Subscribed to events but nothing fires.

**Solution**: Make sure you:

1. Subscribe BEFORE enqueuing the job
2. Use resource-scoped EventBus (`eventBus.scope(resourceId)`)
3. Check the event name matches exactly

```typescript
// ✅ Correct order
resourceBus.get('detection:completed').subscribe(/* ... */);
await makeMeaning.jobQueue.createJob(/* ... */);

// ❌ Wrong order - may miss events
await makeMeaning.jobQueue.createJob(/* ... */);
resourceBus.get('detection:completed').subscribe(/* ... */);
```

### Script Hangs and Never Exits

**Problem**: Script runs but never completes.

**Solution**: Ensure you:

1. Await all async operations
2. Call `makeMeaning.stop()` and `eventBus.destroy()`
3. Add a timeout as fallback

```typescript
// Add timeout
setTimeout(() => {
  console.error('Timeout - forcing exit');
  process.exit(1);
}, 10 * 60 * 1000); // 10 minutes
```

### "Cannot find module" Errors

**Problem**: TypeScript can't resolve `@semiont/*` imports.

**Solution**: Run from the monorepo root and ensure packages are built:

```bash
npm run build:packages
tsx scripts/your-script.ts
```

## Next Steps

- **Review the examples**: Start with `create-resource.test.ts` for basics, then explore `batch-detect-entities.test.ts` for parallel processing patterns
- **Run the tests**: Use `npm test` in the make-meaning package to see the examples in action
- **Explore subsystems**: Check EventStore, RepStore, and GraphDB APIs
- **Build your workflow**: Combine patterns for your specific use case

For more information, see:

- [EventBus Scoping Architecture](../../../EVENT-BUS-SCOPING.md)
- [Job Event Emission](../../../JOB-EVENTS.md)
- [Make-Meaning Service API](../src/service.ts)
