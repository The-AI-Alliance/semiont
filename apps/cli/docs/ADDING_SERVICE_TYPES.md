# Adding New Service Types to Semiont CLI

This guide explains how to add new service types to the Semiont CLI's type system.

## Overview

Service types are high-level categorizations that services declare about themselves. They represent what a service is (its purpose and behavior), not where it runs (the platform). This distinction is crucial for the architecture.

### Current Service Types

- **frontend** - User-facing web applications
- **backend** - API servers and application logic  
- **database** - Data persistence layers
- **filesystem** - File storage and management services
- **worker** - Background job processors
- **mcp** - Model Context Protocol services
- **inference** - AI/ML model serving
- **generic** - General-purpose services (fallback)

## Architecture

```
Service declares type → Platform maps to implementation → Handler executes
        ↓                        ↓                            ↓
   "I am a backend"    "backend maps to ECS on AWS"    ECS handler runs
```

## When to Add a New Service Type

Add a new service type when:
1. You have services with fundamentally different behavior patterns
2. Multiple platforms need to handle this service category differently
3. The service has unique infrastructure requirements
4. Existing types don't accurately represent the service's purpose

Examples of good candidates:
- **cache** - In-memory data stores (Redis, Memcached)
- **queue** - Message queuing services (RabbitMQ, SQS)
- **gateway** - API gateways and proxies
- **analytics** - Data processing and analytics engines
- **streaming** - Real-time data streaming services

## Step-by-Step Guide

### 1. Add to Service Types Definition

Update `src/core/service-types.ts`:

```typescript
export const SERVICE_TYPES = {
  FRONTEND: 'frontend',
  BACKEND: 'backend',
  DATABASE: 'database',
  FILESYSTEM: 'filesystem',
  WORKER: 'worker',
  MCP: 'mcp',
  INFERENCE: 'inference',
  CACHE: 'cache',        // Add your new type
  GENERIC: 'generic',
} as const;

export type ServiceType = typeof SERVICE_TYPES[keyof typeof SERVICE_TYPES];
```

### 2. Document the Service Type

Add documentation explaining when to use this type:

```typescript
/**
 * Service Type Definitions
 * 
 * - frontend: User-facing web applications
 * - backend: API servers and application logic
 * - database: Data persistence layers
 * - cache: In-memory data stores for fast access (NEW)
 * - ...
 */
```

### 3. Create Service Implementation

Create a service class that declares this type in `src/services/cache-service.ts`:

```typescript
import { BaseService } from '../core/base-service.js';
import { ServiceRequirements } from '../core/service-requirements.js';
import { SERVICE_TYPES, SERVICE_TYPE_ANNOTATION } from '../core/service-types.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';

export class CacheService extends BaseService {
  
  getRequirements(): ServiceRequirements {
    const baseRequirements = super.getRequirements();
    
    return {
      ...baseRequirements,
      
      // REQUIRED: Declare the service type
      annotations: {
        [SERVICE_TYPE_ANNOTATION]: SERVICE_TYPES.CACHE,
        
        // Declare supported commands
        [COMMAND_CAPABILITY_ANNOTATIONS.START]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.STOP]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.CHECK]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.FLUSH]: 'true',  // Cache-specific
      },
      
      // Cache-specific requirements
      resources: {
        memory: '4Gi',  // Caches need memory
        cpu: '500m',
      },
      
      network: {
        ports: [6379],  // Redis default
        protocol: 'tcp',
      },
      
      // Cache-specific configuration
      cache: {
        type: 'redis',
        maxMemory: '3Gi',
        evictionPolicy: 'lru',
        persistence: false,
      }
    };
  }
}
```

### 4. Create Platform Handlers

Each platform needs handlers for the new service type. Create handlers in each platform's handler directory:

#### POSIX Platform Handler
`src/platforms/posix/handlers/cache-start.ts`:

```typescript
import { HandlerDescriptor } from '../../../core/handlers/types.js';
import { StartHandlerContext, StartHandlerResult } from './types.js';

const startCacheService = async (context: StartHandlerContext): Promise<StartHandlerResult> => {
  const { service, savedState } = context;
  const requirements = service.getRequirements();
  
  // Start Redis/Memcached as a local process
  const port = requirements.network?.ports?.[0] || 6379;
  
  // Check if already running
  if (savedState?.resources?.pid) {
    const isRunning = await checkProcess(savedState.resources.pid);
    if (isRunning) {
      return {
        success: false,
        error: 'Cache service already running',
      };
    }
  }
  
  // Start the cache process
  const command = getCacheCommand(requirements.cache?.type);
  const process = spawn(command, ['--port', String(port)]);
  
  return {
    success: true,
    resources: {
      platform: 'posix',
      data: {
        pid: process.pid,
        port,
      }
    },
    endpoint: `redis://localhost:${port}`,
  };
};

