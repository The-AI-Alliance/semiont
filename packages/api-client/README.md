# @semiont/api-client

**Primary TypeScript SDK for Semiont**

> 🎯 **Use this package for all external integrations, demos, MCP servers, and frontend applications.**
>
> This package provides a type-safe, spec-first SDK that includes:
> - **API Client**: HTTP client for all backend endpoints
> - **TypeScript Types**: Generated from OpenAPI specification ([specs/openapi.json](../../specs/openapi.json))
> - **W3C Utilities**: Helpers for annotations, selectors, entity types, and locales
> - **Event Utilities**: Formatting and display helpers for event streams

## Installation

```bash
npm install @semiont/api-client
```

## Basic Usage

```typescript
import { SemiontApiClient } from '@semiont/api-client';

// Create client instance
const client = new SemiontApiClient({
  baseUrl: 'http://localhost:4000',
  accessToken: 'your-access-token', // Optional - can authenticate later
});

// Authenticate (if needed)
await client.authenticateLocal('user@example.com', '123456');
// OR
client.setAccessToken('your-token');

// Use the client
const doc = await client.createDocument({
  name: 'My Document',
  content: 'Hello World',
  format: 'text/plain',
  entityTypes: ['example']
});

console.log('Created:', doc.document.id);
```

## Features

- ✅ **Spec-First**: Types generated from [OpenAPI specification](../../specs/openapi.json)
- ✅ **Type-Safe**: Full TypeScript types for all API operations
- ✅ **Framework-Agnostic**: Works in Node.js, browser, or any JavaScript environment
- ✅ **Built-in Authentication**: Multiple auth methods (local, Google OAuth, refresh tokens)
- ✅ **W3C Utilities**: Selector helpers, entity type extraction, locale formatting
- ✅ **Event Utilities**: Event formatting, display names, relative time
- ✅ **Automatic Retry**: Configurable retry logic with exponential backoff
- ✅ **Error Handling**: Structured error responses with `APIError` class
- ✅ **HTTP Client**: Uses `ky` for reliable HTTP requests

## Who Uses This

- ✅ **MCP Server** (`packages/mcp-server`) - Model Context Protocol integration
- ✅ **Demo Scripts** (`demo/`) - Example scripts and automation
- ✅ **Frontend** (`apps/frontend`) - Web application (can wrap with React hooks)
- ✅ **External Applications** - Third-party integrations and tools
- ✅ **CLI Tools** - Command-line utilities consuming the API

## Who Should NOT Use This

- ❌ **Backend Internal Code** - Use [`@semiont/core`](../core/) for backend domain logic (events, crypto, DID utilities)

**Note**: If you need backend-specific utilities (event sourcing, crypto, type guards), use [`@semiont/core`](../core/). For API consumption and W3C annotation utilities, use this package.

## API Reference

### Constructor

```typescript
new SemiontApiClient(config: SemiontApiClientConfig)
```

**Config Options:**
- `baseUrl` (required): Backend API URL (e.g., `http://localhost:4000`)
- `accessToken` (optional): JWT access token for authenticated requests
- `timeout` (optional): Request timeout in milliseconds (default: 30000)
- `retry` (optional): Number of retry attempts (default: 2)

### Authentication Methods

#### `authenticateLocal(email: string, code: string)`
Authenticate using local development auth (email + verification code).

```typescript
const response = await client.authenticateLocal('user@example.com', '123456');
// Token is automatically set in the client
```

#### `authenticateGoogle(credential: string)`
Authenticate using Google OAuth credential.

```typescript
const response = await client.authenticateGoogle('google-oauth-credential');
```

#### `refreshToken(refreshToken: string)`
Exchange refresh token for new access token.

```typescript
const response = await client.refreshToken('refresh-token-here');
```

#### `generateMCPToken()`
Generate a 30-day refresh token for MCP clients.

```typescript
const response = await client.generateMCPToken();
console.log('Refresh token:', response.refreshToken);
```

#### `setAccessToken(token: string)`
Manually set the access token.

```typescript
client.setAccessToken('your-jwt-token');
```

#### `clearAccessToken()`
Clear the current access token.

```typescript
client.clearAccessToken();
```

### Document Methods

#### `createDocument(data)`
Create a new document.

