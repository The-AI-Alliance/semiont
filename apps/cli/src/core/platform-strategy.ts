/**
 * Platform Strategy Interface
 * 
 * Defines how services are managed across different deployment platforms.
 * Each platform (process, container, AWS, external) implements this interface
 * to provide platform-specific behavior for common operations.
 */

// Command result types are now under core/commands
import { Service } from '../services/types.js';


/**
 * Platform strategy interface
 * Implemented by each deployment platform (process, container, AWS, external)
 */
export interface PlatformStrategy {

  getResourceName(service: Service): string;

  determineServiceType(service: Service): string;

  /**
   * Build platform-specific context extensions for handlers
   * Including resource discovery if needed
   */
  buildHandlerContextExtensions(service: Service, requiresDiscovery: boolean): Promise<Record<string, any>>;
  
  /**
   * Get the platform name for logging
   */
  getPlatformName(): string;
  
  /**
   * Quick check if a service is running without full context
   */
  quickCheckRunning?(state: import('./state-manager.js').ServiceState): Promise<boolean>;
}

/**
 * Base platform strategy with common functionality
 */
export abstract class BasePlatformStrategy implements PlatformStrategy {

  abstract determineServiceType(service: Service): string;
  abstract buildHandlerContextExtensions(service: Service, requiresDiscovery: boolean): Promise<Record<string, any>>;
  
  abstract getPlatformName(): string;
  
  
  /**
   * Quick check if a service is running without full context
   * Default implementation returns false
   */
  async quickCheckRunning(_state: import('./state-manager.js').ServiceState): Promise<boolean> {
    return false;
  }
  
  /**
   * Helper to generate container/instance names
   */
  public getResourceName(service: Service): string {
    return `semiont-${service.name}-${service.environment}`;
  }
  
  /**
   * Helper to detect container runtime
   */
  protected detectContainerRuntime(): 'docker' | 'podman' {
    const fs = require('fs');
    return fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
  }
}