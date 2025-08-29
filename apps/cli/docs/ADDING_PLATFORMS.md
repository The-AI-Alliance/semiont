# Adding New Platforms to Semiont CLI

This guide walks you through adding a new platform strategy to the Semiont CLI.

## Overview

Platforms in Semiont represent different infrastructure targets where services can be deployed:
- **process** - Local processes on the host machine
- **container** - Docker/Podman containers
- **aws** - AWS ECS/Fargate services  
- **external** - Externally managed services
- **mock** - Mock platform for testing

Each platform implements the `PlatformStrategy` interface to provide infrastructure-specific behavior.

## Architecture

```
Service → Platform Strategy → Infrastructure
            ↓
    Implements all commands
    (start, stop, check, etc.)
```

## Step-by-Step Guide

### 1. Create the Platform File

Create a new file in `src/platforms/`:

```bash
touch src/platforms/my-platform.ts
```

### 2. Import Dependencies

```typescript
/**
 * My Platform Strategy
 * 
 * Implements service deployment on [describe your platform]
 */

import { BasePlatformStrategy, ServiceContext } from './platform-strategy.js';
import { StartResult } from "../commands/start.js";
import { StopResult } from "../commands/stop.js";
import { CheckResult } from "../commands/check.js";
import { UpdateResult } from "../commands/update.js";
import { ProvisionResult } from "../commands/provision.js";
import { PublishResult } from "../commands/publish.js";
import { BackupResult } from "../commands/backup.js";
import { ExecResult, ExecOptions } from "../commands/exec.js";
import { TestResult, TestOptions } from "../commands/test.js";
import { RestoreResult, RestoreOptions } from "../commands/restore.js";
import { PlatformResources, createPlatformResources } from "./platform-resources.js";
import { StateManager } from '../services/state-manager.js';
import { printInfo, printWarning, printError } from '../lib/cli-logger.js';
```

### 3. Implement the Platform Strategy

