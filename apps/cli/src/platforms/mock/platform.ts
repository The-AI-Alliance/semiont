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