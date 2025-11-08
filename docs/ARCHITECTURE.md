# Semiont Architecture

Platform-agnostic architecture for the Semiont semantic knowledge platform.

## Overview

Semiont transforms unstructured text into a queryable knowledge graph using W3C Web Annotations as the semantic layer. The architecture makes deliberate choices that prioritize longevity, interoperability, and operational simplicity.

**Core Principles:**

- **Event Sourcing**: Immutable event log as source of truth, enabling audit trails and temporal queries
- **Data Architecture**: Separation of content (representations), events (Event Store), and relationships (Graph Database)
- **W3C Standards**: Full Web Annotation Data Model compliance ensures data portability
- **Spec-First Development**: Types generated from OpenAPI specification, not the reverse
- **Platform Agnostic**: Services run on local processes, containers, or cloud infrastructure

This is a knowledge management system designed to outlive specific vendors or platforms. W3C compliance means your data exports as standard JSON-LD that any compatible system can consume.

Event sourcing provides complete audit trails. Event Store maintains materialized views automatically (like database indexes), enabling fast queries without replaying events. All services communicate via REST APIs with OpenAPI contracts.

## System Architecture

```mermaid
graph TB
    subgraph "Client"
        USER[User Browser]
        AI[AI Agents]
        MCP[MCP Server]
    end

    subgraph "Identity"
        OAUTH[OAuth Providers<br/>Google]
    end

    subgraph "Application"
        FE[Frontend<br/>NextAuth.js]
        BE[Backend API<br/>JWT Auth]
    end

    subgraph "Data"
        REP[RepresentationStore]
        EVENTS[Event Store<br/>with Views]
        GRAPH[Graph]
        DB[(Database<br/>Users Only)]
        SEC[Secrets]
    end

    subgraph "Compute"
        INF[Inference]
        JW[Job Worker]
    end

    %% Client connections
    USER -->|HTTPS| FE
    AI -->|MCP Protocol| MCP

    %% OAuth flow (server-side only)
    USER -.->|OAuth| OAUTH
    OAUTH -.->|Token| FE
    FE -.->|Exchange Token| BE

    %% API calls (client-side from browser)
    USER -->|REST + JWT| BE
    USER -->|SSE + JWT| BE
    MCP -->|REST + JWT| BE

    %% Backend to data (write path)
    BE -->|Store Representations| REP
    BE -->|Append Events| EVENTS
    BE -->|Create/Update Users| DB
    BE -.->|Future| SEC

    %% Event-driven flow
    EVENTS -.->|Sync| GRAPH

    %% Backend reads
    BE -->|Get by Checksum| REP
    BE -->|Query Views| EVENTS
    BE -->|Graph Queries| GRAPH

    %% Compute services
    BE -->|Generate/Detect| INF
    BE -->|Queue Jobs| JW
    JW -->|Emit Events| EVENTS
    JW -->|Use AI| INF

    %% SSE event flow (real-time updates back to browser)
    EVENTS -.->|Subscribe| BE
    BE -.->|SSE: Events| USER

    %% Styling - darker fills ensure text contrast in both light and dark modes
    classDef client fill:#4a90a4,stroke:#2c5f7a,stroke-width:2px,color:#fff
    classDef identity fill:#c97d5d,stroke:#8b4513,stroke-width:2px,color:#fff
    classDef app fill:#d4a827,stroke:#8b6914,stroke-width:2px,color:#000
    classDef data fill:#8b6b9d,stroke:#6b4a7a,stroke-width:2px,color:#fff
    classDef compute fill:#5a9a6a,stroke:#3d6644,stroke-width:2px,color:#fff

    class USER,AI,MCP client
    class OAUTH identity
    class FE,BE app
    class REP,EVENTS,GRAPH,DB,SEC data
    class INF,JW compute
```

**Component Details**:

