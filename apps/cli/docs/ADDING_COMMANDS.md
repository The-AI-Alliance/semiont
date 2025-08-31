# Adding New Commands to Semiont CLI

This guide walks you through adding a new command to the Semiont CLI using the new service-based architecture.

## Overview

Semiont CLI commands follow a consistent pattern using:
- **CommandBuilder** for type-safe command definitions
- **Service-based architecture** for business logic
- **Platform strategies** for deployment-specific behavior
- **Zod schemas** for runtime validation
- **Structured results** for consistent output

## Architecture Quick Reference

```
Command → ServiceDeployments → Service → Platform Strategy
                                ↓              ↓
                            Business Logic  Infrastructure
```

## Step-by-Step Guide

### 1. Create the Command File

Create a new file in `src/core/commands/` named after your command:

```bash
touch src/core/commands/my-command.ts
```

### 2. Define the Result Types

Start by defining your command's result structure:

```typescript
/**
 * My Command - Service-based implementation
 */

import { z } from 'zod';
import { printError, printSuccess, printInfo } from '../lib/cli-logger.js';
import { type ServicePlatformInfo } from '../platforms/platform-resolver.js';
import { CommandResults } from '../commands/command-results.js';
import { CommandBuilder } from '../commands/command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../commands/base-options-schema.js';

// Import service architecture
import { ServiceFactory } from '../services/service-factory.js';
import { ServiceName } from '../services/service-interface.js';
import { Config } from '../lib/cli-config.js';
import { parseEnvironment } from '../lib/environment-validator.js';
import type { Platform } from '../platforms/platform-resolver.js';
import type { PlatformResources } from '../platforms/platform-resources.js';

// Define your result type
export interface MyCommandResult {
  entity: string;
  platform: Platform;
  success: boolean;
  status: 'completed' | 'failed' | 'skipped';
  message?: string;
  resources?: PlatformResources;
  metadata?: Record<string, any>;
}
```

### 3. Define the Command Schema

Create your command's options schema:

```typescript
// Command options schema
const MyCommandOptionsSchema = BaseOptionsSchema.extend({
  force: z.boolean().default(false).describe('Force the operation'),
  timeout: z.number().default(30).describe('Operation timeout in seconds'),
  skipValidation: z.boolean().default(false).describe('Skip validation checks'),
});

export type MyCommandOptions = z.infer<typeof MyCommandOptionsSchema>;
```

### 4. Implement the Command Handler

Implement the command logic using services and platforms:

```typescript
/**
 * Execute my-command for the given services
 */
export async function myCommand(
  serviceDeployments: ServicePlatformInfo[],
  options: MyCommandOptions
): Promise<CommandResults<MyCommandResult>> {
  const { environment, verbose, quiet, dryRun, force } = options;
  
  const config: Config = {
    projectRoot: process.env.SEMIONT_ROOT || process.cwd(),
    environment: parseEnvironment(environment),
    verbose: verbose ?? false,
    quiet: quiet ?? false,
    dryRun,
  };
  
  const results: MyCommandResult[] = [];
  
  // Process each service
  for (const deployment of serviceDeployments) {
    const { name, platform, config: serviceConfig } = deployment;
    
    if (!quiet) {
      printInfo(`Processing ${name} on ${platform}...`);
    }
    
    try {
      // Create service instance with platform strategy
      const service = ServiceFactory.create(
        name as ServiceName,
        platform as Platform,
        config,
        serviceConfig
      );
      
      // Get the platform strategy
      const platformStrategy = service.getPlatformStrategy();
      
      // Execute platform-specific logic
      // Most commands will delegate to a platform method
      const result = await platformStrategy.myOperation(service);
      
      results.push({
        entity: name,
        platform,
        success: result.success,
        status: result.success ? 'completed' : 'failed',
        message: result.message,
        resources: result.resources,
        metadata: {
          ...result.metadata,
          force,
          timeout: options.timeout,
        }
      });
      
      if (!quiet && result.success) {
        printSuccess(`${name}: ${result.message || 'Operation completed'}`);
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      results.push({
        entity: name,
        platform,
        success: false,
        status: 'failed',
        message: errorMessage,
      });
      
      if (!quiet) {
        printError(`${name}: ${errorMessage}`);
      }
      
      // Stop on first error unless --force
      if (!force) {
        break;
      }
    }
  }
  
  // Return structured results
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  return {
    command: 'my-command',
    executionContext: {
      environment: parseEnvironment(environment),
      timestamp: new Date(),
      dryRun: dryRun ?? false,
    },
    results,
    summary: {
      total: results.length,
      succeeded,
      failed,
      skipped: 0,
    },
  };
}
```

