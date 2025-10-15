# @semiont/sdk

Core SDK for the Semiont semantic knowledge platform. Provides TypeScript types, schemas, utilities, and an API client for building applications on Semiont.

## Installation

```bash
npm install @semiont/sdk
```

## Overview

The Semiont SDK provides:

1. **TypeScript Types & Schemas** - Complete type definitions for documents, annotations, and events
2. **API Client** - High-level client for interacting with the Semiont backend
3. **Utility Functions** - Helpers for working with annotations, selectors, and W3C Web Annotations
4. **Validation** - Zod schemas for runtime validation of API requests/responses

## Quick Start

### Using the API Client

```typescript
import { SemiontClient } from '@semiont/sdk';

// Initialize client
const client = new SemiontClient({
  backendUrl: 'http://localhost:4000',
  authEmail: 'user@example.com',
});

// Authenticate
await client.authenticate();

// Create a document
const doc = await client.createDocument({
  name: 'My Document',
  content: 'Hello, world!',
  format: 'text/plain',
  entityTypes: ['note'],
  creationMethod: 'api',
});

// Create an annotation
const annotation = await client.createAnnotation({
  target: {
    source: doc.document.id,
    selector: {
      type: 'TextPositionSelector',
      offset: 0,
      length: 5,
      exact: 'Hello',
    },
  },
  body: {
    type: 'TextualBody',
    value: 'A greeting',
    entityTypes: ['comment'],
  },
});

// Get document event history
const events = await client.getDocumentEvents(doc.document.id);
console.log(`Document has ${events.total} events`);
```

### Using Types

```typescript
import type {
  Document,
  Annotation,
  CreateDocumentRequest,
  CreateAnnotationRequest,
} from '@semiont/sdk';

function processDocument(doc: Document): void {
  console.log(`Processing: ${doc.name}`);
}

function createHighlight(req: CreateAnnotationRequest): void {
  // TypeScript ensures correct structure
}
```

### Using Utilities

```typescript
import {
  extractAnnotationId,
  isHighlight,
  isReference,
  getExactText,
  encodeAnnotationIdForUrl,
} from '@semiont/sdk';

// Extract short ID from full URI
const shortId = extractAnnotationId('http://localhost:4000/annotations/abc123');
// => 'abc123'

// Check annotation types
if (isHighlight(annotation)) {
  console.log('This is a highlight');
}

if (isReference(annotation)) {
  console.log('This is a reference to another document');
}

// Get text from selector
const text = getExactText(annotation.target.selector);

// URL-encode annotation IDs for API calls
const encoded = encodeAnnotationIdForUrl(annotation.id);
```

## Core Concepts

### Documents

Documents are the primary content units in Semiont. Each document:
- Has a content-addressed ID (SHA-256 hash)
- Contains text content with a format (text/plain, text/markdown, etc.)
- Has entity types for classification
- Tracks creation method and metadata

```typescript
import type { Document, CreateDocumentRequest } from '@semiont/sdk';

const request: CreateDocumentRequest = {
  name: 'Example Document',
  content: 'Document content here...',
  format: 'text/markdown',
  entityTypes: ['article', 'research'],
  creationMethod: 'api',
};
```

### Annotations

Annotations follow the W3C Web Annotation standard. Two main types:

**Highlights** - Mark spans of text:
```typescript
import type { CreateAnnotationRequest } from '@semiont/sdk';

const highlight: CreateAnnotationRequest = {
  target: {
    source: documentId,
    selector: {
      type: 'TextPositionSelector',
      offset: 100,
      length: 50,
      exact: 'the highlighted text',
    },
  },
  body: {
    type: 'TextualBody',
    value: 'My comment on this text',
    entityTypes: ['comment'],
  },
};
```

**References** - Link to other documents:
```typescript
const reference: CreateAnnotationRequest = {
  target: {
    source: documentId,
    selector: {
      type: 'TextPositionSelector',
      offset: 200,
      length: 10,
      exact: 'click here',
    },
  },
  body: {
    type: 'SpecificResource',
    source: targetDocumentId, // or null for stub reference
    entityTypes: ['hyperlink'],
  },
};
```

### Event-Sourced Architecture

Semiont uses event sourcing with three storage layers:

- **Layer 1 (Storage)**: Content-addressed documents in `.dat` files
- **Layer 2 (Events)**: Append-only event logs (`.jsonl` files)
- **Layer 3 (Projections)**: Current state computed from events

Events include:
- `document.created` - Document uploaded
- `reference.created` - Annotation created (stub or resolved)
- `reference.resolved` - Stub reference resolved to target
- `reference.deleted` - Annotation removed
- `highlight.added` - Highlight annotation created
- `highlight.removed` - Highlight annotation deleted

