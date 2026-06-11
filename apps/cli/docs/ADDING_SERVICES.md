# Adding New Services to Semiont CLI

This guide walks you through adding a new service type to the Semiont CLI.

## Overview

Services in Semiont represent different types of application components. The supported services (see `SUPPORTED_SERVICES` in `src/services/service-factory.ts`) are:

- **backend** - API servers and application logic
- **frontend** - Web UI and static assets
- **database** - Data storage services
- **graph** - Graph databases (JanusGraph, Neptune, Neo4j)
- **mcp** - Model Context Protocol servers
- **inference** - AI/ML model serving (Anthropic, Ollama)
- **embedding** - Embedding model providers
- **vectors** - Vector databases (Qdrant, etc.)

Services encapsulate business logic and requirements independent of deployment platform.

## Architecture

```
Command → Service → Platform
            ↓           ↓
      Business Logic  Infrastructure
      Requirements    Implementation
      Type Declaration Handler Selection
```

## Step-by-Step Guide

### 1. Create the Service File

Create a new file in `src/services/`:

```bash
touch src/services/my-service.ts
```

### 2. Implement the Service Class

Services extend `BaseService` and do **not** define their own constructor — they inherit `BaseService`'s constructor `(name, platform, envConfig, serviceConfig, runtimeFlags)`, which `ServiceFactory` invokes. The one required override is `getRequirements()`:

```typescript
/**
 * My Service - Custom service implementation
 */

import { BaseService } from '../core/base-service.js';
import { ServiceRequirements, RequirementPresets, mergeRequirements } from '../core/service-requirements.js';
import { SERVICE_TYPES, SERVICE_TYPE_ANNOTATION } from '../core/service-types.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';
import { CLI_BEHAVIOR_ANNOTATIONS } from '../core/service-cli-behaviors.js';

export class MyService extends BaseService {

  override getRequirements(): ServiceRequirements {
    // Start from a preset and merge service-specific requirements
    const baseRequirements = RequirementPresets.statelessApi();

    const myRequirements: ServiceRequirements = {
      network: {
        ports: [this.getPort()],
        protocol: 'tcp',
        healthCheckPath: '/health',
        healthCheckPort: this.getPort(),
      },
      resources: {
        memory: '1Gi',     // Kubernetes-style notation
        cpu: '1.0',
        replicas: 1,
      },
      storage: [{
        persistent: true,
        size: '10Gi',
        mountPath: '/data',
        type: 'volume',
        backupEnabled: true,
      }],
      security: {
        secrets: ['API_KEY'],
        readOnlyRootFilesystem: false,
        allowPrivilegeEscalation: false,
      },
      annotations: {
        // Service type declaration (required)
        [SERVICE_TYPE_ANNOTATION]: SERVICE_TYPES.BACKEND, // or FRONTEND, DATABASE, etc.

        // Command capability declarations (optional)
        [COMMAND_CAPABILITY_ANNOTATIONS.PUBLISH]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.UPDATE]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.BACKUP]: 'true',

        // CLI behavior declarations (optional)
        [CLI_BEHAVIOR_ANNOTATIONS.KEEP_ALIVE]: 'false',
        [CLI_BEHAVIOR_ANNOTATIONS.SUPPRESS_OUTPUT]: 'false',
      },
    };

    return mergeRequirements(baseRequirements, myRequirements);
  }
}
```

`BaseService` provides config accessors (`getPort()`, `getHealthEndpoint()`, `getCommand()`, `getImage()`, `getEnvironmentVariables()`) and requirement helpers (`needsPersistentStorage()`, `getRequiredSecrets()`, etc.). Type-narrow `this.config` if your service has a specific config type — see `graph-service.ts` for the pattern.

### 3. Register the Service

Add your service to `SUPPORTED_SERVICES` and the switch in `src/services/service-factory.ts`:

