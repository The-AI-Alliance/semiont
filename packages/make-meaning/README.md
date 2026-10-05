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

**Building an application?** Use [`@semiont/sdk`](../sdk/README.md) against a running knowledge base.

## What is in it

| | |
|---|---|
| `Gatherer`, `Matcher` | Context assembled around a resource or an annotation, and candidates found for a reference |
| `Smelter`, `smelterFanIn` | The pipeline that keeps the vector index in step with the record |
| `ResourceContext`, `AnnotationContext`, `AnnotationGather`, `GraphContext`, `LLMContext` | What the actors are built from: the readers that assemble context |
| `makeMeaningConfigFrom` | A `MakeMeaningConfig` from a knowledge base's loaded configuration |

The Archivist's actors (Stower, Browser, CloneTokenManager) and the Weaver are not exported. They run only from their entry points; the Archivist's code is `src/archivist/`, and nothing outside that directory imports from it.

## What a change must keep

- **The bus is the whole interface.** An actor has no business methods, only `initialize()` and `stop()`. Whatever a client can do, it does by putting an event on the bus.
- **One writer.** The Stower is the only code that appends to the record. The Stower and the Browser run in one process on purpose, so that a read never races the write it follows, and the Archivist is the working tree's only writer for the same reason.
- **Each derived store has one owner.** The views are materialized inside the append. The graph is the Weaver's: it catches up from its checkpoint when it starts, and rebuilds from nothing only when told to (`weave:rebuild`). The vector index is the Smelter's, and is reconciled against the record when it starts.
- **Who did something is derived, never taken from a payload.** The Stower works out an annotation's creator and generator from the identity the gateway verified, and refuses a payload that names one.
- **A name is given to a person in one place.** Records carry a DID. The Browser fills in what a person is called as a reply goes out.
- **Entity types are a controlled vocabulary.** The Stower refuses one that the knowledge base has not registered.
- **A knowledge base acts as itself.** It seeds its default entity types under its own DID, `did:web:<[site] domain>`, which is why one that declares no domain is refused.

## Documentation

- [Architecture](docs/architecture.md): what each actor answers, who a write is attributed to, the knowledge base's stores, the context modules, the order things start in.
- [The actor model](../../docs/architecture/ACTOR-MODEL.md): the design this implements.
- [Workers](../jobs/docs/Workers.md): the worker, in `@semiont/jobs`.

## License

Apache-2.0
