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

### `getResource(uri: ResourceUri)`

Retrieve a resource by URI (returns JSON metadata).

```typescript
const result = await client.getResource(resourceUri);
console.log('Resource:', result.resource);
```

### `getResourceRepresentation(uri: ResourceUri, options?)`

Get resource representation using W3C content negotiation. Returns raw text content instead of JSON metadata.

```typescript
// Get markdown representation
const markdown = await client.getResourceRepresentation(resourceUri, {
  accept: 'text/markdown'
});

// Get plain text representation (default)
const text = await client.getResourceRepresentation(resourceUri);

// Get HTML representation
const html = await client.getResourceRepresentation(resourceUri, {
  accept: 'text/html'
});
```

**Options:**
- `accept` (optional): Media type for content negotiation (default: `'text/plain'`)

**Use Cases:**
- Getting raw content for editing
- Cloning resource content
- Exporting to different formats
- Client-side rendering of content

### `listResources(limit?: number, archived?: boolean)`

List resources with optional filters.

```typescript
const result = await client.listResources(20, false);
console.log(`Found ${result.total} resources`);
```

### `updateResource(uri: ResourceUri, data)`

Update resource metadata (name, entity types, archive status).

```typescript
const result = await client.updateResource(resourceUri, {
  name: 'Updated Name',
  entityTypes: ['updated'],
  archived: true
});
```

### `getResourceEvents(uri: ResourceUri)`

Get event history for a resource.

```typescript
const result = await client.getResourceEvents(resourceUri);
console.log(`Total events: ${result.events.length}`);
```

### `getResourceAnnotations(uri: ResourceUri)`

Get annotations for a resource.

```typescript
const result = await client.getResourceAnnotations(resourceUri);
console.log(`Found ${result.annotations.length} annotations`);
```

### `getResourceReferencedBy(uri: ResourceUri)`

Find resources that reference this resource.

```typescript
const result = await client.getResourceReferencedBy(resourceUri);
console.log('Referenced by:', result.referencedBy);
```

### `generateCloneToken(uri: ResourceUri)`

Generate a token for cloning a resource (valid 24 hours).

```typescript
const result = await client.generateCloneToken(resourceUri);
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

### `createAnnotation(resourceUri: ResourceUri, data)`

Create a new annotation (highlight or reference). Uses W3C Web Annotation Model with dual selectors.

```typescript
const result = await client.createAnnotation(resourceUri, {
  target: {
    source: resourceUri,
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

### `getAnnotation(uri: ResourceAnnotationUri)`

Retrieve an annotation by URI.

```typescript
const result = await client.getAnnotation(annotationUri);
```

### `deleteAnnotation(uri: ResourceAnnotationUri)`

Delete an annotation.

```typescript
await client.deleteAnnotation(annotationUri);
```

### `getAnnotationHistory(uri: ResourceAnnotationUri)`

Get the complete event history for a specific annotation with sequence numbers and checksums.

```typescript
const result = await client.getAnnotationHistory(annotationUri);

console.log(`Total events: ${result.total}`);
result.events.forEach(event => {
  console.log(`${event.type} at ${event.timestamp} (sequence: ${event.metadata.sequenceNumber})`);
});
```

### `updateAnnotationBody(uri: ResourceAnnotationUri, data: UpdateAnnotationBodyRequest)`

Update an annotation's body with fine-grained operations (add, remove, replace body items).

```typescript
const result = await client.updateAnnotationBody(annotationUri, {
  operations: [{
    op: 'add',
    item: {
      type: 'SpecificResource',
      source: targetResourceUri,
      purpose: 'linking'
    }
  }]
});

console.log('Updated annotation:', result.annotation.id);
```

### `generateResourceFromAnnotation(uri: ResourceAnnotationUri, data)`

Generate a new resource from an annotation using AI.

```typescript
const result = await client.generateResourceFromAnnotation(annotationUri, {
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

### `getResourceLLMContext(resourceUri, options?)`

Get resource with full context optimized for LLM processing.

```typescript
const context = await client.getResourceLLMContext(resourceUri, {
  depth: 2,              // Graph traversal depth (1-3, default: 2)
  maxResources: 10,      // Max related resources (1-20, default: 10)
  includeContent: true,  // Include full content (default: true)
  includeSummary: false, // Generate summary (default: false)
});

console.log('Main resource:', context.mainResource);
console.log('Related resources:', context.relatedResources);
console.log('Graph:', context.graph);
```

### `getAnnotationLLMContext(annotationUri, options?)`

Get annotation with surrounding context for LLM processing.

```typescript
const context = await client.getAnnotationLLMContext(annotationUri, {
  includeSourceContext: true,   // Include source text context (default: true)
  includeTargetContext: true,   // Include target resource context (default: true)
  contextWindow: 1000,          // Characters of context (100-5000, default: 1000)
});

console.log('Annotation:', context.annotation);
console.log('Source context:', context.sourceContext);
console.log('Target resource:', context.targetResource);
```

## Entity Detection and Jobs

### `detectEntities(resourceUri, entityTypes?)`

Start an async entity detection job on a resource.

```typescript
// Start detection with specific entity types
const job = await client.detectEntities(resourceUri, ['person', 'organization', 'location']);
console.log('Job ID:', job.jobId);
console.log('Status:', job.status); // 'pending'

// Start detection with all entity types
const job2 = await client.detectEntities(resourceUri);
```

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

### `client.sse.detectAnnotations(resourceUri, options)`

Stream real-time entity detection progress via Server-Sent Events.

```typescript
import { resourceUri } from '@semiont/api-client';

const rUri = resourceUri('http://localhost:4000/resources/resource-123');

const stream = client.sse.detectAnnotations(rUri, {
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
- `resourceUri` (ResourceUri): Resource to detect entities in
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

### `client.sse.generateResourceFromAnnotation(resourceUri, annotationUri, options)`

Stream real-time resource generation progress via Server-Sent Events.

```typescript
import { resourceUri, annotationUri } from '@semiont/api-client';

const rUri = resourceUri('http://localhost:4000/resources/resource-123');
const annUri = annotationUri('http://localhost:4000/annotations/annotation-456');

const stream = client.sse.generateResourceFromAnnotation(rUri, annUri, {
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
- `resourceUri` (ResourceUri): Source resource ID
- `annotationUri` (AnnotationUri): Annotation ID to generate from
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

### `client.sse.resourceEvents(resourceUri)`

Subscribe to real-time resource events via Server-Sent Events (long-lived connection).

```typescript
import { resourceUri } from '@semiont/api-client';

const rUri = resourceUri('http://localhost:4000/resources/resource-123');

const stream = client.sse.resourceEvents(rUri);

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
- `resourceUri` (ResourceUri): Resource ID to subscribe to

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
  const resource = await client.getResource(resourceUri);
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

## Type Definitions

The package exports TypeScript types from the OpenAPI specification:

```typescript
import type { paths } from '@semiont/api-client';

// Access specific endpoint types
type CreateResourceRequest = paths['/api/resources']['post']['requestBody']['content']['application/json'];
type CreateResourceResponse = paths['/api/resources']['post']['responses']['200']['content']['application/json'];
```
