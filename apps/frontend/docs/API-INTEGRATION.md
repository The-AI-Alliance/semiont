# API Integration Guide

**Last Updated**: 2025-10-25

How the Semiont frontend integrates with the backend API, including type-safe client usage, W3C annotation model, and asynchronous operations.

## Table of Contents

- [Overview](#overview)
- [API Client Usage](#api-client-usage)
- [W3C Web Annotation Model](#w3c-web-annotation-model)
- [Synchronous vs Asynchronous Operations](#synchronous-vs-asynchronous-operations)
- [Real-Time Progress Tracking](#real-time-progress-tracking)
- [API Endpoints Reference](#api-endpoints-reference)
- [Error Handling](#error-handling)
- [Related Documentation](#related-documentation)

## Overview

The frontend uses the `@semiont/api-client` package for type-safe API communication with the backend. All API interactions are:

- **Type-safe**: TypeScript types generated from OpenAPI specification
- **Authenticated**: Automatic JWT token inclusion via NextAuth.js session
- **Error-handled**: Structured error responses with proper HTTP status codes
- **Cached**: React Query manages server state caching and invalidation

**Key Concepts**:
- **Synchronous APIs**: Return immediate responses (document CRUD, search, highlights)
- **Asynchronous APIs**: Create background jobs with progress tracking (entity detection, document generation)
- **W3C Annotations**: All annotations follow the W3C Web Annotation Data Model for interoperability

## API Client Usage

### Installation and Setup

The API client is pre-configured in `src/lib/api-client.ts` with React Query integration:

```typescript
import { api } from '@/lib/api-client';

// API client automatically:
// - Includes JWT bearer token from NextAuth session
// - Handles 401 errors (redirects to login)
// - Handles 403 errors (shows permission denied)
// - Provides React Query hooks for caching
```

### Making API Calls

**Using React Query Hooks** (recommended for components):

```typescript
'use client';

import { api } from '@/lib/api-client';

export function DocumentList() {
  const { data, error, isLoading } = api.documents.list.useQuery();

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <ul>
      {data.documents.map(doc => (
        <li key={doc.id}>{doc.name}</li>
      ))}
    </ul>
  );
}
```

**Using API Service Directly** (for non-component code):

```typescript
import { apiService } from '@/lib/api-client';

async function createDocument() {
  try {
    const response = await apiService.documents.create({
      name: 'My Document',
      content: '# Hello World',
    });
    console.log('Created:', response.id);
  } catch (error) {
    console.error('Failed:', error);
  }
}
```

### Authentication Integration

The API client automatically includes the JWT token from NextAuth.js:

```typescript
// src/lib/api-client.ts
async function apiClient(endpoint: string, options: RequestInit = {}) {
  const session = await getSession();

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': session?.accessToken ? `Bearer ${session.accessToken}` : '',
      ...options.headers,
    },
  });

  if (!response.ok) {
    // Automatic 401/403 handling
    if (response.status === 401) {
      // Redirect to login
    }
    throw new APIError(response);
  }

  return response.json();
}
```

**No manual token management required** - NextAuth.js session handles everything.

## W3C Web Annotation Model

Semiont implements the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) for full interoperability with other annotation systems.

### Annotation Structure

All annotations follow this W3C-compliant structure:

```typescript
interface Annotation {
  "@context": "http://www.w3.org/ns/anno.jsonld";
  type: "Annotation";
  id: string;                    // Annotation ID
  created: string;               // ISO 8601 timestamp
  creator: {
    id: string;                  // User ID
    type: "Person";
  };
  target: {
    source: string;              // Document ID
    selector: Selector[];        // Text position/quote selectors
  };
  body: AnnotationBody[];        // Multi-body array (entity tags + links)
}
```

### Multi-Body Annotations

Semiont supports **multi-body annotations** combining entity type tags and document links:

**Entity Tag Body** (`TextualBody`):
```typescript
{
  type: "TextualBody",
  purpose: "tagging",
  value: "Person"               // Entity type (Person, Organization, etc.)
}
```

**Document Link Body** (`SpecificResource`):
```typescript
{
  type: "SpecificResource",
  purpose: "linking",
  source: "doc_456",            // Linked document ID
  relationship: "citation"      // citation, definition, elaboration, etc.
}
```

**Combined Example**:
```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "anno_123",
  "target": {
    "source": "doc_789",
    "selector": [
      {
        "type": "TextPositionSelector",
        "start": 42,
        "end": 57
      },
      {
        "type": "TextQuoteSelector",
        "exact": "Albert Einstein",
        "prefix": "physicist ",
        "suffix": " developed"
      }
    ]
  },
  "body": [
    {
      "type": "TextualBody",
      "purpose": "tagging",
      "value": "Person"
    },
    {
      "type": "SpecificResource",
      "purpose": "linking",
      "source": "doc_einstein_bio",
      "relationship": "definition"
    }
  ]
}
```

### Selectors

Semiont uses two W3C selector types for robust text anchoring:

**TextPositionSelector** (character offsets):
```typescript
{
  type: "TextPositionSelector",
  start: 100,      // Character offset from document start
  end: 115         // Character offset (end is exclusive)
}
```

**TextQuoteSelector** (text content with context):
```typescript
{
  type: "TextQuoteSelector",
  exact: "knowledge graph",      // Exact selected text
  prefix: "building a ",          // Text before (for disambiguation)
  suffix: " using annotations"    // Text after (for disambiguation)
}
```

**Why Both?**: TextPositionSelector is fast and precise. TextQuoteSelector is resilient to document edits (can find text even if offsets change).

### JSON-LD Export

All annotations can be exported as standard JSON-LD for semantic web integration:

```typescript
// Export button in UI
const exportAnnotation = async (annotationId: string) => {
  const response = await fetch(`/api/annotations/${annotationId}`, {
    headers: { 'Accept': 'application/ld+json' }
  });
  const jsonLD = await response.json();
  // Download or share with other W3C-compliant systems
};
```

## Synchronous vs Asynchronous Operations

The API provides both synchronous (immediate response) and asynchronous (background job) operations.

### Synchronous APIs

These return immediate responses:

**Document Operations**:
- `POST /api/documents` - Create document
- `GET /api/documents/:id` - Get document
- `PATCH /api/documents/:id` - Update document
- `DELETE /api/documents/:id` - Delete document
- `GET /api/documents/search?q=query` - Search documents

**Annotation Operations**:
- `POST /api/documents/:id/annotations` - Create annotation
- `GET /api/documents/:id/annotations` - List annotations
- `PATCH /api/documents/:id/annotations/:annotationId` - Update annotation
- `DELETE /api/documents/:id/annotations/:annotationId` - Delete annotation

**Example**:
```typescript
// Synchronous - immediate response
const { data } = api.documents.create.useMutation();
await data({ name: 'Doc', content: '# Hello' });
// Document created instantly
```

### Asynchronous APIs

These create background jobs with progress tracking:

**Entity Detection** - Find entities in documents using AI:
```typescript
POST /api/documents/:id/detect-annotations-stream
```

**Document Generation** - AI-generated documents from annotations:
```typescript
POST /api/annotations/:id/generate-document-stream
```

**Why Asynchronous?**:
- Entity detection can take minutes for large documents with many entity types
- Document generation requires LLM API calls (slow)
- Jobs continue even if user closes browser
- Real-time progress updates via Server-Sent Events (SSE)

**Example**:
```typescript
// Asynchronous - creates job, returns job ID
const response = await fetch('/api/documents/123/detect-entities', {
  method: 'POST',
  body: JSON.stringify({ entityTypes: ['Person', 'Organization'] })
});
const { jobId } = await response.json();

// Poll job status or use SSE for progress
```

## Real-Time Progress Tracking

Asynchronous operations support two patterns for tracking progress:

### Server-Sent Events (SSE) - Recommended

SSE provides real-time progress updates pushed from the server:

**Entity Detection with SSE**:
```typescript
'use client';

import { useEffect, useState } from 'react';

export function EntityDetectionProgress({ documentId }: { documentId: string }) {
  const [progress, setProgress] = useState(null);
  const [status, setStatus] = useState<'running' | 'complete' | 'failed'>('running');

  useEffect(() => {
    const eventSource = new EventSource(
      `/api/documents/${documentId}/detect-annotations-stream?entityTypes=Person,Organization`
    );

    eventSource.onmessage = (event) => {
      const job = JSON.parse(event.data);

      setProgress(job.progress);
      setStatus(job.status);

      if (job.status === 'complete' || job.status === 'failed') {
        eventSource.close();
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE error:', error);
      eventSource.close();
      setStatus('failed');
    };

    return () => eventSource.close();
  }, [documentId]);

  if (status === 'complete') {
    return <div>Detection complete! Found {progress?.entitiesFound} entities.</div>;
  }

  if (status === 'failed') {
    return <div>Detection failed. Please try again.</div>;
  }

  return (
    <div>
      <p>Processing entity type: {progress?.currentEntityType}</p>
      <p>Progress: {progress?.processedEntityTypes}/{progress?.totalEntityTypes}</p>
      <p>Entities found: {progress?.entitiesFound}</p>
    </div>
  );
}
```

**Document Generation with SSE**:
```typescript
export function DocumentGenerationProgress({ annotationId }: { annotationId: string }) {
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    const eventSource = new EventSource(
      `/api/annotations/${annotationId}/generate-document-stream`
    );

    eventSource.onmessage = (event) => {
      const job = JSON.parse(event.data);
      setProgress(job.progress);

      if (job.status === 'complete') {
        eventSource.close();
        // Navigate to generated document
        window.location.href = `/documents/${job.result.documentId}`;
      }
    };

    return () => eventSource.close();
  }, [annotationId]);

  return (
    <div>
      <p>Stage: {progress?.stage}</p>
      <p>Progress: {progress?.percentage}%</p>
      {progress?.message && <p>{progress.message}</p>}
    </div>
  );
}
```

### Polling Job Status

Alternative to SSE - poll the job status endpoint:

```typescript
async function pollJobStatus(jobId: string) {
  const maxAttempts = 60;
  const pollInterval = 2000; // 2 seconds

  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await response.json();

    if (job.status === 'complete') {
      return job.result;
    }

    if (job.status === 'failed') {
      throw new Error(job.error || 'Job failed');
    }

    // Job still running, wait and retry
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error('Job timed out');
}
```

**SSE vs Polling**:
- **SSE**: Real-time, efficient, recommended for UI
- **Polling**: Simpler, works without SSE support, more server load

## API Endpoints Reference

### Document APIs (Synchronous)

| Endpoint | Method | Description | Returns |
|----------|--------|-------------|---------|
| `/api/documents` | POST | Create new document | `{ id, name, content }` |
| `/api/documents/:id` | GET | Get document by ID | `Document` |
| `/api/documents/:id` | PATCH | Update document | `Document` |
| `/api/documents/:id` | DELETE | Delete document | `{ success: true }` |
| `/api/documents` | GET | List documents (paginated) | `{ documents, total }` |
| `/api/documents/search?q=query` | GET | Search documents | `{ documents }` |
| `/api/documents/:id/backlinks` | GET | Get documents linking to this one | `{ backlinks }` |

### Annotation APIs (Synchronous)

| Endpoint | Method | Description | Returns |
|----------|--------|-------------|---------|
| `/api/documents/:id/annotations` | POST | Create annotation | `Annotation` |
| `/api/documents/:id/annotations` | GET | List document annotations | `{ annotations }` |
| `/api/documents/:id/annotations/:annoId` | PATCH | Update annotation | `Annotation` |
| `/api/documents/:id/annotations/:annoId` | DELETE | Delete annotation | `{ success: true }` |

### Asynchronous Job APIs

| Endpoint | Method | Description | Returns |
|----------|--------|-------------|---------|
| `/api/documents/:id/detect-entities` | POST | Start entity detection job | `{ jobId, status }` |
| `/api/documents/:id/detect-annotations-stream` | POST | Entity detection with SSE | SSE stream |
| `/api/annotations/:id/generate-document` | POST | Start document generation job | `{ jobId, status }` |
| `/api/annotations/:id/generate-document-stream` | POST | Document generation with SSE | SSE stream |
| `/api/jobs/:jobId` | GET | Get job status and progress | `Job` |

### Authentication APIs

| Endpoint | Method | Description | Returns |
|----------|--------|-------------|---------|
| `/api/auth/session` | GET | Get current session | `{ user, accessToken }` |
| `/api/users/me` | GET | Get current user info | `User` |

## Error Handling

### HTTP Status Codes

The API uses standard HTTP status codes:

- **200 OK**: Successful request
- **201 Created**: Resource created
- **400 Bad Request**: Invalid input (validation errors)
- **401 Unauthorized**: Authentication required or JWT expired
- **403 Forbidden**: Insufficient permissions
- **404 Not Found**: Resource not found
- **500 Internal Server Error**: Server error

### Error Response Format

All errors follow a consistent format:

```typescript
{
  error: string;           // Human-readable error message
  code: string;            // Machine-readable error code
  details?: unknown;       // Additional error context
}
```

### Handling Errors in Components

**Using React Query**:
```typescript
const { data, error, isError } = api.documents.get.useQuery('doc_123');

if (isError) {
  // error is typed as APIError
  if (error.code === 'DOCUMENT_NOT_FOUND') {
    return <div>Document not found</div>;
  }
  return <div>Error: {error.message}</div>;
}
```

**Automatic Error Handling**:
- **401 Errors**: API client automatically redirects to `/auth/signin`
- **403 Errors**: API client shows "Permission Denied" message
- **Network Errors**: React Query retry logic (3 attempts with exponential backoff)

### Custom Error Boundaries

Wrap components in error boundaries for graceful degradation:

```typescript
import { AsyncErrorBoundary } from '@/components/ErrorBoundary';

export function DocumentPage() {
  return (
    <AsyncErrorBoundary>
      <DocumentContent />
    </AsyncErrorBoundary>
  );
}
```

## Related Documentation

### Backend Documentation
- [Backend README](../../backend/README.md) - Backend API overview
- [Job Worker](../../../docs/services/JOB-WORKER.md) - Background job processing implementation
- [W3C Web Annotation](../../../specs/docs/W3C-WEB-ANNOTATION.md) - Complete W3C annotation data flow

### Frontend Documentation
- [Frontend Architecture](./ARCHITECTURE.md) - High-level system design
- [Authentication](./AUTHENTICATION.md) - OAuth, JWT, session management
- [Annotations](./ANNOTATIONS.md) - W3C annotation UI components

### External Resources
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) - Official specification
- [TanStack Query Documentation](https://tanstack.com/query) - React Query guide
- [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) - SSE specification

---

**Package**: `@semiont/api-client`
**Implementation**: [packages/api-client/](../../../packages/api-client/)
**Last Updated**: 2025-10-25