### 5. Export the Command Definition

Use CommandBuilder to define your command:

```typescript
// Command definition
export const myCommandDefinition = new CommandBuilder()
  .name('my-command')
  .description('Brief description of what your command does')
  .schema(MyCommandOptionsSchema)
  .requiresServices(true)  // or false if services are optional
  .args(withBaseArgs({
    // Add command-specific arguments
    'force': {
      type: 'boolean',
      description: 'Force operation even on failures',
      default: false,
    },
    'timeout': {
      type: 'number', 
      description: 'Operation timeout in seconds',
      default: 30,
    },
  }))
  .handler(myCommand)
  .build();
```

### 6. Add Platform Strategy Methods (if needed)

If your command requires new platform behavior, add methods to the platform strategies:

```typescript
// In src/platforms/platform-strategy.ts
export interface PlatformStrategy {
  // ... existing methods ...
  
  /**
   * My new operation
   */
  myOperation?(context: ServiceContext): Promise<MyOperationResult>;
}

// In src/platforms/process-platform.ts
export class ProcessPlatformStrategy extends BasePlatformStrategy {
  async myOperation(context: ServiceContext): Promise<MyOperationResult> {
    // Process-specific implementation
    const { name, config } = context;
    
    // Perform operation
    // ...
    
    return {
      success: true,
      message: 'Operation completed',
      resources: this.createResources(/* ... */),
    };
  }
}

// Similarly for container-platform.ts, aws-platform.ts, etc.
```

### 7. Register the Command

You need to register your command in the command discovery module:

1. **Add to command discovery** (`src/core/command-discovery.ts`):
```typescript
const COMMAND_MODULES: Record<string, string> = {
  // ... existing commands ...
  'my-command': './commands/my-command.js',
};
```

2. **Export your command definition correctly**:
```typescript
// In your command file, export as:
export const myCommandCommand = myCommandDefinition;  // camelCase + 'Command'
// OR
export default myCommandDefinition;  // Default export
```

The command discovery module will look for:
- `${camelCaseName}Command` (e.g., `myCommandCommand`)
- `default` export
- Named export matching the command name

### 8. Add Tests

Create a test file at `src/commands/__tests__/my-command.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { myCommand } from '../my-command.js';
import type { ServicePlatformInfo } from '../../platforms/platform-resolver.js';

describe('my-command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  function createServiceDeployments(
    services: Array<{name: string, platform: string, config?: any}>
  ): ServicePlatformInfo[] {
    return services.map(service => ({
      name: service.name,
      platform: service.platform as Platform,
      config: service.config || {}
    }));
  }
  
  it('should return structured results', async () => {
    const deployments = createServiceDeployments([
      { name: 'backend', platform: 'process' },
      { name: 'frontend', platform: 'container' },
    ]);
    
    const options = {
      environment: 'test',
      force: false,
      timeout: 30,
    };
    
    const result = await myCommand(deployments, options);
    
    expect(result).toMatchObject({
      command: 'my-command',
      executionContext: {
        environment: 'test',
        dryRun: false,
      },
      summary: {
        total: 2,
      },
    });
  });
  
  it('should handle dry-run mode', async () => {
    const deployments = createServiceDeployments([
      { name: 'backend', platform: 'process' },
    ]);
    
    const options = {
      environment: 'test',
      dryRun: true,
    };
    
    const result = await myCommand(deployments, options);
    
    expect(result.executionContext.dryRun).toBe(true);
    // Verify no actual operations were performed
  });
  
  it('should stop on error unless force is true', async () => {
    // Test error handling behavior
  });
});
```

