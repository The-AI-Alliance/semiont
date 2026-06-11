# @semiont/core

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+core%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=core)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=core)
[![npm version](https://img.shields.io/npm/v/@semiont/core.svg)](https://www.npmjs.com/package/@semiont/core)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/core.svg)](https://www.npmjs.com/package/@semiont/core)
[![License](https://img.shields.io/npm/l/@semiont/core.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Core types and domain logic for the Semiont semantic knowledge platform. This package is the **source of truth for OpenAPI types** and provides the shared domain layer: event-sourcing types, the EventBus, the transport contract, W3C Web Annotation utilities, anchoring, DIDs, and configuration loading.

> **Architecture Note**: This package generates TypeScript types from the OpenAPI specification. Every other package in the monorepo imports them from here.

## Who Should Use This

- ✅ **Backend** (`apps/backend`) - Server implementation, imports types from core
- ✅ **Packages** - Other monorepo packages that need OpenAPI types, the EventBus, or the transport contract
- ✅ **Frontend / Browser** - Types and pure utilities (the main barrel is browser-safe)

## Who Should Use `@semiont/core/node` Instead

Node.js-specific exports live in the `/node` subpath:

```typescript
import { SemiontProject, loadEnvironmentConfig } from '@semiont/core/node';
```

- **`SemiontProject`** — represents a project on the filesystem; resolves XDG directories, reads/writes files. Not usable in a browser.
- **`loadEnvironmentConfig`** — loads `~/.semiontconfig` + `.semiont/config` using `fs`/`os`/`path`. Not usable in a browser.

**Rule**: If your code runs in a browser or edge runtime, use `@semiont/core`. If it runs in Node.js and needs filesystem access, use `@semiont/core/node`.

## Who Should Use `@semiont/sdk` Instead

Application code talking to a Semiont backend should use [`@semiont/sdk`](../sdk/), which provides `SemiontClient`, the verb-oriented namespaces, and the session layer. The SDK consumes the `ITransport` / `IContentTransport` contracts defined here; the HTTP implementations of those contracts live in [`@semiont/http-transport`](../http-transport/) and are re-exported by the SDK for convenience.

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
type Resource = components['schemas']['Resource'];
type CreateResourceRequest = components['schemas']['CreateResourceRequest'];
```

These types are generated during the build process:
```bash
npm run generate:openapi  # Bundles spec → generates types.ts
```

### Branded Types

Compile-time type safety for URIs, tokens, and identifiers:

```typescript
import { resourceUri, annotationUri, accessToken, entityType } from '@semiont/core';

const rUri = resourceUri('http://localhost:4000/resources/doc-123');
const token = accessToken('eyJhbGc...');
const eType = entityType('Person');
```

Branded ID types (`ResourceId`, `AnnotationId`, `UserId`) with factories and guards (`resourceId`, `annotationId`, `userId`, `isResourceId`, `isAnnotationId`) live alongside the URI brands.

### Event Sourcing Types

The persisted event catalog — every event type written to the JSONL event log, discriminated on `type` and namespaced by concern (`yield:*` resource lifecycle, `mark:*` annotations and tags, `frame:*` schema registration, `job:*` job lifecycle):

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

`PERSISTED_EVENT_TYPES` is the runtime list of every persisted event type, with a compile-time exhaustiveness check against the catalog.

### EventBus

The RxJS-based event bus shared by backend and clients, with a typed channel protocol:

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
import type { ITransport, IContentTransport, IBackendOperations, ConnectionState } from '@semiont/core';
import { BRIDGED_CHANNELS } from '@semiont/core';
```

`@semiont/http-transport` implements these over HTTP + SSE; `LocalTransport` in `@semiont/make-meaning` implements them in-process.

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
  source: 'https://example.com/target',
});

// Strict match: disambiguate among same-source bodies under different
// purposes. Needed when an annotation has multiple SpecificResource bodies
// pointing at the same target under different W3C purposes.
const linkingIdx = findBodyItem(annotation.body, {
  type: 'SpecificResource',
  source: 'https://example.com/target',
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

### DID Utilities

Generate and parse W3C Decentralized Identifiers for humans and software peers:

```typescript
import { userToDid, userToAgent, agentToDid, softwareToAgent, didToAgent } from '@semiont/core';

userToDid({ email: 'alice@example.com', domain: 'example.com' });
// => 'did:web:example.com:users:alice%40example.com'

userToAgent({ id: 'u1', domain: 'example.com', name: 'Alice', email: 'alice@example.com' });
// => { '@type': 'Person', '@id': 'did:web:example.com:users:alice%40example.com', name: 'Alice' }

didToAgent('did:web:example.com:agents:ollama:gemma2%3A27b');
// => { '@type': 'Software', '@id': ..., name: 'ollama gemma2:27b', provider: 'ollama', model: 'gemma2:27b' }
```

### Error Classes

In-process error types, sharing the `TransportErrorCode` vocabulary with the transport-specific classes (`APIError` lives in `@semiont/http-transport`):

```typescript
import {
  SemiontError,
  ValidationError,
  ScriptError,
  NotFoundError,
  UnauthorizedError,
  ConflictError,
} from '@semiont/core';

throw new NotFoundError('Resource not found');
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
- **MIME** — `getMimeCategory`, `isImageMimeType`, `getExtensionForMimeType`, …
- **Text encoding** — `extractCharset`, `decodeWithCharset`
- **Text context** — `extractContext`, `reconcileSelector`
- **SVG** — `createRectangleSvg`, `parseSvgSelector`, `scaleSvgToNative`, …
- **IDs** — `generateUuid`

### Configuration

Schema-generated configuration types plus loaders:

```typescript
import { loadTomlConfig, parseEnvironment, ConfigurationError } from '@semiont/core';
import type { SemiontConfig, EnvironmentConfig, ServicesConfig } from '@semiont/core';
```

Filesystem-backed loading (`SemiontProject`, `loadEnvironmentConfig`) is in `@semiont/core/node` — see above.

### Backend Internal Types

Types not in the OpenAPI spec:

```typescript
import type {
  UpdateResourceInput,
  ResourceFilter,
  CreateAnnotationInternal,
  AnnotationCategory,
  GoogleAuthRequest,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
} from '@semiont/core';
```

## Architecture: Spec-First

Semiont follows a **spec-first architecture**:

1. **OpenAPI Specification** ([specs/src/](../../specs/src/)) is the source of truth
2. **@semiont/core** generates types from OpenAPI and provides domain utilities
3. Every other package imports types from `@semiont/core`; application code talks to the backend through `@semiont/sdk`, whose transports implement core's `ITransport` contract

**Type Yield Flow**: OpenAPI spec → `@semiont/core/src/types.ts` (via `openapi-typescript`) → imported across the monorepo. This ensures no circular dependencies and clear build order.

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
- [`@semiont/backend`](../../apps/backend/) - Backend API server
- [`@semiont/frontend`](../../apps/frontend/) - Web application

## Learn More

- [W3C Web Annotation Model](https://www.w3.org/TR/annotation-model/) - Annotation standard
- [DID:WEB Specification](https://w3c-ccg.github.io/did-method-web/) - Decentralized identifiers
- [W3C Selectors](../../docs/protocol/W3C-SELECTORS.md) - Selector implementation details
