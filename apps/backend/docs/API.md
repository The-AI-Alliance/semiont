# Backend API Reference

Complete API endpoint documentation for the Semiont backend service.

**Related Documentation:**
- [Main README](../README.md) - Backend overview
- [W3C Web Annotation Implementation](../../../docs/W3C-WEB-ANNOTATION.md) - Annotation architecture across layers
- [Authentication Guide](./AUTHENTICATION.md) - JWT tokens and OAuth
- [Development Guide](./DEVELOPMENT.md) - Local development setup

## API Documentation

### Interactive API Explorer

- **Local Development**: http://localhost:3001/api
- **Production**: https://your-domain.com/api
- **Features**:
  - 🔍 Interactive endpoint testing
  - 📝 Request/response examples
  - 🔐 Authentication testing with JWT tokens
  - 📊 Schema visualization

### OpenAPI Specification

- **Endpoint**: `/doc` - Raw OpenAPI 3.0 specification
- **File**: [../public/openapi.json](../public/openapi.json) - Generated OpenAPI 3.0 schema
- **Usage**: Import into Postman, Insomnia, or generate client SDKs
- **Auto-Generated**: From Hono route definitions with Zod schemas
- **Type-Safe**: Full TypeScript type definitions included

## Document Management

### `POST /api/documents`

Create a new document

- **Auth**: Required
- **Body**: `{ name: string, content: string, contentType?: string }`
- **Response**: `{ success: true, document: Document }`

### `GET /api/documents/:id`

Get document by ID

- **Auth**: Required
- **Response**: `{ success: true, document: Document }`

### `PATCH /api/documents/:id`

Update document

- **Auth**: Required
- **Body**: `{ name?: string, content?: string, contentType?: string }`
- **Response**: `{ success: true, document: Document }`

### `DELETE /api/documents/:id`

Delete document

- **Auth**: Required
- **Response**: `{ success: true }`

### `GET /api/documents`

List all documents with pagination

- **Auth**: Required
- **Query**: `?limit=20&offset=0&contentType=text/markdown`
- **Response**: `{ success: true, documents: Document[], total: number }`

### `GET /api/documents/search`

Search documents by name

- **Auth**: Required
- **Query**: `?q=searchterm&limit=10`
- **Response**: `{ success: true, documents: Document[], total: number }`

### `GET /api/documents/schema-description`

Get natural language description of graph schema

- **Auth**: Required
- **Response**: `{ success: true, description: string }`

### `POST /api/documents/:id/llm-context`

Get LLM-suitable context for a document

- **Auth**: Required
- **Body**: `{ selectionId?: string }`
- **Response**: `{ success: true, context: object }`

### `POST /api/documents/discover-context`

Discover graph context from arbitrary text

- **Auth**: Required
- **Body**: `{ text: string }`
- **Response**: `{ success: true, context: object }`

## Annotation Management (W3C Web Annotation Model)

The API follows the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) for annotations, supporting:
- **TextualBody** with `purpose: "tagging"` for entity types
- **SpecificResource** with `purpose: "linking"` for document references
- **Multi-body arrays** mixing entity tags and document links
- **Three target forms**: simple IRI, source-only, or source + selector

For complete details on how annotations flow through all layers, see [W3C Web Annotation Implementation](../../../docs/W3C-WEB-ANNOTATION.md).

### Annotation Body Structure (Phase 2)

Annotations use multi-body arrays to combine entity tags and document links:

**Stub reference (entity tags only)**:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "anno-123",
  "motivation": "linking",
  "target": {
    "source": "doc-456",
    "selector": {
      "type": "TextPositionSelector",
      "exact": "Albert Einstein",
      "offset": 100,
      "length": 15
    }
  },
  "body": [
    { "type": "TextualBody", "value": "Person", "purpose": "tagging" },
    { "type": "TextualBody", "value": "Scientist", "purpose": "tagging" },
    { "type": "TextualBody", "value": "Physicist", "purpose": "tagging" }
  ]
}
```

**Resolved reference (entity tags + document link)**:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "anno-456",
  "motivation": "linking",
  "target": {
    "source": "doc-789",
    "selector": {
      "type": "TextQuoteSelector",
      "exact": "quantum mechanics"
    }
  },
  "body": [
    { "type": "TextualBody", "value": "Concept", "purpose": "tagging" },
    { "type": "SpecificResource", "source": "doc-resolved", "purpose": "linking" }
  ]
}
```

