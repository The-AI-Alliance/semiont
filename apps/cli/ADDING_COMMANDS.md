# Adding New Commands to Semiont CLI

This guide walks you through adding a new command to the Semiont CLI, following the established patterns and best practices.

## Overview

Semiont CLI commands follow a consistent pattern that ensures type safety, proper validation, and deployment-type awareness. Each command is a self-contained module that exports a command definition and implementation.

## Step-by-Step Guide

### 1. Create the Command File

Create a new file in `apps/cli/src/commands/` named after your command:

```bash
touch apps/cli/src/commands/my-command.ts
```

### 2. Define the Command Structure

Start with the basic command template:

```typescript
import { z } from 'zod';
import type { CommandDefinition } from '../lib/command-definition.js';
import { baseOptionsSchema } from '../lib/base-command-options.js';
import { resolveServiceDeployments } from '../lib/deployment-resolver.js';
import { colors } from '../lib/cli-colors.js';

// Define your command's schema
const myCommandSchema = baseOptionsSchema.extend({
  environment: z.string().optional(),
  service: z.string().default('all'),
  // Add your command-specific options here
  force: z.boolean().default(false).describe('Force the operation'),
  timeout: z.number().default(30).describe('Operation timeout in seconds'),
});

type MyCommandOptions = z.infer<typeof myCommandSchema>;
```

### 3. Implement the Command Logic

Add the command implementation following functional programming principles:

```typescript
// Pure function for command logic
async function executeMyCommand(
  serviceName: string,
  serviceInfo: ServiceDeploymentInfo,
  options: MyCommandOptions
): Promise<void> {
  const { dryRun, verbose } = options;

  if (verbose) {
    console.log(colors.dim(`Processing ${serviceName}...`));
  }

  // Handle deployment types appropriately
  switch (serviceInfo.deploymentType) {
    case 'aws':
      await handleAwsDeployment(serviceName, serviceInfo, options);
      break;
    case 'container':
      await handleContainerDeployment(serviceName, serviceInfo, options);
      break;
    case 'process':
      await handleProcessDeployment(serviceName, serviceInfo, options);
      break;
    case 'external':
      console.log(colors.yellow(`⚠️  ${serviceName} is externally managed`));
      break;
    default:
      throw new Error(`Unknown deployment type: ${serviceInfo.deploymentType}`);
  }
}

// Deployment-specific handlers (pure functions)
async function handleAwsDeployment(
  serviceName: string,
  serviceInfo: ServiceDeploymentInfo,
  options: MyCommandOptions
): Promise<void> {
  const { dryRun, force } = options;

  if (dryRun) {
    console.log(colors.cyan('[DRY RUN] Would perform AWS operation'));
    return;
  }

  // AWS-specific implementation
  console.log(colors.green(`✓ Completed AWS operation for ${serviceName}`));
}

async function handleContainerDeployment(
  serviceName: string,
  serviceInfo: ServiceDeploymentInfo,
  options: MyCommandOptions
): Promise<void> {
  const { dryRun } = options;
  
  if (dryRun) {
    console.log(colors.cyan('[DRY RUN] Would perform container operation'));
    return;
  }

  // Container-specific implementation using containerRuntime
  const { containerRuntime } = await import('../lib/container-runtime.js');
  const runtime = await containerRuntime.detect();
  
  // Perform container operations
  console.log(colors.green(`✓ Completed container operation for ${serviceName}`));
}

async function handleProcessDeployment(
  serviceName: string,
  serviceInfo: ServiceDeploymentInfo,
  options: MyCommandOptions
): Promise<void> {
  const { dryRun } = options;
  
  if (dryRun) {
    console.log(colors.cyan('[DRY RUN] Would perform process operation'));
    return;
  }

  // Process-specific implementation
  console.log(colors.green(`✓ Completed process operation for ${serviceName}`));
}
```

### 4. Export the Command Definition

Export your command with proper configuration:

