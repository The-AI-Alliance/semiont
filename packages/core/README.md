# @semiont/core

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+core%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=core)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=core)
[![npm version](https://img.shields.io/npm/v/@semiont/core.svg)](https://www.npmjs.com/package/@semiont/core)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/core.svg)](https://www.npmjs.com/package/@semiont/core)
[![License](https://img.shields.io/npm/l/@semiont/core.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

What every TypeScript package in Semiont stands on: the protocol's types, generated from the [spec](../../specs/README.md), and the logic that has to be the same wherever it runs. That is ids, the event bus and its channels, the transport contract, annotations and how they are anchored, and identities.

## Who uses it

Every other TypeScript package, the Browser, and the conformance and end-to-end suites. It depends on no other Semiont package.

**Building an application?** Use [`@semiont/sdk`](../sdk/README.md). It re-exports what an application needs from here, the id constructors and the error types among them, and an application rarely imports this package by name.

## What is in it

| Area | What | Where |
|---|---|---|
| The protocol's types | `components`, `paths`, `operations`: every request, response and schema | `src/types.ts`, generated when the package is built and not committed |
| Ids | `ResourceId`, `AnnotationId`, `JobId`, `UserId`, each with a constructor that holds text to its rule and a guard that asks without throwing | `src/generated/identifiers.ts`, generated |
| The bus | `EventBus`, the `EventMap` of every channel and its payload, and `busRequest` for a request and its reply | [src/event-bus.ts](src/event-bus.ts), [src/bus-protocol.ts](src/bus-protocol.ts), [src/bus-request.ts](src/bus-request.ts) |
| The record's events | `PersistedEvent`, `StoredEvent`, and the list of every event type a knowledge base records | [src/persisted-events.ts](src/persisted-events.ts), [src/event-base.ts](src/event-base.ts) |
| The transport contract | `ITransport`, `IContentTransport`, `IGatewayOperations`: what a client needs of the wire | [src/transport.ts](src/transport.ts) |
| Annotations | Building one, applying changes to its body, and reading its target, its selectors and its links | [src/annotation-assembly.ts](src/annotation-assembly.ts), [src/web-annotation-utils.ts](src/web-annotation-utils.ts) |
| Anchoring | Finding an annotation again after its text changed, and the geometry of text on a PDF page (`locate`, `textUnder`) | [src/anchor-annotation.ts](src/anchor-annotation.ts), [src/pdf-anchoring.ts](src/pdf-anchoring.ts) |
| Identity | DIDs for people, software and a knowledge base itself, and `attribution`, which says who a record is attributed to | [src/did-utils.ts](src/did-utils.ts) |
| Resource writes | `ResourceOperations`: how creating or cloning a resource maps onto the bus | [src/resource-operations.ts](src/resource-operations.ts) |
| Media types | Which types a knowledge base admits, and what can be done with each | [src/media-types.ts](src/media-types.ts) |
| Shared rules | Error codes, timing, retry and the cache's refresh table, the same for every SDK | `src/generated/`, [src/retry.ts](src/retry.ts) |
| Configuration | The loader of a knowledge base's configuration | [src/config/](src/config/) |

The main import runs in a browser. What cannot is on a subpath:

| Import | |
|---|---|
| `@semiont/core/node` | `SemiontProject`, a knowledge base on a filesystem, and `loadEnvironmentConfig` |
| `@semiont/core/openapi` | The spec's validators, compiled when the package is built, and its limits |
| `@semiont/core/identity` | `IssuerVerifier`: verifying the tokens of an OIDC issuer |
| `@semiont/core/testing` | The test doubles every layer shares |
| `@semiont/core/testing/axioms` | Property-based harnesses for state units and transports. They need `fast-check` |
| `@semiont/core/testing/issuer` | An OIDC issuer in one process, for tests that verify tokens |

## Example

```typescript
import { resourceId, isResourceId, userToDid, didToAgent } from '@semiont/core';

// An id is made by its constructor, which throws for text its rule refuses.
const id = resourceId('5bcd259ab1464cf68a556bbad21f513f');

// A guard asks the same rule without throwing.
const typed = isResourceId('https://kb.example/resources/5bcd');   // false: a URI is not an id

// A person's DID, from the subject their issuer asserts.
const did = userToDid({ subject: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', domain: 'example.org' });
const agent = didToAgent(did);   // { '@type': 'Person', '@id': did }, with no name: a DID carries none
```

## What a change must keep

- **The spec is the source.** `src/types.ts`, [src/bus-protocol.ts](src/bus-protocol.ts) and everything in `src/generated/` are generated from [`specs/src`](../../specs/src/), and never edited. Only `bus-protocol.ts` is committed; the rest is made when the package is built. Change the spec, then run `npm run generate:openapi --workspace=@semiont/core`. A type written by hand that restates a schema is a second copy that nothing keeps true: use the spec's type, under the spec's name.
- **The main import runs in a browser.** It uses no Node builtin. The validators and the token verifier are reachable only by their subpaths, because of the weight they would add to every bundle, and `npm run lint:core-subpaths` fails a re-export of either from the root.
- **It depends on no other Semiont package.** Everything else depends on it.
- **An id is made only by its constructor or its guard.** One kind is never assignable to another.
- **Who did something is worked out in one place.** `attribution()` builds a record's `creator`, `generator` and `wasAttributedTo` from identities the gateway verified. `npm run lint:attribution` fails a second place that builds them.
- **Its tests read every package.** Three census tests here walk the source of all of `packages/` and `apps/`, tests included, so a change somewhere else can fail this package's suite.

## Documentation

- [API tour](docs/API.md): each area, with examples.
- [Utilities](docs/Utilities.md): the small helpers.
- [The spec](../../specs/README.md), which this package is generated from.

## License

Apache-2.0
