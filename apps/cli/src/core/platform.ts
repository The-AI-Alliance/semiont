/**
 * Platform Abstract Class
 * 
 * Base class for all platform implementations.
 * Each platform (AWS, Container, POSIX, etc.) extends this class
 * to provide platform-specific behavior for service operations.
 */

import { Service } from './service-interface.js';
import { getServiceTypeFromAnnotations } from './service-types.js';

/**
 * Platform type identifier
 */
export type PlatformType = 'aws' | 'container' | 'posix' | 'external' | 'mock';

/**
 * Options for collecting logs
 */
export interface LogOptions {
  tail?: number;        // Number of recent lines (default: 10)
  since?: Date;         // Logs since this time
  filter?: string;      // Filter pattern
  level?: string;       // Log level filter
}

/**
 * Represents a single log entry
 */
export interface LogEntry {
  timestamp: Date;
  message: string;
  level?: string;
  source?: string;      // Container ID, process name, etc.
}

/**
 * Result of credential validation
 */
export interface CredentialValidationResult {
  valid: boolean;
  error?: string;
  requiresAction?: string;  // Command or action user should take to fix
  details?: Record<string, any>;  // Platform-specific details
}

/**
 * Abstract base class for all platform implementations
 */
export abstract class Platform {
  
  /**
   * Get the platform name for logging and identification
   */
  abstract getPlatformName(): string;
  
  /**
   * Build platform-specific context extensions for handlers
   * Including resource discovery if needed
   */
  abstract buildHandlerContextExtensions(
    service: Service, 
    requiresDiscovery: boolean
  ): Promise<Record<string, any>>;
  
  /**
   * Collect logs for a service
   * Platform determines how to collect based on service type
   */
  abstract collectLogs(service: Service, options?: LogOptions): Promise<LogEntry[] | undefined>;
  
  /**
   * Get standardized resource name for the service
   */
  getResourceName(service: Service): string {
    return `semiont-${service.name}-${service.environment}`;
  }
  
  /**
   * Determine service type from service requirements.
   * Requires an explicit service/type annotation — no guessing.
   */
  determineServiceType(service: Service): string {
    const requirements = service.getRequirements();
    const declaredType = getServiceTypeFromAnnotations(requirements.annotations);

    if (!declaredType) {
      throw new Error(
        `Service '${service.name}' does not declare a service/type annotation in getRequirements(). ` +
        `All services must explicitly declare their type.`
      );
    }

    return this.mapServiceType(declaredType);
  }

  /**
   * Map generic service type to platform-specific handler type.
   * Override in platform implementations if needed.
   */
  protected mapServiceType(declaredType: string): string {
    return declaredType;
  }
  
  /**
   * Whether this platform manages service lifecycle (provision/start/stop).
   * Returns true for platforms that run services (posix, container, aws).
   * Returns false for platforms that only observe (external).
   */
  managesLifecycle(): boolean {
    return true;
  }

  /**
   * Quick check if a service is running without full context
   * Default implementation returns false
   */
  async quickCheckRunning(_state: import('./state-manager.js').ServiceState): Promise<boolean> {
    return false;
  }
  
  /**
   * Validate platform credentials
   * Default implementation returns valid (no credentials needed)
   */
  async validateCredentials(_environment: string): Promise<CredentialValidationResult> {
    return { valid: true };
  }
}