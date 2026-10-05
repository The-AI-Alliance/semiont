# Direct Scripting Guide

Use `@semiont/make-meaning` directly in TypeScript scripts without requiring a running HTTP gateway.

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
import { SemiontProject } from '@semiont/core/node';
import { createProcessLogger } from '@semiont/observability/process-logger';
import { startMakeMeaning, type MakeMeaningConfig } from '@semiont/make-meaning';

async function main() {
  // anchoredTextDir is REQUIRED and has no default. It names where this KB's
  // derived anchored-text (OCR) store lives. A default would let a script that
  // forgot it write a full OCR pass per representation into a directory nobody
  // reads, lose it on exit, and re-derive it forever — silent, expensive, and
  // indistinguishable from working. Containers get it from the image
  // (SEMIONT_ANCHORED_TEXT_DIR=/anchored-text, mounted by `semiont start`);
  // a script running outside one names it itself.
  //
  // SEMIONT_ROOT names a knowledge base: its committed .semiont/config
  // declares a [site] domain, the identity the knowledge base acts under.
  // startMakeMeaning refuses one that declares none.
  const project = new SemiontProject(process.env.SEMIONT_ROOT!, {
    anchoredTextDir: process.env.SEMIONT_ANCHORED_TEXT_DIR!,
  });
  const logger = createProcessLogger('script');

  // Hand-built here; `makeMeaningConfigFrom` derives the same shape from a
  // config loaded with `loadEnvironmentConfig` (`@semiont/core/node`)
  const config: MakeMeaningConfig = {
    // The resource-gather settle bound (semanticContext read-your-writes
    // barrier). TOML deployments set it at
    // [environments.<env>.make-meaning.gather]; hand-built configs state
    // their policy explicitly — there is no in-code default.
    gather: { settleTimeoutMs: 15_000 }, search: { semanticFloor: 0.6 },
    services: {
      graph: { platform: { type: 'posix' }, type: 'memory' },
      vectors: { type: 'memory' },
      embedding: { type: 'ollama', model: 'nomic-embed-text' },
    },
    actors: {
      gatherer: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: process.env.ANTHROPIC_API_KEY! },
      matcher:  { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: process.env.ANTHROPIC_API_KEY! },
    },
    workers: {
      default: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: process.env.ANTHROPIC_API_KEY! },
    },
  };

  // EventBus is created outside make-meaning
  const eventBus = new EventBus();

  // Start make-meaning service (initializes KB and actors)
  const makeMeaning = await startMakeMeaning(project, config, eventBus, logger);

  try {
    // Access components:
    // makeMeaning.knowledgeSystem.kb                — Knowledge Base (eventStore, views, content, anchoredText, graph, weaveProgress, smeltProgress, vectors)
    // makeMeaning.knowledgeSystem.stower            — Write gateway actor
    // makeMeaning.knowledgeSystem.browser           — Read actor (browse queries, directory listings)
    // makeMeaning.knowledgeSystem.gatherer          — Context assembly actor
    // makeMeaning.knowledgeSystem.matcher           — Search/link actor
    // makeMeaning.knowledgeSystem.cloneTokenManager — Clone token actor

    console.log('Script running...');
  } finally {
    await makeMeaning.stop();
    eventBus.destroy();
  }
}

main().catch(console.error);
```

### Running

`SemiontProject` composes the state tree (materialized views and projections) under `XDG_STATE_HOME`, which has no default.

```bash
export SEMIONT_ROOT=/path/to/your/project
export SEMIONT_ANCHORED_TEXT_DIR=/path/to/anchored-text
export XDG_STATE_HOME=/path/to/state
tsx scripts/your-script.ts
```

## Creating Resources

Content is written to the content store first; `createResource` then registers it and returns the new `ResourceId`:

```typescript
import { ResourceOperations, deriveStorageUri, userId } from '@semiont/core';
import { asBusRequestPrimitive } from '@semiont/make-meaning';

const kb = makeMeaning.knowledgeSystem.kb;
const uri = deriveStorageUri('my-document', 'text/plain');
const stored = await kb.content.store(Buffer.from('Document content here'), uri);

