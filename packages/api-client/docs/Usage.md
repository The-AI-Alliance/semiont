# API Client Usage Guide

Comprehensive examples for common operations with the Semiont API Client.

## Installation

Install from npm:

```bash
# Latest stable release
npm install @semiont/api-client

# Or latest development build
npm install @semiont/api-client@dev
```

## Table of Contents

- [Authentication](#authentication)
  - [Logout](#logout)
- [Resources](#resources)
  - [Creating Resources](#creating-resources)
  - [Reading Resources](#reading-resources)
  - [Updating Resources](#updating-resources)
  - [Listing Resources](#listing-resources)
- [Annotations](#annotations)
  - [Annotation History](#annotation-history)
- [Event Streams](#event-streams)
- [SSE Streaming](#sse-streaming)
  - [Stream Entity Detection](#stream-entity-detection)
  - [Stream Resource Generation](#stream-resource-generation)
  - [Subscribe to Resource Events](#subscribe-to-resource-events)
  - [Stream Lifecycle Management](#stream-lifecycle-management)
  - [SSE Error Handling](#sse-error-handling)
- [Entity Detection and Jobs](#entity-detection-and-jobs)
  - [Managing Entity Types](#managing-entity-types)
  - [Start Entity Detection Job](#start-entity-detection-job)
  - [Poll Job Status](#poll-job-status)
  - [Poll Until Complete](#poll-until-complete)
  - [Complete Example: Detect and Wait](#complete-example-detect-and-wait)
- [LLM Context](#llm-context)
  - [Get Resource LLM Context](#get-resource-llm-context)
  - [Get Annotation LLM Context](#get-annotation-llm-context)
- [Logging and Observability](#logging-and-observability)
- [Error Handling](#error-handling)
- [System Status](#system-status)

## Authentication

### Local Authentication

```typescript
import { SemiontApiClient } from '@semiont/api-client';

const client = new SemiontApiClient({
  baseUrl: 'http://localhost:4000',
});

// Authenticate with email and verification code
const response = await client.authenticateLocal('user@example.com', '123456');

// Token is automatically set in the client
console.log('Authenticated:', response.user.email);
```

### Google OAuth

```typescript
const response = await client.authenticateGoogle('google-oauth-credential-token');
console.log('Authenticated:', response.user.email);
```

### Refresh Token

```typescript
// Generate long-lived refresh token (e.g., for MCP servers)
const mcpToken = await client.generateMCPToken();
console.log('Save this token:', mcpToken.refreshToken);

// Later, use refresh token to get new access token
const newAccess = await client.refreshToken(mcpToken.refreshToken);
console.log('New access token valid until:', newAccess.expiresAt);
```

### Manual Token Management

```typescript
// Set token manually
client.setAccessToken('your-jwt-token-here');

// Clear token (logout)
client.clearAccessToken();
```

### Logout

```typescript
// Logout user and invalidate server-side session
await client.logout();

console.log('User logged out successfully');
```

## Resources

### Creating Resources

#### Creating Text Resources

```typescript
import { resourceUri } from '@semiont/api-client';

// Simple text/markdown example
const textBlob = new Blob(['# Introduction\n\nThis paper explores...']);
const result = await client.createResource({
  name: 'My Research Paper',
  file: textBlob,
  format: 'text/markdown',
  entityTypes: ['research', 'paper'],
  language: 'en',
});

const rUri = resourceUri(result.resource['@id']);
console.log('Created resource:', rUri);
```

#### Creating Image Resources

```typescript
// Browser: from file input
const fileInput = document.querySelector('input[type="file"]');
const imageFile = fileInput.files[0];

const { resource } = await client.createResource({
  name: 'Team Photo',
  file: imageFile,
  format: 'image/jpeg',
  entityTypes: ['photo'],
  language: 'en'
});

console.log('Uploaded image:', resource['@id']);

// Node.js: from filesystem
import { readFileSync } from 'fs';

const imageBuffer = readFileSync('/path/to/photo.jpg');
const { resource } = await client.createResource({
  name: 'Team Photo',
  file: imageBuffer,
  format: 'image/jpeg',
  entityTypes: ['photo']
});
```

#### Character Encoding Support

By default, text resources are assumed to be UTF-8. To specify a different character encoding, include a `charset` parameter in the `format` field:

```typescript
// Default UTF-8 (no charset parameter needed)
const utf8Blob = new Blob(['Hello World']);
await client.createResource({
  name: 'Modern Document',
  file: utf8Blob,
  format: 'text/plain'  // Defaults to UTF-8
});

// Legacy document with ISO-8859-1 encoding
const legacyBlob = new Blob([legacyContent]);
await client.createResource({
  name: 'Legacy Document',
  file: legacyBlob,
  format: 'text/plain; charset=iso-8859-1'
});

// Windows-1252 encoded text
const windowsBlob = new Blob([windowsContent]);
await client.createResource({
  name: 'Windows Document',
  file: windowsBlob,
  format: 'text/markdown; charset=windows-1252'
});
```

**Supported charsets:**

- `utf-8` (default)
- `iso-8859-1` / `latin1`
- `windows-1252` / `cp1252`
- `ascii` / `us-ascii`
- `utf-16le`

The charset is preserved in the resource metadata and used for correct decoding when retrieving the content.

### Reading Resources

```typescript
// Get full resource with annotations (JSON metadata)
const resource = await client.getResource(rUri);

console.log('Name:', resource.resource.name);
console.log('Format:', resource.resource.format);
console.log('Annotations:', resource.annotations.length);
console.log('Entity References:', resource.entityReferences.length);
```

### Getting Resource Representations

Use W3C content negotiation to get the raw binary content of a resource (images, PDFs, text, etc.) with content type:

#### Fetching Text Content

```typescript
// Get markdown content for editing (decode to text)
const { data, contentType } = await client.getResourceRepresentation(rUri, {
  accept: 'text/markdown'
});
const markdown = new TextDecoder().decode(data);

console.log('Content:', markdown);
// Output: "# Introduction\n\nThis paper explores..."
console.log('Type:', contentType); // 'text/markdown'

// Get plain text representation
const { data, contentType } = await client.getResourceRepresentation(rUri, {
  accept: 'text/plain'
});
const plainText = new TextDecoder().decode(data);
```

#### Fetching Image Content

```typescript
// Get JPEG image
const { data, contentType } = await client.getResourceRepresentation(imageUri, {
  accept: 'image/jpeg'
});

// Browser: Create object URL for display
const blob = new Blob([data], { type: contentType });
const imageUrl = URL.createObjectURL(blob);

// Use in img tag
const img = document.querySelector('img');
img.src = imageUrl;

// Node.js: Save to file
import { writeFileSync } from 'fs';
writeFileSync('/path/to/output.jpg', Buffer.from(data));

// Get PNG image
const { data: pngData, contentType: pngType } = await client.getResourceRepresentation(imageUri, {
  accept: 'image/png'
});
const pngBlob = new Blob([pngData], { type: pngType });
```

**Use Cases:**
- Small to medium files (< 10MB)
- Load text content for editing in a text editor
- Clone resource content to create new documents
- Create object URLs for displaying media with correct MIME type
- Display raw content in the UI

**For large files (videos, large PDFs, datasets), use streaming instead:**

```typescript
// Stream large video file (never loads entire file into memory)
const { stream, contentType } = await client.getResourceRepresentationStream(rUri, {
  accept: 'video/mp4'
});

// Option 1: Process chunks as they arrive
const reader = stream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  // Process chunk (value is Uint8Array)
  console.log(`Received ${value.length} bytes`);
  processChunk(value);
}

// Option 2: Use async iteration
for await (const chunk of stream) {
  processChunk(chunk);
}

// Option 3: Pipe directly to a file (Node.js)
const fileStream = fs.createWriteStream('large-file.mp4');
await stream.pipeTo(Writable.toWeb(fileStream));
```

**Streaming benefits:**
- Never loads entire file into memory
- Backend connection stays open until stream consumed
- Lower latency - starts processing immediately
- Perfect for proxying large content

### Updating Resources

Resources in Semiont are **append-only** (event sourced), so content and name are immutable. You can only update metadata like entity types and archive status.

```typescript
// Update entity types
const updated = await client.updateResource(rUri, {
  entityTypes: ['research', 'paper', 'published'],
});

console.log('Updated entity types:', updated.resource.entityTypes);

// Archive a resource (instead of deleting)
const archived = await client.updateResource(rUri, {
  archived: true,
});

// Unarchive a resource
const unarchived = await client.updateResource(rUri, {
  archived: false,
});

// Update multiple fields in one operation
const result = await client.updateResource(rUri, {
  archived: true,
  entityTypes: ['archived', 'draft'],
});
```

### Listing Resources

```typescript
// List all active resources
const active = await client.listResources(20, false);
console.log(`Found ${active.total} active resources`);

// List only archived resources
const archived = await client.listResources(20, true);
console.log(`Found ${archived.total} archived resources`);

// List all resources (active and archived)
const all = await client.listResources(20);
console.log(`Found ${all.total} total resources`);

// Search resources by name or content
const search = await client.listResources(20, false, 'quantum physics');
console.log(`Found ${search.total} matching resources`);
```

### Resource Events

```typescript
// Get event history for a resource
const events = await client.getResourceEvents(rUri);

console.log(`Total events: ${events.events.length}`);

// Example: Find when resource was archived
const archivedEvent = events.events.find(e => e.type === 'resource.archived');
if (archivedEvent) {
  console.log('Archived at:', archivedEvent.timestamp);
}
```

## Annotations

### Creating Annotations

Semiont uses the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/).

#### Create a Highlight

```typescript
import { resourceAnnotationUri } from '@semiont/api-client';

const highlight = await client.createAnnotation(rUri, {
  target: {
    source: rUri,
    selector: [
      {
        type: 'TextPositionSelector',
        start: 0,
        end: 11,
      },
      {
        type: 'TextQuoteSelector',
        exact: 'Hello World',
      },
    ],
  },
  body: [],
  motivation: 'highlighting',
});

console.log('Created highlight:', highlight.annotation.id);
```

#### Create a Reference (Stub)

```typescript
const reference = await client.createAnnotation(rUri, {
  target: {
    source: rUri,
    selector: [
      {
        type: 'TextPositionSelector',
        start: 15,
        end: 30,
      },
      {
        type: 'TextQuoteSelector',
        exact: 'quantum physics',
      },
    ],
  },
  body: [
    {
      type: 'TextualBody',
      value: JSON.stringify({ entityTypes: ['concept', 'physics'] }),
      format: 'application/json',
      purpose: 'tagging',
    },
  ],
  motivation: 'linking',
});

console.log('Created reference stub:', reference.annotation.id);
```

### Linking Annotations to Resources

```typescript
// Link a reference annotation to an existing resource
const annUri = resourceAnnotationUri(`${rUri}/annotations/${annotationId}`);

const linked = await client.updateAnnotationBody(annUri, {
  operations: [
    {
      op: 'add',
      item: {
        type: 'SpecificResource',
        source: targetResourceUri,
        purpose: 'linking',
      },
    },
  ],
});

console.log('Linked annotation to resource:', linked.annotation.id);
```

### Deleting Annotations

```typescript
const annUri = resourceAnnotationUri(`${rUri}/annotations/${annotationId}`);
await client.deleteAnnotation(annUri);

console.log('Deleted annotation:', annotationId);
```

### Annotation History

Get the complete event history for an annotation with sequence numbers and checksums.

```typescript
const annUri = resourceAnnotationUri(`${rUri}/annotations/${annotationId}`);
const history = await client.getAnnotationHistory(annUri);

console.log(`Total events: ${history.total}`);

// Events are sorted by sequence number
history.events.forEach(event => {
  console.log(`[${event.metadata.sequenceNumber}] ${event.type}`);
  console.log(`  Timestamp: ${event.timestamp}`);
  console.log(`  User: ${event.userId}`);
  console.log(`  Checksum: ${event.metadata.checksum}`);
});
```

## Event Streams

### Get Resource Events

```typescript
const events = await client.getResourceEvents(rUri);

// Format events for display
events.events.forEach(event => {
  console.log(`[${event.timestamp}] ${event.type}`);
  console.log('  Payload:', JSON.stringify(event.payload, null, 2));
});
```

### Get Referenced By

```typescript
// Find all resources that reference this resource
const refs = await client.getResourceReferencedBy(rUri);

console.log(`Referenced by ${refs.referencedBy.length} resources`);
refs.referencedBy.forEach(ref => {
  console.log(`- ${ref.name} (${ref.id})`);
});
```

## SSE Streaming

Server-Sent Events (SSE) provide real-time progress updates for long-running operations. Unlike polling (used in `pollJobUntilComplete`), SSE streams push updates as they happen, reducing latency and server load.

### Architecture and Design Principles

The SSE implementation follows five core design principles:

**1. Clear Separation from Request/Response**

SSE streaming uses a **separate namespace** (`client.sse.*`) to distinguish it from standard HTTP request/response methods. This makes it immediately obvious when code is dealing with streaming vs. traditional HTTP.

```typescript
// Traditional HTTP (ky-based)
await client.createResource({ ... });

// SSE streaming (fetch-based)
client.sse.detectAnnotations(...);
```

**2. Not ky-Based**

SSE methods **do not use `ky`** (the HTTP client used for other methods). Instead, they use:
- Native `fetch()` for HTTP connection
- Manual SSE parsing (not `EventSource` API for better control)
- `AbortController` for cancellation

**Rationale**:
- `ky` is optimized for request/response, not streaming
- SSE requires parsing `text/event-stream` format
- We need fine-grained control over connection lifecycle

**3. Type-Safe Events**

All events have TypeScript interfaces matching the backend's event payloads. Types are derived from OpenAPI schemas where possible.

```typescript
interface DetectionProgress {
  status: 'started' | 'scanning' | 'complete' | 'error';
  resourceId: string;
  currentEntityType?: string;
  totalEntityTypes: number;
  processedEntityTypes: number;
  foundCount?: number;
}
```

**4. Consistent Callback API**

All three SSE methods return stream objects with similar callback patterns:
- `.onProgress()` - Incremental updates
- `.onComplete()` - Final result
- `.onError()` - Error handling
- `.close()` - Manual cancellation

**5. No Response Validation**

SSE streams are not validated (per `SSE-VALIDATION-CONSIDERATIONS.md`). Request bodies are validated via OpenAPI schemas, but streaming responses are parsed as-is.

### When to Use SSE vs Regular Methods

**When to use SSE:**

- ✅ Long-running operations (detection, generation)
- ✅ Real-time progress updates
- ✅ Live collaboration (see events from other users)
- ✅ Operations that benefit from immediate feedback

**When to use regular methods:**

- ✅ Simple CRUD operations (create, read, update, delete)
- ✅ One-time requests without progress tracking
- ✅ Batch operations that don't need real-time feedback

**Note**: SSE methods use native `fetch()` instead of `ky` for better streaming support.

### Stream Entity Detection

Stream real-time progress updates during entity detection:

```typescript
import { resourceUri } from '@semiont/api-client';

const rUri = resourceUri('http://localhost:4000/resources/resource-123');

// Start detection stream
const stream = client.sse.detectAnnotations(rUri, {
  entityTypes: ['Person', 'Organization', 'Location']
});

// Handle progress events
stream.onProgress((progress) => {
  if (progress.status === 'started') {
    console.log(`Starting detection for ${progress.totalEntityTypes} entity types...`);
  } else if (progress.status === 'scanning') {
    console.log(`Scanning for ${progress.currentEntityType}...`);
    console.log(`Progress: ${progress.processedEntityTypes}/${progress.totalEntityTypes}`);
  }
});

// Handle completion
stream.onComplete((result) => {
  console.log(`Detection complete!`);
  console.log(`Found ${result.foundCount} entities`);
  console.log(`Processed ${result.processedEntityTypes}/${result.totalEntityTypes} entity types`);

  // Fetch updated resource with new annotations
  client.getResource(rUri).then(resource => {
    console.log(`Resource now has ${resource.annotations.length} annotations`);
  });
});

// Handle errors
stream.onError((error) => {
  console.error('Detection failed:', error.message);
});

// Cleanup when done (e.g., component unmount)
// stream.close();
```

**Progress Event Types:**

- `detection-started` - Detection job has started
- `detection-progress` - Currently scanning an entity type
- `detection-complete` - All entity types scanned
- `detection-error` - Detection failed

### Stream Resource Generation

Stream real-time progress updates during resource generation from an annotation:

```typescript
import { resourceUri, annotationUri } from '@semiont/api-client';

const rUri = resourceUri('http://localhost:4000/resources/resource-123');
const annUri = annotationUri('http://localhost:4000/annotations/annotation-456');

// Start generation stream with custom options
const stream = client.sse.generateResourceFromAnnotation(rUri, annUri, {
  title: 'Spanish Summary',
  language: 'es',
  prompt: 'Create a concise summary focusing on key findings'
});

// Handle progress events (percentage-based)
stream.onProgress((progress) => {
  console.log(`${progress.status}: ${progress.percentage}%`);

  if (progress.message) {
    console.log(`  ${progress.message}`);
  }

  // Progress stages:
  // - 'started' (0%)
  // - 'fetching' (25%)
  // - 'generating' (50-75%)
  // - 'creating' (90%)
});

// Handle completion
stream.onComplete((result) => {
  console.log(`Generation complete!`);
  console.log(`Generated resource: ${result.resourceId}`);

  // Navigate to generated resource or fetch it
  if (result.resourceId) {
    const generatedUri = resourceUri(result.resourceId);
    client.getResource(generatedUri).then(resource => {
      console.log('Generated resource:', resource.name);
    });
  }
});

// Handle errors
stream.onError((error) => {
  console.error('Generation failed:', error.message);
});
```

**Generation Options:**

- `title` - Custom title for generated resource (optional)
- `language` - Language locale (e.g., 'es', 'fr', 'ja') (optional)
- `prompt` - Custom generation prompt (optional)

**Progress Event Types:**

- `generation-started` - Generation job has started
- `generation-progress` - Generation in progress (with percentage)
- `generation-complete` - Resource generated successfully
- `generation-error` - Generation failed

### Subscribe to Resource Events

Subscribe to real-time events for a resource (long-lived stream for collaboration):

```typescript
import { resourceUri } from '@semiont/api-client';

const rUri = resourceUri('http://localhost:4000/resources/resource-123');

// Open long-lived event stream
const stream = client.sse.resourceEvents(rUri);

// Handle all events (uses onProgress for events)
stream.onProgress((event) => {
  console.log(`[${event.timestamp}] ${event.type}`);
  console.log(`  User: ${event.userId}`);
  console.log(`  Sequence: ${event.metadata.sequenceNumber}`);
  console.log(`  Payload:`, event.payload);

  // Handle specific event types
  switch (event.type) {
    case 'annotation.created':
      console.log('New annotation added by another user!');
      break;
    case 'annotation.updated':
      console.log('Annotation modified by another user!');
      break;
    case 'annotation.deleted':
      console.log('Annotation removed by another user!');
      break;
  }
});

// Handle stream errors
stream.onError((error) => {
  console.error('Event stream error:', error.message);
  // Implement reconnection logic if needed
});

// NOTE: This is a long-lived stream with NO completion event
// It stays open until explicitly closed

// Cleanup on component unmount or when no longer needed
// stream.close();
```

**Event Types You'll Receive:**

- `resource.created` - Resource was created
- `resource.updated` - Resource metadata changed
- `annotation.created` - New annotation added
- `annotation.updated` - Annotation modified
- `annotation.deleted` - Annotation deleted
- `comment.created` - Comment added
- `comment.updated` - Comment modified
- `comment.deleted` - Comment deleted

**Use Cases:**

- Real-time collaboration (see other users' changes)
- Live annotation feed
- Activity monitoring
- Synchronized views across multiple clients

### Stream Lifecycle Management

All SSE streams should be cleaned up when no longer needed:

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

```typescript
// Node.js example with timeout
const stream = client.sse.resourceEvents(resourceId);

stream.onProgress((event) => console.log(event));

// Close after 5 minutes
setTimeout(() => {
  console.log('Closing event stream...');
  stream.close();
}, 5 * 60 * 1000);
```

### SSE Error Handling

SSE streams can fail for various reasons. Always implement error handling:

```typescript
const stream = client.sse.detectAnnotations(resourceId, { entityTypes: ['Person'] });

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
    console.log('Token expired, re-authenticating...');
  } else if (error.message.includes('Network')) {
    // Retry with exponential backoff
    console.log('Network error, retrying...');
  }
});
```

## Entity Detection and Jobs

### Managing Entity Types

Add entity types that can be used for annotations and detection.

```typescript
// Add a single entity type
await client.addEntityType('concept');

// Add multiple entity types at once
const result = await client.addEntityTypesBulk(['concept', 'person', 'organization']);
console.log(`Added ${result.added} entity types`);
console.log('All entity types:', result.entityTypes);

// List all available entity types
const types = await client.listEntityTypes();
console.log('Available entity types:', types.entityTypes);
```

### Entity Detection with SSE Streaming

For entity detection, use the SSE streaming API for real-time progress updates. See the [SSE Streaming](#sse-streaming) section below for details.

```typescript
import { resourceUri, entityType } from '@semiont/api-client';

const rUri = resourceUri('http://localhost:4000/resources/resource-123');

// Start detection with real-time progress updates
const stream = client.sse.detectAnnotations(rUri, {
  entityTypes: ['person', 'organization', 'location'].map(entityType)
});

stream.onProgress((progress) => {
  console.log(`Status: ${progress.status}`);
  console.log(`Progress: ${progress.processedEntityTypes}/${progress.totalEntityTypes}`);
  console.log(`Found: ${progress.foundCount} entities`);
});

stream.onComplete(() => {
  console.log('Detection complete!');
});

stream.onError((error) => {
  console.error('Detection failed:', error);
});
```

### Job Status (For Existing Jobs)

Check the status of an existing job:

```typescript
const status = await client.getJobStatus(jobId);

console.log('Status:', status.status);      // 'pending' | 'running' | 'complete' | 'failed'
console.log('Type:', status.type);          // 'detection' | 'generation'
console.log('Progress:', status.progress);  // { current: 50, total: 100, message: '...' }

if (status.status === 'complete') {
  console.log('Result:', status.result);
} else if (status.status === 'failed') {
  console.error('Error:', status.error);
}
```

## LLM Context

### Get Resource LLM Context

Get a resource with full context optimized for LLM processing. This includes the resource, related resources, annotations, and a graph representation.

```typescript
import { resourceUri } from '@semiont/api-client';

const rUri = resourceUri('http://localhost:4000/resources/resource-123');

// Get with default options
const context = await client.getResourceLLMContext(rUri);

console.log('Main resource:', context.mainResource);
console.log('Related resources:', context.relatedResources);
console.log('Annotations:', context.annotations);
console.log('Graph:', context.graph);

// Get with custom options
const contextWithOptions = await client.getResourceLLMContext(rUri, {
  depth: 3,              // Graph traversal depth (1-3, default: 2)
  maxResources: 15,      // Max related resources (1-20, default: 10)
  includeContent: true,  // Include full content (default: true)
  includeSummary: true,  // Generate AI summary (default: false)
});

console.log('Context for LLM:', contextWithOptions);
```

### Get Annotation LLM Context

Get an annotation with surrounding text context for LLM processing. Useful for understanding what text was selected and the context around it.

```typescript
import { resourceAnnotationUri } from '@semiont/api-client';

const annUri = resourceAnnotationUri(
  'http://localhost:4000/resources/resource-123/annotations/ann-456'
);

// Get with default options
const context = await client.getAnnotationLLMContext(annUri);

console.log('Annotation:', context.annotation);
console.log('Source resource:', context.sourceResource);
console.log('Target resource:', context.targetResource);
console.log('Source context:', context.sourceContext);

// Get with custom options
const contextWithWindow = await client.getAnnotationLLMContext(annUri, {
  includeSourceContext: true,   // Include source text context (default: true)
  includeTargetContext: true,   // Include target resource context (default: true)
  contextWindow: 500,           // Characters of context (100-5000, default: 1000)
});

// Source context includes text before/after the selection
console.log('Before:', contextWithWindow.sourceContext?.before);
console.log('Selected:', contextWithWindow.sourceContext?.selected);
console.log('After:', contextWithWindow.sourceContext?.after);
```

## Logging and Observability

Enable logging to debug requests, monitor API usage, and troubleshoot issues:

```typescript
import { SemiontApiClient, Logger, baseUrl } from '@semiont/api-client';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
});

const client = new SemiontApiClient({
  baseUrl: baseUrl('http://localhost:4000'),
  logger  // All HTTP requests and SSE streams will be logged
});
```

**What gets logged**:

- HTTP requests and responses (debug level)
- SSE stream lifecycle events (info level)
- Individual SSE events (debug level)
- Errors with full context (error level)

**Security**: Authorization headers are never logged to prevent token leaks.

📘 **[Complete Logging Guide](./LOGGING.md)** - Detailed documentation on logger setup, integration examples (winston, pino, DataDog, Splunk), structured metadata, log levels, filtering, and troubleshooting.

## Error Handling

```typescript
import { APIError } from '@semiont/api-client';

try {
  const resource = await client.getResource(rUri);
} catch (error) {
  if (error instanceof APIError) {
    // Structured API error
    console.error('API Error:', {
      message: error.message,
      status: error.status,
      statusText: error.statusText,
      details: error.details,
    });

    // Handle specific error codes
    if (error.status === 404) {
      console.log('Resource not found');
    } else if (error.status === 401) {
      console.log('Authentication required');
      // Re-authenticate
      await client.authenticateLocal(email, code);
    }
  } else {
    // Network or other error
    console.error('Unexpected error:', error);
  }
}
```

## Testing

See [client.test.ts](../src/__tests__/client.test.ts) for complete test examples.

### Example Test: Archive Resource

```typescript
test('should archive a resource', async () => {
  const client = new SemiontApiClient({ baseUrl: 'http://localhost:4000' });

  // Archive resource
  const result = await client.updateResource(resourceUri, {
    archived: true,
  });

  expect(result.resource.archived).toBe(true);
});
```

## System Status

Check the system status to get version information, available features, and authentication state.

```typescript
const status = await client.getStatus();

console.log('Version:', status.version);
console.log('Features:', status.features);
console.log('Authenticated:', status.authenticated);

// Check if specific features are available
if (status.features?.oauth) {
  console.log('Google OAuth is enabled');
}

if (status.features?.entityDetection) {
  console.log('Entity detection is available');
}
```

## Advanced Usage

### Custom Timeout and Retry

```typescript
const client = new SemiontApiClient({
  baseUrl: 'http://localhost:4000',
  timeout: 60000, // 60 seconds
  retry: 3, // Retry failed requests 3 times
});
```

### Using with Environment Variables

```typescript
const client = new SemiontApiClient({
  baseUrl: process.env.SEMIONT_API_URL || 'http://localhost:4000',
  accessToken: process.env.SEMIONT_ACCESS_TOKEN,
});
```

### Clone Resources with Tokens

```typescript
// Generate a clone token (valid for 24 hours)
const tokenResponse = await client.generateCloneToken(rUri);
console.log('Clone token:', tokenResponse.token);

// Later, use token to clone resource (no auth required)
const cloned = await client.createResourceFromToken({
  token: tokenResponse.token,
  name: 'Cloned Resource',
});

console.log('Cloned resource:', cloned.resource.id);
```

## See Also

- [README.md](../README.md) - Package overview and API reference
- [Utilities Guide](./Utilities.md) - W3C annotation and event utilities
- [OpenAPI Specification](../../../specs/README.md) - Complete API schema (source in [../../../specs/src/](../../../specs/src/))
- [Demo Scripts](../../../demo/) - Complete working examples
