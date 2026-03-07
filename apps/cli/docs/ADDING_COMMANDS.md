# Adding New Commands to Semiont CLI

This guide walks you through adding a new command to the Semiont CLI using the new service-based architecture.

## Overview

Semiont CLI commands follow a unified pattern using:
- **Environment** as the primary configuration context
- **MultiServiceExecutor** for consistent command execution
- **CommandDescriptor** for configuring command behavior
- **Handler-based architecture** for platform-specific logic
- **Zod schemas** for runtime validation
- **CommandResult** type for uniform output

## Architecture Quick Reference

```
Command → MultiServiceExecutor → Environment Resolution → Service Discovery
                ↓                    ↓                       ↓
        CommandDescriptor    Load Config from         Platform/ServiceType
                            environments/*.json        Handler Resolution
```

### Core Concepts Working Together

1. **Environment**: Defines which services exist and their configurations
2. **Command**: User-facing operation to execute
3. **Service**: Business entity that the command operates on
4. **Service Type**: Platform-specific categorization (web, database, lambda, etc.)
5. **Platform**: Infrastructure target (posix, container, aws, etc.)

## Step-by-Step Guide

### 1. Create the Command File

Create a new file in `src/core/commands/` named after your command:

```bash
touch src/core/commands/my-command.ts
```

### 2. Define the Command Descriptor

Start by defining your command's descriptor and extensions:

```typescript
/**
 * My Command - Unified implementation
 */

import { z } from 'zod';
import { CommandDescriptor } from '../core/command-descriptor.js';
import { CommandResult } from '../core/command-result.js';
import { MultiServiceExecutor } from '../core/multi-service-executor.js';
import { BaseOptionsSchema } from '../commands/base-options-schema.js';

// Define command-specific extensions
interface MyCommandExtensions {
  myCommand?: {
    operationId?: string;
    duration?: number;
    // Add command-specific fields
  };
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

### 4. Create the Command Descriptor

Define how your command should be executed:

```typescript
const myCommandDescriptor: CommandDescriptor<MyCommandOptions> = {
  name: 'my-command',
  
  // Transform handler results to CommandResult
  buildResult: (handlerResult, service, platform, serviceType) => ({
    entity: service.name,
    platform: platform.type,
    success: handlerResult.success,
    timestamp: new Date(),
    error: handlerResult.error,
    metadata: handlerResult.metadata,
    extensions: {
      myCommand: {
        operationId: handlerResult.operationId,
        duration: handlerResult.duration,
      }
    }
  }),
  
  // Merge options with service configuration
  buildServiceConfig: (options, serviceInfo) => ({
    verbose: options.verbose,
    quiet: options.quiet,
    environment: options.environment,
    ...serviceInfo.config
  }),
  
  // Extract handler-specific options
  extractHandlerOptions: (options) => ({
    force: options.force,
    timeout: options.timeout,
    skipValidation: options.skipValidation
  }),
  
  // Optional: Pre-execution hook for special cases
  preExecute: async (serviceDeployments, options) => {
    // Modify serviceDeployments if needed
    // e.g., add synthetic services
    return serviceDeployments;
  }
};

/**
 * Execute my-command using MultiServiceExecutor
 * 
 * Environment is resolved from:
 * 1. options.environment (if provided)
 * 2. process.env.SEMIONT_ENV (fallback)
 * 3. Error if neither is set
 */
export async function myCommand(options: MyCommandOptions) {
  const executor = new MultiServiceExecutor(myCommandDescriptor);
  return executor.execute(options);
}
```

### 5. Add Platform Handlers

Create handlers for each platform that supports your command:

```typescript
// In src/platforms/posix/handlers/my-command.ts
import { HandlerDescriptor } from '../../core/handlers/types.js';

export interface MyCommandHandlerContext {
  service: Service;
  options: {
    force?: boolean;
    timeout?: number;
    skipValidation?: boolean;
  };
}

export interface MyCommandHandlerResult {
  success: boolean;
  error?: string;
  operationId?: string;
  duration?: number;
  metadata?: Record<string, any>;
}

