# Semiont Services Documentation

Comprehensive documentation for all Semiont services and their implementations.

## Overview

Semiont's architecture consists of multiple services that work together to provide a semantic knowledge platform. This directory contains detailed documentation for each service layer and component.

**Service Architecture**: Each service has:
- **Documentation** (this directory) - Architecture, design, and operational details
- **Implementation** - Code in `apps/` or `packages/` directories
- **CLI Integration** - Service definitions in [apps/cli/src/services/](../../apps/cli/src/services/)

## Service Categories

### Application Services

**Frontend** - Next.js web application
- **Documentation**: [apps/frontend/README.md](../../apps/frontend/README.md)
- **Implementation**: [apps/frontend/](../../apps/frontend/)
- **CLI Service**: [frontend-service.ts](../../apps/cli/src/services/frontend-service.ts)

**Backend** - Hono API server
- **Documentation**: [apps/backend/README.md](../../apps/backend/README.md)
- **Implementation**: [apps/backend/](../../apps/backend/)
- **CLI Service**: [backend-service.ts](../../apps/cli/src/services/backend-service.ts)

**MCP Server** - Model Context Protocol integration
- **Documentation**: [packages/mcp-server/README.md](../../packages/mcp-server/README.md)
- **Implementation**: [packages/mcp-server/](../../packages/mcp-server/)
- **CLI Service**: [mcp-service.ts](../../apps/cli/src/services/mcp-service.ts)

### Data Layer Services (4-Layer Architecture)

**Layer 1: RepresentationStore** - Binary/text document storage
- **Documentation**: [REPRESENTATION-STORE.md](./REPRESENTATION-STORE.md)
- **Implementation**: [apps/backend/src/storage/content/](../../apps/backend/src/storage/content/)
- **Storage**: Sharded filesystem (65,536 shards)

**Layer 2: Event Store** - Immutable event log
- **Documentation**: [EVENT-STORE.md](./EVENT-STORE.md)
- **Implementation**: [apps/backend/src/events/](../../apps/backend/src/events/)
- **Storage**: Append-only JSONL files

**Layer 3: Projection Store** - Materialized views
- **Documentation**: [PROJECTION.md](./PROJECTION.md)
- **Implementation**: [apps/backend/src/storage/projection/](../../apps/backend/src/storage/projection/)
- **Storage**: Filesystem JSONL + PostgreSQL

**Layer 4: Graph Database** - Relationship traversal
- **Documentation**: [GRAPH.md](./GRAPH.md)
- **Implementation**: [apps/backend/src/graph/](../../apps/backend/src/graph/)
- **Storage**: Neo4j, AWS Neptune, or in-memory

### Infrastructure Services

**Database** - PostgreSQL for users and metadata
- **Documentation**: [DATABASE.md](./DATABASE.md)
- **Implementation**: [apps/backend/prisma/](../../apps/backend/prisma/)
- **CLI Service**: [database-service.ts](../../apps/cli/src/services/database-service.ts)
- **Storage**: User accounts, API keys, job queue

**Filesystem** - File storage and uploads
- **Documentation**: [FILESYSTEM.md](./FILESYSTEM.md)
- **Implementation**: [apps/backend/src/storage/content/](../../apps/backend/src/storage/content/)
- **CLI Service**: [filesystem-service.ts](../../apps/cli/src/services/filesystem-service.ts)
- **Storage**: Local filesystem, AWS S3, AWS EFS

**Graph** - Graph database service
- **Documentation**: [GRAPH.md](./GRAPH.md)
- **Implementation**: [apps/backend/src/graph/](../../apps/backend/src/graph/)
- **CLI Service**: [graph-service.ts](../../apps/cli/src/services/graph-service.ts)
- **Providers**: Neo4j, AWS Neptune, JanusGraph, in-memory

**Inference** - AI/ML LLM service
- **Documentation**: [INFERENCE.md](./INFERENCE.md)
- **Implementation**: [apps/backend/src/jobs/generation-worker.ts](../../apps/backend/src/jobs/generation-worker.ts)
- **CLI Service**: [inference-service.ts](../../apps/cli/src/services/inference-service.ts)
- **Providers**: Anthropic Claude, OpenAI, local models

**Job Worker** - Background job processing (prototype)

- **Documentation**: [JOB-WORKER.md](./JOB-WORKER.md)
- **Implementation**: [apps/backend/src/jobs/](../../apps/backend/src/jobs/)
- **Status**: Embedded in backend (not yet a proper CLI service)
- **Workers**: Entity detection, document generation

**Secrets Management** - Future secrets manager integration (planned)
- **Documentation**: [SECRETS.md](./SECRETS.md)
- **Status**: Planning phase (Q1-Q4 2026)
- **Providers**: AWS Secrets Manager, HashiCorp Vault, Azure Key Vault

## Service Documentation Index

