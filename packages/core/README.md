# @semiont/core

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+core%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=core)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=core)
[![npm version](https://img.shields.io/npm/v/@semiont/core.svg)](https://www.npmjs.com/package/@semiont/core)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/core.svg)](https://www.npmjs.com/package/@semiont/core)
[![License](https://img.shields.io/npm/l/@semiont/core.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Core types and domain logic for the Semiont semantic knowledge platform. This package is the **source of truth for OpenAPI types** and provides the shared domain layer: event-sourcing types, the EventBus, the transport contract, W3C Web Annotation utilities, anchoring, DIDs, and configuration loading.

> **Architecture Note**: This package generates TypeScript types from the OpenAPI specification. Every other TypeScript package in the monorepo imports them from here.

## Who Should Use This

- ✅ **Services** (`@semiont/make-meaning`, `@semiont/jobs`) - Server implementations, import types from core
- ✅ **Packages** - Other monorepo packages that need OpenAPI types, the EventBus, or the transport contract
- ✅ **Browser** - Types and pure utilities (the main barrel is browser-safe)

## Who Should Use `@semiont/core/node` Instead

Node.js-specific exports live in the `/node` subpath:

```typescript
import { SemiontProject, loadEnvironmentConfig } from '@semiont/core/node';
```

- **`SemiontProject`** — represents a project on the filesystem; resolves XDG directories, reads/writes files. Not usable in a browser.
- **`loadEnvironmentConfig`** — loads `~/.semiontconfig` + `.semiont/config` using `fs`/`os`/`path`. Not usable in a browser.

**Rule**: If your code runs in a browser or edge runtime, use `@semiont/core`. If it runs in Node.js and needs filesystem access, use `@semiont/core/node`.

## Who Should Use `@semiont/sdk` Instead

Application code talking to a Semiont gateway should use [`@semiont/sdk`](../sdk/), which provides `SemiontClient`, the verb-oriented namespaces, and the session layer. The SDK consumes the `ITransport` / `IContentTransport` contracts defined here; the HTTP implementations of those contracts live in [`@semiont/http-transport`](../http-transport/) and are re-exported by the SDK for convenience.

**Rule of thumb**: If you are making API calls, use `@semiont/sdk`. If you only need types and domain logic, use `@semiont/core`. Import from `@semiont/http-transport` directly only when constructing a transport stack by hand.

## Installation

Install the latest stable release from npm:

```bash
npm install @semiont/core
```

Or install the latest development build:

```bash
npm install @semiont/core@dev
```

## What's Included

### OpenAPI Types (Generated)

TypeScript types generated from the OpenAPI specification - the **source of truth** for all API schemas:

```typescript
import type { components, paths, operations } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];
type Resource = components['schemas']['ResourceDescriptor'];
type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
```

These types are generated during the build process:
```bash
npm run generate:openapi  # Bundles spec → generates types.ts
```

The spec's validators and limits come from the same bundle, on the
`@semiont/core/openapi` subpath:

```typescript
import { validators, operationLimits, itemLimits } from '@semiont/core/openapi';

validators.BusEmitRequest(body);                          // Ajv, compiled at build
operationLimits['POST /bus/emit'].claimSeconds;           // an operation's x-semiont-limits
itemLimits['BusSubscribeRequest.pendingReplies'];         // a property's maxItems
```

### Branded Types

Compile-time type safety for tokens and identifiers:

```typescript
import { accessToken, entityType } from '@semiont/core';

const token = accessToken('eyJhbGc...');
const eType = entityType('Person');
```

The four kinds of id are types of their own, generated from the spec ([`specs/src/identifiers/kinds.json`](../../specs/src/identifiers/kinds.json) and each kind's schema): `ResourceId`, `AnnotationId`, `JobId`, `UserId`. The spec's types carry them, so a property that holds an id is of its kind and one kind is not assignable to another. Each is made by its constructor (`resourceId`, `annotationId`, `jobId`, `userId`), which holds text to the kind's rule and throws a `TypeError` for text the rule refuses:

```typescript
import { resourceId, annotationId } from '@semiont/core';

const resource = resourceId('5bcd259ab1464cf68a556bbad21f513f');
resourceId('https://kb.example/resources/5bcd259ab1464cf68a556bbad21f513f'); // throws: a URI is not an id
const annotation = annotationId('a-1');
// client.mark.delete(annotation, resource) does not compile
```

Each kind also has a guard (`isResourceId`, `isAnnotationId`, `isJobId`, `isUserId`) that asks the same rule without throwing and narrows the text to the kind. Use it where text that is not an id is an ordinary answer, such as an address typed into a browser:

```typescript
import { isResourceId } from '@semiont/core';

if (!isResourceId(params.id)) return notFound();
const descriptor = await client.browse.resource(params.id).fresh();
```

A resource is named by its `ResourceId` wherever it is named: an annotation target's `source`, a reference body's `source`, a bus frame's `scope`, and a description's `wasDerivedFrom`.

### Event Sourcing Types

The persisted event catalog — every event type written to the JSONL event log, discriminated on `type` and namespaced by concern (`yield:*` resource lifecycle, `mark:*` annotations and tags, `frame:*` schema registration, `person:*` display names, `job:*` job lifecycle):

```typescript
import type {
  PersistedEvent,
  PersistedEventType,
  EventOfType,
  EventInput,
  StoredEvent,
  EventMetadata,
  BodyOperation,
  ResourceAnnotations,
} from '@semiont/core';
import { PERSISTED_EVENT_TYPES } from '@semiont/core';

function handle(event: PersistedEvent) {
  if (event.type === 'mark:added') {
    // payload is narrowed to the AnnotationAdded payload
  }
}
```

`PERSISTED_EVENT_TYPES` is the runtime list of every persisted event type, generated with the catalog from the bus registry's `storedEvent` channels.

### EventBus

The RxJS-based event bus shared by services and clients, with a typed channel protocol:

```typescript
import { EventBus, ScopedEventBus, burstBuffer, serializePerKey } from '@semiont/core';
import type { EventMap, EventName } from '@semiont/core';
```

- **`EventBus` / `ScopedEventBus`** — framework-agnostic pub/sub over the unified `EventMap`
- **`CHANNEL_SCHEMAS`** — maps each channel to its OpenAPI payload schema
- **`burstBuffer`** — RxJS operator for coalescing event bursts
- **`serializePerKey`** — per-key serialization for RPC-style callers
- **`busLog` / `setBusLogTraceIdProvider`** — cross-wire bus observability

### Transport Contract

The interfaces every concrete transport must satisfy, plus the channel set transports bridge into a client's bus:

```typescript
import type { ITransport, IContentTransport, IGatewayOperations, ConnectionState } from '@semiont/core';
import { BRIDGED_CHANNELS } from '@semiont/core';
```

`@semiont/http-transport` implements these over HTTP + SSE; `LocalTransport` and `LocalContentTransport` in `@semiont/make-meaning` implement `ITransport` and `IContentTransport` in-process.

### Resource writes

The one statement of how a resource write maps onto its channel's payload, used by the Archivist's upload path and by in-process callers alike:

```typescript
import { ResourceOperations } from '@semiont/core';
import type { CreateResourceInput, BusRequestPrimitive } from '@semiont/core';
```

Each method rides a `BusRequestPrimitive` the caller supplies — the operation names the channel, the caller names the fabric — stamps the caller as `_userId`, and resolves to the new `ResourceId` from the correlated reply — the Stower's, or the CloneTokenManager's for `createFromCloneToken`:

- **`createResource(input, emitter, bus)`** — `yield:create`. The `Emitter` is `{ did, roles }`, stamped as `_userId` and `_roles` — the Stower refuses a worker's create that cites no job. Callers store the bytes first; `CreateResourceInput` carries the resulting `storageUri`, `contentChecksum` and `byteSize`, plus `name`, `format`, and optional `language`, `entityTypes`, generation provenance, `jobId` and `isDraft`.
- **`persistClone(input, userId, bus)`** — `yield:clone-persist`. A clone names its `parentResourceId`; callers reach this only after a clone token has been validated.
- **`createFromCloneToken(input, userId, bus)`** — `yield:clone-create`. The bytes are already stored; the command carries the token and storage coordinates only.

A `*-failed` reply rejects with `BusRequestError`.

### W3C Web Annotation Utilities

Pure functions for building and reading W3C Annotations:

```typescript
import {
  assembleAnnotation,
  applyBodyOperations,
  getBodySource,
  getTargetSelector,
  getExactText,
  isHighlight,
  isReference,
  isComment,
} from '@semiont/core';
```

Selector helpers cover text position, text quote, SVG, and PDF-viewrect fragment selectors (`getTextPositionSelector`, `getSvgSelector`, `createFragmentSelector`, `parseSvgSelector`, …).

### Annotation body matcher

`findBodyItem` locates a body item in an annotation body by identity
(type + source for `SpecificResource`, type + value for `TextualBody`).
Used by the `mark:body-updated` event replay path to apply add / remove /
replace operations.

```typescript
import { findBodyItem, type BodyItemIdentity } from '@semiont/core';

// Loose match: any body item with this source, regardless of purpose.
// This is the common case for Semiont's bind/unbind flow.
const index = findBodyItem(annotation.body, {
  type: 'SpecificResource',
  source: '5bcd259ab1464cf68a556bbad21f513f',
});

// Strict match: disambiguate among same-source bodies under different
// purposes. Needed when an annotation has multiple SpecificResource bodies
// pointing at the same target under different W3C purposes.
const linkingIdx = findBodyItem(annotation.body, {
  type: 'SpecificResource',
  source: '5bcd259ab1464cf68a556bbad21f513f',
  purpose: 'linking',
});
```

`purpose` is optional in the identity. Omit it to match on identity alone;
provide it when the caller knows which purpose to target.

### Anchoring

Re-anchor annotations after content edits — fuzzy text matching plus a render-time strategy that combines position and quote selectors with confidence scoring:

```typescript
import {
  anchorAnnotation,
  normalizeText,
  buildContentCache,
  findBestTextMatch,
} from '@semiont/core';
```

### PDF anchoring

Text paired with the geometry that indexes it, and the inverse pair that reads
it in either direction. Pure arithmetic over plain data — this is what *reasons
over* a coordinate map; producing one (text layer, OCR, tables, forms) lives in
[`@semiont/content`](../content/README.md), which the browser cannot import
because it carries pdf.js, Tesseract and `node:fs`.

```typescript
import { locate, textUnder, anchorRuns, isTextRun, type AnchoredText } from '@semiont/core';

// A model quoted text; find its geometry. One rect per line.
const { rects } = locate(anchored, match.start, match.end);

// A person drew a box; find its text. '' when it covers no words.
const quote = textUnder(anchored, pdfCoordinate);

// pdf.js runs -> AnchoredText, the offset/separator convention both the
// server extractor and the browser canvas share.
const anchored = anchorRuns(content.items.filter(isTextRun), pageNumber);
```

Coordinates are PDF points, origin bottom-left, Y increasing upward; the flip to
canvas pixels happens in the browser. `textUnder` counts a word as covered at
`RUN_COVERAGE_THRESHOLD` (50%) of its area rather than on any intersection —
with ~2pt of headroom between lines, a hand-drawn box that overshoots by less
than the height of a comma would otherwise pull in its neighbours.

See **[ANCHORING.md](../../docs/architecture/ANCHORING.md)** for how a map is derived,
stored, served, and turned into a selector.

### DID Utilities

Generate and parse W3C Decentralized Identifiers for humans and software peers:

```typescript
import { userToDid, agentToDid, softwareToAgent, didToAgent } from '@semiont/core';

// A person is named by the issuer claim `[identity] subjectClaim` selects,
// under the deployment's `[site] domain`.
userToDid({ subject: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', domain: 'example.com' });
// => 'did:web:example.com:users:f47ac10b-58cc-4372-a567-0e02b2c3d479'

didToAgent('did:web:example.com:agents:ollama:gemma2%3A27b');
// => { '@type': 'Software', '@id': ..., name: 'ollama gemma2:27b', provider: 'ollama', model: 'gemma2:27b' }
```

### Error Classes

In-process error types, sharing the `SemiontError` base with the transport-specific classes (`APIError` lives in `@semiont/http-transport`):

```typescript
import {
  SemiontError,
  ValidationError,
  ScriptError,
  NotFoundError,
  UnauthorizedError,
  ConflictError,
} from '@semiont/core';

throw new NotFoundError('Resource'); // "Resource not found"
```

### Type Guards & Validation

```typescript
import { isString, isObject, isArray, isDefined, validateData, isValidEmail } from '@semiont/core';

if (isDefined(value)) {
  // TypeScript knows value is T, not T | null | undefined
}
```

### Resource & Misc Utilities

- **ResourceDescriptor accessors** — `getResourceId`, `getPrimaryRepresentation`, `getChecksum`, `isArchived`, `decodeRepresentation`, …
- **Locales** — `LOCALES`, `getLocaleInfo`, `formatLocaleDisplay`, …
- **Media types** — `MEDIA_TYPES` capability registry keyed by the spec's `SupportedMediaType` enum (render / anchoring / text source / authorable per type), generated from `specs/src/media-types/registry.json`, with `capabilitiesOf`, `textSourceOf`, `mediaTypeForExtension`, `baseMediaType`, …
- **Text encoding** — `extractCharset`, `decodeWithCharset`
- **Text context** — `extractContext`, `reconcileSelector`
- **SVG** — `createRectangleSvg`, `parseSvgSelector`, `scaleSvgToNative`, …
- **IDs** — `generateUuid`

### Configuration

Schema-generated configuration types plus loaders:

```typescript
import { loadTomlConfig, parseEnvironment, ConfigurationError } from '@semiont/core';
import type { EnvironmentConfig, ServicesConfig } from '@semiont/core';
```

Filesystem-backed loading (`SemiontProject`, `loadEnvironmentConfig`) is in `@semiont/core/node` — see above.

### Internal Types

Types not in the OpenAPI spec:

```typescript
import type {
  UpdateResourceInput,
  ResourceFilter,
  CreateAnnotationInternal,
  AnnotationCategory,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
} from '@semiont/core';
```

## Architecture: Spec-First

Semiont follows a **spec-first architecture**:

1. **OpenAPI Specification** ([specs/src/](../../specs/src/)) is the source of truth
2. **@semiont/core** generates types from OpenAPI and provides domain utilities
3. Every other TypeScript package imports types from `@semiont/core`; application code talks to the gateway through `@semiont/sdk`, whose transports implement core's `ITransport` contract

**Type Generation Flow**: OpenAPI spec → `packages/core/src/types.ts` (via `openapi-typescript`) → imported across the monorepo. This ensures no circular dependencies and clear build order.

## Development

```bash
# Build the package
npm run build

# Type check
npm run typecheck

# Clean build artifacts
npm run clean
```

## License

Apache-2.0

## Related Packages

- [`@semiont/sdk`](../sdk/) - The Semiont SDK (`SemiontClient`) - use this for application development
- [`@semiont/http-transport`](../http-transport/) - HTTP implementations of core's transport contract
- [gateway](../../apps/gateway/) - the gateway (Rust), which serves this protocol
- [`@semiont/browser`](../../apps/browser/) - Web application

## Learn More

- [W3C Web Annotation Model](https://www.w3.org/TR/annotation-model/) - Annotation standard
- [DID:WEB Specification](https://w3c-ccg.github.io/did-method-web/) - Decentralized identifiers
- [W3C Selectors](../../docs/protocol/W3C-SELECTORS.md) - Selector implementation details
