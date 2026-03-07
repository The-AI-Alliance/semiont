# Semiont Services Documentation

Comprehensive documentation for all Semiont services and their implementations.

## Overview

Semiont's architecture consists of multiple services that work together to provide a semantic knowledge platform. For detailed service documentation, see:

- **Service Overview**: [OVERVIEW.md](./OVERVIEW.md) - Deployment-focused service catalog
- **Architecture**: [../ARCHITECTURE.md](../ARCHITECTURE.md) - System architecture
- **Package Documentation**: Individual packages in `packages/*/docs/`

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

### Data Storage Services

**Content Store** - Binary/text document storage
- **Package**: [@semiont/content](../../packages/content/)
- **API Documentation**: [packages/content/docs/API.md](../../packages/content/docs/API.md)
- **Implementation**: Content-addressed storage with SHA-256

**Event Store** - Immutable event log + materialized views
- **Package**: [@semiont/event-sourcing](../../packages/event-sourcing/)
- **API Documentation**: [packages/event-sourcing/docs/API.md](../../packages/event-sourcing/docs/API.md)
- **Architecture**: [packages/event-sourcing/docs/ARCHITECTURE.md](../../packages/event-sourcing/docs/ARCHITECTURE.md)

**Graph Database** - Relationship traversal
- **Package**: [@semiont/graph](../../packages/graph/)
- **API Documentation**: [packages/graph/docs/API.md](../../packages/graph/docs/API.md)
- **Providers**: Neo4j, AWS Neptune, JanusGraph, in-memory

### Infrastructure Services

**Database** - PostgreSQL for users and metadata
- **Documentation**: [apps/backend/docs/DATABASE.md](../../apps/backend/docs/DATABASE.md)
- **Implementation**: [apps/backend/prisma/](../../apps/backend/prisma/)
- **CLI Service**: [database-service.ts](../../apps/cli/src/services/database-service.ts)
- **Storage**: User accounts, OAuth tokens (NOT document metadata)

**Filesystem** - File storage patterns
- **Documentation**: [apps/backend/docs/FILESYSTEM.md](../../apps/backend/docs/FILESYSTEM.md)
- **Implementation**: [apps/backend/src/storage/](../../apps/backend/src/storage/)
- **CLI Service**: [filesystem-service.ts](../../apps/cli/src/services/filesystem-service.ts)
- **Storage**: Local filesystem, AWS S3, AWS EFS

**Inference** - AI/ML LLM service
- **Package**: [@semiont/inference](../../packages/inference/)
- **API Documentation**: [packages/inference/docs/API.md](../../packages/inference/docs/API.md)
- **CLI Service**: [inference-service.ts](../../apps/cli/src/services/inference-service.ts)
- **Providers**: Anthropic Claude, OpenAI, local models

**Job Worker** - Background job processing
- **Package**: [@semiont/jobs](../../packages/jobs/)
- **API Documentation**: [packages/jobs/docs/API.md](../../packages/jobs/docs/API.md)
- **Status**: Embedded in backend (future standalone service)
- **Workers**: Entity detection, document generation

**Secrets Management** - Future secrets manager integration (planned)
- **Documentation**: [SECRETS.md](./SECRETS.md)
- **Status**: Planning phase (Q1-Q4 2026)
- **Providers**: AWS Secrets Manager, HashiCorp Vault, Azure Key Vault

## Service Documentation Index

| Service | Type | Package/Documentation | Implementation |
|---------|------|----------------------|----------------|
| **Frontend** | Application | [apps/frontend/](../../apps/frontend/) | Next.js app |
| **Backend** | Application | [apps/backend/](../../apps/backend/) | Hono API |
| **MCP Server** | Application | [@semiont/mcp-server](../../packages/mcp-server/) | MCP protocol |
| **Content Store** | Data Storage | [@semiont/content](../../packages/content/) | Content-addressed storage |
| **Event Store** | Data Storage | [@semiont/event-sourcing](../../packages/event-sourcing/) | Event log + views |
| **Graph Database** | Data Storage | [@semiont/graph](../../packages/graph/) | Multi-provider graph |
| **Database** | Infrastructure | [Backend Docs](../../apps/backend/docs/DATABASE.md) | PostgreSQL (auth only) |
| **Filesystem** | Infrastructure | [Backend Docs](../../apps/backend/docs/FILESYSTEM.md) | Storage patterns |
| **Inference** | Infrastructure | [@semiont/inference](../../packages/inference/) | LLM integration |
| **Job Worker** | Infrastructure | [@semiont/jobs](../../packages/jobs/) | Background processing |
| **Secrets** | Infrastructure | [SECRETS.md](./SECRETS.md) | Future plans |

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

## Documentation Migration

The detailed service documentation has been reorganized to be package-centric:

### Previous Structure (Deleted)
- `docs/services/EVENT-STORE.md` → Moved to `packages/event-sourcing/docs/`
- `docs/services/GRAPH.md` → Moved to `packages/graph/docs/`
- `docs/services/INFERENCE.md` → Moved to `packages/inference/docs/`
- `docs/services/JOB-WORKER.md` → Moved to `packages/jobs/docs/`
- `docs/services/REPRESENTATION-STORE.md` → Moved to `packages/content/docs/`
- `docs/services/FILESYSTEM.md` → Moved to `apps/backend/docs/FILESYSTEM.md`
- `docs/services/DATABASE.md` → Moved to `apps/backend/docs/DATABASE.md`

### Current Structure
- **Package Documentation**: Each package contains its own comprehensive docs in `packages/{name}/docs/`
- **Backend Documentation**: Backend-specific implementation details in `apps/backend/docs/`
- **Service Overview**: Deployment and management focus in [OVERVIEW.md](./OVERVIEW.md)

## Related Documentation

### System Documentation
- [Architecture Overview](../ARCHITECTURE.md) - Overall system architecture
- [Service Overview](./OVERVIEW.md) - Service management and deployment
- [AWS Deployment](../platforms/AWS.md) - Production deployment guide
- [Configuration Guide](../CONFIGURATION.md) - Environment and service configuration
- [Authentication](../AUTHENTICATION.md) - OAuth 2.0 and JWT authentication

### Package Documentation
- [Packages Overview](../../packages/README.md) - Package dependency graph and descriptions
- Individual package docs in `packages/*/docs/` directories

### Development Guides
- [CLI Documentation](../../apps/cli/README.md) - CLI usage and development
- [Frontend Development](../../apps/frontend/README.md) - Next.js app development
- [Backend Development](../../apps/backend/README.md) - API server development