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
  
  /**
   * Collect logs for a service
   * Platform determines how to collect based on service type
   */
  collectLogs(service: Service, options?: LogOptions): Promise<LogEntry[] | undefined>;
  
  /**
   * Validate credentials/prerequisites for this platform
   * Returns validation result with helpful error messages if invalid
   */
  validateCredentials(environment: string): Promise<CredentialValidationResult>;
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
   * Collect logs for a service - must be implemented by each platform
   */
  abstract collectLogs(service: Service, options?: LogOptions): Promise<LogEntry[] | undefined>;
  
  /**
   * Validate credentials/prerequisites for this platform
   * Default implementation always returns valid
   */
  async validateCredentials(_environment: string): Promise<CredentialValidationResult> {
    return { valid: true };
  }
  
  /**
   * Helper to generate container/instance names
   */
  public getResourceName(service: Service): string {
    return `semiont-${service.name}-${service.environment}`;
  }
}