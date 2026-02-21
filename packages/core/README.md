# @semiont/core

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+core%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=core)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=core)
[![npm version](https://img.shields.io/npm/v/@semiont/core.svg)](https://www.npmjs.com/package/@semiont/core)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/core.svg)](https://www.npmjs.com/package/@semiont/core)
[![License](https://img.shields.io/npm/l/@semiont/core.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Core types and domain logic for the Semiont semantic knowledge platform. This package is the **source of truth for OpenAPI types** and provides backend utilities for event sourcing, URIs, DID generation, and the EventBus.

> **Architecture Note**: This package generates TypeScript types from the OpenAPI specification. `@semiont/api-client` re-exports these types and provides HTTP client functionality.

## Who Should Use This

- ✅ **Backend** (`apps/backend`) - Server implementation, imports types from core
- ✅ **Packages** - Other monorepo packages that need OpenAPI types or EventBus
- ✅ **Internal Utilities** - Type generation, validation, domain logic

## Who Should Use `@semiont/api-client` Instead

- **External Applications** - For HTTP client + utilities
- **Frontend** (`apps/frontend`, `packages/react-ui`) - For API communication and W3C utilities
- **Demo Scripts** - For higher-level API access
- **MCP Servers** - For client-side annotation utilities

**Rule of thumb**: If you need to make HTTP requests or work with W3C selectors, use `@semiont/api-client`. If you only need types and domain logic, use `@semiont/core`.

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

### Event Sourcing Types

Event types for the event-sourced architecture:

```typescript
import type {
  ResourceEvent,
  ResourceCreatedEvent,
  ResourceArchivedEvent,
  DocumentUnarchivedEvent,
  AnnotationAddedEvent,
  AnnotationRemovedEvent,
  AnnotationBodyUpdatedEvent,
  EntityTagAddedEvent,
  EntityTagRemovedEvent,
  StoredEvent,
  EventMetadata,
  DocumentAnnotations,
  BodyOperation,
} from '@semiont/core';
```

### DID Utilities

Generate W3C Decentralized Identifiers for annotations:

```typescript
import { userToDid, userToAgent, didToAgent } from '@semiont/core';

// Convert user to DID:WEB
const did = userToDid(user);
// => 'did:web:localhost%3A4000:users:user-id'

// Convert user to W3C Agent
const agent = userToAgent(user);
// => { id: 'did:web:...', type: 'Person', name: 'User Name' }
```

### Cryptographic Utilities

Content-addressing and checksums:

```typescript
import {
  generateId,
  generateToken,
  generateUuid,
  calculateChecksum,
  verifyChecksum,
} from '@semiont/core';

// Generate unique IDs
const id = generateId();
const token = generateToken();
const uuid = generateUuid();

// Content checksums for verification
const checksum = calculateChecksum(content);
const isValid = verifyChecksum(content, checksum);
```

### Type Guards

Runtime type checking:

```typescript
import {
  isString,
  isNumber,
  isBoolean,
  isObject,
  isArray,
  isNonEmptyArray,
  isDefined,
} from '@semiont/core';

if (isNonEmptyArray(value)) {
  // TypeScript knows value is T[] with length > 0
}
```

### Error Classes

Backend error types:

```typescript
import {
  SemiontError,
  APIError,
  NotFoundError,
  ConflictError,
  ValidationError,
  UnauthorizedError,
} from '@semiont/core';

throw new NotFoundError('Document not found');
throw new ValidationError('Invalid annotation format');
```

### HTTP Client Utilities

Backend HTTP utilities (internal use):

```typescript
import { fetchAPI, createFetchAPI } from '@semiont/core';

const response = await fetchAPI(url, { method: 'POST', body: data });
```

### Backend-Specific Annotation Utilities

Utilities that work with internal backend types:

```typescript
import { bodyItemsMatch, findBodyItem } from '@semiont/core';

// Find specific body item in annotation
const item = findBodyItem(annotation.body, (item) => item.purpose === 'tagging');

// Check if two body items match
if (bodyItemsMatch(item1, item2)) {
  // ...
}
```

### Backend Internal Types

Types not in the OpenAPI spec:

```typescript
import type {
  UpdateDocumentInput,
  ResourceFilter,
  CreateAnnotationInternal,
  AnnotationCategory,
  GoogleAuthRequest,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
} from '@semiont/core';
```

### Constants

Backend-specific constants:

```typescript
import { CREATION_METHODS } from '@semiont/core';

CREATION_METHODS.API          // 'api'
CREATION_METHODS.PASTE        // 'paste'
CREATION_METHODS.FILE_UPLOAD  // 'file-upload'
CREATION_METHODS.REFERENCE    // 'reference'
CREATION_METHODS.IMPORT       // 'import'
```

## What's NOT Included

The following utilities have been **moved to @semiont/api-client** (as of 2025-10-24):

### ❌ Selector Utilities

**Use `@semiont/api-client` instead:**

```typescript
// OLD (removed from @semiont/core):
import { getExactText, getTextPositionSelector } from '@semiont/core';

// NEW (use @semiont/api-client):
import { getExactText, getTextPositionSelector } from '@semiont/api-client';
```

### ❌ Locale Utilities

**Use `@semiont/api-client` instead:**

```typescript
// OLD (removed from @semiont/core):
import { LOCALES, formatLocaleDisplay, getLocaleInfo } from '@semiont/core';

// NEW (use @semiont/api-client):
import { LOCALES, formatLocaleDisplay, getLocaleInfo } from '@semiont/api-client';
```

### ❌ Annotation Utilities (Public API)

**Use `@semiont/api-client` instead:**

```typescript
// OLD (removed from @semiont/core):
import { compareAnnotationIds, getEntityTypes, getBodySource } from '@semiont/core';

// NEW (use @semiont/api-client):
import { compareAnnotationIds, getEntityTypes, getBodySource } from '@semiont/api-client';
```

## Architecture: Spec-First

Semiont follows a **spec-first architecture**:

1. **OpenAPI Specification** ([specs/src/](../../specs/src/)) is the source of truth
2. **@semiont/core** generates types from OpenAPI and provides utilities
3. **@semiont/api-client** re-exports types from core and provides HTTP client

**Principle**:
- OpenAPI types & domain utilities → `@semiont/core` (source of truth)
- HTTP client & convenience re-exports → `@semiont/api-client`
- Backend internal implementation → imports from `@semiont/core`

**Type Generation Flow**: OpenAPI spec → `@semiont/core/src/types.ts` (via `openapi-typescript`) → re-exported by `@semiont/api-client` for convenience. This ensures no circular dependencies and clear build order.

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

- [`@semiont/api-client`](../api-client/) - Primary TypeScript SDK (use this for most cases)
- [`@semiont/backend`](../../apps/backend/) - Backend API server
- [`@semiont/frontend`](../../apps/frontend/) - Web application

## Learn More

- [W3C Web Annotation Model](https://www.w3.org/TR/annotation-model/) - Annotation standard
- [DID:WEB Specification](https://w3c-ccg.github.io/did-method-web/) - Decentralized identifiers
- [W3C Selectors](../../specs/docs/W3C-SELECTORS.md) - Selector implementation details
