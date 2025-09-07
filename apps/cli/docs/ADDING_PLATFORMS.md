# Adding New Platforms to Semiont CLI

This guide walks you through adding a new platform to the Semiont CLI using the handler-based architecture.

## Overview

Platforms in Semiont represent different infrastructure targets where services can be deployed:
- **posix** - Local processes on POSIX-compliant systems (Linux, macOS)
- **container** - Docker/Podman containers
- **aws** - AWS cloud services (ECS, Lambda, RDS, etc.)
- **external** - Externally managed services
- **mock** - Mock platform for testing

Each platform uses handlers to implement command-specific logic for different service types.

## Architecture

```
MultiServiceExecutor → Platform/ServiceType → Handler → Result
                              ↓                   ↓
                     Handler Resolution    Command Logic
```

## Step-by-Step Guide

### 1. Create Platform Directory Structure

Create a new directory for your platform with handlers:

```bash
mkdir -p src/platforms/my-platform/handlers
touch src/platforms/my-platform/index.ts
touch src/platforms/my-platform/platform.ts
```

### 2. Create Platform Class

Create your platform class extending the abstract Platform class in `src/platforms/my-platform/platform.ts`:

```typescript
import { Platform, LogOptions, LogEntry } from '../../core/platform.js';
import { Service } from '../../services/types.js';
import { HandlerRegistry } from '../../core/handlers/registry.js';
import { handlers } from './handlers/index.js';

export class MyPlatform extends Platform {
  constructor() {
    super();
    this.registerHandlers();
  }
  
  private registerHandlers(): void {
    const registry = HandlerRegistry.getInstance();
    registry.registerHandlers('my-platform', handlers);
  }
  
  getPlatformName(): string {
    return 'my-platform';
  }
  
  // Map service types to platform-specific implementations if needed
  protected override mapServiceType(declaredType: string): string {
    // Example: map frontend to a specific handler type
    if (declaredType === 'frontend') {
      return 'static-site';  // Platform-specific type
    }
    return declaredType;  // Use as-is for others
  }
  
  async buildHandlerContextExtensions(service: Service, requiresDiscovery: boolean): Promise<Record<string, any>> {
    // Return platform-specific context that handlers need
    return {
      platformConfig: this.loadPlatformConfig(),
      resourcePrefix: `my-platform-${service.name}`
    };
  }
  
  async collectLogs(service: Service, options?: LogOptions): Promise<LogEntry[] | undefined> {
    // Implement log collection for your platform
    // Return undefined if logs aren't available
    return undefined;
  }
  
  async validateCredentials(environment: string): Promise<CredentialValidationResult> {
    // Validate platform-specific credentials
    return { valid: true };
  }
}
```

### 3. Define Handler Types

Create handler type definitions in `src/platforms/my-platform/handlers/types.ts`:

```typescript
import type { MyPlatform } from '../platform.js';
import type { Service } from '../../../services/types.js';
import type { PlatformResources } from '../../platform-resources.js';

// Base context for all handlers
export interface BaseHandlerContext {
  service: Service;
  options?: Record<string, any>;
}

// Command-specific contexts
export interface StartHandlerContext extends BaseHandlerContext {
  restart?: boolean;
  force?: boolean;
}

export interface CheckHandlerContext extends BaseHandlerContext {
  includeMetrics?: boolean;
}

// Command-specific results
export interface StartHandlerResult {
  success: boolean;
  error?: string;
  resources?: PlatformResources;
  endpoint?: string;
  metadata?: Record<string, any>;
}

export interface CheckHandlerResult {
  success: boolean;
  error?: string;
  status?: 'running' | 'stopped' | 'error' | 'not-found';
  healthy?: boolean;
  checks?: Array<{ name: string; status: string; }>;
  logs?: Array<{ timestamp: Date; message: string; level?: string; }>;
  metadata?: Record<string, any>;
}
```

### 3. Create Handlers for Each Service Type

Create handlers for each service type your platform supports:

