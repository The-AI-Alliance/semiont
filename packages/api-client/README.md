# @semiont/api-client

**Common API client for Semiont backend**

> This package provides a type-safe, framework-agnostic API client that can be used by external consumers (MCP server, demo scripts, frontend).

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

- ✅ **Type-Safe**: Full TypeScript types from OpenAPI specification
- ✅ **Framework-Agnostic**: Works in Node.js, browser, or any JavaScript environment
- ✅ **Built-in Authentication**: Multiple auth methods (local, Google OAuth, refresh tokens)
- ✅ **Automatic Retry**: Configurable retry logic with exponential backoff
- ✅ **Error Handling**: Structured error responses with `APIError` class
- ✅ **HTTP Client**: Uses `ky` for reliable HTTP requests

## Who Uses This

- ✅ **MCP Server** (`packages/mcp-server`) - Model Context Protocol integration
- ✅ **Demo Scripts** (`demo/`) - Example scripts and automation
- ✅ **Frontend** (`apps/frontend`) - Can wrap with React hooks for UI

## Who Should NOT Use This

- ❌ **Backend** (`apps/backend`) - Backend is the API, doesn't call itself
- ❌ **Internal Services** - Use internal SDK or direct database access

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
Create a new annotation (highlight or reference).

```typescript
const result = await client.createAnnotation({
  target: {
    source: 'doc-sha256:abc123...',
    selector: {
      type: 'TextPositionSelector',
      offset: 0,
      length: 10,
      exact: 'Hello World'
    }
  },
  body: {
    type: 'TextualBody',
    value: 'My comment',
    entityTypes: ['note']
  }
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

#### `resolveAnnotation(id: string, targetDocumentId: string)`
Resolve a stub reference to point to a target document.

```typescript
const result = await client.resolveAnnotation(
  'annotation-id',
  'doc-sha256:target...'
);

console.log('Resolved to:', result.targetDocument?.id);
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
