# Semiont API Overview

High-level guide to the Semiont semantic knowledge platform API.

**For Endpoint Details:**
- **[OpenAPI Specification](../openapi.json)** - Complete endpoint reference (source of truth)
- **Interactive Explorer**: http://localhost:3001/api (local) - Test endpoints interactively
- **[API Client Package](../../packages/api-client/)** - TypeScript SDK for consuming this API

**For Implementation Details:**
- [W3C Web Annotation Implementation](./W3C-WEB-ANNOTATION.md) - How annotations flow through backend layers
- [Backend Documentation](../../apps/backend/) - Backend architecture and development

## Using the API

### OpenAPI Specification (Source of Truth)

All endpoint details, schemas, and request/response formats are defined in [../openapi.json](../openapi.json):

- **Spec-First Architecture**: Types generated from this specification
- **Interactive Testing**: Import into Postman, Insomnia, or use the built-in explorer
- **Client Generation**: Generate SDKs in any language
- **Type-Safe**: Full TypeScript definitions in [@semiont/api-client](../../packages/api-client/)
- **Live Endpoint**: `/api/openapi.json` serves the spec with dynamic server URL

**Don't restate the spec** - refer to it for all endpoint-level details.

## Core Capabilities

### Document Management

Create, read, update, and delete markdown documents. Features include:

- **CRUD Operations**: Standard create, read, update, delete
- **Content Types**: text/plain, text/markdown
- **Search**: Find documents by name or content
- **Pagination**: Efficient browsing of large document sets
- **Event Sourcing**: All changes tracked in immutable event log
- **Content Streaming**: Efficient handling of large documents

**Related Endpoints**: `/api/documents`, `/api/documents/{id}`, `/api/documents/search`

See [openapi.json](../openapi.json) for complete endpoint details.

### Annotation Management (W3C Web Annotation Model)

Full W3C Web Annotation Data Model compliance for marking up documents with:

- **Entity Tags**: Mark text spans with entity types (Person, Concept, Organization, etc.)
- **Document Links**: Create references between documents
- **Highlights**: Mark important passages
- **Multiple Selectors**: TextPositionSelector, TextQuoteSelector support
- **Multi-body Arrays**: Combine entity tags and document links
- **Motivations**: W3C vocabulary (linking, highlighting, tagging, commenting, etc.)

**Workflows:**
- **Stub References**: Entity tags without resolved links (provisional annotations)
- **Resolved References**: Entity tags + links to specific documents
- **Highlights**: Important passages with optional entity classification
- **AI Generation**: Generate document content from annotated text

**Related Endpoints**: `/api/annotations`, `/api/annotations/{id}`, `/api/documents/{id}/annotations`

For W3C JSON-LD structure and examples, see [W3C Web Annotation](./W3C-WEB-ANNOTATION.md).
For backend implementation flow, see [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md).

### Entity Type Management

Define and manage custom entity types for semantic classification:

- **Predefined Types**: Person, Organization, Location, Concept, Event, etc.
- **Custom Types**: Add project-specific entity types
- **Bulk Operations**: Create multiple entity types at once
- **Type Hierarchy**: Optional parent-child relationships

**Related Endpoints**: `/api/entity-types`, `/api/entity-types/bulk`

### Graph Context & LLM Integration

Extract semantic context from the knowledge graph for LLM consumption:

- **Document Context**: Get related documents, annotations, and entity information
- **Text Discovery**: Find relevant graph context from arbitrary text
- **Event Streaming**: Real-time updates to document state
- **Reference Context**: Build LLM context from annotation references

**Workflows:**
- **AI Generation**: Generate documents from annotated text with graph context
- **Context Discovery**: Find related documents and entities
- **Streaming Detection**: Real-time entity and annotation detection

**Related Endpoints**: `/api/documents/{id}/llm-context`, `/api/documents/{id}/discover-context`, `/api/documents/{id}/detect-entities`

## Authentication & Security

All endpoints require JWT authentication except health checks and OAuth token exchange:

- **OAuth 2.0**: Google OAuth with domain restrictions
- **JWT Tokens**: Stateless bearer token authentication
- **MCP Support**: Special token flow for Model Context Protocol clients
- **Refresh Tokens**: Long-lived tokens for MCP (30 days)
- **Admin Roles**: Role-based access control

**Public Endpoints**: `/api/health`, `/api/openapi.json`, `/api/tokens/google`

**Related Endpoints**: `/api/tokens/*`, `/api/users/*`, `/api/admin/*`

For complete authentication details, see [Backend Authentication](../../apps/backend/docs/AUTHENTICATION.md).

## Data Model & Architecture

### Semantic Graph Model

The API builds and maintains a knowledge graph with these core entities:

- **Documents**: Markdown/text content with metadata
- **Annotations**: W3C-compliant markup linking text spans to entities and documents
- **Entity Types**: Semantic classifications (Person, Organization, Concept, Location, etc.)
- **References**: Graph edges between documents created via annotations
- **Events**: Immutable change log (event sourcing)

**Graph Capabilities:**
- **Backlinks**: Discover which documents reference a given document
- **Entity Networks**: Find all documents mentioning an entity type
- **Context Extraction**: Build semantic context for LLM consumption
- **Path Finding**: Trace connections between concepts

### 4-Layer Backend Architecture

The API is backed by a 4-layer data architecture:

1. **Content Store**: Raw document binary/text (filesystem)
2. **Event Store**: Immutable event log (filesystem JSONL)
3. **Projection Store**: Materialized views (filesystem JSONL)
4. **Graph Database**: Relationship traversal (Neptune/In-Memory)

**Benefits:**
- **Event Sourcing**: Complete audit trail, time-travel queries
- **Rebuildable**: Projections and graph can be rebuilt from events
- **Scalable**: Each layer optimized for its access pattern

For architecture details, see [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md#data-layer-architecture).

### Route Organization

- **API Routes**: `/api/*` - All backend functionality
- **Auth Routes**: `/auth/*` - OAuth flows (frontend-handled)
- **Health**: `/api/health` - Load balancer health checks

## Quick Reference

**For detailed endpoint specs:**
- [OpenAPI Specification](../openapi.json) - Complete endpoint reference (source of truth)
- Interactive Explorer: http://localhost:3001/api (local development)

**For implementation details:**
- [W3C Web Annotation](./W3C-WEB-ANNOTATION.md) - JSON-LD structure and W3C semantics
- [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md) - 4-layer architecture flow
- [Backend Authentication](../../apps/backend/docs/AUTHENTICATION.md) - Auth implementation
- [API Client Package](../../packages/api-client/) - TypeScript SDK

**For backend development:**
- [Backend README](../../apps/backend/) - Development setup and overview
- [Backend Configuration](../../apps/backend/docs/CONFIGURATION.md) - Environment configuration

---

**Last Updated**: 2025-10-25