- **OAuth Providers**: Google OAuth 2.0 for user authentication
- **Frontend**: Next.js 14 web application with NextAuth.js (OAuth handler only, browser calls backend directly via REST and SSE)
- **Backend API**: Hono server with JWT validation implementing W3C Web Annotation Data Model, provides SSE streams for real-time updates
- **MCP Server**: Model Context Protocol for AI agent integration (uses JWT refresh tokens)
- **RepresentationStore**: Content-addressed storage, W3C compliant, checksum-based
- **Event Store**: Immutable JSONL event log (source of truth), maintains materialized views automatically for fast queries
- **Graph**: Neo4j/Neptune for relationship queries
- **Database**: PostgreSQL for user authentication ONLY (not resource/annotation metadata)
- **Secrets**: Planned credential management integration
- **Inference**: External LLM APIs (Anthropic Claude, OpenAI)
- **Job Worker**: Background job processing (prototype, embedded in backend)

**Key Flows**:

- **Authentication**: Browser → Google OAuth → Frontend Server (NextAuth.js exchanges token) → Backend (verify + generate JWT) → Database (create/update user) → JWT stored in browser session
- **API Calls**: Browser → Backend (validate JWT) → Data layers
- **Write Path**: Browser → Backend (validate JWT) → RepresentationStore + Event Store (updates views) → Graph (synced via events)
- **Read Path**: Browser → Backend (validate JWT) → Event Store views or Graph → RepresentationStore → Response
- **Job Processing**: Browser → Backend → Job Worker → Inference → Event Store (emits completion events)
- **Real-Time Events (SSE)**: Job Worker emits events → Event Store → Backend subscribes → SSE stream → Browser
- **Job Progress (SSE)**: Browser → Backend SSE stream → Polls Job Worker filesystem queue (500ms) → Browser receives progress updates
- **Event Sourcing**: All writes create immutable events, Event Store maintains views automatically
- **Graph Sync**: Graph database updated automatically via event subscriptions

## Application Services

The application layer consists of server-side services that handle user requests and coordinate data operations.

### Frontend - Next.js Web Application

**Technology**: Next.js 14, TypeScript, Tailwind CSS, NextAuth.js

**Responsibilities**:

- Server-side rendering and static page generation
- OAuth 2.0 authentication with domain restrictions
- W3C annotation UI (highlight text, create entity tags, link resources)
- Real-time collaboration via Server-Sent Events
- Export annotations as JSON-LD

**Key Architectural Decisions**:

- SSR for initial page loads, CSR for dynamic interactions
- API client generated from OpenAPI spec ensures type safety
- Authentication handled by NextAuth.js with JWT session tokens

**Documentation**: [Frontend README](../apps/frontend/README.md)

### Backend - API Server (BFF Pattern)

**Technology**: Hono, TypeScript, Prisma, PostgreSQL

**Responsibilities**:

- REST API implementing W3C Web Annotation Data Model
- Event sourcing for all resource and annotation mutations
- Data management across Event Store, Graph, and RepresentationStore
- JWT validation and role-based access control
- Request validation against OpenAPI specification

**Key Architectural Decisions**:

- Hono chosen for performance and lightweight routing
- OpenAPI specification is hand-written (spec-first approach)
- Backend validates requests against spec, not vice versa
- Event Store is source of truth, not database
- Event Store maintains materialized views automatically for fast queries
- Graph database maintained via event subscriptions

**Documentation**: [Backend README](../apps/backend/README.md)

### MCP Server - AI Integration

**Technology**: Model Context Protocol, TypeScript

**Responsibilities**:

- Expose Semiont knowledge graph to AI systems (Claude Desktop, etc.)
- Provide tools for resource search, annotation, and graph traversal
- Handle long-lived refresh token authentication

**Key Architectural Decisions**:

- Implements Model Context Protocol for AI agent integration
- Uses same API client as frontend for consistency
- 30-day refresh tokens for persistent AI sessions

**Documentation**: [MCP Server README](../packages/mcp-server/README.md)

## Data Architecture

The data architecture separates content storage, event log, and relationship graph while maintaining clear dependencies.

