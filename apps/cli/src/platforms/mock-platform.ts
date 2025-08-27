/**
 * Mock Platform Strategy
 * 
 * Provides mock implementations for testing without actual resource allocation.
 * Useful for unit tests and dry-run scenarios.
 */

import { StartResult } from "../services/start-service.js";
import { StopResult } from "../services/stop-service.js";
import { CheckResult } from "../services/check-service.js";
import { UpdateResult } from "../services/update-service.js";
import { ProvisionResult } from "../services/provision-service.js";
import { PublishResult } from "../services/publish-service.js";
import { BackupResult } from "../services/backup-service.js";
import { PlatformResources } from "../lib/platform-resources.js";
import { ExecResult, ExecOptions } from "../services/exec-service.js";
import { TestResult, TestOptions } from "../services/test-service.js";
import { RestoreResult, RestoreOptions } from "../services/restore-service.js";
import { BasePlatformStrategy, ServiceContext } from './platform-strategy.js';

export class MockPlatformStrategy extends BasePlatformStrategy {
  private mockState: Map<string, any> = new Map();
  
  getPlatformName(): string {
    return 'mock';
  }
  
  async start(context: ServiceContext): Promise<StartResult> {
    const mockId = `mock-${context.name}-${Date.now()}`;
    const endpoint = context.getPort() ? `http://localhost:${context.getPort()}` : undefined;
    
    // Store mock state
    this.mockState.set(context.name, {
      id: mockId,
      running: true,
      startTime: new Date()
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
          mockPort: context.getPort(),
          mockEndpoint: endpoint
        }
      } as PlatformResources,
      metadata: {
        mockImplementation: true
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
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      provisionTime: new Date(),
      resources: {
        platform: 'mock',
        data: {
          mockId: `mock-provision-${context.name}`
        }
      } as PlatformResources,
      dependencies: [],
      metadata: {
        mockImplementation: true
      }
    };
  }
  
  async publish(context: ServiceContext): Promise<PublishResult> {
    const version = `mock-${Date.now()}`;
    
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      publishTime: new Date(),
      version: {
        current: version,
        previous: `mock-${Date.now() - 1000}`
      },
      artifacts: {
        imageTag: version,
        imageUrl: `mock://artifacts/${context.name}/${version}`,
        packageName: context.name,
        packageVersion: version
      },
      metadata: {
        mockImplementation: true
      }
    };
  }
  
  async backup(context: ServiceContext): Promise<BackupResult> {
    const backupId = `backup-${context.name}-${Date.now()}`;
    
    return {
      entity: context.name,
      platform: 'mock',
      success: true,
      backupTime: new Date(),
      backupId,
      backup: {
        size: 2048,
        location: `mock://backups/${backupId}`,
        format: 'tar'
      },
      metadata: {
        mockImplementation: true
      }
    };
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
      tests: {
        passed: 10,
        failed: 0,
        skipped: 2,
        total: 12
      },
      coverage: {
        enabled: true,
        lines: 85,
        branches: 75,
        functions: 90,
        statements: 88
      },
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
}