const myCommandHandler = async (context: MyCommandHandlerContext): Promise<MyCommandHandlerResult> => {
  const { service, options } = context;
  
  // Check implementation type if service supports multiple implementations
  const implementationType = service.config.type;
  
  // IMPORTANT: No fallbacks when checking implementation types
  if (implementationType && implementationType !== 'expected-implementation') {
    return {
      success: false,
      error: `Unsupported implementation: ${implementationType}`
    };
  }
  
  // Platform-specific implementation
  const startTime = Date.now();
  
  try {
    // Perform operation
    // ...
    
    return {
      success: true,
      operationId: generateId(),
      duration: Date.now() - startTime,
      metadata: { /* ... */ }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      duration: Date.now() - startTime
    };
  }
};

// Register the handler (preflight is mandatory)
export const myCommandDescriptor: HandlerDescriptor<MyCommandHandlerContext, MyCommandHandlerResult> = {
  command: 'my-command',
  platform: 'posix',
  serviceType: 'web',  // or 'database', 'worker', etc.
  handler: myCommandHandler,
  preflight: preflightMyCommand,
};
```

### 6. Register Handlers

Handlers must be properly registered in the platform's handler index file:

```typescript
// In src/platforms/posix/handlers/index.ts
import { myCommandDescriptor } from './serviceType-my-command.js';

const posixHandlers = [
  // ... existing handlers
  myCommandDescriptor,  // Add your handler to the array
];

export const handlers = posixHandlers;
```

**Important Lessons Learned:**
1. **Handler File Naming**: Use pattern `{serviceType}-{command}.ts` (e.g., `graph-stop.ts`)
2. **Descriptor Naming**: Use generic names (e.g., `graphStopDescriptor` not `janusgraphStopDescriptor`)
3. **Import and Array**: Handlers must be both imported AND added to the handlers array
4. **No Self-Registration**: Despite old documentation, handlers do NOT self-register

The HandlerRegistry will discover handlers based on:
- Platform (posix, container, aws, etc.)
- Command (my-command)
- ServiceType (web, database, worker, etc.)

### 7. Export the Command for CLI

Export your command for the CLI to discover:

```typescript
// Export for CLI integration
export const myCommandCommand = {
  name: 'my-command',
  description: 'Brief description of what your command does',
  schema: MyCommandOptionsSchema,
  handler: myCommand,
  requiresServices: true,  // or false if services are optional
  requiresEnvironment: true  // Always true for MultiServiceExecutor commands
};

// For backward compatibility
export type MyCommandResult = CommandResult;
```

### 8. Add Tests

Create a test file at `src/commands/__tests__/my-command.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { myCommand } from '../my-command.js';

describe('my-command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock environment
    process.env.SEMIONT_ENV = 'test';
  });
  
  it('should return structured results', async () => {
    const options = {
      environment: 'test',
      services: ['backend', 'frontend'],
      force: false,
      timeout: 30,
    };
    
    const result = await myCommand(options);
    
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
    
    // Verify CommandResult structure
    result.results.forEach(r => {
      expect(r).toHaveProperty('entity');
      expect(r).toHaveProperty('platform');
      expect(r).toHaveProperty('success');
      expect(r).toHaveProperty('timestamp');
    });
  });
  
  it('should handle dry-run mode', async () => {
    const options = {
      environment: 'test',
      services: ['backend'],
      dryRun: true,
    };
    
    const result = await myCommand(options);
    
    expect(result.executionContext.dryRun).toBe(true);
    // Verify no actual operations were performed
  });
  
  it('should use SEMIONT_ENV when --environment not provided', async () => {
    process.env.SEMIONT_ENV = 'staging';
    
    const options = {
      services: ['backend'],
    };
    
    const result = await myCommand(options);
    expect(result.executionContext.environment).toBe('staging');
  });
  
  it('should error when no environment specified', async () => {
    delete process.env.SEMIONT_ENV;
    
    const options = {
      services: ['backend'],
    };
    
    await expect(myCommand(options)).rejects.toThrow(
      'Environment is required. Specify --environment flag or set SEMIONT_ENV environment variable'
    );
  });
  
  it('should load services from environment config', async () => {
    // Environment config defines which services exist
    const options = {
      environment: 'dev',
      services: ['all'],  // Will resolve to services defined in dev.json
    };
    
    const result = await myCommand(options);
    // Result includes all services defined in environments/dev.json
    expect(result.results.length).toBeGreaterThan(0);
  });
});
```

## Best Practices

### 1. Use MultiServiceExecutor for Consistency

All commands should use MultiServiceExecutor for consistent behavior:

```typescript
// ✅ Good - Use MultiServiceExecutor
export async function myCommand(options: MyCommandOptions) {
  const executor = new MultiServiceExecutor(myCommandDescriptor);
  return executor.execute(options);
}