### RepresentationStore

**Purpose**: W3C-compliant storage of resource representations (content)

**Technology**: Content-addressed filesystem storage (SHA-256 checksums)

**Key Characteristics**:

- Content-addressed: Files stored by checksum, not resource ID
- W3C compliant: Implements W3C representation metadata model
- Deduplication: Identical content stored once
- Integrity verification: Built-in checksum validation
- Sharded storage: 4-hex sharding for scalability
- Platform-agnostic: (local filesystem, EFS, S3)

**Why This Matters**: Content-addressed storage enables automatic deduplication (100 resources with identical content = 1 file) and integrity verification. Storing by checksum rather than resource ID aligns with W3C standards where resources can have multiple representations. Content is completely separate from metadata—a 1GB PDF doesn't bloat Event Store views.

**Filesystem Backend**: RepresentationStore uses the [Filesystem](./services/FILESYSTEM.md) service for physical storage (local filesystem, AWS S3, AWS EFS).

**Documentation**: [REPRESENTATION-STORE.md](./services/REPRESENTATION-STORE.md)

### Event Store

**Purpose**: Immutable event log (source of truth), maintains materialized views for fast queries

**Technology**: Append-only JSONL files for events, sharded JSON files for views

**Event Types**:

- Resource lifecycle: `resource.created`, `resource.archived`
- Annotations: `annotation.added`, `annotation.removed`, `annotation.body.updated`
- Entity types: `entitytype.added`, `entitytag.added`

**Key Characteristics**:

**Event Log:**

- Events never modified or deleted (append-only)
- Cryptographic chain integrity (each event references previous event hash)
- Sequence numbers for ordering guarantees
- File rotation at 10,000 events per resource

**Materialized Views:**

- Maintained automatically by Event Store (like database indexes)
- Resource views in sharded JSON files (`data/projections/resources/`)
- System views (entity types) in JSON files (`data/projections/entity-types/`)
- Optimized for fast queries without event replay
- Incremental updates for performance
- Can be deleted and reconstructed at any time from event log

**Why This Matters**: Event sourcing provides a complete audit trail. You can replay events to any point in time. Views can be rebuilt if corrupted. New view types can be added without schema migrations. Like a traditional database, you write to the log and the database maintains indexes automatically—views are those indexes. PostgreSQL is NOT used for resource/annotation metadata—all metadata is in Event Store.

**Documentation**: [EVENT-STORE.md](./services/EVENT-STORE.md)

### Graph Database

**Purpose**: Relationship traversal and discovery

**Technology**: Neo4j, AWS Neptune, JanusGraph, or in-memory (configurable)

**Graph Model**:

- **Vertices**: Resources, Annotations, EntityTypes
- **Edges**: `BELONGS_TO` (annotation → resource), `REFERENCES` (annotation → linked resource), `TAGGED_AS` (annotation → entity type)

**Key Characteristics**:

- Built from Event Store via event subscriptions
- Enables graph queries (backlinks, entity co-occurrence, resource clusters)
- Supports multiple implementations (Neo4j Cypher, Gremlin, in-memory)

**Why This Matters**: Graph databases excel at relationship queries. "Find all resources linking to this one" is a single Cypher query. In SQL, that's multiple joins. The graph is maintained automatically via event subscriptions—no manual sync required.

**Documentation**: [GRAPH.md](./services/GRAPH.md)

### Database - PostgreSQL

**Purpose**: User authentication only (NOT resource/annotation metadata)

**Technology**: PostgreSQL 15 (AWS RDS in production), Prisma ORM

**Storage** ([see schema](../../apps/backend/prisma/schema.prisma)):

- User authentication records (`users` table)
- OAuth provider data (Google, GitHub)
- User roles (admin, moderator)

**Key Characteristics**:

- Automatic migrations via Prisma on backend startup
- No manual migration files (schema is source of truth)
- Connection pooling via Prisma Client
- **Resource/annotation metadata NOT stored here** - all metadata flows through Event Store (and its materialized views)

