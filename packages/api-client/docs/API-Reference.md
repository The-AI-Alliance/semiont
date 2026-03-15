# API Reference

Complete method documentation for `@semiont/api-client`.

## Constructor

```typescript
new SemiontApiClient(config: SemiontApiClientConfig)
```

**Config Options:**
- `baseUrl` (required): Backend API URL (e.g., `http://localhost:4000`)
- `accessToken` (optional): JWT access token for authenticated requests
- `timeout` (optional): Request timeout in milliseconds (default: 30000)
- `retry` (optional): Number of retry attempts (default: 2)

## Authentication Methods

### `authenticateLocal(email: string, code: string)`

Authenticate using local development auth (email + verification code).

```typescript
const response = await client.authenticateLocal('user@example.com', '123456');
// Token is automatically set in the client
```

### `authenticateGoogle(credential: string)`

Authenticate using Google OAuth credential.

```typescript
const response = await client.authenticateGoogle('google-oauth-credential');
```

### `refreshToken(refreshToken: string)`

Exchange refresh token for new access token.

```typescript
const response = await client.refreshToken('refresh-token-here');
```

### `generateMCPToken()`

Generate a 30-day refresh token for MCP clients.

```typescript
const response = await client.generateMCPToken();
console.log('Refresh token:', response.refreshToken);
```

### `setAccessToken(token: string)`

Manually set the access token.

```typescript
client.setAccessToken('your-jwt-token');
```

### `clearAccessToken()`

Clear the current access token.

```typescript
client.clearAccessToken();
```

### `logout()`

Logout the current user (invalidates server-side session).

```typescript
await client.logout();
```

## Resource Methods

### `createResource(data)`

Create a new resource.

```typescript
const result = await client.createResource({
  name: 'My Resource',
  content: 'Resource content here',
  format: 'text/plain', // or 'text/markdown'
  entityTypes: ['article', 'research']
});

console.log('Resource ID:', result.resource.id);
```

### `getResource(id: ResourceId)`

Retrieve a resource by ID (returns JSON metadata).

```typescript
const result = await client.getResource(resourceId);
console.log('Resource:', result.resource);
```

### `getResourceRepresentation(id: ResourceId, options?)`

Get resource representation using W3C content negotiation. Returns raw binary content (images, PDFs, text, etc.) with content type.

```typescript
// Get markdown representation (decode to text)
const { data, contentType } = await client.getResourceRepresentation(resourceId, {
  accept: 'text/markdown'
});
const markdown = new TextDecoder().decode(data);
console.log(contentType); // 'text/markdown'

// Get plain text representation (default)
const { data, contentType } = await client.getResourceRepresentation(resourceId);
const text = new TextDecoder().decode(data);

// Get image representation (use as binary)
const { data, contentType } = await client.getResourceRepresentation(resourceId, {
  accept: 'image/png'
});
const blob = new Blob([data], { type: contentType });
const url = URL.createObjectURL(blob);

// Get PDF representation
const { data, contentType } = await client.getResourceRepresentation(resourceId, {
  accept: 'application/pdf'
});
```

**Options:**
- `accept` (optional): Media type for content negotiation (default: `'text/plain'`)

**Returns:** `Promise<{ data: ArrayBuffer; contentType: string }>` - Binary content and actual content type from server

**Use Cases:**
- Small to medium files (< 10MB)
- Getting raw content for editing
- Cloning resource content
- Client-side rendering of content

**Note:** For large files (videos, large PDFs), use `getResourceRepresentationStream()` to avoid loading entire content into memory.

### `getResourceRepresentationStream(id: ResourceId, options?)`

Get resource representation as a stream using W3C content negotiation. Use this for large files to avoid memory issues.

