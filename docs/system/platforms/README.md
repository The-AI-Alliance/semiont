# Semiont Platform Documentation

Documentation for all platform types supported by the Semiont CLI.

## Overview

Semiont services run on different **platforms** depending on the deployment environment. A platform defines where and how services execute - local processes, containers, cloud infrastructure, or external APIs.

**Platform Philosophy**: Services declare what they are (service type), environments declare where they run (platform type).

## Available Platforms

### POSIX - Local Development
- **Documentation**: [POSIX.md](./POSIX.md)
- **CLI Implementation**: [apps/cli/src/platforms/posix/](../../../apps/cli/src/platforms/posix/)
- **Use Case**: Local development with native OS processes
- **Services**: backend, frontend, database, graph, mcp, filesystem, web, worker

### Container - Isolated Services
- **Documentation**: [Container.md](./Container.md)
- **CLI Implementation**: [apps/cli/src/platforms/container/](../../../apps/cli/src/platforms/container/)
- **Use Case**: Containerized services (Apple Container, Docker, Podman)
- **Services**: database, graph, generic, web

### External - Third-Party Services
- **Documentation**: [External.md](./External.md)
- **CLI Implementation**: [apps/cli/src/platforms/external/](../../../apps/cli/src/platforms/external/)
- **Use Case**: External APIs and managed services
- **Services**: inference (LLM APIs), graph (Neo4j Aura)

### Mock - Testing
- **Documentation**: [Mock.md](./Mock.md)
- **CLI Implementation**: [apps/cli/src/platforms/mock/](../../../apps/cli/src/platforms/mock/)
- **Use Case**: Simulated services for testing
- **Services**: Any service (simulated behavior)

## Platform Comparison

| Platform | Management | Use Case | Primary Services |
|----------|-----------|----------|------------------|
| **POSIX** | Native processes | Local dev | backend, frontend, mcp |
| **Container** | Container runtime | Isolation | database, graph |
| **External** | Third-party APIs | External | inference, graph |
| **Mock** | Simulated | Testing | Any (test doubles) |

> **There is no cloud platform.** The AWS platform was removed; the CLI provisions nothing in a
> cloud. Semiont's container images can be scheduled by any container platform (ECS Fargate,
> Kubernetes, …), but that is your own integration — see
> [Running Semiont on AWS](./AWS.md).

## Platform Selection

### By Environment

Platform assignments (example `~/.semiontconfig`):

```
Development environment:
├── Backend → POSIX
├── Frontend → POSIX
├── Database → Container (postgres:15-alpine)
├── Graph → External (Neo4j)
├── MCP → POSIX
├── Filesystem → POSIX
└── Inference → External (Anthropic API)
```

A deployed KB stack does not use these platforms at all: it runs the published container images,
brought up by the `semiont` launcher or `docker compose`. See
[CONTAINER-TOPOLOGY.md](../CONTAINER-TOPOLOGY.md) for the distinction between the two layers.

### By Service Type

Based on handler implementations:

**Application Services** ([posix/handlers/](../../../apps/cli/src/platforms/posix/handlers/)):

- Backend, Frontend, MCP → POSIX

**Data Services**:

- Database → Container
- Graph → External or Container

**Infrastructure Services**:

- Inference → External (Anthropic/OpenAI APIs)
- Filesystem → POSIX

## Configuration

Platforms are assigned **per service** in `~/.semiontconfig` — a gitignored TOML file. Each service section carries a `platform` field naming its platform type. See [Adding Environments](../../../apps/cli/docs/ADDING_ENVIRONMENTS.md) for the full per-environment format.

**Example** (`~/.semiontconfig`):

```toml
[environments.local.backend]
platform = "posix"
command = "npm run dev"
port = 4000

[environments.local.database]
platform = "container"
image = "postgres:15-alpine"
port = 5432

[environments.local.database.environment]
POSTGRES_DB = "semiont"
POSTGRES_USER = "postgres"
POSTGRES_PASSWORD = "localpass"

[environments.local.workers.default.inference]
platform = "external"
type = "anthropic"
model = "claude-sonnet-4-20250514"
endpoint = "https://api.anthropic.com"
apiKey = "${ANTHROPIC_API_KEY}"
```

## CLI Commands

See [CLI README](../../../apps/cli/README.md) for complete command reference.

**Common Commands**:

- `semiont start` - Start services (platform-aware)
- `semiont stop` - Stop services
- `semiont check` - Health check
- `semiont provision` - Provision infrastructure

Platform handlers implement service-specific behavior for each command.

## Platform Handlers

Each platform implements service-specific handlers in `apps/cli/src/platforms/{platform}/handlers/`.

**POSIX Handlers** ([posix/handlers/](../../../apps/cli/src/platforms/posix/handlers/)):

- backend-start.ts, backend-stop.ts, backend-check.ts
- frontend-start.ts, frontend-stop.ts, frontend-check.ts
- database-start.ts, graph-start.ts, mcp-start.ts, etc.

**Container Handlers** ([container/handlers/](../../../apps/cli/src/platforms/container/handlers/)):

- database-start.ts, database-stop.ts, database-check.ts
- graph-start.ts, graph-stop.ts
- generic-start.ts, web-start.ts

**AWS Handlers** ([aws/handlers/](../../../apps/cli/src/platforms/aws/handlers/)):

- ecs-start.ts, ecs-check.ts, ecs-publish.ts
- rds-check.ts, neptune-check.ts
- stack-provision.ts

**External Handlers** ([external/handlers/](../../../apps/cli/src/platforms/external/handlers/)):

- inference-check.ts, graph-check.ts

**Mock Handlers** ([mock/handlers/](../../../apps/cli/src/platforms/mock/handlers/)):

- default-start.ts, default-check.ts

### Adding New Platforms

See [Adding Platforms Guide](../../../apps/cli/docs/ADDING_PLATFORMS.md) for instructions on extending platform support.

## Related Documentation

- [CLI README](../../../apps/cli/README.md) - Complete CLI reference
- [Adding Platforms](../../../apps/cli/docs/ADDING_PLATFORMS.md) - Extend platform support
- [Services](../services/README.md) - Service documentation
- [Architecture](../README.md) - Overall system design