```typescript
const result = await client.createDocument({
  name: 'My Document',
  content: 'Document content here',
  format: 'text/plain', // or 'text/markdown'
  entityTypes: ['article', 'research']
});

console.log('Document ID:', result.document.id);
```

#### `getDocument(id: string)`
Retrieve a document by ID.

```typescript
const result = await client.getDocument('doc-sha256:abc123...');
console.log('Document:', result.document);
```

#### `listDocuments(params?)`
List documents with optional filters.

```typescript
const result = await client.listDocuments({
  limit: 20,
  archived: false
});

console.log(`Found ${result.total} documents`);
```

#### `updateDocument(id: string, data)`
Update document content or metadata.

```typescript
const result = await client.updateDocument('doc-sha256:abc123...', {
  name: 'Updated Name',
  content: 'Updated content'
});
```

#### `deleteDocument(id: string)`
Delete a document.

```typescript
await client.deleteDocument('doc-sha256:abc123...');
```

#### `searchDocuments(query: string, limit?: number)`
Search documents by name or content.

```typescript
const result = await client.searchDocuments('prometheus', 10);
console.log(`Found ${result.documents.length} matching documents`);
```

#### `getDocumentEvents(id: string)`
Get event history for a document.

```typescript
const result = await client.getDocumentEvents('doc-sha256:abc123...');
console.log(`Total events: ${result.events.length}`);
```

#### `getDocumentHighlights(id: string)`
Get highlights for a document.

```typescript
const result = await client.getDocumentHighlights('doc-sha256:abc123...');
console.log(`Found ${result.highlights.length} highlights`);
```

#### `getDocumentReferences(id: string)`
Get references for a document.

```typescript
const result = await client.getDocumentReferences('doc-sha256:abc123...');
console.log(`Found ${result.references.length} references`);
```

### Annotation Methods

#### `createAnnotation(data)`
Create a new annotation (highlight or reference). Uses W3C Web Annotation Model with dual selectors.

```typescript
const result = await client.createAnnotation({
  target: {
    source: 'doc-sha256:abc123...',
    selector: [
      {
        type: 'TextPositionSelector',
        start: 0,
        end: 11
      },
      {
        type: 'TextQuoteSelector',
        exact: 'Hello World'
      }
    ]
  },
  body: [],
  motivation: 'highlighting'
});

console.log('Annotation ID:', result.annotation.id);
```

#### `getAnnotation(id: string)`
Retrieve an annotation by ID.

```typescript
const result = await client.getAnnotation('annotation-id');
```

#### `listAnnotations(params?)`
List annotations with optional filters.

```typescript
const result = await client.listAnnotations({
  documentId: 'doc-sha256:abc123...',
  motivation: 'highlighting'
});
```

#### `deleteAnnotation(id: string, documentId: string)`
Delete an annotation.

```typescript
await client.deleteAnnotation('annotation-id', 'doc-sha256:abc123...');
```

#### `updateAnnotationBody(id: string, data: UpdateAnnotationBodyRequest)`
Update an annotation's body with fine-grained operations (add, remove, replace body items).

```typescript
const result = await client.updateAnnotationBody('annotation-id', {
  documentId: 'doc-sha256:abc123...',
  operations: [{
    op: 'add',
    item: {
      type: 'SpecificResource',
      source: 'doc-sha256:target...',
      purpose: 'linking'
    }
  }]
});

console.log('Updated annotation:', result.annotation.id);
```

#### `generateDocumentFromAnnotation(id: string, data)`
Generate a new document from an annotation using AI.

```typescript
const result = await client.generateDocumentFromAnnotation('annotation-id', {
  name: 'Generated Document',
  prompt: 'Explain this concept in detail',
  entityTypes: ['explanation']
});

console.log('Generated document:', result.document.id);
```

### Entity Type Methods

#### `addEntityType(type: string)`
Add a new entity type.

```typescript
const result = await client.addEntityType('custom-type');
```

#### `listEntityTypes()`
List all available entity types.

```typescript
const result = await client.listEntityTypes();
console.log('Entity types:', result.entityTypes);
```

### Admin Methods

#### `listUsers()`
List all users (admin only).

```typescript
const result = await client.listUsers();
console.log(`Total users: ${result.total}`);
```

#### `getUserStats()`
Get user statistics (admin only).

```typescript
const result = await client.getUserStats();
console.log('Stats:', result.stats);
```

#### `updateUser(id: string, data)`
Update user information (admin only).