```typescript
// Stream large video file (never loads entire file into memory)
const { stream, contentType } = await client.getResourceRepresentationStream(resourceId, {
  accept: 'video/mp4'
});

// Consume stream chunk by chunk
const reader = stream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(`Received ${value.length} bytes`);
  // Process chunk...
}

// Or use async iteration
for await (const chunk of stream) {
  // Process chunk
}

// Or pipe directly to Response (in Next.js API routes)
return new Response(stream, {
  headers: { 'Content-Type': contentType }
});
```

**Options:**
- `accept` (optional): Media type for content negotiation (default: `'text/plain'`)

**Returns:** `Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }>` - Streaming binary content and content type

**Use Cases:**
- Large files (videos, large PDFs, datasets)
- Proxying content without buffering
- Downloading files incrementally
- Processing large files chunk by chunk

**Benefits:**
- Backend connection stays open until stream is consumed
- Never loads entire file into memory
- Lower latency (starts sending data immediately)
- Better for proxying large content

### `listResources(limit?: number, archived?: boolean)`

List resources with optional filters.

```typescript
const result = await client.listResources(20, false);
console.log(`Found ${result.total} resources`);
```

### `updateResource(id: ResourceId, data)`

Update resource metadata (name, entity types, archive status).

```typescript
const result = await client.updateResource(resourceId, {
  name: 'Updated Name',
  entityTypes: ['updated'],
  archived: true
});
```

### `getResourceEvents(id: ResourceId)`

Get event history for a resource.

```typescript
const result = await client.getResourceEvents(resourceId);
console.log(`Total events: ${result.events.length}`);
```

### `getResourceAnnotations(id: ResourceId)`

Get annotations for a resource.

```typescript
const result = await client.getResourceAnnotations(resourceId);
console.log(`Found ${result.annotations.length} annotations`);
```

### `getResourceReferencedBy(id: ResourceId)`

Find resources that reference this resource.

```typescript
const result = await client.getResourceReferencedBy(resourceId);
console.log('Referenced by:', result.referencedBy);
```

### `generateCloneToken(id: ResourceId)`

Generate a token for cloning a resource (valid 24 hours).

```typescript
const result = await client.generateCloneToken(resourceId);
console.log('Token:', result.token);
```

### `createResourceFromToken(data)`

Clone a resource using a token (no authentication required).

```typescript
const result = await client.createResourceFromToken({
  token: 'clone-token-here',
  name: 'Cloned Resource'
});
```

## Annotation Methods

### `createAnnotation(resourceId: ResourceId, data)`

Create a new annotation (highlight or reference). Uses W3C Web Annotation Model with dual selectors.

```typescript
const result = await client.createAnnotation(resourceId, {
  target: {
    source: resourceId,
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

### `getAnnotation(id: AnnotationId)`

Retrieve an annotation by ID.

```typescript
const result = await client.getAnnotation(annotationId);
```

### `deleteAnnotation(resourceId: ResourceId, annotationId: AnnotationId)`

Delete an annotation.

```typescript
await client.deleteAnnotation(resourceId, annotationId);
```

### `getAnnotationHistory(resourceId: ResourceId, annotationId: AnnotationId)`

Get the complete event history for a specific annotation with sequence numbers and checksums.

```typescript
const result = await client.getAnnotationHistory(resourceId, annotationId);

console.log(`Total events: ${result.total}`);
result.events.forEach(event => {
  console.log(`${event.type} at ${event.timestamp} (sequence: ${event.metadata.sequenceNumber})`);
});
```

### `updateAnnotationBody(resourceId: ResourceId, annotationId: AnnotationId, data: UpdateAnnotationBodyRequest)`

Update an annotation's body with fine-grained operations (add, remove, replace body items).

```typescript
const result = await client.updateAnnotationBody(resourceId, annotationId, {
  operations: [{
    op: 'add',
    item: {
      type: 'SpecificResource',
      source: targetResourceId,
      purpose: 'linking'
    }
  }]
});

console.log('Updated annotation:', result.annotation.id);
```

### `generateResourceFromAnnotation(resourceId: ResourceId, annotationId: AnnotationId, data)`

Generate a new resource from an annotation using AI.

```typescript
const result = await client.generateResourceFromAnnotation(resourceId, annotationId, {
  name: 'Generated Resource',
  prompt: 'Explain this concept in detail',
  entityTypes: ['explanation']
});