```typescript
// src/platforms/my-platform/handlers/web-start.ts
import { HandlerDescriptor } from '../../../core/handlers/types.js';
import { StartHandlerContext, StartHandlerResult } from './types.js';
import { PlatformResources } from '../../platform-resources.js';

/**
 * Start handler for web services on my-platform
 */
const startWebService = async (context: StartHandlerContext): Promise<StartHandlerResult> => {
  const { service, options } = context;
  const requirements = service.getRequirements();
  
  try {
    // Check port availability
    const port = requirements.network?.ports?.[0];
    if (port && await isPortInUse(port)) {
      return {
        success: false,
        error: `Port ${port} is already in use`,
      };
    }
    
    // Platform-specific start logic
    const serviceId = await startServiceOnMyPlatform({
      name: service.name,
      command: service.getCommand(),
      environment: service.getEnvironmentVariables(),
      port,
      memory: requirements.compute?.memory,
      cpu: requirements.compute?.cpu,
    });
    
    // Create platform resources
    const resources: PlatformResources = {
      platform: 'my-platform',
      data: {
        serviceId,
        port,
        // Add platform-specific resource data
      }
    };
    
    // Build endpoint URL
    const endpoint = port ? `http://localhost:${port}` : undefined;
    
    return {
      success: true,
      resources,
      endpoint,
      metadata: {
        serviceType: 'web',
        serviceId,
        port,
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to start web service: ${error}`,
    };
  }
};

/**
 * Descriptor for web service start handler
 */
export const webStartDescriptor: HandlerDescriptor<StartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'my-platform',
  serviceType: 'web',
  handler: startWebService
};
```

### 4. Create Handlers for All Commands

Create handlers for each command your platform supports:

```typescript
// src/platforms/my-platform/handlers/web-check.ts
export const webCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'my-platform',
  serviceType: 'web',
  handler: async (context) => {
    // Health check logic
  }
};

// src/platforms/my-platform/handlers/web-update.ts
export const webUpdateDescriptor: HandlerDescriptor<UpdateHandlerContext, UpdateHandlerResult> = {
  command: 'update',
  platform: 'my-platform',
  serviceType: 'web',
  handler: async (context) => {
    // Update logic - deploys previously published artifacts
    // Should check for newer versions and deploy them
  }
};

// src/platforms/my-platform/handlers/web-publish.ts
export const webPublishDescriptor: HandlerDescriptor<PublishHandlerContext, PublishHandlerResult> = {
  command: 'publish',
  platform: 'my-platform',
  serviceType: 'web',
  handler: async (context) => {
    // Publish logic - builds and pushes artifacts
    // Does NOT deploy to running services
    // Creates new versions/revisions for update command to deploy
  }
};

// Continue for other commands: provision, etc.
```

### 4. Register All Handlers

Create an index file to export all handlers:

```typescript
// src/platforms/my-platform/handlers/index.ts

// Web service handlers
export * from './web-start.js';
export * from './web-check.js';
export * from './web-update.js';

// Database service handlers
export * from './database-start.js';
export * from './database-check.js';

// Worker service handlers
export * from './worker-start.js';
export * from './worker-check.js';

// Add more as needed
```

### 5. Export Handlers Collection

Create a collection of all handlers for registration:

```typescript
// src/platforms/my-platform/handlers/index.ts
import { webStartDescriptor } from './web-start.js';
import { webCheckDescriptor } from './web-check.js';
import { databaseStartDescriptor } from './database-start.js';
// ... other imports

export const handlers = [
  webStartDescriptor,
  webCheckDescriptor,
  databaseStartDescriptor,
  // ... all other handlers
];
```

### 6. Update Platform Resources Type

Add your platform's resource type to `src/platforms/platform-resources.ts`:

```typescript
// Add your platform's resource type
export interface MyPlatformResources {
  platform: 'my-platform';
  data: {
    serviceId: string;
    endpoint?: string;
    port?: number;
    // Add platform-specific fields
  };
}

// Update the union type
export type PlatformResources = 
  | PosixResources
  | ContainerResources
  | AWSResources
  | MyPlatformResources;
```

### 7. Update Platform Type

Add your platform to the PlatformType in `src/core/platform-resolver.ts`:

```typescript
export type PlatformType = 'aws' | 'container' | 'posix' | 'external' | 'mock' | 'my-platform';
```

### 8. Register Platform in Factory

Add your platform to the PlatformFactory in `src/platforms/index.ts`:

```typescript
import { MyPlatform } from './my-platform/platform.js';

export class PlatformFactory {
  private static createPlatform(type: PlatformType): Platform {
    switch (type) {
      case 'my-platform':
        return new MyPlatform();
      // ... other cases
    }
  }
}
```

### 9. Add Tests

Create tests for your handlers:

```typescript
// src/platforms/my-platform/handlers/__tests__/web-start.test.ts
import { describe, it, expect, vi } from 'vitest';
import { webStartDescriptor } from '../web-start.js';

describe('my-platform web-start handler', () => {
  it('should start a web service', async () => {
    const context = {
      service: {
        name: 'test-web',
        getRequirements: () => ({
          network: { ports: [3000] },
          compute: { memory: 512, cpu: 1 }
        }),
        getCommand: () => 'npm start',
        getEnvironmentVariables: () => ({ NODE_ENV: 'production' })
      },
      options: {}
    };
    
    const result = await webStartDescriptor.handler(context);
    
    expect(result.success).toBe(true);
    expect(result.resources).toBeDefined();
    expect(result.endpoint).toBe('http://localhost:3000');
  });
  
  it('should handle port conflicts', async () => {
    // Mock port in use
    vi.mock('../../../core/io/network-utils.js', () => ({
      isPortInUse: vi.fn().mockResolvedValue(true)
    }));
    
    const context = {
      service: {
        name: 'test-web',
        getRequirements: () => ({
          network: { ports: [3000] }
        }),
        // ...
      },
      options: {}
    };
    
    const result = await webStartDescriptor.handler(context);
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('Port 3000 is already in use');
  });
});
```

## Handler Pattern Best Practices

### 1. Self-Contained Handlers

Each handler should be self-contained with its own logic:

```typescript
// ✅ Good - Self-contained handler
const handler = async (context) => {
  // All logic for this command/serviceType combination
  const logs = await collectLogs(context.service);
  const health = await checkHealth(context.service);
  
  return {
    success: true,
    healthy: health.isHealthy,
    logs,
  };
};

// ❌ Bad - Handler depends on external state
const handler = async (context) => {
  // Don't reference global state or platform instance
  return this.platformInstance.doSomething();
};
```

### 2. Proper Handler Registration

Handlers self-register when their descriptors are exported:

```typescript
// ✅ Good - Handler with descriptor
export const myHandlerDescriptor: HandlerDescriptor = {
  command: 'start',
  platform: 'my-platform',
  serviceType: 'web',
  handler: myHandler
};

// ❌ Bad - Handler without registration
const myHandler = async (context) => {
  // Handler won't be discovered
};
```

### 3. ServiceType Specificity

Create specific handlers for each service type:

```typescript
// ✅ Good - Specific handlers
export const webStartDescriptor = {
  serviceType: 'web',
  handler: webStartHandler
};

export const databaseStartDescriptor = {
  serviceType: 'database',
  handler: databaseStartHandler
};

// ❌ Bad - Generic handler for all types
export const genericStartDescriptor = {
  serviceType: '*',  // Avoid wildcards
  handler: genericHandler
};
```

### 4. Options Pass-through

Handlers receive options from commands via context:

```typescript
const handler = async (context) => {
  const { service, options } = context;
  
  // Options come from CommandDescriptor.extractHandlerOptions
  if (options.force) {
    // Force mode behavior
  }
  
  if (options.timeout) {
    // Apply timeout
  }
};
```

### 5. Error Handling

Return structured errors in handler results:

```typescript
const handler = async (context) => {
  try {
    // Operation
    return {
      success: true,
      // ...
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      metadata: {
        errorType: error.constructor.name,
        // Additional error context
      }
    };
  }
};
```

## Platform Capabilities Matrix

Document which commands and service types your platform supports:

| Command | Web | Database | Worker | Filesystem | MCP |
|---------|-----|----------|--------|------------|-----|
| start   | ✅  | ✅       | ✅     | ✅         | ❌  |
| check   | ✅  | ✅       | ✅     | ✅         | ❌  |
| update  | ✅  | ❌       | ✅     | ❌         | ❌  |
| publish | ✅  | ❌       | ✅     | ❌         | ❌  |
| provision | ❌ | ❌      | ❌     | ❌         | ❌  |

## Integration with UnifiedExecutor

The UnifiedExecutor automatically discovers and uses your handlers:

1. **Handler Discovery**: Based on platform, command, and serviceType
2. **Automatic Resolution**: No manual registration needed
3. **Fallback Handling**: Returns error if no handler found
4. **Result Transformation**: CommandDescriptor transforms handler results

## Testing Strategy

### Unit Tests
Test individual handlers in isolation:
```typescript
// Test handler directly
const result = await webStartDescriptor.handler(mockContext);
expect(result.success).toBe(true);
```

### Integration Tests
Test with UnifiedExecutor:
```typescript
// Test through command execution
const result = await startCommand({
  services: ['web-service'],
  environment: 'test'
});
expect(result.results[0].success).toBe(true);
```

### Platform Tests
Test platform-specific behavior:
```typescript
// Test resource creation, networking, etc.
```

## Platform Best Practices

When creating a new platform:

1. **Service Type Mapping** - Decide if your platform needs to map service types
2. **Handler Granularity** - Create specific handlers for each service type
3. **Context Extensions** - Provide platform-specific context in buildHandlerContextExtensions
4. **Resource Tracking** - Define clear resource types for state management
5. **Credential Validation** - Implement proper credential checking
6. **Log Collection** - Provide log access if your platform supports it

## Checklist

- [ ] Handler types defined
- [ ] Handlers created for all supported commands
- [ ] Handlers created for all service types
- [ ] Platform resources type defined
- [ ] Platform type added to union
- [ ] Handlers exported for registration
- [ ] Tests cover main scenarios
- [ ] Documentation updated
- [ ] Platform capabilities documented

## Examples

Look at existing platforms for examples:
- `posix/handlers/` - POSIX system handlers with process management
- `container/handlers/` - Docker/Podman container handlers
- `aws/handlers/` - AWS cloud service handlers with multiple service types
- `mock/handlers/` - Simple mock handlers for testing

Remember: Handlers are self-contained, platform-specific, and service-type-specific implementations of commands.