export const cacheStartDescriptor: HandlerDescriptor = {
  command: 'start',
  platform: 'posix',
  serviceType: 'cache',
  handler: startCacheService,
};
```

#### Container Platform Handler
`src/platforms/container/handlers/cache-start.ts`:

```typescript
const startCacheContainer = async (context: ContainerStartHandlerContext): Promise<StartHandlerResult> => {
  const { service, runtime, containerName } = context;
  const requirements = service.getRequirements();
  
  // Determine cache image
  const cacheType = requirements.cache?.type || 'redis';
  const image = cacheType === 'redis' ? 'redis:7-alpine' : 'memcached:1.6-alpine';
  
  // Container configuration
  const config = {
    Image: image,
    name: containerName,
    HostConfig: {
      Memory: parseMemory(requirements.cache?.maxMemory || '1Gi'),
      PortBindings: {
        '6379/tcp': [{ HostPort: String(requirements.network?.ports?.[0] || 6379) }]
      },
    },
    Env: [
      `MAXMEMORY=${requirements.cache?.maxMemory || '1Gi'}`,
      `EVICTION_POLICY=${requirements.cache?.evictionPolicy || 'lru'}`,
    ],
  };
  
  // Create and start container
  const containerId = await createContainer(runtime, config);
  await startContainer(runtime, containerId);
  
  return {
    success: true,
    resources: {
      platform: 'container',
      data: {
        containerId,
        containerName,
        image,
      }
    },
  };
};
```

#### AWS Platform Handler
`src/platforms/aws/handlers/elasticache-start.ts`:

```typescript
const provisionElastiCache = async (context: AWSStartHandlerContext): Promise<StartHandlerResult> => {
  const { service, stackName } = context;
  const requirements = service.getRequirements();
  
  // Map to AWS ElastiCache
  const cacheType = requirements.cache?.type === 'memcached' ? 'memcached' : 'redis';
  
  const template = {
    Resources: {
      CacheCluster: {
        Type: 'AWS::ElastiCache::CacheCluster',
        Properties: {
          CacheNodeType: 'cache.t3.micro',
          Engine: cacheType,
          NumCacheNodes: 1,
          Port: requirements.network?.ports?.[0] || 6379,
          // Additional ElastiCache configuration
        }
      }
    }
  };
  
  // Deploy via CloudFormation
  await deployStack(stackName, template);
  
  // Get endpoint
  const endpoint = await getElastiCacheEndpoint(stackName);
  
  return {
    success: true,
    resources: {
      platform: 'aws',
      data: {
        clusterId: `${stackName}-cache`,
        endpoint,
        engine: cacheType,
      }
    },
    endpoint,
  };
};

export const elasticacheStartDescriptor: HandlerDescriptor = {
  command: 'start',
  platform: 'aws',
  serviceType: 'cache',
  handler: provisionElastiCache,
  requiresDiscovery: true,
};
```

### 5. Platform Type Mapping (Optional)

If platforms need to map the service type to specific implementations, override `mapServiceType` in the platform class:

```typescript
// In src/platforms/aws/platform.ts
export class AWSPlatform extends Platform {
  
  protected override mapServiceType(declaredType: string): string {
    switch (declaredType) {
      case 'cache':
        // AWS uses ElastiCache for cache services
        return 'elasticache';
      case 'queue':
        // AWS uses SQS for queue services
        return 'sqs';
      default:
        return declaredType;
    }
  }
}
```

### 6. Register Handlers

Add handlers to the platform's handler index:

```typescript
// src/platforms/posix/handlers/index.ts
export const handlers = [
  // ... existing handlers
  cacheStartDescriptor,
  cacheCheckDescriptor,
  cacheStopDescriptor,
  cacheFlushDescriptor,  // Cache-specific command
];
```

### 7. Add Cache-Specific Commands (Optional)

For service-type-specific commands, create new command implementations:

```typescript
// src/core/commands/flush.ts
import { CommandDescriptor } from '../command-descriptor.js';
import { MultiServiceExecutor } from '../multi-service-executor.js';

const flushDescriptor: CommandDescriptor<FlushOptions> = {
  name: 'flush',
  
  buildResult: (handlerResult, service, platform) => ({
    entity: service.name,
    platform: platform.getPlatformName(),
    success: handlerResult.success,
    extensions: {
      flush: {
        itemsFlushed: handlerResult.itemsFlushed,
        timestamp: new Date(),
      }
    }
  }),
};