```typescript
export class MyPlatformStrategy extends BasePlatformStrategy {
  
  getPlatformName(): string {
    return 'my-platform';
  }
  
  /**
   * Start a service on this platform
   */
  async start(context: ServiceContext): Promise<StartResult> {
    const { name, config, requirements, verbose, dryRun } = context;
    
    if (dryRun) {
      printInfo(`[DRY RUN] Would start ${name} on my-platform`);
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: true,
        startTime: new Date(),
        metadata: { dryRun: true }
      };
    }
    
    // Implement platform-specific start logic
    try {
      // 1. Provision resources based on requirements
      const resources = await this.provisionResources(context);
      
      // 2. Start the service
      const serviceId = await this.startService(context, resources);
      
      // 3. Save state
      await StateManager.save(
        context.projectRoot,
        context.environment,
        name,
        {
          entity: name,
          platform: 'my-platform' as any,
          environment: context.environment,
          startTime: new Date(),
          resources: createPlatformResources('my-platform' as any, {
            serviceId,
            // Add platform-specific resource data
          }),
        }
      );
      
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: true,
        startTime: new Date(),
        resources: createPlatformResources('my-platform' as any, { serviceId }),
        endpoint: this.getServiceEndpoint(serviceId),
      };
      
    } catch (error) {
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  /**
   * Stop a service on this platform
   */
  async stop(context: ServiceContext): Promise<StopResult> {
    const { name, dryRun } = context;
    
    if (dryRun) {
      printInfo(`[DRY RUN] Would stop ${name} on my-platform`);
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: true,
        metadata: { dryRun: true }
      };
    }
    
    try {
      // Load saved state
      const state = await StateManager.load(
        context.projectRoot,
        context.environment,
        name
      );
      
      if (!state) {
        return {
          entity: name,
          platform: 'my-platform' as any,
          success: false,
          error: 'Service not found',
        };
      }
      
      // Stop the service using saved resources
      if (state.resources && 'serviceId' in state.resources.data) {
        await this.stopService(state.resources.data.serviceId);
      }
      
      // Clear state
      await StateManager.clear(
        context.projectRoot,
        context.environment,
        name
      );
      
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: true,
        stoppedAt: new Date(),
      };
      
    } catch (error) {
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  /**
   * Check service status
   */
  async check(context: ServiceContext): Promise<CheckResult> {
    const { name } = context;
    
    try {
      const state = await StateManager.load(
        context.projectRoot,
        context.environment,
        name
      );
      
      if (!state) {
        return {
          entity: name,
          platform: 'my-platform' as any,
          success: true,
          status: 'not-found',
          healthy: false,
        };
      }
      
      // Check actual service status
      const status = await this.getServiceStatus(state.resources?.data);
      
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: true,
        status: status.running ? 'running' : 'stopped',
        healthy: status.healthy,
        checks: status.checks,
        resources: state.resources,
      };
      
    } catch (error) {
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: false,
        status: 'error',
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  /**
   * Update a service
   */
  async update(context: ServiceContext): Promise<UpdateResult> {
    // Implementation similar to stop + start
    const stopResult = await this.stop(context);
    if (!stopResult.success) {
      return {
        entity: context.name,
        platform: 'my-platform' as any,
        success: false,
        error: stopResult.error,
      };
    }
    
    const startResult = await this.start(context);
    return {
      entity: context.name,
      platform: 'my-platform' as any,
      success: startResult.success,
      version: 'latest',
      updatedAt: new Date(),
      error: startResult.error,
    };
  }
  
  /**
   * Provision infrastructure
   */
  async provision(context: ServiceContext): Promise<ProvisionResult> {
    const { name, requirements, dryRun } = context;
    
    if (dryRun) {
      printInfo(`[DRY RUN] Would provision infrastructure for ${name}`);
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: true,
        metadata: { dryRun: true }
      };
    }
    
    try {
      // Create infrastructure based on requirements
      const infrastructure = await this.createInfrastructure(requirements);
      
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: true,
        resources: createPlatformResources('my-platform' as any, infrastructure),
        metadata: {
          provisioned: Object.keys(infrastructure),
        }
      };
      
    } catch (error) {
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  /**
   * Publish/deploy artifacts
   */
  async publish(context: ServiceContext): Promise<PublishResult> {
    const { name, config, dryRun } = context;
    
    if (dryRun) {
      printInfo(`[DRY RUN] Would publish ${name} to my-platform`);
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: true,
        metadata: { dryRun: true }
      };
    }
    
    try {
      // Build and publish artifacts
      const artifact = await this.buildArtifact(context);
      const location = await this.publishArtifact(artifact);
      
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: true,
        artifact: location,
        version: artifact.version,
        publishedAt: new Date(),
      };
      
    } catch (error) {
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  /**
   * Backup service data
   */
  async backup(context: ServiceContext): Promise<BackupResult> {
    const { name } = context;
    
    try {
      // Create backup
      const backupId = `backup-${Date.now()}`;
      const backupData = await this.createBackup(context);
      
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: true,
        backupId,
        location: `/backups/${backupId}`,
        size: backupData.size,
        timestamp: new Date(),
        details: backupData.details,
      };
      
    } catch (error) {
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  /**
   * Execute command in service context
   */
  async exec(
    context: ServiceContext,
    command: string,
    options?: ExecOptions
  ): Promise<ExecResult> {
    const { name } = context;
    const { interactive = false, detach = false } = options || {};
    
    try {
      const state = await StateManager.load(
        context.projectRoot,
        context.environment,
        name
      );
      
      if (!state) {
        throw new Error('Service not running');
      }
      
      // Execute command in service context
      const result = await this.executeInService(
        state.resources?.data,
        command,
        { interactive, detach }
      );
      
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: true,
        output: result.output,
        exitCode: result.exitCode,
      };
      
    } catch (error) {
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: false,
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  /**
   * Run tests
   */
  async test(
    context: ServiceContext,
    options?: TestOptions
  ): Promise<TestResult> {
    const { name } = context;
    const { suite = 'unit', coverage = false } = options || {};
    
    try {
      // Run test suite
      const results = await this.runTests(context, suite, coverage);
      
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: results.passed,
        passed: results.passedCount,
        failed: results.failedCount,
        skipped: results.skippedCount,
        duration: results.duration,
        coverage: coverage ? results.coverage : undefined,
      };
      
    } catch (error) {
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: false,
        passed: 0,
        failed: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  /**
   * Restore from backup
   */
  async restore(
    context: ServiceContext,
    backupId: string,
    options?: RestoreOptions
  ): Promise<RestoreResult> {
    const { name } = context;
    const { force = false } = options || {};
    
    try {
      // Restore from backup
      await this.restoreBackup(context, backupId, force);
      
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: true,
        backupId,
        restoredAt: new Date(),
      };
      
    } catch (error) {
      return {
        entity: name,
        platform: 'my-platform' as any,
        success: false,
        backupId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  /**
   * Collect logs from service
   */
  async collectLogs(context: ServiceContext): Promise<CheckResult['logs']> {
    const state = await StateManager.load(
      context.projectRoot,
      context.environment,
      context.name
    );
    
    if (!state || !state.resources) {
      return undefined;
    }
    
    // Fetch logs from platform
    const logs = await this.fetchLogs(state.resources.data);
    
    return logs.map(log => ({
      timestamp: log.timestamp,
      message: log.message,
      level: log.level,
    }));
  }
  
  /**
   * Quick check if service is running (for dependency checks)
   */
  override async quickCheckRunning(
    state: import('../services/state-manager.js').ServiceState
  ): Promise<boolean> {
    if (!state.resources || state.resources.platform !== 'my-platform') {
      return false;
    }
    
    try {
      const status = await this.getServiceStatus(state.resources.data);
      return status.running;
    } catch {
      return false;
    }
  }
  
  // ============================================
  // Platform-specific helper methods
  // ============================================
  
  private async provisionResources(context: ServiceContext): Promise<any> {
    // Implement resource provisioning
    throw new Error('Not implemented');
  }
  
  private async startService(context: ServiceContext, resources: any): Promise<string> {
    // Implement service start
    throw new Error('Not implemented');
  }
  
  private async stopService(serviceId: string): Promise<void> {
    // Implement service stop
    throw new Error('Not implemented');
  }
  
  private async getServiceStatus(resources: any): Promise<{
    running: boolean;
    healthy: boolean;
    checks?: Array<{name: string; status: string}>;
  }> {
    // Implement status check
    throw new Error('Not implemented');
  }
  
  private getServiceEndpoint(serviceId: string): string | undefined {
    // Return service endpoint if applicable
    return undefined;
  }
  
  private async createInfrastructure(requirements: any): Promise<any> {
    // Implement infrastructure creation
    throw new Error('Not implemented');
  }
  
  private async buildArtifact(context: ServiceContext): Promise<any> {
    // Implement artifact building
    throw new Error('Not implemented');
  }
  
  private async publishArtifact(artifact: any): Promise<string> {
    // Implement artifact publishing
    throw new Error('Not implemented');
  }
  
  private async createBackup(context: ServiceContext): Promise<any> {
    // Implement backup creation
    throw new Error('Not implemented');
  }
  
  private async executeInService(
    resources: any,
    command: string,
    options: any
  ): Promise<{output?: string; exitCode: number}> {
    // Implement command execution
    throw new Error('Not implemented');
  }
  
  private async runTests(
    context: ServiceContext,
    suite: string,
    coverage: boolean
  ): Promise<any> {
    // Implement test execution
    throw new Error('Not implemented');
  }
  
  private async restoreBackup(
    context: ServiceContext,
    backupId: string,
    force: boolean
  ): Promise<void> {
    // Implement backup restoration
    throw new Error('Not implemented');
  }
  
  private async fetchLogs(resources: any): Promise<any[]> {
    // Implement log fetching
    return [];
  }
}
```

