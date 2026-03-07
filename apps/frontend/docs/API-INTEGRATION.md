# API Integration Guide

**Last Updated**: 2025-01-12

How the Semiont frontend integrates with the backend API through the framework-agnostic @semiont/react-ui library, including the provider pattern, type-safe client usage, and W3C annotation model.

## Table of Contents

- [Overview](#overview)
- [Provider Pattern Architecture](#provider-pattern-architecture)
- [API Client Usage](#api-client-usage)
- [W3C Web Annotation Model](#w3c-web-annotation-model)
- [Synchronous vs Asynchronous Operations](#synchronous-vs-asynchronous-operations)
- [Real-Time Progress Tracking](#real-time-progress-tracking)
- [API Endpoints Reference](#api-endpoints-reference)
- [Error Handling](#error-handling)
- [Related Documentation](#related-documentation)

## Overview

The frontend integrates with the backend API through a layered architecture that maintains framework independence:

```
┌─────────────────────────────────────┐
│         apps/frontend               │
│      (Next.js Application)          │
│                                     │
│  Implements Provider Interfaces:    │
│  • NextAuth Session Provider        │
│  • API Client Configuration         │
│  • React Query Setup                │
└─────────────┬───────────────────────┘
              │ uses
              ▼
┌─────────────────────────────────────┐
│    packages/react-ui                │
│  (Framework-agnostic library)       │
│                                     │
│  Provides:                          │
│  • ApiClientProvider Interface      │
│  • API Hooks (useResources, etc.)   │
│  • Query Key Management             │
└─────────────┬───────────────────────┘
              │ uses
              ▼
┌─────────────────────────────────────┐
│    packages/api-client              │
│  (Type-safe API Client)             │
│                                     │
│  • OpenAPI Generated Types          │
│  • HTTP Client                      │
│  • Request/Response Handling        │
└─────────────────────────────────────┘
```

All API interactions feature:
- **Type-safety**: TypeScript types generated from OpenAPI specification
- **Framework-agnostic**: API client injected via Provider Pattern
- **Authenticated**: Automatic JWT token inclusion via session management
- **Error-handled**: Structured error responses with proper HTTP status codes
- **Cached**: React Query integration for intelligent caching

## Provider Pattern Architecture

The Provider Pattern enables @semiont/react-ui to work with any React framework by abstracting framework-specific implementations behind interfaces.

### How It Works

1. **@semiont/react-ui defines interfaces** for external dependencies
2. **Frontend implements these interfaces** using Next.js specific tools
3. **Components use the interfaces**, not the implementations

### ApiClientProvider Implementation

The frontend provides the API client to @semiont/react-ui components:

```typescript
// apps/frontend/src/app/providers/ApiClientProvider.tsx
import { ApiClientProvider } from '@semiont/react-ui';
import { createApiClient } from '@semiont/api-client';
import { useSession } from 'next-auth/react';

export function NextApiClientProvider({ children }) {
  const session = useSession();

  const apiClientManager = {
    getClient: () => createApiClient({
      baseURL: process.env.NEXT_PUBLIC_API_URL,
      getToken: async () => session.data?.accessToken
    }),

    // React Query configuration
    queryOptions: {
      defaultOptions: {
        queries: {
          staleTime: 5 * 60 * 1000, // 5 minutes
          cacheTime: 10 * 60 * 1000, // 10 minutes
          retry: 3,
          retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000)
        }
      }
    }
  };

  return (
    <ApiClientProvider apiClientManager={apiClientManager}>
      {children}
    </ApiClientProvider>
  );
}
```

### Using API Hooks from @semiont/react-ui

Components can now use the framework-agnostic hooks:

```typescript
// Any component in the app
import { useResources, useAnnotations } from '@semiont/react-ui';

export function ResourceList() {
  // These hooks work regardless of whether the app uses
  // Next.js, Vite, CRA, or any other React framework
  const resources = useResources();
  const { data, isLoading } = resources.list.useQuery();

  const createMutation = resources.create.useMutation({
    onSuccess: (newResource) => {
      // Handle success
    }
  });

  // Component logic...
}
```

### Benefits of This Architecture

1. **Framework Independence**: @semiont/react-ui works with any React framework
2. **Testability**: Easy to mock providers for testing
3. **Flexibility**: Each app can implement providers differently
4. **Type Safety**: Full TypeScript support across boundaries
5. **Separation of Concerns**: UI logic separate from infrastructure

## API Client Usage

### Component Library Integration

With @semiont/react-ui factored out, API calls are made through the library's hooks which use the injected API client:

```typescript
// Components use @semiont/react-ui hooks, not direct API calls
import { useResources, useAnnotations, useToast } from '@semiont/react-ui';

export function DocumentList() {
  const resources = useResources();
  const { showToast } = useToast();

  // React Query hooks provided by @semiont/react-ui
  const { data, error, isLoading } = resources.list.useQuery();

  const createMutation = resources.create.useMutation({
    onSuccess: () => {
      showToast('Resource created successfully', 'success');
    }
  });

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <ul>
      {data?.resources.map(doc => (
        <li key={doc.id}>{doc.name}</li>
      ))}
    </ul>
  );
}
```

### Direct API Client Usage

For app-specific API calls not covered by @semiont/react-ui hooks:

```typescript
// apps/frontend/src/lib/api-client.ts
import { createApiClient } from '@semiont/api-client';
import { getSession } from 'next-auth/react';

// Create a Next.js specific API client instance
export const apiClient = createApiClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  getToken: async () => {
    const session = await getSession();
    return session?.accessToken;
  }
});

// Use for custom endpoints
async function callCustomEndpoint() {
  try {
    const response = await apiClient.request({
      method: 'POST',
      path: '/api/custom/endpoint',
      body: { data: 'value' }
    });
    console.log('Success:', response);
  } catch (error) {
    console.error('Failed:', error);
  }
}
```

### Authentication Flow

The authentication flow is handled through the provider pattern:

```typescript
// 1. Frontend implements session provider
export function NextAuthSessionProvider({ children }) {
  const session = useSession();

  const sessionManager = {
    getSession: () => session.data,
    getToken: async () => session.data?.accessToken,
    signIn: (credentials) => signIn('credentials', credentials),
    signOut: () => signOut(),
  };

  return (
    <SessionProvider sessionManager={sessionManager}>
      {children}
    </SessionProvider>
  );
}

// 2. @semiont/react-ui hooks use the session for API calls
// Inside @semiont/react-ui:
function useResources() {
  const { apiClient } = useApiClient(); // Gets injected client
  const { getToken } = useSession();    // Gets token from provider

  // React Query automatically includes auth token
  return {
    list: {
      useQuery: () => useQuery({
        queryKey: ['resources'],
        queryFn: async () => {
          const token = await getToken();
          return apiClient.resources.list({
            headers: { Authorization: `Bearer ${token}` }
          });
        }
      })
    }
  };
}
```

**Key Points**:
- **No manual token management** - Provider pattern handles authentication
- **Framework-agnostic** - @semiont/react-ui doesn't know about NextAuth
- **Type-safe** - Full TypeScript support from OpenAPI specs

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

**Entity Detection** - Find entities in resources using AI:
```typescript
POST /resources/:id/detect-annotations-stream
```

**Resource Generation** - AI-generated resources from annotations:
```typescript
POST /resources/:resourceId/annotations/:annotationId/generate-resource-stream
```

**Why Asynchronous?**:
- Entity detection can take minutes for large resources with many entity types
- Resource generation requires LLM API calls (slow)
- Jobs continue even if user closes browser
- Real-time progress updates via Server-Sent Events (SSE)

**Example**:
```typescript
// Asynchronous - uses SSE streaming for real-time progress
const stream = client.sse.detectAnnotations(resourceUri, {
  entityTypes: ['Person', 'Organization']
});

stream.onProgress((p) => console.log(p.message));
stream.onComplete((r) => console.log('Done!'));
```

## Real-Time Progress Tracking

Asynchronous operations support two patterns for tracking progress:

### Server-Sent Events (SSE) - Recommended

SSE provides real-time progress updates pushed from the server:

**Entity Detection with SSE**:
```typescript
'use client';

import { useEffect, useState } from 'react';

export function EntityDetectionProgress({ resourceId }: { resourceId: string }) {
  const [progress, setProgress] = useState(null);
  const [status, setStatus] = useState<'running' | 'complete' | 'failed'>('running');

  useEffect(() => {
    const eventSource = new EventSource(
      `/resources/${resourceId}/detect-annotations-stream?entityTypes=Person,Organization`
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
  }, [resourceId]);

  if (status === 'complete') {
    return <div>Detection complete! Found {progress?.foundCount} entities.</div>;
  }

  if (status === 'failed') {
    return <div>Detection failed. Please try again.</div>;
  }

  return (
    <div>
      <p>Processing entity type: {progress?.currentEntityType}</p>
      <p>Progress: {progress?.processedEntityTypes}/{progress?.totalEntityTypes}</p>
      <p>Entities found: {progress?.foundCount}</p>
    </div>
  );
}
```

**Resource Generation with SSE**:
```typescript
export function ResourceGenerationProgress({
  resourceId,
  annotationId
}: {
  resourceId: string;
  annotationId: string;
}) {
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    const eventSource = new EventSource(
      `/resources/${resourceId}/annotations/${annotationId}/generate-resource-stream`
    );

    eventSource.onmessage = (event) => {
      const job = JSON.parse(event.data);
      setProgress(job.progress);

      if (job.status === 'complete') {
        eventSource.close();
        // Navigate to generated resource
        window.location.href = `/resources/${job.result.resourceId}`;
      }
    };

    return () => eventSource.close();
  }, [resourceId, annotationId]);

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

### Resource APIs (Synchronous)

| Endpoint | Method | Description | Returns |
|----------|--------|-------------|---------|
| `/resources` | POST | Create new resource | `{ resource }` |
| `/resources/:id` | GET | Get resource by ID | `Resource` |
| `/resources/:id` | PATCH | Update resource | `Resource` |
| `/resources/:id` | DELETE | Delete resource | `{ success: true }` |
| `/resources` | GET | List resources (paginated) | `{ resources, total }` |
| `/resources/search?q=query` | GET | Search resources | `{ resources }` |

### Annotation APIs (Synchronous)

| Endpoint | Method | Description | Returns |
|----------|--------|-------------|---------|
| `/resources/:id/annotations` | POST | Create annotation | `Annotation` |
| `/resources/:id/annotations` | GET | List resource annotations | `{ annotations }` |
| `/resources/:id/annotations/:annoId` | PATCH | Update annotation | `Annotation` |
| `/resources/:id/annotations/:annoId` | DELETE | Delete annotation | `{ success: true }` |

### Asynchronous Job APIs (SSE Streaming)

| Endpoint | Method | Description | Returns |
|----------|--------|-------------|---------|
| `/resources/:id/detect-annotations-stream` | POST | Entity detection with SSE | SSE stream |
| `/resources/:resourceId/annotations/:annotationId/generate-resource-stream` | POST | Resource generation with SSE | SSE stream |
| `/jobs/:jobId` | GET | Get job status and progress | `Job` |

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

### React UI Library
- [`@semiont/react-ui/docs/PROVIDERS.md`](../../../packages/react-ui/docs/PROVIDERS.md) - Provider Pattern architecture
- [`@semiont/react-ui/docs/API-INTEGRATION.md`](../../../packages/react-ui/docs/API-INTEGRATION.md) - API client integration guide
- [`@semiont/react-ui/docs/ANNOTATIONS.md`](../../../packages/react-ui/docs/ANNOTATIONS.md) - Annotation system documentation

### Backend Documentation
- [Backend README](../../backend/README.md) - Backend API overview
- [Jobs Package](../../../packages/jobs/) - Background job processing implementation
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

**Packages**:
- `@semiont/api-client` - [packages/api-client/](../../../packages/api-client/)
- `@semiont/react-ui` - [packages/react-ui/](../../../packages/react-ui/)

**Last Updated**: 2025-01-03
