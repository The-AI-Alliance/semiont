/**
 * Mock Platform Strategy
 * 
 * Provides a simulated platform for testing and development without provisioning
 * real infrastructure. This platform validates service requirements and simulates
 * operations without side effects, making it ideal for CI/CD pipelines and testing.
 * 
 * Capabilities:
 * - Simulates all platform operations without real resource allocation
 * - Validates service requirements and configurations
 * - Provides deterministic responses for testing
 * - Maintains in-memory state for simulated services
 * - Supports dry-run mode for production commands
 * - Generates realistic mock responses for debugging
 * 
 * Requirements Handling:
 * - Compute: Validates memory/CPU requirements are reasonable
 * - Network: Simulates port allocation and checks for conflicts
 * - Storage: Tracks simulated storage allocation
 * - Dependencies: Verifies dependency graph is valid
 * - Security: Validates security configurations without real credentials
 * 
 * Use Cases:
 * - Unit and integration testing
 * - CI/CD pipeline validation
 * - Dry-run operations before production deployment
 * - Development without infrastructure costs
 * - Documentation and demo scenarios
 */

import { StartResult } from "../commands/start.js";
import { StopResult } from "../commands/stop.js";
import { CheckResult } from "../commands/check.js";
import { UpdateResult } from "../commands/update.js";
import { ProvisionResult } from "../commands/provision.js";
import { PublishResult } from "../commands/publish.js";
import { BackupResult } from "../commands/backup.js";
import { PlatformResources } from "./platform-resources.js";
import { ExecResult, ExecOptions } from "../commands/exec.js";
import { TestResult, TestOptions } from "../commands/test.js";
import { RestoreResult, RestoreOptions } from "../commands/restore.js";
import { BasePlatformStrategy, ServiceContext } from './platform-strategy.js';

export class MockPlatformStrategy extends BasePlatformStrategy {
  private mockState: Map<string, any> = new Map();
  
  getPlatformName(): string {
    return 'mock';
  }
  