console.log('Generated resource:', result.resource.id);
```

## Entity Type Methods

### `addEntityType(type: string)`

Add a new entity type.

```typescript
const result = await client.addEntityType('custom-type');
```

### `listEntityTypes()`

List all available entity types.

```typescript
const result = await client.listEntityTypes();
console.log('Entity types:', result.entityTypes);
```

### `addEntityTypesBulk(types: string[])`

Add multiple entity types at once.

```typescript
const result = await client.addEntityTypesBulk(['concept', 'person', 'organization']);
console.log('Added:', result.added);
console.log('Entity types:', result.entityTypes);
```

## LLM Context Methods

### `getResourceLLMContext(resourceId, options?)`

Get resource with full context optimized for LLM processing.

```typescript
const context = await client.getResourceLLMContext(resourceId, {
  depth: 2,              // Graph traversal depth (1-3, default: 2)
  maxResources: 10,      // Max related resources (1-20, default: 10)
  includeContent: true,  // Include full content (default: true)
  includeSummary: false, // Generate summary (default: false)
});

console.log('Main resource:', context.mainResource);
console.log('Related resources:', context.relatedResources);
console.log('Graph:', context.graph);
```

### `getAnnotationLLMContext(resourceId, annotationId, options?)`

Get annotation with surrounding context for LLM processing.

```typescript
const context = await client.getAnnotationLLMContext(resourceId, annotationId, {
  includeSourceContext: true,   // Include source text context (default: true)
  includeTargetContext: true,   // Include target resource context (default: true)
  contextWindow: 1000,          // Characters of context (100-5000, default: 1000)
});

console.log('Annotation:', context.annotation);
console.log('Source context:', context.sourceContext);
console.log('Target resource:', context.targetResource);
```

## Jobs

### `getJobStatus(jobId)`

Get the current status of an async job.

```typescript
const status = await client.getJobStatus('job-123');
console.log('Status:', status.status);      // 'pending' | 'running' | 'complete' | 'failed' | 'cancelled'
console.log('Progress:', status.progress);  // { current: 50, total: 100, message: '...' }
console.log('Result:', status.result);      // Available when complete
```

### `pollJobUntilComplete(jobId, options?)`

Poll a job until it completes or fails, with progress callbacks.

```typescript
const result = await client.pollJobUntilComplete('job-123', {
  interval: 1000,  // Poll every 1 second (default: 1000)
  timeout: 60000,  // Timeout after 60 seconds (default: 60000)
  onProgress: (status) => {
    console.log(`Progress: ${status.progress?.current}/${status.progress?.total}`);
    console.log(status.progress?.message);
  },
});

if (result.status === 'complete') {
  console.log('Detection complete:', result.result);
} else if (result.status === 'failed') {
  console.error('Job failed:', result.error);
}
```

## Admin Methods

### `listUsers()`

List all users (admin only).

```typescript
const result = await client.listUsers();
console.log(`Total users: ${result.total}`);
```

### `getUserStats()`

Get user statistics (admin only).

```typescript
const result = await client.getUserStats();
console.log('Stats:', result.stats);
```

### `updateUser(id: string, data)`

Update user information (admin only).

```typescript
const result = await client.updateUser('user-id', {
  isAdmin: true
});
```

## SSE Streaming Namespace

The `client.sse.*` namespace provides Server-Sent Events (SSE) streaming for real-time progress updates on long-running operations.

**Design Notes**:
- Uses native `fetch()` instead of `ky` for streaming support
- Returns stream objects with `.onProgress()`, `.onComplete()`, `.onError()`, and `.close()` methods
- All events are type-safe with TypeScript interfaces
- Request bodies are validated via OpenAPI schemas; responses are not validated

### `client.sse.detectAnnotations(resourceId, options)`

Stream real-time entity detection progress via Server-Sent Events.

```typescript
import { resourceId } from '@semiont/api-client';