```typescript
export const myCommand: CommandDefinition = {
  name: 'my-command',
  description: 'Brief description of what your command does',
  options: myCommandSchema,
  requiresEnvironment: () => true, // or false if environment is optional
  
  handler: async (args) => {
    // Parse and validate arguments
    const options = myCommandSchema.parse(args);
    const { environment, service, dryRun, verbose } = options;

    // Validate environment if required
    if (!environment && requiresEnvironment()) {
      console.error(colors.red('Error: Environment is required'));
      process.exit(1);
    }

    // Resolve service deployments
    const deployments = await resolveServiceDeployments(environment!, service);
    
    if (deployments.length === 0) {
      console.log(colors.yellow('No services to process'));
      return;
    }

    console.log(colors.bold(`\n🚀 Starting my-command for ${deployments.length} service(s)\n`));

    // Process each service
    for (const [serviceName, serviceInfo] of deployments) {
      try {
        await executeMyCommand(serviceName, serviceInfo, options);
      } catch (error) {
        console.error(colors.red(`✗ Failed to process ${serviceName}:`), error);
        if (!options.force) {
          process.exit(1);
        }
      }
    }

    console.log(colors.green('\n✅ Command completed successfully'));
  },

  examples: [
    {
      description: 'Run command for all services',
      command: 'semiont my-command production',
    },
    {
      description: 'Run command for specific service with options',
      command: 'semiont my-command staging --service backend --force --timeout 60',
    },
    {
      description: 'Dry run to preview changes',
      command: 'semiont my-command local --dry-run --verbose',
    },
  ],
};
```

### 5. Register the Command

Add your command to the CLI registry in `apps/cli/src/cli.ts`:

```typescript
import { myCommand } from './commands/my-command.js';

const commands = [
  initCommand,
  provisionCommand,
  startCommand,
  stopCommand,
  restartCommand,
  checkCommand,
  publishCommand,
  updateCommand,
  configureCommand,
  backupCommand,
  execCommand,
  testCommand,
  watchCommand,
  myCommand, // Add your command here
];
```

### 6. Add Tests

Create a test file at `apps/cli/src/commands/__tests__/my-command.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { myCommand } from '../my-command.js';

describe('my-command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should require environment', () => {
    expect(myCommand.requiresEnvironment()).toBe(true);
  });

  it('should handle dry-run mode', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    
    await myCommand.handler({
      environment: 'test',
      service: 'backend',
      dryRun: true,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DRY RUN]')
    );
  });

  it('should process multiple services', async () => {
    // Test processing multiple services
  });

  it('should handle errors gracefully', async () => {
    // Test error handling
  });
});
```

### 7. Update Documentation

#### Update the Service-Command Matrix

Add your command to the matrix in `apps/cli/README.md`:

1. Add to the command list table
2. Add to the Command Environment Requirements table
3. Add to the appropriate service operations section

#### Update the Command Summary

Add your command to the summary table:

```markdown
| `my-command` | Brief description of what it does | AWS, Container, Process, External |
```

## Best Practices

### 1. Functional Programming

Write pure, side-effect free functions whenever possible:

```typescript
// ✅ Good - Pure function
function calculateTimeout(baseTimeout: number, retries: number): number {
  return baseTimeout * Math.pow(2, retries);
}

// ❌ Bad - Side effects mixed with logic
function calculateAndLogTimeout(baseTimeout: number, retries: number): number {
  const timeout = baseTimeout * Math.pow(2, retries);
  console.log(`Timeout: ${timeout}`); // Side effect
  return timeout;
}
```

### 2. Deployment-Type Awareness

Always handle all deployment types explicitly:

```typescript
switch (serviceInfo.deploymentType) {
  case 'aws':
    // AWS-specific logic
    break;
  case 'container':
    // Container-specific logic
    break;
  case 'process':
    // Process-specific logic
    break;
  case 'external':
    // Handle external services appropriately
    break;
  default:
    // Always have a default case for unknown types
    throw new Error(`Unknown deployment type: ${serviceInfo.deploymentType}`);
}
```

