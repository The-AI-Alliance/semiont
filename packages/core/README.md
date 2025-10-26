# @semiont/core

Backend domain logic for the Semiont semantic knowledge platform. This package provides **internal backend utilities** for event sourcing, cryptography, DID generation, and type guards.

> ⚠️ **Not for External Use**: If you're building applications that consume the Semiont API, use [`@semiont/api-client`](../api-client/README.md) instead. This package is for **backend internal use only**.

## Who Should Use This

- ✅ **Backend** (`apps/backend`) - Server implementation with event sourcing
- ✅ **Internal Services** - System components requiring domain logic
- ✅ **CLI Tools** - Command-line utilities with full system access

## Who Should NOT Use This

- ❌ **External Applications** - Use [`@semiont/api-client`](../api-client/README.md)
- ❌ **Frontend** - Use [`@semiont/api-client`](../api-client/README.md)
- ❌ **MCP Servers** - Use [`@semiont/api-client`](../api-client/README.md)
- ❌ **Demo Scripts** - Use [`@semiont/api-client`](../api-client/README.md)

## Installation

```bash
npm install @semiont/core
```

## What's Included

### Event Sourcing Types

Event types for the event-sourced architecture:

```typescript
import type {
  DocumentEvent,
  DocumentCreatedEvent,
  DocumentArchivedEvent,
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
  CreateDocumentInput,
  UpdateDocumentInput,
  DocumentFilter,
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

1. **OpenAPI Specification** ([specs/openapi.json](../../specs/openapi.json)) is the source of truth
2. **@semiont/api-client** generates types from OpenAPI and provides utilities
3. **@semiont/core** provides backend-specific domain logic not in the API

**Principle**:
- API contract & data utilities → `@semiont/api-client`
- Backend internal implementation → `@semiont/core`

**Deduplication (2025-10-24)**: Selector utilities, locale utilities, and public annotation utilities were moved from this package to `@semiont/api-client` as part of the spec-first architecture migration.

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