const rId = resourceId('resource-123');

const stream = client.sse.detectAnnotations(rId, {
  entityTypes: ['Person', 'Organization']
});

stream.onProgress((progress) => {
  console.log(`Scanning ${progress.currentEntityType}...`);
  console.log(`Progress: ${progress.processedEntityTypes}/${progress.totalEntityTypes}`);
});

stream.onComplete((result) => {
  console.log(`Found ${result.foundCount} entities`);
});

stream.onError((error) => {
  console.error('Failed:', error);
});

// Cancel stream
stream.close();
```

**Parameters**:
- `resourceId` (ResourceId): Resource to detect entities in
- `options` (object): Detection options
  - `entityTypes` (string[]): Entity types to detect

**Returns**: `SSEStream<DetectionProgress, DetectionProgress>`

**Event Types**:
- `detection-started` - Detection job has started
- `detection-progress` - Currently scanning an entity type
- `detection-complete` - All entity types scanned
- `detection-error` - Detection failed

**Progress Interface**:
```typescript
interface DetectionProgress {
  status: 'started' | 'scanning' | 'complete' | 'error';
  resourceId: string;
  currentEntityType?: string;
  totalEntityTypes: number;
  processedEntityTypes: number;
  foundCount?: number;
  message?: string;
}
```

### `client.sse.generateResourceFromAnnotation(resourceId, annotationId, options)`

Stream real-time resource generation progress via Server-Sent Events.

```typescript
import { resourceId, annotationId } from '@semiont/api-client';

const rId = resourceId('resource-123');
const annId = annotationId('annotation-456');

const stream = client.sse.generateResourceFromAnnotation(rId, annId, {
  title: 'Albert Einstein',
  prompt: 'Write a biography',
  language: 'en'
});

stream.onProgress((progress) => {
  console.log(`${progress.status}: ${progress.percentage}%`);
  console.log(progress.message);
});

stream.onComplete((result) => {
  console.log('Created:', result.resourceId);
  // Navigate to generated resource
  router.push(`/resource/${result.resourceId}`);
});

stream.onError((error) => {
  console.error('Failed:', error);
});
```

**Parameters**:
- `resourceId` (ResourceId): Source resource ID
- `annotationId` (AnnotationId): Annotation ID to generate from
- `options` (object): Generation parameters
  - `title` (string, optional): Custom title for generated resource
  - `prompt` (string, optional): Custom generation prompt
  - `language` (string, optional): Language locale (e.g., 'es', 'fr', 'ja')

**Returns**: `SSEStream<GenerationProgress, GenerationProgress>`

**Event Types**:
- `generation-started` - Generation job has started
- `generation-progress` - Generation in progress (with percentage)
- `generation-complete` - Resource generated successfully
- `generation-error` - Generation failed

**Progress Interface**:
```typescript
interface GenerationProgress {
  status: 'started' | 'fetching' | 'generating' | 'creating' | 'complete' | 'error';
  referenceId: string;
  resourceName?: string;
  resourceId?: string;
  sourceResourceId?: string;
  percentage: number;
  message?: string;
}
```

**Progress Stages**:
- `started` (0%) - Job initialized
- `fetching` (25%) - Fetching source content
- `generating` (50-75%) - AI generating content
- `creating` (90%) - Creating resource in database
- `complete` (100%) - Done

### `client.sse.resourceEvents(resourceId)`

Subscribe to real-time resource events via Server-Sent Events (long-lived connection).

```typescript
import { resourceId } from '@semiont/api-client';

const rId = resourceId('resource-123');

const stream = client.sse.resourceEvents(rId);

stream.onProgress((event) => {
  // Handle stream-connected event
  if (event.type === 'stream-connected') {
    console.log('Listening for changes...');
    return;
  }

  // Handle resource events
  if (event.type === 'annotation.created') {
    refreshAnnotations();
  }
});

