# Container Platform

Container-based platform using Docker or Podman.

## Overview

The Container platform runs services in containers using Docker or Podman ([database-start.ts](../../apps/cli/src/platforms/container/handlers/database-start.ts)).

**Platform Type**: `container`

## Configuration

**Example from** [local.json](../../apps/cli/templates/environments/local.json):

```json
{
  "database": {
    "platform": {
      "type": "container"
    },
    "image": "postgres:15-alpine",
    "name": "semiont-local-db",
    "port": 5432,
    "environment": {
      "POSTGRES_DB": "semiont",
      "POSTGRES_USER": "postgres",
      "POSTGRES_PASSWORD": "localpass"
    }
  }
}
```

## Supported Services

Based on handler files in [apps/cli/src/platforms/container/handlers/](../../apps/cli/src/platforms/container/handlers/):
- **database** - PostgreSQL, MySQL, MongoDB
- **graph** - Neo4j
- **web** - Web servers
- **generic** - Other containerized services

## Implementation

**Handlers**: [apps/cli/src/platforms/container/handlers/](../../apps/cli/src/platforms/container/handlers/)

Service-specific handlers:
- [database-start.ts](../../apps/cli/src/platforms/container/handlers/database-start.ts)
- [database-stop.ts](../../apps/cli/src/platforms/container/handlers/database-stop.ts)
- [graph-start.ts](../../apps/cli/src/platforms/container/handlers/graph-start.ts)
- [generic-start.ts](../../apps/cli/src/platforms/container/handlers/generic-start.ts)

## Container Runtime

The platform uses `execSync` to execute Docker/Podman commands ([database-start.ts:1](../../apps/cli/src/platforms/container/handlers/database-start.ts#L1)).

## Networking

Creates environment-specific networks ([database-start.ts:22](../../apps/cli/src/platforms/container/handlers/database-start.ts#L22)):

```typescript
const networkName = `semiont-${service.environment}`;
```

## Related Documentation

- [CLI Platform Implementation](../../apps/cli/src/platforms/container/) - Container handlers source code
- [Adding Platforms Guide](../../apps/cli/docs/ADDING_PLATFORMS.md) - How to extend platform support
- [POSIX Platform](./POSIX.md) - Alternative for native processes