### 4. Add Platform Resources Type

If your platform needs custom resource types, add them to `src/platforms/platform-resources.ts`:

```typescript
// Add your platform's resource type
export interface MyPlatformResources {
  platform: 'my-platform';
  data: {
    serviceId: string;
    endpoint?: string;
    // Add platform-specific fields
  };
}

// Update the union type
export type PlatformResources = 
  | ProcessResources
  | ContainerResources
  | AWSResources
  | MyPlatformResources;
```

### 5. Register the Platform

Add your platform to the factory in `src/platforms/index.ts`:

```typescript
import { MyPlatformStrategy } from './my-platform.js';

export class PlatformFactory {
  private static createPlatform(type: Platform): PlatformStrategy {
    switch (type) {
      case 'process':
        return new ProcessPlatformStrategy();
      case 'container':
        return new ContainerPlatformStrategy();
      case 'aws':
        return new AWSPlatformStrategy();
      case 'my-platform':
        return new MyPlatformStrategy();
      // ...
    }
  }
}
```

### 6. Update Platform Type

Add your platform to the Platform type in `src/platforms/platform-resolver.ts`:

```typescript
export type Platform = 'aws' | 'container' | 'process' | 'external' | 'mock' | 'my-platform';
```

### 7. Add Tests

Create test file at `src/platforms/__tests__/my-platform.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MyPlatformStrategy } from '../my-platform.js';
import { ServiceContext } from '../platform-strategy.js';

describe('MyPlatformStrategy', () => {
  let platform: MyPlatformStrategy;
  let context: ServiceContext;
  
  beforeEach(() => {
    platform = new MyPlatformStrategy();
    context = {
      name: 'test-service',
      config: {},
      projectRoot: '/test',
      environment: 'test',
      verbose: false,
      requirements: {
        compute: { memory: 512, cpu: 0.5 },
        network: { ports: [{ port: 3000, protocol: 'tcp' }] },
      },
      getEnvironmentVariables: () => ({}),
      getCapabilities: () => [],
    };
  });
  
  describe('start', () => {
    it('should start a service', async () => {
      const result = await platform.start(context);
      
      expect(result.success).toBe(true);
      expect(result.platform).toBe('my-platform');
      expect(result.entity).toBe('test-service');
    });
    
    it('should handle dry-run mode', async () => {
      context.dryRun = true;
      
      const result = await platform.start(context);
      
      expect(result.success).toBe(true);
      expect(result.metadata?.dryRun).toBe(true);
    });
  });
  
  // Add more tests for other methods
});
```