const rId = await ResourceOperations.createResource(
  {
    name: 'My Document',
    storageUri: stored.storageUri,
    contentChecksum: stored.checksum,
    byteSize: stored.byteSize,
    format: 'text/plain',
    language: 'en',
  },
  { did: userId('did:web:example.com:users:script-user'), roles: [] },
  asBusRequestPrimitive(eventBus),
);

console.log(`Created: ${rId}`);
```

## Jobs

The in-process knowledge base runs no jobs: the job queue belongs to the dispatcher, a service of the
stack, and jobs are run by workers against it. A script that runs jobs — annotation detection,
generation — runs the stack and uses the SDK: `semiont.mark` and `semiont.yield` start them, and
`semiont.job` follows and cancels them (see [Job Workers](./job-workers.md)).

## Querying the Knowledge Base

```typescript
import { ResourceContext, AnnotationContext, GraphContext } from '@semiont/make-meaning';

const { kb } = makeMeaning.knowledgeSystem;

// Get resource metadata
const resource = await ResourceContext.getResourceMetadata(resourceId, kb);

// Get annotations
const annotations = await AnnotationContext.getAllAnnotations(resourceId, kb);

// Search resources via graph — whatever a Weaver has projected into the
// configured graph: the Weaver is a standalone service, not started here
const { resources: results } = await kb.graph.listResources({ search: 'query text', limit: 10 });

// Get graph stats
const stats = await kb.graph.getStats();
console.log(`Total resources: ${stats.resourceCount}`);
```

## Batch Processing

```typescript
import { SYSTEM_SCOPE } from '@semiont/core';

// The log also holds the system scope (vocabulary and people), which is no resource
const resourceIds = (await makeMeaning.knowledgeSystem.kb.eventStore.log.getAllResourceIds())
  .filter((rId) => rId !== SYSTEM_SCOPE);

console.log(`Processing ${resourceIds.length} resources...`);

for (const rId of resourceIds) {
  const annotations = await AnnotationContext.getAllAnnotations(rId, kb);
  console.log(`${rId}: ${annotations.length} annotations`);
}
```

## Using the SDK (Recommended)

For most scripting use cases, the `@semiont/sdk` `SemiontClient` with verb namespaces is the simplest approach:

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

// Browse resources
const resource = await semiont.browse.resource(resourceId('doc-123')).fresh();
const content = await semiont.browse.resourceContent(resourceId('doc-123'));
const events = await semiont.browse.resourceEvents(resourceId('doc-123'));

// Mark annotations / register entity types
await semiont.mark.annotation({
  motivation: 'highlighting',
  target: { source: resourceId('doc-123'), selector: { type: 'TextQuoteSelector', exact: 'a passage' } },
});
await semiont.frame.addEntityType('Person');

// Gather LLM context
const { response: context } = await semiont.gather.annotation(resourceId('doc-123'), annotationId('ann-1'));

// Bind references
await semiont.bind.body(resourceId('doc-123'), annotationId('ann-1'), [
  { op: 'add', item: { type: 'SpecificResource', source: resourceId('doc-456'), purpose: 'linking' } },
]);
```

Use the context modules directly (`ResourceContext`, `AnnotationContext`, `GraphContext`) only when you need lower-level control.

## Differences from Direct Context Modules

| Aspect | SemiontClient (SDK) | Direct Context Modules |
|--------|------------------|----------------------|
| **Transport** | HTTP REST + SSE | Direct function calls |
| **Authentication** | Sign-in at the knowledge base's issuer; the session keeps the token fresh | Not needed |
| **Events** | Observable return types | EventBus subscriptions |
| **Error handling** | HTTP status codes / Observable errors | Exceptions |
| **Deployment** | Gateway server required | Standalone script |
| **API surface** | Full (all 8 verbs + job, auth, system) | Low-level KB access |

## Troubleshooting

### "XDG_STATE_HOME is not set"

`SemiontProject` refuses to construct without a state tree. Set XDG_STATE_HOME before running:

```bash
export XDG_STATE_HOME=/path/to/state
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