```typescript
import type { GetEventsResponse, DocumentEvent } from '@semiont/sdk';

const events: GetEventsResponse = await client.getDocumentEvents(docId);

events.events.forEach((stored) => {
  const event = stored.event;
  console.log(`Event ${stored.metadata.sequenceNumber}: ${event.type}`);
});
```

## API Client

The `SemiontClient` provides a high-level interface to the Semiont backend:

### Methods

#### `authenticate(): Promise<AuthResponse>`
Authenticate using local development auth (requires `ENABLE_LOCAL_AUTH=true` on backend).

```typescript
const authResponse = await client.authenticate();
console.log(`Logged in as: ${authResponse.user.name}`);
```

#### `getToken(): string`
Get the current JWT authentication token (throws if not authenticated).

#### `createDocument(request: CreateDocumentRequest): Promise<CreateDocumentResponse>`
Upload a new document.

```typescript
const response = await client.createDocument({
  name: 'My Document',
  content: 'Content here...',
  format: 'text/plain',
  entityTypes: ['note'],
  creationMethod: 'api',
});

const docId = response.document.id;
```

#### `createAnnotation(request: CreateAnnotationRequest): Promise<CreateAnnotationResponse>`
Create a new annotation (highlight or reference).

```typescript
const response = await client.createAnnotation({
  target: {
    source: docId,
    selector: {
      type: 'TextPositionSelector',
      offset: 0,
      length: 10,
      exact: 'First word',
    },
  },
  body: {
    type: 'TextualBody',
    value: 'A comment',
  },
});

const annotationId = response.annotation.id;
```

#### `resolveAnnotation(annotationId: string, targetDocumentId: string): Promise<{success: boolean}>`
Resolve a stub reference to point to a target document.

```typescript
const result = await client.resolveAnnotation(
  'http://localhost:4000/annotations/abc123',
  'doc-sha256:...'
);

if (result.success) {
  console.log('Reference resolved!');
}
```

#### `getDocumentEvents(documentId: string): Promise<GetEventsResponse>`
Fetch the complete event history for a document.

```typescript
const events = await client.getDocumentEvents(docId);
console.log(`Total events: ${events.total}`);
```

### Async Job Operations

The SDK supports triggering async jobs for long-running AI operations like entity detection and document generation. These methods use a **job-based polling approach** where you create a job, then poll for its status until completion.

#### `detectEntities(documentId: string, entityTypes: string[]): Promise<CreateJobResponse>`
Trigger an async entity detection job to find and annotate entities in a document.

```typescript
// Create detection job
const job = await client.detectEntities(docId, ['person', 'location', 'organization']);
console.log(`Job created: ${job.jobId}`);

// Poll for completion
const result = await client.waitForJob(job.jobId, {
  onProgress: (status) => console.log(`Status: ${status.status}`),
});

console.log(`Detected ${result.result.totalFound} entities`);
```

#### `generateDocument(annotationId: string, options): Promise<CreateJobResponse>`
Trigger an async document generation job to create a new document using AI from an annotation.

```typescript
// Create generation job
const job = await client.generateDocument(annotationId, {
  documentId: sourceDocId,
  title: 'Generated Explanation',
  prompt: 'Write a detailed explanation of this concept',
  locale: 'en',
});

// Wait for completion
const result = await client.waitForJob(job.jobId);
console.log(`Generated document: ${result.result.documentId}`);
```

#### `getJobStatus(jobId: string): Promise<JobStatusResponse>`
Get the current status of an async job.

```typescript
const status = await client.getJobStatus(jobId);
console.log(`Job ${jobId} is ${status.status}`);

if (status.status === 'complete') {
  console.log('Result:', status.result);
}
```

#### `waitForJob(jobId: string, options?: WaitForJobOptions): Promise<JobStatusResponse>`
Wait for a job to complete by polling its status. Throws if the job fails or times out.

```typescript
// Wait with custom options
const result = await client.waitForJob(jobId, {
  pollInterval: 1000,      // Poll every 1 second (default: 500ms)
  timeout: 600000,         // 10 minute timeout (default: 5 minutes)
  onProgress: (job) => {
    // Called on each status update
    console.log(`Progress: ${job.status}`, job.progress);
  },
});
```

**Job Types:**