**Why This Matters**: PostgreSQL is used ONLY for user authentication. Resource and annotation metadata lives entirely in the Event Store (including its materialized views as JSON files). This separation keeps the database small and focused on its core responsibility: user management.

**Documentation**: [DATABASE.md](./services/DATABASE.md)

### Secrets - Credential Management

**Purpose**: Future integration with secrets managers

**Status**: Planned (Q1-Q4 2026)

**Planned Providers**: AWS Secrets Manager, HashiCorp Vault, Azure Key Vault

**Documentation**: [SECRETS.md](./services/SECRETS.md)

## Compute Services

### Inference - AI/ML Service

**Purpose**: LLM-powered resource generation and entity detection

**Technology**: External APIs (Anthropic Claude, OpenAI)

**Capabilities**:

- Generate resources from annotated text selections
- Detect entities in resource content
- Extract graph context for AI consumption
- Streaming text generation

**Key Characteristics**:

- External service (no local hosting)
- Configurable provider (Anthropic, OpenAI, local models)
- Streaming support for long-running operations

**Documentation**: [INFERENCE.md](./services/INFERENCE.md)

### Job Worker - Background Processing

**Purpose**: Asynchronous job processing for long-running AI operations

**Technology**: Filesystem-based job queue, embedded worker processes

**Status**: Prototype implementation (not yet a proper CLI-managed service)

**Capabilities**:

- Entity detection jobs (find entities in resources using AI)
- Resource generation jobs (create new resources from annotations)
- Progress tracking with SSE streaming to clients
- Automatic retry logic for failed jobs
- Event emission to Event Store

**Key Characteristics**:

- Embedded in backend process (not independently deployable)
- Filesystem-based job queue with atomic operations
- FIFO job processing with configurable polling
- Graceful shutdown (waits for in-flight jobs)
- No CLI integration or environment configuration (yet)

**Why This Matters**: Long-running AI operations (entity detection across large resources, resource generation) can't block HTTP requests. Job workers decouple processing from client connections—jobs continue even if the client disconnects. This is a temporary embedded implementation; future versions will be independently scalable services.

**Current Limitations**: Not yet a proper service—no CLI integration, no platform abstraction, no independent deployment. Workers start automatically with the backend. This will eventually become a standalone service with Redis/SQS queue options and ECS deployment.

**Documentation**: [JOB-WORKER.md](./services/JOB-WORKER.md)

## Platform Abstraction

Services run on different platforms depending on the deployment environment. The CLI manages platform selection and service lifecycle.

### Platform Types

**POSIX** - Native OS processes

- **Use Case**: Local development
- **Services**: Backend, Frontend, MCP
- **Management**: Process spawning via Node.js `child_process`

**Container** - Docker/Podman

- **Use Case**: Isolated services (databases, graph)
- **Services**: Database, Graph
- **Management**: Container runtime via CLI

**AWS** - Managed cloud services

- **Use Case**: Production deployment
- **Services**: ECS (backend), RDS (database), Neptune (graph), S3/EFS (storage)
- **Management**: CloudFormation, ECS task definitions

**External** - Third-party APIs

- **Use Case**: External dependencies
- **Services**: Inference (LLM APIs), Graph (Neo4j Aura)
- **Management**: Health checks only (no lifecycle control)

**Mock** - Test doubles

- **Use Case**: CI/CD testing
- **Services**: Any service (simulated behavior)
- **Management**: Instant success responses

**Key Principle**: Services declare *what* they are (service type). Environments declare *where* they run (platform type). This separation allows running the same service on different platforms without code changes.

**Documentation**: [Platforms](./platforms/README.md)

## API Design

The Semiont API is RESTful with semantic extensions for knowledge graph operations.

### Core Resources

**Resources** - Markdown content with entity type tags

```http
POST   /api/resources
GET    /api/resources/{id}
PATCH  /api/resources/{id}
DELETE /api/resources/{id}
```

