# @semiont/make-meaning

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+make-meaning%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=make-meaning)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=make-meaning)
[![npm version](https://img.shields.io/npm/v/@semiont/make-meaning.svg)](https://www.npmjs.com/package/@semiont/make-meaning)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/make-meaning.svg)](https://www.npmjs.com/package/@semiont/make-meaning)
[![License](https://img.shields.io/npm/l/@semiont/make-meaning.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The actors that search a knowledge base's record and the stores derived from it, over the bus. One of Semiont's services, the Librarian, is an entry point of this package.

## Who uses it

| Service | Entry point | Runs |
|---|---|---|
| **Librarian** | `@semiont/make-meaning/librarian-main` | Gatherer, Matcher |

The entry point composes exactly what the Librarian owns. The gateway composes nothing from this package: it verifies tokens and relays the bus. The record is the [Archivist](../../apps/archivist/README.md)'s. The job queue is the [dispatcher](../../apps/dispatcher/README.md)'s, and jobs are run by the [Worker](../../apps/worker/README.md). What each service is for is in the [service catalogue](../../docs/operator/services/OVERVIEW.md).

**Building an application?** Use [`@semiont/sdk`](../sdk/README.md) against a running knowledge base.

## What is in it

| | |
|---|---|
| `Gatherer`, `Matcher` | Context assembled around a resource or an annotation, and candidates found for a reference |
| `ResourceContext`, `AnnotationContext`, `AnnotationGather`, `GraphContext`, `LLMContext` | What the actors are built from: the readers that assemble context |
| `makeMeaningConfigFrom` | A `MakeMeaningConfig` from a knowledge base's loaded configuration |

## What a change must keep

- **The bus is the whole interface.** An actor has no business methods, only `initialize()` and `stop()`. Whatever a client can do, it does by putting an event on the bus.
- **Nothing here writes the record.** The Archivist is the only writer of the event log, the views and the working tree. The Librarian reads views from the state tree, bytes from the Archivist, and a resource's anchored text from the gateway.
- **Each derived store has one owner.** The graph is the [Weaver](../../apps/weaver/README.md)'s and the vector index is the [Smelter](../../apps/smelter/README.md)'s. Neither service is part of this package: the Librarian only reads what they keep.
- **A name is given to a person in one place.** Records carry a DID. A reply that mentions a person is named from the people projection as it goes out.
- **A read waits for the store it reads, within a bound.** A gather that outlasts the bound goes on without that part and counts the degrade.

## Documentation

- [Architecture](docs/architecture.md): what each actor answers, what each service reads and writes, the context modules, the order things start in.
- [The actor model](../../docs/architecture/ACTOR-MODEL.md): the design this implements.
- [The Worker service](../../docs/protocol/WORKER-SERVICE.md): what the service that runs jobs does.

## License

Apache-2.0