## Best Practices

### 1. Use Service Requirements

Respect the service requirements when provisioning resources:

```typescript
const { compute, network, storage } = context.requirements || {};

if (compute) {
  // Allocate CPU and memory based on requirements
  resources.cpu = compute.cpu;
  resources.memory = compute.memory;
}

if (network?.ports) {
  // Configure network ports
  resources.ports = network.ports;
}
```

### 2. Implement State Management

Always save and load state properly:

```typescript
// Save state after successful start
await StateManager.save(projectRoot, environment, name, {
  entity: name,
  platform: 'my-platform',
  environment,
  startTime: new Date(),
  resources,
});

// Load state for operations
const state = await StateManager.load(projectRoot, environment, name);
```

### 3. Handle Errors Gracefully

Return structured error responses:

```typescript
try {
  // Operation
} catch (error) {
  return {
    entity: name,
    platform: 'my-platform',
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
```

### 4. Support Dry-Run Mode

Check for dry-run in all modifying operations:

```typescript
if (context.dryRun) {
  printInfo(`[DRY RUN] Would perform operation`);
  return {
    success: true,
    metadata: { dryRun: true }
  };
}
```

### 5. Implement quickCheckRunning

For efficient dependency checking:

```typescript
override async quickCheckRunning(state: ServiceState): Promise<boolean> {
  // Quick check without full context
  // Should be faster than full check() method
  return this.isServiceAlive(state.resources);
}
```

## Platform Capabilities

Different platforms may not support all operations. It's okay to return "not supported":

```typescript
async backup(context: ServiceContext): Promise<BackupResult> {
  return {
    entity: context.name,
    platform: 'my-platform',
    success: false,
    error: 'Backup not supported on this platform',
  };
}
```

## Integration Points

### Service Requirements

Services declare what they need, platforms provide it:

```typescript
// Service declares requirements
class MyService extends BaseService {
  getRequirements(): ServiceRequirements {
    return {
      compute: { memory: 512, cpu: 1 },
      network: { ports: [{ port: 8080, protocol: 'tcp' }] },
    };
  }
}

// Platform uses requirements
async start(context: ServiceContext) {
  const { requirements } = context;
  // Provision based on requirements
}
```

### Platform Selection

Services can be configured to use specific platforms in environment configs:

```json
{
  "services": {
    "backend": {
      "platform": "my-platform",
      "config": {
        "region": "us-west-2"
      }
    }
  }
}
```

## Testing Your Platform

1. **Unit tests** - Test each method independently
2. **Integration tests** - Test with real services
3. **State management** - Verify state is saved/loaded correctly
4. **Error scenarios** - Test failure cases
5. **Resource cleanup** - Ensure resources are cleaned up

## Checklist

- [ ] All PlatformStrategy methods implemented
- [ ] Platform resources type defined
- [ ] Platform registered in factory
- [ ] Platform type added to union
- [ ] State management working
- [ ] Dry-run mode supported
- [ ] Error handling consistent
- [ ] Tests cover main scenarios
- [ ] quickCheckRunning implemented
- [ ] Documentation updated

## Examples

Look at existing platforms for examples:
- `process-platform.ts` - Simple local process management
- `container-platform.ts` - Docker/Podman integration
- `aws-platform.ts` - Cloud platform with full AWS integration
- `mock-platform.ts` - Testing platform with minimal implementation