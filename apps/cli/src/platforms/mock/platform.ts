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

import { Platform, LogOptions, LogEntry } from '../../core/platform.js';
import { Service } from '../../core/service-interface.js';
import { HandlerRegistry } from '../../core/handlers/registry.js';
import { handlers } from './handlers/index.js';

export class MockPlatform extends Platform {
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
   * Map service types to mock handler types
   */
  protected override mapServiceType(_declaredType: string): string {
    // Mock platform uses default handler for all services
    return 'default';
  }
  
  /**
   * Build platform-specific context extensions for handlers
   */
  async buildHandlerContextExtensions(_service: Service, _requiresDiscovery: boolean): Promise<Record<string, any>> {
    return {
      mockState: this.mockState
    };
  }
  
  /**
   * Collect logs for a mock service
   * Returns simulated log entries for testing
   */
  async collectLogs(service: Service, options?: LogOptions): Promise<LogEntry[] | undefined> {
    const { tail = 10 } = options || {};
    const state = this.mockState.get(service.name);
    
    // If service is not "running" in mock state, no logs
    if (!state || state.status !== 'running') {
      return undefined;
    }
    
    // Generate mock log entries
    const logs: LogEntry[] = [];
    const now = new Date();
    
    for (let i = 0; i < Math.min(tail, 5); i++) {
      const timestamp = new Date(now.getTime() - (i * 60000)); // 1 minute apart
      
      // Generate different log levels for variety
      const levels = ['info', 'debug', 'warn', 'error'];
      const level = levels[i % levels.length];
      
      logs.push({
        timestamp,
        message: `Mock log entry ${i + 1} for ${service.name}`,
        level,
        source: 'mock'
      });
    }
    
    // Add a startup message
    logs.push({
      timestamp: new Date(now.getTime() - (logs.length * 60000)),
      message: `Service ${service.name} started successfully (mock)`,
      level: 'info',
      source: 'mock'
    });
    
    return logs.reverse(); // Return in chronological order
  }
}