| Service | Type | Documentation | Implementation |
|---------|------|---------------|----------------|
| **Frontend** | Application | [apps/frontend/README.md](../../apps/frontend/README.md) | [apps/frontend/](../../apps/frontend/) |
| **Backend** | Application | [apps/backend/README.md](../../apps/backend/README.md) | [apps/backend/](../../apps/backend/) |
| **MCP Server** | Application | [packages/mcp-server/README.md](../../packages/mcp-server/README.md) | [packages/mcp-server/](../../packages/mcp-server/) |
| **RepresentationStore** | Data Layer 1 | [REPRESENTATION-STORE.md](./REPRESENTATION-STORE.md) | [apps/backend/src/storage/content/](../../apps/backend/src/storage/content/) |
| **Event Store** | Data Layer 2 | [EVENT-STORE.md](./EVENT-STORE.md) | [apps/backend/src/events/](../../apps/backend/src/events/) |
| **Projection Store** | Data Layer 3 | [PROJECTION.md](./PROJECTION.md) | [apps/backend/src/storage/projection/](../../apps/backend/src/storage/projection/) |
| **Graph Database** | Data Layer 4 | [GRAPH.md](./GRAPH.md) | [apps/backend/src/graph/](../../apps/backend/src/graph/) |
| **Database** | Infrastructure | [DATABASE.md](./DATABASE.md) | [apps/backend/prisma/](../../apps/backend/prisma/) |
| **Filesystem** | Infrastructure | [FILESYSTEM.md](./FILESYSTEM.md) | [apps/backend/src/storage/content/](../../apps/backend/src/storage/content/) |
| **Inference** | Infrastructure | [INFERENCE.md](./INFERENCE.md) | [apps/backend/src/jobs/](../../apps/backend/src/jobs/) |
| **Job Worker** | Infrastructure (prototype) | [JOB-WORKER.md](./JOB-WORKER.md) | [apps/backend/src/jobs/](../../apps/backend/src/jobs/) |
| **Secrets** | Infrastructure | [SECRETS.md](./SECRETS.md) | Planned (Q1-Q4 2026) |

## CLI Service Implementations

All services are integrated with the Semiont CLI for management:

**Service Factory**: [apps/cli/src/services/service-factory.ts](../../apps/cli/src/services/service-factory.ts)
- Creates service instances based on environment configuration
- Maps service types to platform implementations

**Service Implementations**: [apps/cli/src/services/](../../apps/cli/src/services/)
- `backend-service.ts` - Backend API service management
- `frontend-service.ts` - Frontend app service management
- `database-service.ts` - PostgreSQL database management
- `filesystem-service.ts` - File storage management
- `graph-service.ts` - Graph database management
- `inference-service.ts` - LLM inference service
- `mcp-service.ts` - MCP server management

**Extending the CLI**:

- [Adding Service Types](../../apps/cli/docs/ADDING_SERVICE_TYPES.md) - Define new service type schemas
- [Adding Services](../../apps/cli/docs/ADDING_SERVICES.md) - Add service instances to environments

## Service Management

### Using the CLI

All services can be managed through the Semiont CLI:

```bash
# Start all services
semiont start --environment local

# Start specific service
semiont start --service backend --environment local

# Check service status
semiont check --service all --environment local

# Stop services
semiont stop --service all --environment local

# Monitor services
semiont watch --environment local
```

### Environment Configuration

Services are configured per environment in `environments/*.json`:

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

See [CLI README](../../apps/cli/README.md) for complete CLI documentation.

## Architecture References

### 4-Layer Data Architecture

The data layer services implement a 4-layer architecture:

```
Layer 4: Graph Database (Relationships & Traversal)
           ↑
Layer 3: Projection Store (Materialized Views)
           ↑
Layer 2: Event Store (Immutable Event Log)
           ↑
Layer 1: RepresentationStore (Binary/Text Files)
```

**Benefits**:
- **Event Sourcing**: Complete audit trail and time-travel capability
- **Rebuildable**: Projections and graph can be rebuilt from events
- **Separation of Concerns**: Each layer optimized for its access pattern

**Complete Documentation**:
- [Architecture Overview](../ARCHITECTURE.md) - High-level system design
- [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md#data-layer-architecture) - Detailed layer implementation

### Service Communication

**Request Flow**:
1. User → Frontend (Next.js)
2. Frontend → Backend API (Hono)
3. Backend → Data Layers (Content, Events, Projections, Graph)
4. Backend → External Services (Inference, Graph DB)

**Authentication**:
- Frontend: OAuth 2.0 (NextAuth.js)
- Backend: JWT bearer tokens
- MCP: Long-lived refresh tokens

See [Authentication Documentation](../AUTHENTICATION.md) for details.

## Related Documentation

### System Documentation

- [Architecture Overview](../ARCHITECTURE.md) - Overall system architecture
- [AWS Deployment](../platforms/AWS.md) - Production deployment guide
- [Configuration Guide](../CONFIGURATION.md) - Environment and service configuration
- [Authentication](../AUTHENTICATION.md) - OAuth 2.0 and JWT authentication

### API Documentation

- [API Overview](../../specs/docs/API.md) - High-level API capabilities
- [OpenAPI Specification](../../specs/openapi.json) - Complete API reference
- [W3C Web Annotation](../../specs/docs/W3C-WEB-ANNOTATION.md) - Annotation semantics

### Development Guides

- [CLI Documentation](../../apps/cli/README.md) - CLI usage and development
- [Frontend Development](../../apps/frontend/README.md) - Next.js app development
- [Backend Development](../../apps/backend/README.md) - API server development
- [MCP Server](../../packages/mcp-server/README.md) - AI integration

---

**Documentation Directory**: `/docs/services`
**CLI Services**: `/apps/cli/src/services`
**Last Updated**: 2025-10-25