**Highlight with entity tags**:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "hl-789",
  "motivation": "highlighting",
  "target": {
    "source": "doc-abc",
    "selector": {
      "type": "TextPositionSelector",
      "exact": "important passage",
      "offset": 200,
      "length": 17
    }
  },
  "body": [
    { "type": "TextualBody", "value": "KeyConcept", "purpose": "tagging" }
  ]
}
```

## Selection Management (Legacy - Migrating to Annotations)

Selections represent highlighted text, references to other documents, or entity references.

### `POST /api/selections`

Create a provisional selection

- **Auth**: Required
- **Body**: `{ documentId: string, text: string, position: { start: number, end: number }, type?: 'provisional' | 'highlight' | 'reference' }`
- **Response**: `{ success: true, selection: Selection }`

### `GET /api/selections/:id`

Get selection by ID

- **Auth**: Required
- **Response**: `{ success: true, selection: Selection }`

### `PATCH /api/selections/:id`

Update selection

- **Auth**: Required
- **Body**: Partial selection object
- **Response**: `{ success: true, selection: Selection }`

### `DELETE /api/selections/:id`

Delete selection

- **Auth**: Required
- **Response**: `{ success: true }`

### `GET /api/selections`

List selections with filtering

- **Auth**: Required
- **Query**: `?documentId=abc&type=highlight&limit=20&offset=0`
- **Response**: `{ success: true, selections: Selection[], total: number }`

### `POST /api/selections/highlight`

Save selection as a highlight

- **Auth**: Required
- **Body**: `{ documentId: string, text: string, position: { start: number, end: number } }`
- **Response**: `{ success: true, selection: Selection }`

### `POST /api/selections/resolve`

Resolve selection to reference a document

- **Auth**: Required
- **Body**: `{ selectionId: string, targetDocumentId: string, referenceType?: string }`
- **Response**: `{ success: true, selection: Selection }`

### `POST /api/selections/create-document`

Create new document from selection

- **Auth**: Required
- **Body**: `{ selectionId: string, name: string, content: string, referenceType?: string }`
- **Response**: `{ success: true, document: Document }`

### `POST /api/selections/generate-document`

Generate document content from selection (AI-powered)

- **Auth**: Required
- **Body**: `{ selectionId: string, prompt?: string, name?: string, referenceType?: string }`
- **Response**: `{ success: true, document: Document }`

### `GET /api/selections/highlights/:documentId`

Get all highlights for a document

- **Auth**: Required
- **Response**: `{ success: true, selections: Selection[] }`

### `GET /api/selections/references/:documentId`

Get all references for a document

- **Auth**: Required
- **Response**: `{ success: true, selections: Selection[] }`

## Authentication & Authorization

For complete authentication documentation, see [AUTHENTICATION.md](./AUTHENTICATION.md).

### `POST /api/tokens/google`

Exchange Google OAuth token for JWT

- **Auth**: None
- **Body**: `{ access_token: string }`
- **Response**: `{ success: true, token: string, user: User, isNewUser: boolean }`

### `GET /api/users/me`

Get current user information

- **Auth**: Required
- **Response**: `{ success: true, user: User }`

### `POST /api/users/logout`

Logout current user

- **Auth**: Required
- **Response**: `{ success: true, message: string }`

## Health & Status

### `GET /api/health`

Health check endpoint (used by load balancers)

- **Auth**: None
- **Response**: `{ status: 'healthy', timestamp: string }`

### `GET /api/status`

Detailed system status

- **Auth**: Required
- **Response**: `{ status: 'operational', version: string, environment: string, services: object }`

### `GET /api`

API documentation and available endpoints

- **Auth**: None
- **Response**: HTML documentation page

## Graph Operations

The backend integrates with a graph database (Neptune in production) to manage relationships between documents and selections.

### Key Concepts

- **Documents**: Text documents with markdown content
- **Selections**: Text ranges within documents
- **Highlights**: Saved selections for important passages
- **References**: Selections that link to other documents
- **Entity References**: Selections marking entities (Person, Organization, etc.)

### Automatic Selection Detection

When documents are created or updated, the system automatically detects:
- Wiki-style links: `[[page name]]`
- Common patterns: "lorem ipsum", "John Doe"
- Entity mentions based on configured patterns

## API Routing Architecture

The backend handles ALL `/api/*` routes. This clean separation from the frontend (which handles `/auth/*` for OAuth flows) eliminates routing conflicts:

- **Backend owns**: `/api/*` - All API endpoints including `/api/auth/google`, `/api/auth/refresh`, etc.
- **Frontend owns**: `/auth/*` - NextAuth.js OAuth flows
- **ALB routing**: Simple 3-rule pattern (Priority 10: `/auth/*` → Frontend, Priority 20: `/api/*` → Backend, Default → Frontend)

This architecture ensures:
- No path conflicts between NextAuth and backend auth routes
- Clear ownership of endpoints
- Simple debugging (all API calls go to backend)
- Easy to add new API endpoints without routing concerns

## Related Resources

- **[W3C Web Annotation Implementation](../../../docs/W3C-WEB-ANNOTATION.md)** - Complete guide to how W3C Web Annotations flow through all layers of the backend (event store, projections, graph database)
- **[API Client Package](../../../packages/api-client/)** - Type-safe TypeScript client for consuming the backend API from frontend or other services
- **[Core Package](../../../packages/core/)** - Shared types, utilities, and business logic used across all services

---

**Last Updated**: 2025-10-23
