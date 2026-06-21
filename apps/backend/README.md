# Semiont Backend

A type-safe Node.js backend API providing comprehensive document management, W3C Web Annotation support, and graph-based knowledge organization. Built with Hono framework, featuring spec-first OpenAPI validation, JWT authentication, and integration with graph databases for managing document relationships and entity references.

## Quick Links

### 📚 Documentation
- **[Architecture](./docs/ARCHITECTURE.md)** - Infrastructure management patterns, design principles
- **[Development Guide](./docs/DEVELOPMENT.md)** - Local development, CLI usage, manual setup
- **[API Reference](../../docs/protocol/API.md)** - API endpoints, request/response formats
- **[Authentication](./docs/AUTHENTICATION.md)** - JWT tokens, OAuth, MCP authentication
- **[Event-Bus Protocol](../../docs/protocol/EVENT-BUS.md)** - SSE streaming, channels, scoping, correlation
- **[Logging](./docs/LOGGING.md)** - Winston logging, log levels, debugging 401s
- **[Testing Guide](./docs/TESTING.md)** - Running tests, writing tests, coverage
- **[Deployment Guide](../../docs/system/administration/DEPLOYMENT.md)** - Production deployment, rollbacks, monitoring

### 🔗 Related Resources
- **[W3C Web Annotation Implementation](../../docs/protocol/W3C-WEB-ANNOTATION.md)** - How annotations flow through all backend layers (event store, materialized views, graph database)
- **[API Client Package](../../packages/http-transport/)** - Type-safe TypeScript client for consuming the backend API
- **[Core Package](../../packages/core/)** - Shared types, utilities, and business logic
- **[OpenAPI Specification](../../specs/README.md)** - Hand-written OpenAPI 3.0 schema (spec-first, source in [../../specs/src/](../../specs/src/))

## npm Package

