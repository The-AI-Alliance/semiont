# Semiont Platform Documentation

Documentation for all platform types supported by the Semiont CLI.

## Overview

Semiont services run on different **platforms** depending on the deployment environment. A platform defines where and how services execute - local processes, containers, cloud infrastructure, or external APIs.

**Platform Philosophy**: Services declare what they are (service type), environments declare where they run (platform type).

## Available Platforms

### POSIX - Local Development
- **Documentation**: [POSIX.md](./POSIX.md)
- **CLI Implementation**: [apps/cli/src/platforms/posix/](../../apps/cli/src/platforms/posix/)
- **Use Case**: Local development with native OS processes
- **Services**: backend, frontend, database, graph, mcp, filesystem, web, worker

### Container - Isolated Services
- **Documentation**: [Container.md](./Container.md)
- **CLI Implementation**: [apps/cli/src/platforms/container/](../../apps/cli/src/platforms/container/)
- **Use Case**: Docker/Podman containerized services
- **Services**: database, graph, generic, web

### AWS - Production Cloud
- **Documentation**: [AWS.md](./AWS.md)
- **CLI Implementation**: [apps/cli/src/platforms/aws/](../../apps/cli/src/platforms/aws/)
- **Use Case**: AWS managed services (ECS, RDS, S3, EFS)
- **Services**: ECS (backend/worker), RDS, Neptune, S3+CloudFront, EFS, Lambda

### External - Third-Party Services
- **Documentation**: [External.md](./External.md)
- **CLI Implementation**: [apps/cli/src/platforms/external/](../../apps/cli/src/platforms/external/)
- **Use Case**: External APIs and managed services
- **Services**: inference (LLM APIs), graph (Neo4j Aura)

### Mock - Testing
- **Documentation**: [Mock.md](./Mock.md)
- **CLI Implementation**: [apps/cli/src/platforms/mock/](../../apps/cli/src/platforms/mock/)
- **Use Case**: Simulated services for testing
- **Services**: Any service (simulated behavior)

## Platform Comparison

| Platform | Management | Use Case | Primary Services |
|----------|-----------|----------|------------------|
| **POSIX** | Native processes | Local dev | backend, frontend, mcp |
| **Container** | Docker/Podman | Isolation | database, graph |
| **AWS** | AWS managed | Production | ECS, RDS, Neptune, S3 |
| **External** | Third-party APIs | External | inference, graph |
| **Mock** | Simulated | Testing | Any (test doubles) |

## Platform Selection

### By Environment

Platform assignments from [local.json](../../apps/cli/templates/environments/local.json):

```
Development (local.json):
├── Backend → POSIX
├── Frontend → POSIX
├── Database → Container (postgres:15-alpine)
├── Graph → External (Neo4j)
├── MCP → POSIX
├── Filesystem → POSIX
└── Inference → External (Anthropic API)
```

Production and staging environments would typically use AWS platform for managed services.

### By Service Type

Based on handler implementations:

**Application Services** ([posix/handlers/](../../apps/cli/src/platforms/posix/handlers/)):

- Backend, Frontend, MCP → POSIX (local dev)
- Backend → AWS ECS (production)

**Data Services**:

- Database → Container (local), AWS RDS (production)
- Graph → External or Container (local), AWS Neptune (production)

**Infrastructure Services**:

- Inference → External (Anthropic/OpenAI APIs)
- Filesystem → POSIX (local), AWS S3/EFS (production)

## Configuration

Platforms are configured in environment files like [local.json](../../apps/cli/templates/environments/local.json).

**Example** ([local.json:15-28](../../apps/cli/templates/environments/local.json#L15-L28)):

```json
{
  "backend": {
    "platform": { "type": "posix" },
    "command": "npm run dev",
    "port": 4000
  },
  "database": {
    "platform": { "type": "container" },
    "image": "postgres:15-alpine",
    "port": 5432,
    "environment": {
      "POSTGRES_DB": "semiont",
      "POSTGRES_USER": "postgres",
      "POSTGRES_PASSWORD": "localpass"
    }
  },
  "inference": {
    "platform": { "type": "external" },
    "type": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "endpoint": "https://api.anthropic.com",
    "apiKey": "${ANTHROPIC_API_KEY}"
  }
}
```

## CLI Commands

See [CLI README](../../apps/cli/README.md) for complete command reference.

**Common Commands**:

- `semiont start` - Start services (platform-aware)
- `semiont stop` - Stop services
- `semiont check` - Health check
- `semiont provision` - Provision infrastructure

Platform handlers implement service-specific behavior for each command.

## Platform Handlers

Each platform implements service-specific handlers in `apps/cli/src/platforms/{platform}/handlers/`.

**POSIX Handlers** ([posix/handlers/](../../apps/cli/src/platforms/posix/handlers/)):

- backend-start.ts, backend-stop.ts, backend-check.ts
- frontend-start.ts, frontend-stop.ts, frontend-check.ts
- database-start.ts, graph-start.ts, mcp-start.ts, etc.

**Container Handlers** ([container/handlers/](../../apps/cli/src/platforms/container/handlers/)):

- database-start.ts, database-stop.ts, database-check.ts
- graph-start.ts, graph-stop.ts
- generic-start.ts, web-start.ts

**AWS Handlers** ([aws/handlers/](../../apps/cli/src/platforms/aws/handlers/)):

- ecs-start.ts, ecs-check.ts, ecs-publish.ts
- rds-check.ts, neptune-check.ts
- stack-provision.ts

**External Handlers** ([external/handlers/](../../apps/cli/src/platforms/external/handlers/)):

- inference-check.ts, graph-check.ts

**Mock Handlers** ([mock/handlers/](../../apps/cli/src/platforms/mock/handlers/)):

- default-start.ts, default-check.ts

### Adding New Platforms

See [Adding Platforms Guide](../../apps/cli/docs/ADDING_PLATFORMS.md) for instructions on extending platform support.

## Related Documentation

- [CLI README](../../apps/cli/README.md) - Complete CLI reference
- [Adding Platforms](../../apps/cli/docs/ADDING_PLATFORMS.md) - Extend platform support
- [Services](../services/README.md) - Service documentation
- [Architecture](../ARCHITECTURE.md) - Overall system design