  async start(context: ServiceContext): Promise<StartResult> {
    const requirements = context.getRequirements();
    const mockId = `mock-${context.name}-${Date.now()}`;
    
    // Build endpoint from network requirements
    let endpoint: string | undefined;
    if (requirements.network?.ports && requirements.network.ports.length > 0) {
      const primaryPort = requirements.network.ports[0];
      endpoint = `http://localhost:${primaryPort}`;
      
      if (requirements.network.customDomains?.length) {
        // Mock custom domain support
        endpoint = `https://${requirements.network.customDomains[0]}`;
      }
    }
    
    // Check dependencies are met
    if (requirements.dependencies?.services) {
      for (const dep of requirements.dependencies.services) {
        const depState = this.mockState.get(dep);
        if (!depState?.running) {
          console.log(`[MOCK] Dependency ${dep} not running, would normally fail`);
        }
      }
    }
    
    // Simulate resource allocation
    const allocatedResources = {
      cpu: requirements.resources?.cpu || '0.1',
      memory: requirements.resources?.memory || '128Mi',
      replicas: requirements.resources?.replicas || 1
    };
    
    // Store mock state with requirements info
    this.mockState.set(context.name, {
      id: mockId,
      running: true,
      startTime: new Date(),
      requirements,
      allocatedResources,
      endpoint
    });
    
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      startTime: new Date(),
      endpoint,
      resources: {
        platform: 'mock',
        data: {
          mockId: mockId,
          mockPort: requirements.network?.ports?.[0],
          mockEndpoint: endpoint
        }
      } as PlatformResources,
      metadata: {
        mockImplementation: true,
        allocatedResources,
        requirementsMet: true
      }
    };
  }
  
  async stop(context: ServiceContext): Promise<StopResult> {
    const state = this.mockState.get(context.name);
    
    if (state) {
      state.running = false;
      this.mockState.delete(context.name);
    }
    
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      stopTime: new Date(),
      metadata: {
        mockImplementation: true,
        wasRunning: !!state
      }
    };
  }
  
  async check(context: ServiceContext): Promise<CheckResult> {
    const state = this.mockState.get(context.name);
    const status = state?.running ? 'running' : 'stopped';
    
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      checkTime: new Date(),
      status,
      stateVerified: true,
      resources: state ? {
        platform: 'mock',
        data: {
          mockId: state.id
        }
      } as PlatformResources : undefined,
      health: {
        healthy: state?.running || false,
        details: {
          message: state?.running ? 'Mock service is running' : 'Mock service is stopped'
        }
      }
    };
  }
  
  async update(context: ServiceContext): Promise<UpdateResult> {
    // Mock update: simulate stop and start
    await this.stop(context);
    const startResult = await this.start(context);
    
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      updateTime: new Date(),
      previousVersion: 'mock-v1',
      newVersion: 'mock-v2',
      strategy: 'rolling',
      resources: startResult.resources,
      metadata: {
        mockImplementation: true,
        rollingUpdate: false
      }
    };
  }
  
  async provision(context: ServiceContext): Promise<ProvisionResult> {
    const requirements = context.getRequirements();
    const mockResources: any = {};
    const dependencies = requirements.dependencies?.services || [];
    
    // Mock storage provisioning
    if (requirements.storage) {
      for (const storage of requirements.storage) {
        if (storage.persistent) {
          mockResources[`volume-${storage.volumeName || 'default'}`] = {
            size: storage.size,
            mountPath: storage.mountPath,
            created: new Date()
          };
        }
      }
    }
    
    // Mock network provisioning
    if (requirements.network?.needsLoadBalancer) {
      mockResources.loadBalancer = {
        ports: requirements.network.ports,
        domains: requirements.network.customDomains || [],
        created: new Date()
      };
    }
    
    // Mock resource allocation
    if (requirements.resources) {
      mockResources.allocation = {
        cpu: requirements.resources.cpu,
        memory: requirements.resources.memory,
        replicas: requirements.resources.replicas
      };
    }
    
    // Store mock provisioning state
    this.mockState.set(`provision-${context.name}`, {
      requirements,
      resources: mockResources,
      time: new Date()
    });
    
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      provisionTime: new Date(),
      resources: {
        platform: 'mock',
        data: {
          mockId: `mock-provision-${context.name}`,
          metadata: mockResources
        }
      } as PlatformResources,
      dependencies,
      metadata: {
        mockImplementation: true,
        provisionedRequirements: requirements
      }
    };
  }
  
  async publish(context: ServiceContext): Promise<PublishResult> {
    const requirements = context.getRequirements();
    const version = `mock-${Date.now()}`;
    
    // Simulate build process if needed
    if (requirements.build && !requirements.build.prebuilt) {
      console.log(`[MOCK] Building from ${requirements.build.dockerfile || 'Dockerfile'}`);
      console.log(`[MOCK] Build context: ${requirements.build.buildContext || '.'}`);
      if (requirements.build.buildArgs) {
        console.log(`[MOCK] Build args:`, requirements.build.buildArgs);
      }
    }
    
    const artifacts: PublishResult['artifacts'] = {};
    
    // Mock different artifact types based on requirements
    if (requirements.build || context.getImage()) {
      // Container image artifact
      artifacts.imageTag = version;
      artifacts.imageUrl = `mock://registry/${context.name}:${version}`;
    } else if (context.name === 'frontend') {
      // Static site artifact
      artifacts.packageName = context.name;
      artifacts.packageVersion = version;
      artifacts.staticSiteUrl = `https://mock-cdn.example.com/${context.name}/${version}`;
    } else {
      // Generic package
      artifacts.packageName = context.name;
      artifacts.packageVersion = version;
    }
    
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      publishTime: new Date(),
      version: {
        current: version,
        previous: `mock-${Date.now() - 1000}`
      },
      artifacts,
      metadata: {
        mockImplementation: true,
        buildRequirements: requirements.build
      }
    };
  }
  
  async backup(context: ServiceContext): Promise<BackupResult> {
    const requirements = context.getRequirements();
    const backupId = `backup-${context.name}-${Date.now()}`;
    
    // Calculate backup size based on storage requirements
    let totalSize = 0;
    const backedUpVolumes: string[] = [];
    
    if (requirements.storage) {
      for (const storage of requirements.storage) {
        if (storage.persistent && storage.backupEnabled !== false) {
          // Mock size calculation (convert size spec to bytes)
          const sizeInBytes = this.parseSizeToBytes(storage.size || '1Gi');
          totalSize += sizeInBytes;
          backedUpVolumes.push(storage.volumeName || 'default');
        }
      }
    }
    
    // Default size if no storage requirements
    if (totalSize === 0) {
      totalSize = 1024 * 1024; // 1MB default
    }
    
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      backupTime: new Date(),
      backupId,
      backup: {
        size: totalSize,
        location: `mock://backups/${backupId}`,
        format: requirements.storage?.length ? 'tar' : 'json'
      },
      metadata: {
        mockImplementation: true,
        storageRequirements: requirements.storage
      }
    };
  }
  
  private parseSizeToBytes(size: string): number {
    const units: Record<string, number> = {
      'Ki': 1024,
      'Mi': 1024 * 1024,
      'Gi': 1024 * 1024 * 1024,
      'Ti': 1024 * 1024 * 1024 * 1024,
      'K': 1000,
      'M': 1000 * 1000,
      'G': 1000 * 1000 * 1000,
      'T': 1000 * 1000 * 1000 * 1000
    };
    
    const match = size.match(/^(\d+)([KMGT]i?)$/);
    if (match) {
      const value = parseInt(match[1]);
      const unit = match[2];
      return value * (units[unit] || 1);
    }
    return parseInt(size) || 0;
  }
  
  async restore(context: ServiceContext, backupId: string, _options?: RestoreOptions): Promise<RestoreResult> {
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      restoreTime: new Date(),
      backupId: backupId || 'mock-backup-id',
      metadata: {
        mockImplementation: true,
        fromBackup: backupId
      }
    };
  }
  
  async test(context: ServiceContext, options: TestOptions): Promise<TestResult> {
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      testTime: new Date(),
      suite: options?.suite || 'unit',
      passed: 10,
      failed: 0,
      skipped: 2,
      coverage: 85, // Line coverage percentage
      metadata: {
        mockImplementation: true,
        testSuite: options.suite
      }
    };
  }
  
  async exec(context: ServiceContext, command: string, _options?: ExecOptions): Promise<ExecResult> {
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      execTime: new Date(),
      command: command,
      output: {
        stdout: `Mock output for: ${command}`,
        stderr: '',
        combined: `Mock output for: ${command}`
      },
      metadata: {
        mockImplementation: true
      }
    };
  }
  
  async collectLogs(context: ServiceContext): Promise<CheckResult['logs']> {
    const state = this.mockState.get(context.name);
    return {
      recent: state?.running ? [
        `[MOCK] ${context.name} started at ${state.startTime}`,
        `[MOCK] Service is running with id: ${state.id}`
      ] : []
    };
  }
  
  // Helper method to reset mock state (useful for tests)
  resetMockState(): void {
    this.mockState.clear();
  }
  
  // Helper method to get mock state (useful for test assertions)
  getMockState(serviceName: string): any {
    return this.mockState.get(serviceName);
  }
  
  /**
   * Manage secrets in memory for testing
   */
  override async manageSecret(
    action: 'get' | 'set' | 'list' | 'delete',
    secretPath: string,
    value?: any,
    options?: import('./platform-strategy.js').SecretOptions
  ): Promise<import('./platform-strategy.js').SecretResult> {
    // Store secrets in the mock state under a special namespace
    const secretKey = `secret:${options?.environment || 'test'}:${secretPath}`;
    
    switch (action) {
      case 'get': {
        const storedValue = this.mockState.get(secretKey);
        if (storedValue === undefined) {
          return {
            success: false,
            action,
            secretPath,
            platform: 'mock',
            storage: 'memory',
            error: `Secret not found: ${secretPath}`
          };
        }
        
        return {
          success: true,
          action,
          secretPath,
          value: storedValue,
          platform: 'mock',
          storage: 'memory'
        };
      }
      
      case 'set': {
        this.mockState.set(secretKey, value);
        return {
          success: true,
          action,
          secretPath,
          platform: 'mock',
          storage: 'memory',
          metadata: {
            stored: true
          }
        };
      }
      
      case 'list': {
        const prefix = `secret:${options?.environment || 'test'}:${secretPath}`;
        const matchingKeys = Array.from(this.mockState.keys())
          .filter(key => key.startsWith(prefix))
          .map(key => key.replace(/^secret:[^:]+:/, ''));
        
        return {
          success: true,
          action,
          secretPath,
          values: matchingKeys,
          platform: 'mock',
          storage: 'memory'
        };
      }
      
      case 'delete': {
        this.mockState.delete(secretKey);
        return {
          success: true,
          action,
          secretPath,
          platform: 'mock',
          storage: 'memory'
        };
      }
      
      default:
        return {
          success: false,
          action,
          secretPath,
          platform: 'mock',
          error: `Unknown action: ${action}`
        };
    }
  }
}