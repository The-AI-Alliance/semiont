# A Knowledge Base in Your Own Process

`startMakeMeaning()` runs a knowledge base's record, and the five actors a client talks to, inside one process. There is no gateway and no network. This page is for the script or the test that wants that.

## When this is the right tool

Most programs should not do this. A program that works with a knowledge base uses [`@semiont/sdk`](../../sdk/README.md) against a running stack, where there is sign-in, a job queue, a graph and a vector index. [Usage](../../../docs/builder/Usage.md) starts there.

This fits a test of this package or of something built on it, and a script that reads or repairs a knowledge base's record where it lies.

**Never run it against a knowledge base whose stack is up.** The Archivist is the working tree's only writer, and a second process appending to the same log breaks that. Stop the stack first.

What a process started this way does not have:

| | |
|---|---|
| **Jobs** | There is no dispatcher and no worker. `mark.assist` and `yield.fromContext` create a job that nothing answers, and time out |
| **A graph projection** | There is no Weaver. With `graph: { type: 'memory' }` the graph stays empty, so `match.resources` and `gather.referencedBy` find nothing. Configured with a graph database, it reads whatever a Weaver wrote there |
| **A vector index** | There is no Smelter, so nothing is embedded. Semantic recall is empty, and a resource gather waits out `gather.settleTimeoutMs` before it goes on without it |
| **Sign-in** | The process acts as the one identity it states. A client over it has no `auth` and no `system` |
| **Uploads through the client** | `LocalContentTransport` does not implement `putBinary`, so `yield.resource` throws. [Creating a resource](#creating-a-resource) is how it is done here |

Reads from the views, and every write, work as they do in a stack.

## Starting it

```typescript
import { startMakeMeaning, type MakeMeaningConfig } from '@semiont/make-meaning';
import { EventBus } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { createProcessLogger } from '@semiont/observability/process-logger';

const project = new SemiontProject('/path/to/knowledge-base', {
  anchoredTextDir: process.env.SEMIONT_ANCHORED_TEXT_DIR!,
});

const inference = { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: process.env.ANTHROPIC_API_KEY! } as const;
const config: MakeMeaningConfig = {
  gather: { settleTimeoutMs: 15_000 },
  search: { semanticFloor: 0.6 },
  services: {
    graph: { platform: { type: 'posix' }, type: 'memory' },
    vectors: { type: 'memory' },
    embedding: { type: 'ollama', model: 'nomic-embed-text' },
  },
  actors: { gatherer: inference, matcher: inference },
  workers: { default: inference },
};

const eventBus = new EventBus();
const makeMeaning = await startMakeMeaning(project, config, eventBus, createProcessLogger('script'));
```

What the three inputs have to be:

- **The knowledge base** is a directory whose committed `.semiont/config` declares a `[site] domain`. A knowledge base acts under that identity, and one that declares none is refused.
- **`anchoredTextDir`** has no default. It is where text derived from PDFs is kept, and a script that guessed it would derive every document again on each run. A Semiont image sets `SEMIONT_ANCHORED_TEXT_DIR`; a script outside one names the directory itself.
- **`XDG_STATE_HOME`** has to be set in the environment. The views are written under it, and `SemiontProject` refuses to construct without it.

Nothing in the configuration is defaulted: the gather bound, the search floor, the vector store and the embedding provider are each stated. `makeMeaningConfigFrom` builds the same value from a configuration loaded with `loadEnvironmentConfig` (`@semiont/core/node`).

The caller makes the `EventBus` and keeps it. Every actor in the process shares it, and so does the client below.

## The client over it

`LocalTransport` and `LocalContentTransport` are the SDK's two transport contracts, in process. A `SemiontClient` over them is the same client an application uses, so everything in the SDK's documentation that is not in the table above applies.

```typescript
import { LocalTransport, LocalContentTransport, type MakeMeaningService } from '@semiont/make-meaning';
import { SemiontClient } from '@semiont/sdk';
import { resourceId, userId, type EventBus } from '@semiont/core';

declare const eventBus: EventBus;
declare const makeMeaning: MakeMeaningService;

const client = new SemiontClient(
  new LocalTransport({ eventBus, userId: userId('did:web:example.org:users:alice') }),
  new LocalContentTransport(makeMeaning.knowledgeSystem.kb),
);

const doc = resourceId('doc-123');
await client.frame.addEntityType('Person');
await client.mark.annotation({
  motivation: 'highlighting',
  target: { source: doc, selector: { type: 'TextQuoteSelector', exact: 'a passage' } },
});
const annotations = await client.browse.annotations(doc).fresh();
```

The `userId` is who the process acts as. It is stamped on every emit, as the gateway stamps the identity it verified, and the actors trust nothing else.

## Creating a resource

The bytes go into the working tree first. `ResourceOperations.createResource` then records the resource and resolves to its id once the Stower has appended it.

```typescript
import { asBusRequestPrimitive, type MakeMeaningService } from '@semiont/make-meaning';
import { ResourceOperations, deriveStorageUri, userId, type EventBus } from '@semiont/core';

declare const eventBus: EventBus;
declare const makeMeaning: MakeMeaningService;

const { kb } = makeMeaning.knowledgeSystem;
const stored = await kb.content.store(
  Buffer.from('# Hello\n\nA first document.\n'),
  deriveStorageUri('Hello', 'text/markdown'),
);

const id = await ResourceOperations.createResource(
  {
    name: 'Hello',
    storageUri: stored.storageUri,
    contentChecksum: stored.checksum,
    byteSize: stored.byteSize,
    format: 'text/markdown',
    language: 'en',
  },
  { did: userId('did:web:example.org:users:alice'), roles: [] },
  asBusRequestPrimitive(eventBus),
);
```

`asBusRequestPrimitive(eventBus)` gives the in-process bus the request and reply shape `busRequest` (`@semiont/core`) works over, for any channel the client has no method for.

## Below the client

`makeMeaning.knowledgeSystem.kb` holds the stores themselves, which is what a maintenance script is usually after. [Architecture](./architecture.md#knowledge-base) lists them, and the [context modules](./architecture.md#context-modules) are the readers the actors use over them.

```typescript
import { AnnotationContext, type MakeMeaningService } from '@semiont/make-meaning';
import { SYSTEM_SCOPE } from '@semiont/core';

declare const makeMeaning: MakeMeaningService;

const { kb } = makeMeaning.knowledgeSystem;

// The log also holds the system scope (the vocabulary and the people), which is not a resource.
const ids = (await kb.eventStore.log.getAllResourceIds()).filter((id) => id !== SYSTEM_SCOPE);

for (const id of ids) {
  const annotations = await AnnotationContext.getAllAnnotations(id, kb);
  console.log(`${id}: ${annotations.length} annotations`);
}
```

Read through `kb`, and write through the bus. The Stower is the only code that appends to the log, and a script that called the event store itself would skip what the Stower checks and derives.

## Stopping

```typescript
import type { MakeMeaningService } from '@semiont/make-meaning';
import type { EventBus } from '@semiont/core';

declare const eventBus: EventBus;
declare const makeMeaning: MakeMeaningService;

await makeMeaning.stop();
eventBus.destroy();
```

A script that does not stop the service keeps the process alive: the actors hold subscriptions. Put both calls in a `finally`.

## When it does not start

| It says | Why |
|---|---|
| `XDG_STATE_HOME is not set` | The state tree has no default. Set it before the script runs |
| That the knowledge base declares no domain | `.semiont/config` has no `[site] domain`. Add one and commit it |
| That a connection timed out | A store in `services` is not answering. Each connect is bounded at 60 seconds. The `ollama` embedding provider needs Ollama running, with the model pulled |