### 3. Dry-Run Support

Implement comprehensive dry-run support at both command and service levels:

```typescript
if (dryRun) {
  console.log(colors.cyan(`[DRY RUN] Would perform operation on ${serviceName}`));
  console.log(colors.dim(`  Command: ${command}`));
  console.log(colors.dim(`  Options: ${JSON.stringify(options)}`));
  return;
}
```

### 4. Error Handling

Use consistent error handling with proper exit codes:

```typescript
try {
  await performOperation();
} catch (error) {
  console.error(colors.red(`✗ Operation failed: ${error.message}`));
  if (verbose) {
    console.error(colors.dim(error.stack));
  }
  process.exit(1);
}
```

### 5. Use Shared Utilities

Leverage existing utilities from `lib/`:

- `colors` - Consistent color output
- `resolveServiceDeployments()` - Service resolution
- `containerRuntime` - Docker/Podman detection
- `baseOptionsSchema` - Common options

### 6. Type Safety

Use Zod for runtime validation and TypeScript for compile-time safety:

```typescript
// Define schema for validation
const schema = z.object({
  timeout: z.number().min(1).max(300),
  retries: z.number().int().min(0).max(10),
});

// TypeScript type derived from schema
type Options = z.infer<typeof schema>;

// Validate at runtime
const options = schema.parse(userInput);
```

## Common Patterns

### Working with AWS Services

```typescript
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs';

async function getAwsServiceStatus(serviceName: string): Promise<string> {
  const client = new ECSClient({ region: 'us-east-1' });
  const command = new DescribeServicesCommand({
    cluster: 'my-cluster',
    services: [serviceName],
  });
  
  const response = await client.send(command);
  return response.services?.[0]?.status ?? 'UNKNOWN';
}
```

### Working with Containers

```typescript
import { containerRuntime } from '../lib/container-runtime.js';

async function getContainerStatus(containerName: string): Promise<string> {
  const runtime = await containerRuntime.detect();
  const result = await runtime.inspect(containerName);
  return result.State?.Status ?? 'unknown';
}
```

### Working with Processes

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function getProcessStatus(port: number): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`lsof -i :${port}`);
    return stdout.includes('LISTEN');
  } catch {
    return false;
  }
}
```

## Testing Your Command

### Manual Testing

1. Build the CLI:
```bash
cd apps/cli
npm run build
```

2. Test locally:
```bash
# Test with different environments
node dist/cli.js my-command local --dry-run
node dist/cli.js my-command staging --service backend
node dist/cli.js my-command production --verbose

# Test error cases
node dist/cli.js my-command  # Should error if environment required
node dist/cli.js my-command invalid-env  # Should handle invalid environment
```

3. Test all deployment types:
- Create a test environment with each deployment type
- Verify command behaves correctly for AWS, container, process, and external

### Automated Testing

Run the test suite:

```bash
cd apps/cli
npm test

# Run only your command's tests
npm test my-command
```

## Checklist

Before submitting your PR, ensure:

- [ ] Command follows functional programming principles
- [ ] All deployment types are handled
- [ ] Dry-run mode is fully implemented
- [ ] Error handling uses consistent patterns
- [ ] Tests cover main functionality and edge cases
- [ ] Documentation is updated (README, matrix, examples)
- [ ] TypeScript compiles without errors
- [ ] Command uses shared utilities appropriately
- [ ] Examples are provided in command definition
- [ ] Environment requirement is properly configured

## Getting Help

If you need help or have questions:

1. Review existing commands for examples
2. Check the shared utilities in `lib/`
3. Ensure TypeScript types are properly defined
4. Test with different deployment types
5. Ask for review if pattern is unclear

Remember: Focus on writing pure, testable functions that handle all deployment scenarios gracefully.