**Annotations** - W3C Web Annotations linking text to entities or resources

```http
POST   /api/resources/{id}/annotations
GET    /api/resources/{id}/annotations
PATCH  /api/resources/{id}/annotations/{annotationId}
DELETE /api/resources/{id}/annotations/{annotationId}
```

**Entity Types** - Semantic classifications (Person, Organization, etc.)

```http
GET    /api/entity-types
POST   /api/entity-types
```

**Graph Operations** - Relationship queries

```http
GET    /api/resources/{id}/backlinks
GET    /api/resources/{id}/context
POST   /api/annotations/{id}/generate-resource
```

### API Characteristics

**RESTful Core**: Standard HTTP verbs, resource-oriented URLs, JSON payloads

**W3C Extensions**: Annotations follow Web Annotation Data Model (JSON-LD compatible)

**Event-Sourced Mutations**: All writes (`POST`, `PATCH`, `DELETE`) create immutable events

**Streaming Support**: Long-running operations (resource generation, entity detection) support SSE

**Type Safety**: OpenAPI specification is source of truth—TypeScript types generated from spec

### Type-Safe Client

The [@semiont/api-client](../packages/api-client/) package provides a fully type-safe SDK:

- Types generated from [OpenAPI specification](../specs/src/)
- Automatic request/response validation
- Streaming support for long-running operations
- Authentication helpers (JWT, OAuth, MCP tokens)

**Working Examples**: See [/demo](../demo/) for complete TypeScript examples.

**Documentation**:

- [API Overview](../specs/docs/API.md) - High-level capabilities
- [OpenAPI Specification](../specs/README.md) - Complete endpoint reference (source in [../specs/src/](../specs/src/))

## Authentication & Security

Semiont uses OAuth 2.0 for user authentication and JWT for API authorization.

### Authentication Flow

1. **User Login**: OAuth 2.0 via Google (email domain restrictions supported)
2. **Session Token**: NextAuth.js issues JWT session token (7-day expiry)
3. **API Requests**: Frontend includes JWT in `Authorization: Bearer <token>` header
4. **Token Validation**: Backend validates JWT signature and expiry

### Special Cases

**MCP Clients**: Long-lived refresh tokens (30-day expiry) for AI agent sessions

**API Keys**: Future support for programmatic access (planned)

### Security Defaults

- All endpoints require authentication (except `/api/health`, `/api/openapi.json`, OAuth exchange)
- JWT tokens expire after 7 days (force re-authentication)
- Password authentication disabled by default (OAuth only)
- Admin role required for user management endpoints
- HTTPS required in production (enforced by AWS ALB)

**Documentation**: [AUTHENTICATION.md](./AUTHENTICATION.md), [SECURITY.md](./SECURITY.md)

## Operational Concerns

### Configuration Management

**Environment Files**: `environments/*.json` define service configuration per deployment

**Example** (`local.json`):

```json
{
  "services": {
    "backend": {
      "platform": { "type": "posix" },
      "command": "npm run dev",
      "port": 4000
    },
    "database": {
      "platform": { "type": "container" },
      "image": "postgres:15-alpine",
      "port": 5432
    }
  }
}
```

**Key Principle**: Configuration is data, not code. Changing platforms (POSIX → AWS) is a config change, not a code change.

**Documentation**: [CONFIGURATION.md](./CONFIGURATION.md)

### Scaling Strategy

**Horizontal Scaling**:

- Backend API servers: Scale ECS tasks (stateless, share nothing)
- Frontend: Serverless (Next.js on Vercel or S3+CloudFront)
- Database: Read replicas for read-heavy workloads

**Data Storage Scaling**:

- RepresentationStore: Content-addressed storage deduplicates automatically, shard across EFS volumes or S3 buckets
- Event Store: Sharding already built-in (65,536 shards)
- Event Store Views: Filesystem-based JSON files (sharded)
- Graph: Neptune cluster or Neo4j enterprise

**Documentation**: [SCALING.md](./SCALING.md)

