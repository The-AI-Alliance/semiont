# @semiont/make-meaning

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+make-meaning%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=make-meaning)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=make-meaning)
[![npm version](https://img.shields.io/npm/v/@semiont/make-meaning.svg)](https://www.npmjs.com/package/@semiont/make-meaning)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/make-meaning.svg)](https://www.npmjs.com/package/@semiont/make-meaning)
[![License](https://img.shields.io/npm/l/@semiont/make-meaning.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The knowledge system: a knowledge base's record and the stores derived from it, and the actors that serve them over the bus. Four of Semiont's services are entry points of this package.

## Who uses it

| Service | Entry point | Runs |
|---|---|---|
| **Archivist** | `@semiont/make-meaning/archivist-main` | Stower, Browser, CloneTokenManager |
| **Librarian** | `@semiont/make-meaning/librarian-main` | Gatherer, Matcher |
| **Smelter** | `@semiont/make-meaning/smelter-main` | Smelter |
| **Weaver** | `@semiont/make-meaning/weaver-main` | Weaver |

Each entry point composes exactly what its service owns. The gateway composes nothing from this package: it verifies tokens and relays the bus. The job queue is the [dispatcher](../../apps/dispatcher/README.md)'s, and jobs are run by [`@semiont/jobs`](../jobs/README.md). What each service is for is in the [service catalogue](../../docs/operator/services/OVERVIEW.md).

`startMakeMeaning()` puts the five actors a client talks to (Stower, Browser, CloneTokenManager, Gatherer, Matcher) in one process, for scripts and tests. It starts no Weaver, no Smelter and no worker.

**Building an application?** Use [`@semiont/sdk`](../sdk/README.md) against a running knowledge base. This package is for the one case where a program wants a knowledge base in its own process, with no gateway: [Scripting](docs/SCRIPTING.md).

## What is in it

| | |
|---|---|
| `startMakeMeaning(project, config, eventBus, logger)` | A knowledge system in one process. It refuses a knowledge base that declares no `[site] domain` |
| `LocalTransport`, `LocalContentTransport` | The SDK's transport contracts, in process: a `SemiontClient` over them needs no network |
| `Stower` | The one writer. Every change to the record goes through it |
| `Browser` | Every read of the record and its views, and the names of the people a reply mentions |
| `Gatherer`, `Matcher` | Context assembled around a resource or an annotation, and candidates found for a reference |
| `CloneTokenManager` | The tokens a resource is cloned with |
| `Smelter`, `smelterFanIn` | The pipeline that keeps the vector index in step with the record |
| `createKnowledgeBase`, `KnowledgeBase`, `KnowledgeSystem` | The stores as one value, and the stores with their actors |
| `AnnotationOperations`, `ResourceContext`, `AnnotationContext`, `AnnotationGather`, `GraphContext`, `LLMContext` | What the actors are built from: annotation writes, and the readers that assemble context |
| `makeMeaningConfigFrom` | A `MakeMeaningConfig` from a knowledge base's loaded configuration |

The Weaver is not exported. It runs only from its entry point.

## Example

```typescript
import { startMakeMeaning, LocalTransport, LocalContentTransport, type MakeMeaningConfig } from '@semiont/make-meaning';
import { SemiontClient } from '@semiont/sdk';
import { EventBus, userId, type Logger } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';

declare const config: MakeMeaningConfig;
declare const logger: Logger;

const project = new SemiontProject('/path/to/knowledge-base', {
  anchoredTextDir: process.env.SEMIONT_ANCHORED_TEXT_DIR!,
});
const eventBus = new EventBus();
const makeMeaning = await startMakeMeaning(project, config, eventBus, logger);

// The SDK's client, over this process's bus.
const client = new SemiontClient(
  new LocalTransport({ eventBus, userId: userId('did:web:example.org:users:alice') }),
  new LocalContentTransport(makeMeaning.knowledgeSystem.kb),
);
const entityTypes = await client.browse.entityTypes().fresh();

await makeMeaning.stop();
```

## What a change must keep

- **The bus is the whole interface.** An actor has no business methods, only `initialize()` and `stop()`. Whatever a client can do, it does by putting an event on the bus, in one process or across services.
- **One writer.** The Stower is the only code that appends to the record. The Stower and the Browser run in one process on purpose, so that a read never races the write it follows, and the Archivist is the working tree's only writer for the same reason.
- **Each derived store has one owner.** The views are materialized inside the append. The graph is the Weaver's: it catches up from its checkpoint when it starts, and rebuilds from nothing only when told to (`weave:rebuild`). The vector index is the Smelter's, and is reconciled against the record when it starts.
- **Who did something is derived, never taken from a payload.** The Stower works out an annotation's creator and generator from the identity the gateway verified, and refuses a payload that names one.
- **A name is given to a person in one place.** Records carry a DID. The Browser fills in what a person is called as a reply goes out.
- **Entity types are a controlled vocabulary.** The Stower refuses one that the knowledge base has not registered.
- **A knowledge base acts as itself.** It seeds its default entity types under its own DID, `did:web:<[site] domain>`, which is why one that declares no domain is refused.

## Documentation

- [Architecture](docs/architecture.md): what each actor answers, who a write is attributed to, the knowledge base's stores, the context modules, the order things start in.
- [Scripting](docs/SCRIPTING.md): a knowledge base in your own process, and what such a process does not have.
- [The actor model](../../docs/architecture/ACTOR-MODEL.md): the design this implements.
- [Workers](../jobs/docs/Workers.md): the worker, in `@semiont/jobs`.

## License

Apache-2.0
