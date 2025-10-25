# Semiont Architecture

Platform-agnostic architecture for the Semiont semantic knowledge platform.

## Overview

Semiont builds a semantic knowledge graph from markdown documents and W3C-compliant annotations. The architecture emphasizes:

- **Event Sourcing**: Immutable event log as source of truth
- **4-Layer Data Model**: Separation of content, events, projections, and relationships
- **W3C Standards**: Full Web Annotation Data Model compliance
- **Type Safety**: TypeScript throughout with OpenAPI-driven schemas
- **Spec-First**: Types generated from OpenAPI specification

**Navigation:**
- [Application Services](#application-architecture) - Frontend and backend services
- [API Overview](#api-overview) - High-level API design and flavor
- [Authentication](#authentication) - OAuth 2.0 and JWT model
- [AWS Deployment](./platforms/AWS.md) - Production deployment guide

**Deep Dives:**
- [Content Store](./services/CONTENT-STORE.md), [Event Store](./services/EVENT-STORE.md), [Projections](./services/PROJECTION.md), [Graph Database](./services/GRAPH.md)
- [W3C Web Annotation](../specs/docs/W3C-WEB-ANNOTATION.md) - Complete annotation semantics
- [Backend Architecture](../apps/backend/docs/W3C-WEB-ANNOTATION.md#data-layer-architecture) - 4-layer implementation

## Application Architecture

### Dual-Service Model

The application consists of two separate services:

#### Frontend Service

**Next.js 14** application with TypeScript, Tailwind CSS, and NextAuth.js for OAuth authentication.

**Key Features**:
- Server-side rendering (SSR) and static generation (SSG)
- OAuth authentication with domain restrictions
- Responsive design with dark mode support
- Type-safe API client for backend communication
- W3C Web Annotation UI components with JSON-LD export

**For complete frontend details**, including framework choices, development setup, and feature documentation, see [Frontend README](../apps/frontend/README.md).

#### Backend Service (BFF)

**Backend for Frontend** API built with Hono, featuring automatic OpenAPI documentation and type-safe validation.

**Key Features**:
- High-performance HTTP server with automatic OpenAPI docs
- Event sourcing with 4-layer data architecture
- JWT-based authentication middleware
- Automatic database migrations
- Type-safe queries with Prisma
- W3C Web Annotation Data Model support

**For complete backend details**, including API documentation, framework choices, and development setup, see [Backend README](../apps/backend/README.md).

## API Overview

The Semiont API is a **REST/CRUD** API with a **semantic knowledge graph** flavor.

### Core Nouns

- **Documents**: Markdown content (the primary knowledge artifact)
- **Annotations**: W3C-compliant markup linking text spans to entities and other documents
- **Entity Types**: Semantic classifications (Person, Organization, Concept, Location, Event, etc.)
- **Events**: Immutable change records (event sourcing)

### Core Verbs

- **Create/Update/Delete**: Standard CRUD operations on documents and annotations
- **Annotate**: Mark text spans with entity types or link to other documents
- **Discover**: Extract graph context from text or documents
- **Generate**: AI-powered document creation from annotated selections
- **Query**: Graph traversal (backlinks, references, entity networks)

### API Flavor

**RESTful with semantic extensions:**

- Standard REST patterns (`POST /api/documents`, `GET /api/documents/{id}`)
- W3C Web Annotation vocabulary (motivations, selectors, bodies)
- Graph-aware operations (context discovery, reference resolution)
- Event-sourced mutations (all writes create immutable events)
- Streaming support (real-time entity detection, event logs)

**Type-Safe Client:**

The [@semiont/api-client](../packages/api-client/) package provides a fully type-safe TypeScript SDK:

- Types generated from [OpenAPI specification](../specs/openapi.json)
- Automatic request/response validation
- Streaming support for long-running operations
- Authentication helpers (JWT, OAuth, MCP tokens)

**Working Examples:**

See [/demo](../demo/) for complete TypeScript examples using the API client to build knowledge graphs.

**API Documentation:**

- [API Overview](../specs/docs/API.md) - High-level capabilities and workflows
- [OpenAPI Specification](../specs/openapi.json) - Complete endpoint reference (source of truth)

## Authentication

Secure-by-default authentication using OAuth 2.0 and JWT tokens:

- **OAuth 2.0**: Google OAuth with email domain restrictions
- **JWT Tokens**: Stateless bearer token authentication (7-day expiry)
- **MCP Support**: Special token flow for Model Context Protocol clients (30-day refresh tokens)
- **Default Protected**: All endpoints require authentication except health checks and OAuth exchange
- **Role-Based Access**: Admin role support for user management

**Public Endpoints:** `/api/health`, `/api/openapi.json`, `/api/tokens/google`

For complete authentication details, token management, and security best practices, see [AUTHENTICATION.md](./AUTHENTICATION.md).

For MCP client implementation, see [MCP Server](../packages/mcp-server/README.md).

---

**Document Version**: 2.0
**Last Updated**: 2025-10-25
**Architecture**: Platform-agnostic application architecture