### Maintenance & Operations

**Routine Maintenance**:

- Database backups (automated via AWS RDS)
- Log rotation (CloudWatch log retention policies)
- Certificate renewal (automated via AWS ACM)

**Event Store Maintenance**:

- Event file rotation (automatic at 10,000 events)
- View rebuilds (on-demand via CLI)
- Chain validation (periodic integrity checks)

**Graph Database Maintenance**:

- Full graph rebuild from Event Store (rare, event-driven)
- Index optimization (database-specific)

**Documentation**: [MAINTENANCE.md](./MAINTENANCE.md)

## Design Decisions

### Why Event Sourcing?

**Alternative Considered**: Direct database writes (traditional CRUD)

**Decision**: Event sourcing provides audit trails, temporal queries, and rebuildable state. The complexity cost is justified by the value of complete change history.

**Trade-off**: Increased storage (events + projections) vs. queryability and auditability

### Why W3C Web Annotations?

**Alternative Considered**: Custom annotation format

**Decision**: W3C compliance ensures data portability. Your annotations export as standard JSON-LD that any compatible system can import.

**Trade-off**: Some W3C complexity (selectors, motivations) vs. vendor lock-in avoidance

### Why Event Store with Internal Views?

**Alternative Considered**: Separate projection layer (4-layer architecture)

**Decision**: Following database orthodoxy—Event Store is the database, views are its indexes. Just as PostgreSQL maintains indexes automatically, Event Store maintains views automatically. This simplifies the mental model and clarifies ownership.

**Trade-off**: Tighter coupling (views bound to Event Store) vs. conceptual clarity and simpler operations

### Why Spec-First OpenAPI?

**Alternative Considered**: Code-first API with generated docs

**Decision**: OpenAPI specification is source of truth. Frontend types, backend validation, and API docs all generated from spec. Changes start with spec review.

**Trade-off**: Upfront spec design effort vs. API consistency and type safety

## Related Documentation

### Service Deep Dives

- [RepresentationStore](./services/REPRESENTATION-STORE.md) - W3C-compliant content storage
- [Event Store](./services/EVENT-STORE.md) - Immutable event log with materialized views
- [Graph Database](./services/GRAPH.md) - Relationship traversal
- [Database](./services/DATABASE.md) - PostgreSQL schema and migrations
- [Filesystem](./services/FILESYSTEM.md) - File upload and storage
- [Inference](./services/INFERENCE.md) - AI/ML integration
- [Job Worker](./services/JOB-WORKER.md) - Background job processing (prototype)
- [Services Overview](./services/README.md) - Complete service index

### Platform Documentation

- [POSIX Platform](./platforms/POSIX.md) - Native OS processes
- [Container Platform](./platforms/Container.md) - Docker/Podman
- [AWS Platform](./platforms/AWS.md) - Production deployment
- [External Platform](./platforms/External.md) - Third-party APIs
- [Mock Platform](./platforms/Mock.md) - Test doubles
- [Platforms Overview](./platforms/README.md) - Complete platform index

### Operational Documentation

- [Configuration](./CONFIGURATION.md) - Environment and service configuration
- [Security](./SECURITY.md) - Security controls and compliance
- [Scaling](./SCALING.md) - Performance scaling and cost optimization
- [Maintenance](./MAINTENANCE.md) - Operational maintenance procedures
- [Authentication](./AUTHENTICATION.md) - OAuth 2.0 and JWT implementation

### Development Documentation

- [Frontend README](../apps/frontend/README.md) - Next.js development
- [Backend README](../apps/backend/README.md) - Hono API development
- [MCP Server README](../packages/mcp-server/README.md) - AI integration
- [API Client README](../packages/api-client/README.md) - TypeScript SDK
- [CLI README](../apps/cli/README.md) - Command-line interface

---

**Document Version**: 3.0
**Last Updated**: 2025-10-25
**Audience**: CTOs, Architects, Engineering Leaders
**Purpose**: Architectural overview and service relationships
