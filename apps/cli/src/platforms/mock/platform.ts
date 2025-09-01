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

import { BasePlatformStrategy } from '../../core/platform-strategy.js';
import { Service } from '../../services/types.js';
import type { 
  StopResult, 
  UpdateResult, 
  ProvisionResult,
  PublishResult,
  TestResult,
  TestOptions,
  CheckResult,
  PlatformResources 
} from '../../core/command-types.js';
import { HandlerRegistry } from '../../core/handlers/registry.js';
import { handlers } from './handlers/index.js';

export class MockPlatformStrategy extends BasePlatformStrategy {
  private mockState: Map<string, any> = new Map();
  
  constructor() {
    super();
    this.registerHandlers();
  }
  
  private registerHandlers(): void {
    const registry = HandlerRegistry.getInstance();
    registry.registerHandlers('mock', handlers);
  }
  
  getPlatformName(): string {
    return 'mock';
  }
  
  
  async stop(service: Service): Promise<StopResult> {
    const state = this.mockState.get(service.name);
    
    // Only modify state if not in dry run
    if (!service.dryRun && state) {
      state.running = false;
      this.mockState.delete(service.name);
    }
    
    return {
      entity: service.name,
      platform: 'mock',
      success: true,
      stopTime: new Date(),
      metadata: {
        mockImplementation: true,
        wasRunning: !!state,
        dryRun: service.dryRun || false
      }
    };
  }
  
  async update(service: Service): Promise<UpdateResult> {
    // Mock update: simulate stop
    await this.stop(service);
    
    return {
      entity: service.name,
      platform: 'mock',
      success: true,
      updateTime: new Date(),
      previousVersion: 'mock-v1',
      newVersion: 'mock-v2',
      strategy: 'stop-only',
      metadata: {
        mockImplementation: true,
        message: 'Service stopped. Run start command to launch updated version.'
      }
    };
  }
  
  async provision(service: Service): Promise<ProvisionResult> {
    const requirements = service.getRequirements();
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
    this.mockState.set(`provision-${service.name}`, {
      requirements,
      resources: mockResources,
      time: new Date()
    });
    
    return {
      entity: service.name,
      platform: 'mock',
      success: true,
      provisionTime: new Date(),
      resources: {
        platform: 'mock',
        data: {
          mockId: `mock-provision-${service.name}`,
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
  
  async publish(service: Service): Promise<PublishResult> {
    const requirements = service.getRequirements();
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
    if (requirements.build || service.getImage()) {
      // Container image artifact
      artifacts.imageTag = version;
      artifacts.imageUrl = `mock://registry/${service.name}:${version}`;
    } else if (service.name === 'frontend') {
      // Static site artifact
      artifacts.packageName = service.name;
      artifacts.packageVersion = version;
      artifacts.staticSiteUrl = `https://mock-cdn.example.com/${service.name}/${version}`;
    } else {
      // Generic package
      artifacts.packageName = service.name;
      artifacts.packageVersion = version;
    }
    
    return {
      entity: service.name,
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
  
  async test(service: Service, options: TestOptions): Promise<TestResult> {
    return {
      entity: service.name,
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
  
  async collectLogs(service: Service): Promise<CheckResult['logs']> {
    const state = this.mockState.get(service.name);
    return {
      recent: state?.running ? [
        `[MOCK] ${service.name} started at ${state.startTime}`,
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
   * Determine service type for handler selection
   */
  determineServiceType(service: Service): string {
    // Mock platform uses default handler for all services
    return 'default';
  }
  
  /**
   * Build platform-specific context extensions for handlers
   */
  async buildHandlerContextExtensions(service: Service, requiresDiscovery: boolean): Promise<Record<string, any>> {
    return {
      mockState: this.mockState
    };
  }
}