```typescript
import { MyService } from './my-service.js';

const SUPPORTED_SERVICES = ['backend', 'frontend', 'database', 'graph', 'mcp', 'inference', 'embedding', 'vectors', 'my-service'] as const;

export class ServiceFactory {
  static create(
    name: ServiceName,
    platform: PlatformType,
    config: Config,
    envConfig: EnvironmentConfig,
    serviceConfig: ServiceConfig
  ): Service {
    const runtimeFlags = {
      verbose: config.verbose,
      quiet: config.quiet,
      dryRun: config.dryRun,
      forceDiscovery: config.forceDiscovery
    };

    switch (name) {
      // ... existing cases
      case 'my-service':
        return new MyService(name, platform, envConfig, serviceConfig, runtimeFlags);
      default:
        throw new Error(
          `Unknown service type: '${name}'. Supported services: ${SUPPORTED_SERVICES.join(', ')}`
        );
    }
  }
}
```

`ServiceName` is just `string` (`src/core/service-discovery.ts`) — there is no union type to extend; the factory switch is the registry.

### 4. Important: Service Type Declaration

Every service MUST declare its type via the `service/type` annotation. This is how platforms determine which handlers to use:

```typescript
const annotations = {
  [SERVICE_TYPE_ANNOTATION]: SERVICE_TYPES.BACKEND,  // Required!
  // ... other annotations
};
```

Available service types (`src/core/service-types.ts`):
- `SERVICE_TYPES.FRONTEND` - User-facing web applications
- `SERVICE_TYPES.BACKEND` - API servers and application logic
- `SERVICE_TYPES.DATABASE` - Data persistence layers
- `SERVICE_TYPES.GRAPH` - Graph databases and knowledge graphs (JanusGraph, Neptune, Neo4j)
- `SERVICE_TYPES.WORKER` - Background job processors
- `SERVICE_TYPES.INFERENCE` - AI/ML model serving
- `SERVICE_TYPES.MCP` - Model Context Protocol services
- `SERVICE_TYPES.VECTORS` - Vector databases (Qdrant, etc.)
- `SERVICE_TYPES.EMBEDDING` - Embedding model providers
- `SERVICE_TYPES.STACK` - Infrastructure stacks (CloudFormation, Terraform)
- `SERVICE_TYPES.FILESYSTEM` - Shared/persistent file storage (EFS, NFS, etc.)

### 5. Configure the Service

Service configuration lives in `~/.semiontconfig` (TOML), under `[environments.<env>.<service>]`. The `platform` field is a plain string — the config loader normalizes it to `{ type }` internally:

```toml
# JanusGraph on the container platform
[environments.local.graph]
platform = "container"
type = "janusgraph"     # CRITICAL: implementation type
port = 8182
storage = "berkeleydb"

# Neptune on AWS
[environments.production.graph]
platform = "aws"
type = "neptune"
port = 8182

# External inference provider
[environments.local.inference]
platform = "external"
type = "anthropic"
apiKey = "${ANTHROPIC_API_KEY}"
model = "claude-haiku-4-5-20251001"
```

Your handlers should check the implementation type:

```typescript
const implementationType = service.config.type;

if (implementationType !== 'expected-type') {
  return {
    success: false,
    error: `Unsupported implementation: ${implementationType}`
  };
}
```

**Important**: Never use fallbacks when reading implementation types. This ensures explicit configuration and clear error messages.

### 6. Add Platform Handlers

Commands execute against a service through platform handlers keyed by `(platform, command, serviceType)`. For each platform your service runs on, add handler files under `src/platforms/<platform>/handlers/` and register them in that platform's `handlers/index.ts`. See [ADDING_PLATFORMS.md](./ADDING_PLATFORMS.md) and the existing `graph-*.ts` handlers for examples.

### 7. Add Tests

Create a test file at `src/services/__tests__/my-service.test.ts`. Construct the service the way `ServiceFactory` does — five arguments, with a real `PlatformType` (`'aws' | 'container' | 'posix' | 'external' | 'mock'`):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MyService } from '../my-service.js';

