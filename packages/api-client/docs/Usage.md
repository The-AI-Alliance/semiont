# API Client Usage Guide

Comprehensive examples for common operations with the Semiont API Client.

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
- [LLM Context](#llm-context)
  - [Get Resource LLM Context](#get-resource-llm-context)
  - [Get Annotation LLM Context](#get-annotation-llm-context)
- [Entity Detection and Jobs](#entity-detection-and-jobs)
  - [Managing Entity Types](#managing-entity-types)
  - [Start Entity Detection Job](#start-entity-detection-job)
  - [Poll Job Status](#poll-job-status)
  - [Poll Until Complete](#poll-until-complete)
  - [Complete Example: Detect and Wait](#complete-example-detect-and-wait)
- [Event Streams](#event-streams)
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

```typescript
import { resourceUri } from '@semiont/api-client';

const result = await client.createResource({
  name: 'My Research Paper',
  content: '# Introduction\n\nThis paper explores...',
  format: 'text/markdown',
  entityTypes: ['research', 'paper'],
  language: 'en',
});

const rUri = resourceUri(result.resource.id);
console.log('Created resource:', rUri);
```

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

Use W3C content negotiation to get the raw text content of a resource in different formats:

```typescript
// Get markdown content for editing
const markdown = await client.getResourceRepresentation(rUri, {
  accept: 'text/markdown'
});

console.log('Content:', markdown);
// Output: "# Introduction\n\nThis paper explores..."

// Get plain text representation
const plainText = await client.getResourceRepresentation(rUri, {
  accept: 'text/plain'
});

// Get HTML representation (if available)
const html = await client.getResourceRepresentation(rUri, {
  accept: 'text/html'
});
```

**Use Cases:**
- Load content for editing in a text editor
- Clone resource content to create new documents
- Export content to different formats
- Display raw content in the UI

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

### Start Entity Detection Job

Start an async entity detection job on a resource. The backend will analyze the resource content and create annotations for detected entities.

```typescript
import { resourceUri } from '@semiont/api-client';

const rUri = resourceUri('http://localhost:4000/resources/resource-123');

// Detect specific entity types
const job = await client.detectEntities(rUri, ['person', 'organization', 'location']);
console.log('Job ID:', job.jobId);
console.log('Status:', job.status); // 'pending'

// Detect all available entity types
const job2 = await client.detectEntities(rUri);
```

### Poll Job Status

Check the status of a running job:

```typescript
const status = await client.getJobStatus(job.jobId);

console.log('Status:', status.status);      // 'pending' | 'running' | 'complete' | 'failed'
console.log('Type:', status.type);          // 'detection' | 'generation'
console.log('Progress:', status.progress);  // { current: 50, total: 100, message: '...' }

if (status.status === 'complete') {
  console.log('Result:', status.result);
} else if (status.status === 'failed') {
  console.error('Error:', status.error);
}
```

### Poll Until Complete

Use the helper method to automatically poll until the job completes:

```typescript
const result = await client.pollJobUntilComplete(job.jobId, {
  interval: 1000,  // Poll every second (default: 1000ms)
  timeout: 60000,  // Fail after 60 seconds (default: 60000ms)
  onProgress: (status) => {
    if (status.progress) {
      console.log(`Progress: ${status.progress.current}/${status.progress.total}`);
      console.log(status.progress.message);
    }
  },
});

if (result.status === 'complete') {
  console.log('Entity detection complete!');
  console.log('Detected entities:', result.result);

  // Fetch the resource again to see the new annotations
  const updated = await client.getResource(rUri);
  console.log(`Found ${updated.annotations.length} annotations`);
} else if (result.status === 'failed') {
  console.error('Job failed:', result.error);
}
```

### Complete Example: Detect and Wait

```typescript
// Start detection job
const job = await client.detectEntities(resourceUri, ['person', 'organization']);

// Wait for completion with progress updates
const result = await client.pollJobUntilComplete(job.jobId, {
  onProgress: (status) => {
    console.log(`Status: ${status.status}`);
  },
});

// Process results
if (result.status === 'complete') {
  const resource = await client.getResource(resourceUri);
  const entities = resource.annotations.filter(a => a.motivation === 'tagging');
  console.log(`Detected ${entities.length} entities`);
}
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