// ❌ Bad - Custom implementation
export async function myCommand(options: MyCommandOptions) {
  // Manual service resolution and execution
  const services = resolveServices(options);
  // ...
}
```

### 2. Create Platform Handlers for Each ServiceType

Handlers provide platform-specific implementations:

```typescript
// ✅ Good - Handler for specific platform/serviceType
export const webMyCommandDescriptor: HandlerDescriptor = {
  command: 'my-command',
  platform: 'posix',
  serviceType: 'web',
  handler: webMyCommandHandler
};

// ❌ Bad - Generic handler trying to handle all service types
export const myCommandDescriptor: HandlerDescriptor = {
  command: 'my-command',
  platform: 'posix',
  serviceType: '*',  // Don't use wildcards
  handler: genericHandler
};
```

### 3. Use CommandResult Type

Always return CommandResult with appropriate extensions:

```typescript
// ✅ Good - CommandResult with extensions
buildResult: (handlerResult, service, platform, serviceType) => ({
  entity: service.name,
  platform: platform.type,
  success: handlerResult.success,
  timestamp: new Date(),
  extensions: {
    myCommand: {
      customField: handlerResult.customField
    }
  }
})

// ❌ Bad - Custom result type
interface MyCustomResult {
  serviceName: string;
  worked: boolean;
  // ...
}
```

### 4. Handle Missing Handlers Gracefully

MultiServiceExecutor will handle missing handlers, but provide clear messages:

```typescript
// Handler not found for a platform/serviceType combination
// MultiServiceExecutor will return an error result:
{
  success: false,
  error: 'No handler found for command "my-command" on platform "external" with service type "api"'
}