```typescript
import type {
  JobStatusResponse,
  DetectionProgress,
  DetectionResult,
  GenerationProgress,
  GenerationResult,
} from '@semiont/sdk';

// Detection job progress
interface DetectionProgress {
  totalEntityTypes: number;
  processedEntityTypes: number;
  currentEntityType?: string;
  entitiesFound: number;
  entitiesEmitted: number;
}

// Generation job progress
interface GenerationProgress {
  stage: 'fetching' | 'generating' | 'creating' | 'linking';
  percentage: number;
  message?: string;
}
```

**SSE Alternative:** The backend also provides Server-Sent Events (SSE) endpoints for real-time progress streaming, which are used by the frontend UI:
- `POST /api/documents/{id}/detect-annotations-stream` - Real-time entity detection
- `POST /api/annotations/{id}/generate-document-stream` - Real-time document generation

The job-based approach is simpler for CLI tools and scripts, while SSE provides better real-time feedback for interactive UIs. Both use the same underlying job queue and workers.

### Batch Operations

The SDK provides batch helpers for bulk operations:

```typescript
import {
  uploadDocumentBatch,
  createAnnotationBatch,
  resolveAnnotationBatch,
} from '@semiont/sdk';

// Upload multiple documents
const docs = await uploadDocumentBatch(client, [
  { name: 'Doc 1', content: '...', format: 'text/plain', entityTypes: [], creationMethod: 'api' },
  { name: 'Doc 2', content: '...', format: 'text/plain', entityTypes: [], creationMethod: 'api' },
]);

// Create multiple annotations
const annotations = await createAnnotationBatch(client, [
  { target: { source: docId, selector: {...} }, body: {...} },
  { target: { source: docId, selector: {...} }, body: {...} },
]);

// Resolve multiple references
const results = await resolveAnnotationBatch(client, [
  { annotationId: 'http://localhost:4000/annotations/abc', targetDocumentId: 'doc-sha256:...' },
  { annotationId: 'http://localhost:4000/annotations/def', targetDocumentId: 'doc-sha256:...' },
]);
```

## Utility Functions

### Annotation Utilities

```typescript
import {
  extractAnnotationId,
  encodeAnnotationIdForUrl,
  isFullAnnotationUri,
  getAnnotationApiId,
  compareAnnotationIds,
  isHighlight,
  isReference,
  isStubReference,
  isResolvedReference,
  getAnnotationCategory,
} from '@semiont/sdk';

// Extract short ID from full URI
const shortId = extractAnnotationId('http://localhost:4000/annotations/xyz');
// => 'xyz'

// URL-encode for API paths
const encoded = encodeAnnotationIdForUrl('http://localhost:4000/annotations/xyz');

// Check if ID is a full URI
if (isFullAnnotationUri(annotationId)) {
  // ...
}

// Type guards
if (isHighlight(annotation)) {
  console.log('Highlight:', annotation.body.value);
}

if (isStubReference(annotation)) {
  console.log('Unresolved reference');
}

if (isResolvedReference(annotation)) {
  console.log('Links to:', annotation.body.source);
}
```

### Selector Utilities

```typescript
import {
  getExactText,
  getAnnotationExactText,
  getPrimarySelector,
  getTextPositionSelector,
  getTextQuoteSelector,
} from '@semiont/sdk';

// Extract text from selector
const text = getExactText(selector);

// Get text from annotation
const annotationText = getAnnotationExactText(annotation);

// Get primary selector (handles single or array)
const primary = getPrimarySelector(annotation.target.selector);

// Get specific selector types
const positionSelector = getTextPositionSelector(annotation.target.selector);
const quoteSelector = getTextQuoteSelector(annotation.target.selector);
```

### W3C Agent Utilities

```typescript
import {
  userToDid,
  userToAgent,
  didToAgent,
} from '@semiont/sdk';

// Convert user to DID:WEB
const did = userToDid(user);
// => 'did:web:localhost%3A4000:users:user-id'

// Convert user to W3C Agent
const agent = userToAgent(user);
// => { id: 'did:web:...', type: 'Person', name: 'User Name' }

// Convert DID to Agent
const agent2 = didToAgent('did:web:localhost%3A4000:users:123');
```

### Cryptographic Utilities

```typescript
import { computeSha256Hash } from '@semiont/sdk';

// Compute SHA-256 hash (used for content-addressed document IDs)
const hash = await computeSha256Hash('document content');
// => 'abc123...'
```

### Validation

```typescript
import {
  DocumentSchema,
  AnnotationSchema,
  CreateDocumentRequestSchema,
  CreateAnnotationRequestSchema,
} from '@semiont/sdk';

// Validate data at runtime
const result = DocumentSchema.safeParse(data);
if (result.success) {
  const doc = result.data; // Typed as Document
} else {
  console.error('Validation errors:', result.error);
}
```