describe('MyService', () => {
  let service: MyService;

  beforeEach(() => {
    service = new MyService(
      'my-service',
      'container',
      { _metadata: { environment: 'test', projectRoot: '/test' } } as any,
      { platform: { type: 'container' }, port: 8080 } as any,
      { verbose: false, quiet: false }
    );
  });

  describe('getRequirements', () => {
    it('declares its service type', () => {
      const requirements = service.getRequirements();
      expect(requirements.annotations?.['service/type']).toBe('backend');
    });

    it('defines network requirements', () => {
      const requirements = service.getRequirements();
      expect(requirements.network?.ports).toContain(8080);
    });
  });
});
```

## Service Requirements

Services declare requirements (`src/core/service-requirements.ts`) that platforms use to provision resources:

### Resources
```typescript
resources: {
  memory: '1Gi',       // Kubernetes-style notation
  cpu: '1.0',          // cores, or millicores like '100m'
  replicas: 1,
  gpus: 0,
  ephemeralStorage: '5Gi',
}
```

### Network
```typescript
network: {
  ports: [3000],
  protocol: 'tcp',
  needsLoadBalancer: true,
  customDomains: ['api.example.com'],
  healthCheckPath: '/health',
  healthCheckPort: 3000,
  healthCheckInterval: 30,
}
```

### Storage
```typescript
storage: [{
  persistent: true,
  volumeName: 'my-data',
  size: '10Gi',
  mountPath: '/data',
  type: 'volume',        // 'volume' | 'bind' | 'tmpfs'
  backupEnabled: true,
}]
```

### Security
```typescript
security: {
  secrets: ['API_KEY', 'DATABASE_URL'],
  runAsUser: 1000,
  readOnlyRootFilesystem: false,
  allowPrivilegeEscalation: false,
}
```

### Dependencies
```typescript
dependencies: {
  services: ['database'],          // Platform ensures these run first
  startupOrder: ['database', 'my-service'],
}
```

Use `RequirementPresets` (`statefulDatabase`, `statelessApi`, …) as starting points and `mergeRequirements()` to compose them with service-specific requirements.

## Command Capabilities

Services declare which commands they support via annotations, not methods. Lifecycle commands (`start`, `stop`, `restart`, `check`, `watch`, `provision`, `configure` — see `DEFAULT_SUPPORTED_COMMANDS`) are assumed supported unless explicitly disabled; everything else must be opted into:

```typescript
annotations: {
  [SERVICE_TYPE_ANNOTATION]: SERVICE_TYPES.BACKEND,
  [COMMAND_CAPABILITY_ANNOTATIONS.BACKUP]: 'true',     // opt in
  [COMMAND_CAPABILITY_ANNOTATIONS.PUBLISH]: 'true',
  [COMMAND_CAPABILITY_ANNOTATIONS.START]: 'false',     // opt out of a default
}
```

The command-service matcher (`src/core/command-service-matcher.ts`) reads these annotations to decide which services a command applies to.

## Best Practices

### 1. Keep Services Platform-Agnostic

Services should not contain platform-specific code:

```typescript
// ✅ Good - Service declares requirements
getRequirements() {
  return { resources: { memory: '512Mi' } };
}

// ❌ Bad - Service contains AWS-specific code
startOnAWS() {
  const ecs = new ECSClient();
  // ...
}
```

### 2. Use Requirements for Resource Needs

Let platforms interpret requirements:

```typescript
// ✅ Good - Declare what you need
getRequirements() {
  return {
    resources: { memory: '1Gi', cpu: '1' },
    network: { ports: [3000] }
  };
}

// ❌ Bad - Specify how to provision
getDockerConfig() {
  return {
    memory: '1024m',
    cpus: '1.0',
    ports: ['3000:3000']
  };
}
```

### 3. Only Declare Capabilities You Support

Capability annotations drive command routing — declaring `supports-backup` on a service with no backup handlers produces runtime errors, not graceful degradation.

## Checklist

- [ ] Service class extends `BaseService` (no custom constructor)
- [ ] `getRequirements()` returns appropriate requirements
- [ ] `service/type` annotation declared
- [ ] Command capability annotations declared for non-default commands
- [ ] Registered in `ServiceFactory.create()` and `SUPPORTED_SERVICES`
- [ ] Platform handlers added and registered for each supported platform
- [ ] TOML configuration documented for the service
- [ ] Tests cover requirements and annotations
- [ ] `npx tsc --noEmit` passes clean

## Examples

Look at existing services for examples:
- `backend-service.ts` - API server with health checks
- `frontend-service.ts` - Static web service
- `database-service.ts` - Stateful service with backups
- `graph-service.ts` - Graph databases (JanusGraph, Neptune, Neo4j)
- `mcp-service.ts` - Model Context Protocol server
- `inference-service.ts` - AI/ML model serving
- `embedding-service.ts` - Embedding providers
- `vectors-service.ts` - Vector databases