stream.onError((error) => {
  console.error('Stream error:', error);
  // Implement reconnection logic
});

// Cleanup on component unmount
onUnmount(() => stream.close());
```

**Parameters**:
- `resourceId` (ResourceId): Resource ID to subscribe to

**Returns**: `SSEStream<ResourceEvent, never>`

**Event Types You'll Receive**:
- `stream-connected` - Initial connection established (special event, not a resource event)
- `resource.created` - Resource was created
- `resource.updated` - Resource metadata changed
- `annotation.created` - New annotation added
- `annotation.updated` - Annotation modified
- `annotation.deleted` - Annotation deleted
- `comment.created` - Comment added
- `comment.updated` - Comment modified
- `comment.deleted` - Comment deleted

**Event Interface**:
```typescript
interface ResourceEvent {
  id: string;
  type: string;
  timestamp: string;
  userId: string;
  resourceId: string;
  payload: any;
  metadata: {
    sequenceNumber: number;
    prevEventHash: string;
    checksum: string;
  };
}
```

**Use Cases**:
- Real-time collaboration (see other users' changes)
- Live annotation feed
- Activity monitoring
- Synchronized views across multiple clients

**Note**: This is a long-lived stream with NO completion event. It stays open until explicitly closed with `stream.close()`.

### SSE Stream Interface

All SSE methods return a stream object implementing this interface:

```typescript
interface SSEStream<TProgress, TComplete> {
  onProgress(callback: (progress: TProgress) => void): void;
  onComplete(callback: (result: TComplete) => void): void;
  onError(callback: (error: Error) => void): void;
  close(): void;
}
```

**Methods**:
- `onProgress(callback)` - Called for each progress event
- `onComplete(callback)` - Called when operation completes successfully (not used for `resourceEvents`)
- `onError(callback)` - Called on stream errors
- `close()` - Close the stream and cancel the operation

**Lifecycle Management**:

```typescript
// React example
useEffect(() => {
  const stream = client.sse.detectAnnotations(resourceId, { entityTypes: ['Person'] });

  stream.onProgress((p) => setProgress(p));
  stream.onComplete((r) => setResult(r));
  stream.onError((e) => setError(e));

  // Cleanup on unmount
  return () => stream.close();
}, [resourceId]);
```

**Error Handling**:

SSE streams can fail for various reasons. Always implement error handling:

```typescript
stream.onError((error) => {
  console.error('Stream error:', error.message);

  // Common errors:
  // - Network disconnection
  // - 401 Unauthorized (token expired)
  // - 404 Not Found (resource doesn't exist)
  // - 500 Server Error (backend failure)

  // Implement retry logic if appropriate
  if (error.message.includes('401')) {
    // Re-authenticate and retry
  } else if (error.message.includes('Network')) {
    // Retry with exponential backoff
  }
});
```


## System Methods

### `healthCheck()`

Check backend health status.

```typescript
const result = await client.healthCheck();
console.log('Status:', result.status);
```

### `getStatus()`

Get system status including version, features, and authentication state.

```typescript
const result = await client.getStatus();
console.log('Version:', result.version);
console.log('Features:', result.features);
console.log('Authenticated:', result.authenticated);
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

// Get target resource ID
const resourceId = getTargetSource(annotation.target);
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
  const resource = await client.getResource(resourceId);
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

## EventBusClient

The `EventBusClient` communicates directly via the RxJS EventBus without HTTP. It covers all knowledge-domain operations.

### Constructor

```typescript
new EventBusClient(eventBus: EventBus, timeoutMs?: number)
```

**Parameters:**
- `eventBus` (required): `EventBus` instance from `@semiont/core`
- `timeoutMs` (optional): Request timeout in milliseconds (default: 30000)

### Browse Methods

#### `getResource(resourceId: ResourceId)`

Get resource metadata (JSON-LD).

```typescript
const resource = await client.getResource(resourceId('doc-123'));
```