## TypeScript Types

The SDK exports comprehensive types for the entire Semiont domain model:

### Document Types
- `Document` - Core document model
- `CreateDocumentRequest` / `CreateDocumentResponse`
- `UpdateDocumentRequest`
- `GetDocumentResponse` / `ListDocumentsResponse`
- `DocumentFilter` - For querying documents

### Annotation Types
- `Annotation` - Core annotation model (W3C Web Annotation)
- `HighlightAnnotation` / `ReferenceAnnotation` - Specialized types
- `CreateAnnotationRequest` / `CreateAnnotationResponse`
- `Selector` / `TextPositionSelector` / `TextQuoteSelector`
- `Motivation` - W3C annotation motivation
- `Agent` - W3C agent (creator) model

### Event Types
- `DocumentEvent` - Base event type
- `DocumentCreatedEvent` / `DocumentArchivedEvent`
- `ReferenceCreatedEvent` / `ReferenceResolvedEvent` / `ReferenceDeletedEvent`
- `HighlightAddedEvent` / `HighlightRemovedEvent`
- `StoredEvent` - Event with metadata
- `GetEventsResponse` - API response for event queries

### User & Auth Types
- `AuthResponse` - Authentication result with token
- `UserResponse` / `AdminUser`
- `UpdateUserRequest`

### Other Types
- `CreationMethod` - How document was created (api, paste, etc.)
- `ReferenceTag` - Tags for reference types
- `GraphConnection` / `GraphPath` - Graph traversal types
- `ErrorResponse` / `StatusResponse`

See the [TypeScript index.ts](src/index.ts) for the complete list of exports.

## Constants

```typescript
import { CREATION_METHODS, REFERENCE_TAGS } from '@semiont/sdk';

// Available creation methods
CREATION_METHODS.API // 'api'
CREATION_METHODS.PASTE // 'paste'
CREATION_METHODS.FILE_UPLOAD // 'file-upload'

// Reference tag types
REFERENCE_TAGS.CITATION // 'citation'
REFERENCE_TAGS.HYPERLINK // 'hyperlink'
```

## Examples

### Complete Document Upload & Annotation Workflow

```typescript
import { SemiontClient } from '@semiont/sdk';

const client = new SemiontClient({
  backendUrl: 'http://localhost:4000',
  authEmail: 'user@example.com',
});

// 1. Authenticate
await client.authenticate();

// 2. Upload a document
const docResponse = await client.createDocument({
  name: 'Research Paper',
  content: 'The study found that...',
  format: 'text/plain',
  entityTypes: ['research', 'biology'],
  creationMethod: 'api',
});

const docId = docResponse.document.id;

// 3. Create a highlight annotation
const highlightResponse = await client.createAnnotation({
  target: {
    source: docId,
    selector: {
      type: 'TextPositionSelector',
      offset: 4,
      length: 5,
      exact: 'study',
    },
  },
  body: {
    type: 'TextualBody',
    value: 'Important finding',
    entityTypes: ['comment'],
  },
});

// 4. Create a stub reference (unresolved link)
const refResponse = await client.createAnnotation({
  target: {
    source: docId,
    selector: {
      type: 'TextPositionSelector',
      offset: 15,
      length: 10,
      exact: 'found that',
    },
  },
  body: {
    type: 'SpecificResource',
    source: null, // Stub reference
    entityTypes: ['citation'],
  },
});

// 5. Later, resolve the reference to another document
const targetDocId = 'doc-sha256:...'; // ID of cited document
await client.resolveAnnotation(refResponse.annotation.id, targetDocId);

// 6. View complete event history
const events = await client.getDocumentEvents(docId);
console.log(`Document has ${events.total} events`);
events.events.forEach((stored) => {
  console.log(`- ${stored.event.type} (seq: ${stored.metadata.sequenceNumber})`);
});
```

## Development

```bash
# Build the SDK
npm run build

# Watch mode (rebuild on changes)
npm run watch

# Type check
npm run type-check

# Clean build artifacts
npm run clean
```

## License

Apache-2.0

## Related Packages

- `@semiont/backend` - Semiont backend API server
- `@semiont/frontend` - Semiont web application
- `@semiont/demo` - Example scripts and demonstrations

## Learn More

- [Demo Scripts](../../demo/) - See complete examples in the demo package
- [W3C Web Annotation Model](https://www.w3.org/TR/annotation-model/) - Annotation standard
- [DID:WEB Specification](https://w3c-ccg.github.io/did-method-web/) - Decentralized identifiers
