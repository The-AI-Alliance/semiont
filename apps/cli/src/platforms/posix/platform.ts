/**
 * POSIX Platform Strategy
 * 
 * Runs services as native OS processes on the local machine. This platform is ideal for
 * development environments and simple deployments where containerization isn't needed.
 * 
 * Capabilities:
 * - Spawns services as child processes with environment variables
 * - Manages process lifecycle (start, stop, restart)
 * - Tracks running processes via PID files in the state directory
 * - Supports port allocation and basic health checks
 * - Provides process-level isolation through OS mechanisms
 * 
 * Requirements Handling:
 * - Compute: Uses OS-level resource limits where available
 * - Network: Binds to specified ports, checks for conflicts
 * - Storage: Uses local filesystem paths
 * - Dependencies: Verifies dependent processes are running via PID checks
 */


import { BasePlatformStrategy } from '../../core/platform-strategy.js';
import { Service } from '../../services/types.js';
import { StateManager } from '../../core/state-manager.js';
import { HandlerRegistry } from '../../core/handlers/registry.js';
import { handlers } from './handlers/index.js';

export class PosixPlatformStrategy extends BasePlatformStrategy {
  constructor() {
    super();
    this.registerHandlers();
  }
  
  private registerHandlers(): void {
    const registry = HandlerRegistry.getInstance();
    registry.registerHandlers('posix', handlers);
  }
  
  getPlatformName(): string {
    return 'posix';
  }
  
  /**
   * Determine service type for handler selection
   */
  determineServiceType(service: Service): string {
    const requirements = service.getRequirements();
    const serviceName = service.name.toLowerCase();
    
    // Check for MCP services
    if (service.name === ServiceName.MCP || 
        requirements.annotations?.['service/type'] === 'mcp') {
      return 'mcp';
    }
    
    // Check for database services
    if (requirements.annotations?.['service/type'] === 'database' ||
        serviceName.includes('postgres') || 
        serviceName.includes('mysql') || 
        serviceName.includes('mongodb') ||
        serviceName.includes('redis')) {
      return 'database';
    }
    
    // Check for web services
    if (requirements.network?.healthCheckPath ||
        requirements.annotations?.['service/type'] === 'web') {
      return 'web';
    }
    
    // Check for filesystem services
    if (requirements.annotations?.['service/type'] === 'filesystem' ||
        serviceName.includes('nfs') ||
        serviceName.includes('samba') ||
        serviceName.includes('webdav')) {
      return 'filesystem';
    }
    
    // Default to worker for everything else
    return 'worker';
  }
  
  /**
   * Build platform-specific context extensions for handlers
   */
  async buildHandlerContextExtensions(service: Service, requiresDiscovery: boolean): Promise<Record<string, any>> {
    // Load saved state for posix handlers
    const savedState = await StateManager.load(
      service.projectRoot,
      service.environment,
      service.name
    );
    
    return {
      savedState
    };
  }
}