#### `listResources(options?)`

List resources with optional filters.

```typescript
const result = await client.listResources({
  search: 'quantum',
  archived: false,
  entityType: 'article',
  offset: 0,
  limit: 20,
});
```

#### `getAnnotations(resourceId: ResourceId)`

Get all annotations for a resource.

```typescript
const result = await client.getAnnotations(resourceId('doc-123'));
```

#### `getAnnotation(resourceId: ResourceId, annotationId: AnnotationId)`

Get a specific annotation.

```typescript
const result = await client.getAnnotation(resourceId('doc-123'), annotationId('ann-456'));
```

#### `getEvents(resourceId: ResourceId, options?)`

Get resource event history.

```typescript
const result = await client.getEvents(resourceId('doc-123'), {
  type: 'annotation.added',
  limit: 50,
});
```

#### `getAnnotationHistory(resourceId: ResourceId, annotationId: AnnotationId)`

Get annotation edit history.

```typescript
const result = await client.getAnnotationHistory(resourceId('doc-123'), annotationId('ann-456'));
```

### Bind Methods

#### `getReferencedBy(resourceId: ResourceId, motivation?: string)`

Find resources that reference this resource.

```typescript
const result = await client.getReferencedBy(resourceId('doc-123'));
```

#### `searchResources(searchTerm: string)`

Search resources by text query.

```typescript
const results = await client.searchResources('quantum computing');
```

### Mark Methods

#### `listEntityTypes()`

List all available entity types.

```typescript
const result = await client.listEntityTypes();
```

#### `addEntityType(tag: string, userId: UserId)`

Add a new entity type (fire-and-forget, no response).

```typescript
client.addEntityType('custom-type', userId('user-123'));
```

### Gather Methods

#### `getAnnotationLLMContext(resourceId, annotationId, options?)`

Get annotation context for LLM processing.

```typescript
const context = await client.getAnnotationLLMContext(
  resourceId('doc-123'),
  annotationId('ann-456'),
  { contextWindow: 2000 },
);
```

#### `getResourceLLMContext(resourceId, options)`

Get resource context with graph traversal for LLM processing.

```typescript
const context = await client.getResourceLLMContext(
  resourceId('doc-123'),
  { depth: 2, maxResources: 10, includeContent: true, includeSummary: false },
);
```

### Yield Methods (Clone Tokens)

#### `generateCloneToken(resourceId: ResourceId)`

Generate a temporary token for cloning a resource.

```typescript
const result = await client.generateCloneToken(resourceId('doc-123'));
console.log('Token:', result.token, 'Expires:', result.expiresAt);
```

#### `getResourceByToken(token: string)`

Get resource metadata using a clone token.

```typescript
const result = await client.getResourceByToken('clone-token-here');
```

#### `createResourceFromToken(options)`

Create a new resource from a clone token.

```typescript
const result = await client.createResourceFromToken({
  token: 'clone-token-here',
  name: 'Cloned Resource',
  content: 'Modified content',
  userId: userId('user-123'),
});
console.log('New resource:', result.resourceId);
```

### Job Methods

#### `getJobStatus(jobId: JobId)`

Get job status.

```typescript
const status = await client.getJobStatus(jobId('job-123'));
```

### What's NOT Available on EventBusClient

These operations require HTTP and are only available on `SemiontApiClient`:

- Authentication (password, Google, refresh, MCP, terms, logout)
- Admin (users CRUD, stats, OAuth config)
- Health/Status
- Binary content upload/download (`createResource`, `getResourceRepresentation`)
- SSE streaming (`client.sse.*`)

## Type Definitions

The package exports TypeScript types from the OpenAPI specification:

```typescript
import type { paths } from '@semiont/api-client';

// Access specific endpoint types
type CreateResourceRequest = paths['/api/resources']['post']['requestBody']['content']['application/json'];
type CreateResourceResponse = paths['/api/resources']['post']['responses']['200']['content']['application/json'];
```