// Consider if your command should support all platforms
// or document which platforms are supported
```

### 5. Use Type-Safe Patterns

Leverage TypeScript and Zod for type safety:

```typescript
// Define clear interfaces
export interface MyCommandResult {
  entity: string;
  platform: PlatformType;
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

## Preflight Checks

Every `HandlerDescriptor` must include a `preflight` function. Preflight checks validate preconditions before a handler runs (e.g., required commands are installed, ports are free, environment variables are set).

### Writing a Preflight Function

Preflight functions receive the same context as the handler and return a `PreflightResult`:

```typescript
import { PreflightResult } from '../../../core/handlers/types.js';
import {
  checkCommandAvailable,
  checkFileExists,
  checkPortFree,
  checkEnvVarResolved,
  passingPreflight,
  preflightFromChecks,
} from '../../../core/handlers/preflight-utils.js';

// Simple: no preconditions
preflight: async () => passingPreflight(),

// Check that required tools are installed
preflight: async () => preflightFromChecks([
  checkCommandAvailable('npm'),
  checkCommandAvailable('npx'),
]),

// Check with async utilities (e.g., port availability)
preflight: async (context) => {
  const port = context.service.getRequirements().network?.ports?.[0];
  return preflightFromChecks([
    checkCommandAvailable('node'),
    ...(port ? [await checkPortFree(port)] : []),
  ]);
},
```

Available check utilities in `preflight-utils.ts`:
- `checkCommandAvailable(cmd)` — verifies a command is in PATH
- `checkContainerRuntime(runtime)` — verifies docker/podman is available
- `checkPortFree(port)` — verifies a TCP port is not in use (async)
- `checkEnvVarResolved(value, description)` — checks a config value is set and any `${VAR}` templates are resolved
- `checkEnvVarsInConfig(config)` — scans a config object for unresolved `${VAR}` references
- `checkFileExists(path, description)` — verifies a file exists
- `checkDirectoryWritable(path)` — verifies a directory is writable
- `checkAwsCredentials()` — checks AWS credentials are configured
- `passingPreflight()` — returns a passing result with no checks
- `preflightFromChecks(checks)` — aggregates checks into a `PreflightResult`

### The `--preflight` Flag

All service commands (provision, start, check, publish, update, stop) support `--preflight`. This flag is defined in `BaseOptionsSchema` and available to all commands automatically.

When `--preflight` is passed:
1. `MultiServiceExecutor.execute()` takes an early-return path
2. For each service, it builds the handler context identically to normal execution
3. It calls the handler's `preflight()` function instead of `handler()`
4. Failed preflights produce `success: false` results
5. The `summary.failed` count triggers `process.exit(1)` in `command-executor.ts`
6. `executionContext.dryRun` is set to `true`

No changes are needed in individual commands to support `--preflight` — it is handled entirely by `MultiServiceExecutor`.

### Command Chain Preflights (`nextCommand`)

Commands can declare a `nextCommand` in their `CommandDescriptor`:

```typescript
const startDescriptor: CommandDescriptor<StartOptions> = {
  name: 'start',
  nextCommand: 'check',  // After starting, run check's preflights
  // ...
};
```

After normal execution completes, `MultiServiceExecutor` automatically runs the next command's preflight checks. These are **advisory only**:
- Passing checks are shown only in `--verbose` mode
- Failing checks are shown as warnings
- They do **not** affect the exit code or the `summary.failed` count

This gives operators early visibility into whether the next step will succeed (e.g., after `start`, check whether `check` preflights pass).

The current command chain is: `init → provision → start → check`

## Common Patterns

### Pre-execution Hooks for Synthetic Services

```typescript
// Add synthetic services in preExecute
const provisionDescriptor: CommandDescriptor = {
  preExecute: async (serviceDeployments, options) => {
    if (options.stack && serviceDeployments.length === 0) {
      // Add synthetic service for stack operations
      return [{
        name: '__aws_stack__',
        platform: 'aws',
        config: { stackName: options.stackName }
      }];
    }
    return serviceDeployments;
  },
  // ...
};
```

### Handler Context and Options

```typescript
// Options flow from command to handler
const descriptor: CommandDescriptor = {
  extractHandlerOptions: (options) => ({
    force: options.force,
    custom: options.customFlag
  })
};

// Handler receives options in context
const handler = async (context) => {
  const { service, options } = context;
  if (options.force) {
    // Force mode behavior
  }
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
- [ ] Every handler descriptor has a `preflight` function
- [ ] Preflight checks match what the handler actually does
- [ ] `--preflight` flag runs preflights without executing handlers

## Getting Help

1. Review existing commands in `src/commands/` for examples
2. Check service implementations in `src/services/`
3. Review platform strategies in `src/platforms/`
4. Look at shared utilities in `src/lib/`
5. Run tests to verify behavior: `npm test`

## Key Relationships

```
Environment (dev.json) defines:
  → Services (backend, database, worker)
  → Platform assignments (backend: posix, database: container)
  → Service configurations (ports, env vars, etc.)

Command execution:
  → Resolves environment (--environment or SEMIONT_ENV)
  → Loads environment config
  → Discovers services
  → For each service:
      → Determines platform (from environment config)
      → Determines service type (from service characteristics)
      → Finds handler (platform + serviceType + command)
      → Executes handler
      → Returns CommandResult
```

Remember: Environment defines context, Commands use MultiServiceExecutor, Handlers implement platform-specific logic, CommandDescriptor configures behavior.