[![npm version](https://img.shields.io/npm/v/@semiont/backend.svg)](https://www.npmjs.com/package/@semiont/backend)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/backend.svg)](https://www.npmjs.com/package/@semiont/backend)

The backend is published as `@semiont/backend` on npm with pre-built dist and Prisma schema. When using the Semiont CLI, `semiont provision` automatically installs this package unless `SEMIONT_REPO` is set (which directs the CLI to use a local source checkout instead).

## Quick Start

### 🚀 Instant Setup with Semiont CLI (Recommended)

```bash
# Set your development environment
export SEMIONT_ENV=local

# Start everything (database + backend + frontend)
semiont start

# 🎉 Ready to develop in ~30 seconds!
```

**Your services are now running:**
- **Frontend**: http://localhost:3000
- **Backend**: http://localhost:3001
- **API Docs**: http://localhost:3001/api
- **Database**: PostgreSQL in Docker container

For complete development setup, see [Development Guide](./docs/DEVELOPMENT.md).

### 🛠 Manual Setup (Alternative)

```bash
# Install dependencies
npm install

# Run database migrations
npx prisma db push

# Start development server
npm run dev
```

## 🐳 Container Image

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-backend)

Pull and run the published backend container image:

```bash
# Pull latest development build
docker pull ghcr.io/the-ai-alliance/semiont-backend:dev

# Run with configuration
docker run -d \
  -p 4000:4000 \
  -v $(pwd):/app/config \
  -e SEMIONT_ROOT=/app/config \
  -e SEMIONT_ENV=production \
  --name semiont-backend \
  ghcr.io/the-ai-alliance/semiont-backend:dev
```

**Configuration Requirements:**
- `SEMIONT_ROOT` - Path to directory containing `semiont.json` and `environments/` subdirectory
- `SEMIONT_ENV` - Environment name (e.g., `production`, `staging`, `development`)

All other configuration (database, secrets, AI keys) comes from JSON files in `SEMIONT_ROOT/environments/{SEMIONT_ENV}.json`.

**Multi-platform Support:** linux/amd64, linux/arm64

See [Container Documentation](../../docs/system/CONTAINER-TOPOLOGY.md) for advanced usage, Docker Compose, and Kubernetes deployment.

## Technology Stack

- **Architecture**: EventBus-first with HTTP transport (routes delegate to RxJS EventBus actors)
- **Runtime**: Node.js with TypeScript
- **Web Framework**: [Hono](https://hono.dev/) - Fast, lightweight web framework
- **Database**: PostgreSQL with [Prisma ORM](https://prisma.io/)
- **Graph Database**: Neptune (AWS production) / In-memory (local development)
- **Vector Database**: Qdrant (optional) / In-memory — semantic search via `@semiont/vectors`
- **Authentication**: JWT with OAuth 2.0 (Google)
- **Validation**: [Ajv](https://ajv.js.org/) for OpenAPI schema validation
- **API Documentation**: Hand-written OpenAPI 3.0 specification (spec-first approach)
- **Document Processing**: Multi-format support (text, markdown, images, PDFs) with wiki-link and annotation detection for text formats
- **MCP Integration**: Model Context Protocol server for AI assistant access

## Architecture Highlights

### EventBus-Delegated Routes

All knowledge-domain HTTP routes are thin wrappers that delegate to the **EventBus**. Routes emit a request event with a `correlationId`, await the correlated response or failure event, and translate the result to HTTP. This means the entire knowledge domain can operate without HTTP — the EventBus is the primary API surface.

```typescript
// Typical route pattern — thin HTTP wrapper over EventBus
router.get('/resources', async (c) => {
  const response = await eventBusRequest(
    eventBus,
    'browse:resources-requested',      // request event
    { correlationId, search, limit },   // payload
    'browse:resources-result',          // success event
    'browse:resources-failed',          // failure event
  );
  return c.json(response);
});
```

**EventBus-delegated routes** (read operations via request-response):
- Resource listing, metadata, annotations, events, history → `browse:*` events (Gatherer handles)
- Referenced-by queries → `bind:referenced-by-requested` (Matcher handles)
- Entity type listing → `mark:entity-types-requested` (Gatherer handles)
- Clone token operations → `yield:clone-*` events (CloneTokenManager handles)
- Job status → `job:status-requested` (job queue subscription handles)
- LLM context → `gather:*` events (Gatherer handles)

**Fire-and-forget mutations** (already event-driven):
- Annotation create/delete/update → `mark:*` events (Stower handles)
- Resource create → `yield:create` (Stower handles)
- Entity type addition → `frame:add-entity-type` (Stower handles)

**HTTP-only routes** (excluded from EventBus by design):
- Auth (password, Google, refresh, MCP, terms, logout) — PostgreSQL/Prisma dependent
- Admin (users CRUD, stats, OAuth config) — PostgreSQL/Prisma dependent
- Health/Status — infrastructure monitoring
- Binary content retrieval (`GET /resources/:id` with `Accept: text/*`, `image/*`, `application/pdf`) — large file transfer
- Resource creation (`POST /resources` with multipart) — binary file upload

The `eventBusRequest()` helper in `src/utils/event-bus-request.ts` implements the correlationId-based request-response pattern used by all delegated routes.

### W3C Web Annotation Support

Semiont implements the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) for full interoperability:

- **W3C-compliant annotation CRUD** with multi-body arrays
- **Event-sourced architecture** with immutable audit trail (Event Store)
- **Fast query views** for current state (Materialized View Storage)
- **Graph database integration** for relationship traversal (Graph Database)

**Key Features**:
- Multi-body annotations combining entity type tags (`TextualBody`) and document links (`SpecificResource`)
- Stub and resolved references for progressive knowledge graph building
- JSON-LD export for semantic web integration
- Full audit trail via event sourcing

For complete details, see [W3C Web Annotation Implementation](../../docs/protocol/W3C-WEB-ANNOTATION.md).

### Data Architecture

```
Vector Store (semantic similarity search — Qdrant, optional)
   ↑
Graph Database (relationships, backlinks, graph traversal)
   ↑
Materialized Views (fast queries, current state)
   ↑
Event Store (immutable event log, source of truth)
   ↑
Content Storage (binary/text documents, sharded)
```

**Job Worker Integration**: Background workers process long-running AI operations (annotation detection, document generation) and emit events to the Event Store, which materializes views and updates the graph database via the event-driven architecture.

See [System Documentation](../../docs/system/README.md) for complete details.

### Background Job Processing

Asynchronous job processing for long-running AI operations that can't block HTTP requests:

**Current Status**: Prototype implementation embedded in backend process (not yet a standalone CLI-managed service)

**Job Types**:
- **Annotation Detection**: Detect annotations in documents using AI inference (highlights, assessments, comments, tags, entity references), emit `mark:added` events
- **Document Generation**: Create new documents from annotations using AI, emit `document.created` events

**Architecture**:
- Filesystem-based job queue with atomic operations
- FIFO job processing with automatic retry logic
- Progress tracking with Server-Sent Events (SSE) streaming
- Workers emit events to Event Store
- Jobs continue even if client disconnects

**Key Benefits**:
- Decouple long-running operations from HTTP request lifecycle
- Enable real-time progress updates via SSE
- Full audit trail via event sourcing
- Automatic retry on failures

**Future State**: Will become a standalone service with CLI integration, platform abstraction, and support for Redis/SQS queue backends.

See [Jobs Package](../../packages/jobs/) for implementation details.

### Secure-by-Default Authentication

- **All API routes require authentication by default**
- **Explicit public endpoint list** for exceptions
- **JWT Bearer token authentication**
- **OAuth 2.0 (Google)** for user login
- **MCP support** for AI assistant integration

See [Authentication Guide](./docs/AUTHENTICATION.md) for implementation details.

### API Routing Architecture

Clean separation of concerns:
- **Backend owns**: `/api/*` - all API endpoints, including the OAuth credential exchange and JWT minting (`POST /api/tokens/google`)
- **Frontend**: the static Vite + React SPA - no server routes (#557 removed Next.js)
- **No routing conflicts** - simple ALB host/path rules

See [API Reference](../../docs/protocol/API.md) for complete endpoint documentation.

## Project Structure

```
apps/backend/
├── docs/                      # Documentation
│   ├── ARCHITECTURE.md       # Backend architecture
│   ├── AUTHENTICATION.md     # Auth implementation
│   ├── DEVELOPMENT.md        # Local development guide
│   ├── LOGGING.md            # Logging guide
│   └── TESTING.md            # Testing guide
├── src/
│   ├── __tests__/            # Test suites
│   ├── auth/                 # Authentication (JWT, OAuth)
│   ├── cli/                  # Rebuild CLIs (graph, projections, vectors)
│   ├── lib/                  # SSE helpers
│   ├── middleware/           # HTTP middleware (auth, logging, security headers, OpenAPI validation)
│   ├── routes/               # Modular route definitions (thin EventBus wrappers)
│   ├── types/                # Type definitions
│   ├── utils/                # Shared utilities
│   │   └── event-bus-request.ts  # correlationId request-response helper
│   ├── db.ts                 # Prisma client setup
│   ├── index.ts              # Main application
│   └── logger.ts             # Winston-based logger
├── prisma/
│   ├── migrations/           # Database migrations
│   └── schema.prisma         # Database schema
├── scripts/                  # start.sh
└── README.md                 # This file

Note: OpenAPI specification source is maintained at `../../specs/src/` (project root).
Content storage lives in `packages/content` (WorkingTreeStore) and materialized views
in `packages/event-sourcing` — not in this app.
```

## Core Design Principles

### 1. Centralized Infrastructure Management

**All infrastructure components are created once and managed by MakeMeaningService:**

```typescript
// ✅ CORRECT: Access infrastructure via context
const { knowledgeSystem: { kb } } = c.get('makeMeaning');

// ❌ WRONG: Never create infrastructure in routes or services
const graphDb = await getGraphDatabase(config);  // NEVER DO THIS
const content = new WorkingTreeStore(...);  // NEVER DO THIS
```

**Architecture:**
- **MakeMeaningService** (`@semiont/make-meaning`) owns ALL infrastructure:
  - `knowledgeSystem: KnowledgeSystem` - the KB actors (Stower, Gatherer, Matcher, Browser, CloneTokenManager) and `kb: KnowledgeBase`:
    - `kb.eventStore: EventStore` - Immutable event log and materialized views
    - `kb.content: WorkingTreeStore` - Working-tree file content (`file://` URIs, SHA-256 integrity checksums)
    - `kb.graph: GraphDatabase` - Graph database for relationships and traversal
    - `kb.graphConsumer: GraphDBConsumer` - Event-to-graph synchronization
  - `jobQueue: JobQueue` - Background job processing
  - Inference clients are created per-actor inside make-meaning (Gatherer, Matcher) - never in backend code
  - Background workers run in a separate worker-pool process (see [Architecture](./docs/ARCHITECTURE.md))

**Implementation Pattern:**
- Infrastructure created ONCE in [index.ts:104](src/index.ts#L104) via `startMakeMeaning(project, config, eventBus, logger)`
- Routes access via `c.get('makeMeaning')` from Hono context
- Services receive infrastructure as parameters (dependency injection)
- NO route or service creates its own infrastructure instances

**Why This Matters:**
- Prevents duplicate connections and resource leaks
- Ensures consistent configuration across the application
- Simplifies testing with single mock injection point
- Clear ownership and lifecycle management
- Centralized shutdown via `makeMeaning.stop()`

See [Make-Meaning Package](../../packages/make-meaning/) for implementation details.

### 2. Type Safety First
- TypeScript throughout with strict mode
- Compile-time validation
- Type-safe API client generation

### 3. Runtime Validation
- All inputs validated with Zod schemas
- Fail-fast on invalid data
- Detailed error messages

### 4. Functional Programming
- Pure functions preferred
- Immutable data structures
- No side effects in business logic

### 5. Event Sourcing
- Immutable event log as source of truth
- Projections for fast queries
- Complete audit trail

### 6. Security by Default
- All routes protected unless explicitly public
- Multi-layer JWT validation
- Environment variable validation at startup

## API Documentation

### Interactive API Explorer
- **Local**: http://localhost:3001/api
- **Production**: https://your-domain.com/api

Features:
- 🔍 Interactive endpoint testing
- 📝 Request/response examples
- 🔐 Authentication testing with JWT tokens
- 📊 Schema visualization

### OpenAPI Specification
- **Endpoint**: `/api/openapi.json` - Raw OpenAPI 3.0 spec (generated bundle)
- **Source**: [../../specs/src/](../../specs/src/) - Hand-written specification files
- **Spec-first approach** - Hand-written specification, backend validates against it
- **Type generation** - Frontend types generated from spec via `openapi-typescript`
- **Validation** - Backend uses Ajv to validate requests against schemas

## Common Tasks

### Maintenance
```bash
# Rebuild Neo4j graph from event log (clears graph and replays all events)
SEMIONT_ROOT=/path/to/kb npm run rebuild-graph

# Rebuild a single resource in the graph
SEMIONT_ROOT=/path/to/kb npm run rebuild-graph -- <resourceId>
```

The command reads `~/.semiontconfig` for database credentials, graph, and vector store settings. Set `SEMIONT_ENV` or pass `--environment <env>` to select a non-default environment.

The vector store has no backend CLI: the smelter worker (`@semiont/make-meaning/smelter-main`) reconciles Qdrant against the KS catalog on every startup — re-embedding missing resources and annotations and deleting orphaned vectors. To recover from a wiped Qdrant volume, just restart the smelter; to force a full re-embed, wipe the Qdrant volume first and then restart it.

### Development
```bash
# Start development environment
semiont start

# Run tests
npm test

# Type check
npm run type-check

# Database GUI
npx prisma studio
```

See [Development Guide](./docs/DEVELOPMENT.md) for complete workflows.

### Testing
```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests
npm run test:security      # Security tests

# Watch mode
npm run test:watch
```

See [Testing Guide](./docs/TESTING.md) for testing patterns.

### Deployment
```bash
# Build and publish
semiont publish --service backend --environment production

# Deploy to ECS
semiont update --service backend --wait

# Monitor deployment
semiont watch logs --service backend
```

See [Deployment Guide](../../docs/system/administration/DEPLOYMENT.md) for complete procedures.

## Contributing

We welcome contributions! Please read:

1. [Architecture](./docs/ARCHITECTURE.md) - **Critical design patterns and constraints**
2. [Development Guide](./docs/DEVELOPMENT.md) - Setting up local environment
3. [Testing Guide](./docs/TESTING.md) - Writing and running tests

**Key Requirements**:
- **Follow infrastructure management pattern** - NEVER create EventStore, GraphDatabase, WorkingTreeStore, or InferenceClient instances (see [Architecture](./docs/ARCHITECTURE.md))
- Functional programming (pure functions, no mutations)
- All tests must pass
- TypeScript must compile without errors (strict mode)
- Include tests for new functionality

## Troubleshooting

### Common Issues

**"Cannot connect to database"**
```bash
# Check PostgreSQL is running
semiont check --service database
```

**"JWT_SECRET too short"**
- Must be at least 32 characters
- Generate: `openssl rand -base64 32`

**"Port already in use"**
```bash
# Stop all services
semiont stop
```

For detailed troubleshooting, see [Development Guide](./docs/DEVELOPMENT.md#troubleshooting).

## Further Reading

### Backend Documentation
- [Local Setup](../../docs/system/LOCAL-BACKEND.md) - Run the backend locally (container or npm)
- [Architecture](./docs/ARCHITECTURE.md) - **Infrastructure management patterns (REQUIRED READING)**
- [Development Guide](./docs/DEVELOPMENT.md) - Complete local development setup
- [API Reference](../../docs/protocol/API.md) - All API endpoints and examples
- [Authentication](./docs/AUTHENTICATION.md) - JWT, OAuth, MCP implementation
- [Event-Bus Protocol](../../docs/protocol/EVENT-BUS.md) - SSE streaming, channels, scoping, correlation
- [Database](../../docs/system/administration/DATABASE.md) - PostgreSQL setup for user authentication
- [Filesystem](../../docs/system/FILESYSTEM.md) - Storage patterns and providers
- [Knowledge System](../../docs/system/KNOWLEDGE-SYSTEM.md) - Storage architecture across all layers
- [Logging](./docs/LOGGING.md) - Winston logging, log levels, debugging
- [Testing](./docs/TESTING.md) - Testing philosophy and patterns
- [Deployment](../../docs/system/administration/DEPLOYMENT.md) - Production deployment guide

### System Documentation
- [System Documentation](../../docs/system/README.md) - Overall platform architecture
- [W3C Web Annotation](../../docs/protocol/W3C-WEB-ANNOTATION.md) - Annotation data flow
- [Event Sourcing Package](../../packages/event-sourcing/) - Event log and materialized views
- [Graph Package](../../packages/graph/) - Relationship traversal
- [Jobs Package](../../packages/jobs/) - Background job processing (prototype)

### External Resources
- [Hono Documentation](https://hono.dev/)
- [Prisma Documentation](https://prisma.io/docs)
- [Zod Documentation](https://zod.dev/)
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)

---

**Last Updated**: 2026-03-11