```typescript
const result = await client.updateUser('user-id', {
  isAdmin: true
});
```

### Health Methods

#### `healthCheck()`
Check backend health status.

```typescript
const result = await client.healthCheck();
console.log('Status:', result.status);
```

## Utilities

The SDK includes pure TypeScript utilities for working with Semiont data structures. These have no React dependencies and work in any JavaScript environment.

### Annotation Utilities

```typescript
import {
  isReference,
  isHighlight,
  getBodySource,
  getTargetSource,
  getEntityTypes
} from '@semiont/api-client';

// Check annotation type
if (isReference(annotation)) {
  const source = getBodySource(annotation.body);
  console.log('References:', source);
}

if (isHighlight(annotation)) {
  console.log('This is a highlight');
}

// Extract entity types from annotation
const types = getEntityTypes(annotation);
console.log('Entity types:', types);

// Get target document ID
const docId = getTargetSource(annotation.target);
```

### Selector Utilities

```typescript
import {
  getExactText,
  getTextPositionSelector,
  getTextQuoteSelector
} from '@semiont/api-client';

// Extract text from W3C selectors
const text = getExactText(annotation.target.selector);
console.log('Selected text:', text);

// Get specific selector types
const position = getTextPositionSelector(annotation.target.selector);
if (position) {
  console.log(`Range: ${position.start} - ${position.end}`);
}

const quote = getTextQuoteSelector(annotation.target.selector);
if (quote) {
  console.log('Exact text:', quote.exact);
}
```

### Event Utilities

```typescript
import {
  formatEventType,
  getEventEmoji,
  formatRelativeTime,
  isDocumentEvent,
  getAnnotationIdFromEvent
} from '@semiont/api-client';

// Format events for display
events.forEach(event => {
  const emoji = getEventEmoji(event.type);
  const type = formatEventType(event.type);
  const time = formatRelativeTime(event.timestamp);

  console.log(`${emoji} ${type} - ${time}`);

  if (isDocumentEvent(event.event)) {
    const annId = getAnnotationIdFromEvent(event.event);
    console.log('  Annotation:', annId);
  }
});
```

### Locale Utilities

```typescript
import { LOCALES, formatLocaleDisplay } from '@semiont/api-client';

// List all supported locales
console.log('Available locales:', LOCALES.length);

// Format locale for display
const display = formatLocaleDisplay('en');
console.log(display); // "English"
```

## Error Handling

The client throws `APIError` for failed requests:

```typescript
import { SemiontApiClient, APIError } from '@semiont/api-client';

try {
  const doc = await client.createDocument({ ... });
} catch (error) {
  if (error instanceof APIError) {
    console.error('API Error:', error.message);
    console.error('Status:', error.status);
    console.error('Details:', error.details);
  } else {
    console.error('Unexpected error:', error);
  }
}
```

## Advanced Configuration

### Custom Timeout and Retry

```typescript
const client = new SemiontApiClient({
  baseUrl: 'http://localhost:4000',
  timeout: 60000,  // 60 seconds
  retry: 3         // Retry failed requests 3 times
});
```

### Using with Different Environments

```typescript
const client = new SemiontApiClient({
  baseUrl: process.env.SEMIONT_API_URL || 'http://localhost:4000',
  accessToken: process.env.SEMIONT_ACCESS_TOKEN
});
```

## Type Definitions

The package exports TypeScript types from the OpenAPI specification:

```typescript
import type { paths } from '@semiont/api-client';

// Access specific endpoint types
type CreateDocumentRequest = paths['/api/documents']['post']['requestBody']['content']['application/json'];
type CreateDocumentResponse = paths['/api/documents']['post']['responses']['200']['content']['application/json'];
```

## Development

### Regenerate from OpenAPI

```bash
# After updating backend routes
npm run generate
```

### Build

```bash
npm run build
```

## Architecture

This package enforces the API boundary between:
- **Internal** (backend, CLI) - Direct system access
- **External** (frontend, MCP, demos) - Uses `@semiont/api-client`

See [ARCHITECTURE-API-BOUNDARY.md](../../ARCHITECTURE-API-BOUNDARY.md) for details.

## Examples

See the [demo scripts](../../demo/) for complete usage examples, including:
- Authentication flows
- Document creation and management
- Annotation creation and resolution
- Event history retrieval

## License

Apache-2.0