## Best Practices

### 1. Use Services for Business Logic

Services encapsulate business logic independent of deployment platform:

```typescript
// ✅ Good - Service handles business logic
const service = ServiceFactory.create(name, platform, config, serviceConfig);
const result = await service.performOperation();

// ❌ Bad - Command directly implements business logic
if (platform === 'aws') {
  // AWS-specific code in command
} else if (platform === 'container') {
  // Container-specific code in command
}
```

### 2. Use Platform Strategies for Infrastructure

Platform strategies handle infrastructure-specific operations:

```typescript
// ✅ Good - Platform strategy handles infrastructure
const strategy = service.getPlatformStrategy();
const result = await strategy.start(service);

// ❌ Bad - Service contains platform-specific code
class MyService {
  async start() {
    if (this.platform === 'aws') {
      // AWS code in service
    }
  }
}
```

### 3. Return Structured Results

Always return CommandResults for consistency:

```typescript
// ✅ Good - Structured results
return {
  command: 'my-command',
  executionContext: { /* ... */ },
  results: results,
  summary: {
    total: results.length,
    succeeded: successCount,
    failed: failureCount,
    skipped: skippedCount,
  },
};

// ❌ Bad - Unstructured output
console.log('Command completed');
return;
```

### 4. Handle All Platforms

Ensure your command works with all platform types:

```typescript
// Each platform strategy should implement your operation
// Or explicitly state it's not supported:

async myOperation(context: ServiceContext): Promise<MyOperationResult> {
  return {
    success: false,
    message: 'Operation not supported on external platform',
  };
}
```

### 5. Use Type-Safe Patterns

Leverage TypeScript and Zod for type safety:

```typescript
// Define clear interfaces
export interface MyCommandResult {
  entity: string;
  platform: Platform;
  success: boolean;
  // ...
}

// Use Zod for runtime validation
const schema = z.object({
  timeout: z.number().min(1).max(300),
});

// Derive types from schemas
type Options = z.infer<typeof schema>;
```

## Common Patterns

### Working with Service Requirements

```typescript
// Services declare their requirements
class MyService extends BaseService {
  getRequirements(): ServiceRequirements {
    return {
      compute: { memory: 512, cpu: 0.5 },
      network: { ports: [{ port: 3000, protocol: 'tcp' }] },
      storage: { ephemeral: 1024 },
    };
  }
}
```

### Platform Resource Management

```typescript
// Platforms create typed resources
const resources = createPlatformResources('process', {
  pid: process.pid,
  port: 3000,
});

// Store in results for state management
return {
  resources,
  // ...
};
```

### State Management Integration

```typescript
// Save state after successful operations
await StateManager.save(
  config.projectRoot,
  config.environment,
  name,
  {
    entity: name,
    platform,
    environment: config.environment,
    startTime: new Date(),
    resources,
  }
);

// Load state for status checks
const state = await StateManager.load(
  config.projectRoot,
  config.environment,
  name
);
```

## Testing Checklist

- [ ] Command returns proper CommandResults structure
- [ ] All platforms are handled (process, container, aws, external, mock)
- [ ] Dry-run mode prevents actual operations
- [ ] Force mode allows continuation on errors
- [ ] Quiet mode suppresses output
- [ ] Verbose mode shows additional details
- [ ] Environment validation works correctly
- [ ] Service selection (all vs specific) works
- [ ] Error messages are informative
- [ ] State is properly managed

## Getting Help

1. Review existing commands in `src/commands/` for examples
2. Check service implementations in `src/services/`
3. Review platform strategies in `src/platforms/`
4. Look at shared utilities in `src/lib/`
5. Run tests to verify behavior: `npm test`

Remember: Commands orchestrate, Services contain business logic, Platforms handle infrastructure.