export async function flushCommand(options: FlushOptions) {
  const executor = new MultiServiceExecutor(flushDescriptor);
  return executor.execute(options);
}
```

### 8. Update Service Factory

Add logic to create cache services in `src/services/service-factory.ts`:

```typescript
export class ServiceFactory {
  static create(name: ServiceName, platform: PlatformType, config: Config, serviceConfig: ServiceConfig): Service {
    // Check if service declares itself as cache
    const requirements = this.getServiceRequirements(name, serviceConfig);
    const serviceType = requirements.annotations?.[SERVICE_TYPE_ANNOTATION];
    
    if (serviceType === SERVICE_TYPES.CACHE) {
      return new CacheService(name, platform, config, serviceConfig);
    }
    
    // ... other service type checks
  }
}
```

### 9. Add Tests

Create tests for the new service type:

```typescript
// src/core/__tests__/cache-service-type.test.ts
import { describe, it, expect } from 'vitest';
import { CacheService } from '../../services/cache-service.js';
import { SERVICE_TYPES } from '../service-types.js';

describe('Cache Service Type', () => {
  it('should declare cache type', () => {
    const service = new CacheService('cache', 'posix', mockConfig, mockServiceConfig);
    const requirements = service.getRequirements();
    
    expect(requirements.annotations?.['service/type']).toBe(SERVICE_TYPES.CACHE);
  });
  
  it('should include cache-specific requirements', () => {
    const service = new CacheService('cache', 'posix', mockConfig, mockServiceConfig);
    const requirements = service.getRequirements();
    
    expect(requirements.cache).toBeDefined();
    expect(requirements.cache?.type).toBe('redis');
  });
});
```

## Best Practices

### 1. Keep Types High-Level
Service types should represent broad categories of functionality, not specific implementations:
- ✅ Good: `cache` (covers Redis, Memcached, etc.)
- ❌ Bad: `redis` (too specific)

### 2. Platform Agnostic
Service types should make sense across all platforms:
- ✅ Good: `worker` (can run anywhere)
- ❌ Bad: `lambda` (AWS-specific)

### 3. Clear Semantics
Each type should have clear, distinct behavior patterns:
- ✅ Good: `database` vs `cache` (different persistence models)
- ❌ Bad: `api` vs `backend` (overlapping concepts)

### 4. Handler Coverage
Ensure all platforms have handlers for the new type, even if some return "not supported":

```typescript
// Platform doesn't support this type
export const cacheStartDescriptor: HandlerDescriptor = {
  command: 'start',
  platform: 'external',
  serviceType: 'cache',
  handler: async () => ({
    success: false,
    error: 'Cache services not supported on external platform',
  }),
};
```

### 5. Documentation
Always document:
- When to use the new service type
- What makes it different from existing types
- Platform-specific implementation notes
- Example service configurations

## Common Patterns

### Pattern 1: Specialized Storage
For services that store data with specific access patterns:
- **cache** - Volatile, fast access
- **database** - Persistent, structured
- **objectstore** - Blob storage
- **timeseries** - Time-series data

### Pattern 2: Processing Types
For services that process data:
- **worker** - Async job processing
- **streaming** - Real-time data processing
- **batch** - Batch data processing
- **etl** - Extract, transform, load

### Pattern 3: Infrastructure Services
For supporting infrastructure:
- **gateway** - API gateways
- **proxy** - Reverse proxies
- **loadbalancer** - Load balancers
- **servicebus** - Message buses

## Troubleshooting

### Service Type Not Recognized
If your service type isn't being recognized:

1. Check the service declares it correctly:
```typescript
annotations: {
  [SERVICE_TYPE_ANNOTATION]: SERVICE_TYPES.CACHE,
}
```

2. Verify handlers are registered:
```typescript
const registry = HandlerRegistry.getInstance();
registry.registerHandlers('posix', handlers);
```

3. Check platform's mapServiceType if using mapping:
```typescript
protected override mapServiceType(declaredType: string): string {
  console.log('Mapping type:', declaredType);
  // ... mapping logic
}
```

### Handler Not Found
If handlers aren't being found:

1. Verify handler descriptor has all required fields:
```typescript
{
  command: 'start',      // Required
  platform: 'posix',     // Required
  serviceType: 'cache',  // Required
  handler: async () => {},  // Required
}
```

2. Check handler is exported and included in index:
```typescript
export const handlers = [
  cacheStartDescriptor,  // Make sure it's here
];
```

## Summary

Adding a new service type involves:
1. Defining the type constant
2. Creating service implementations that declare the type
3. Creating handlers for each platform
4. Optionally mapping types in platforms
5. Testing the implementation

Service types are a powerful abstraction that allows services to declare what they are, while platforms determine how to run them. This separation enables the same service to run differently on different platforms while maintaining consistent behavior from the service's perspective.