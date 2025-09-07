/**
 * Container Platform Strategy
 * 
 * Runs services in isolated containers using Docker or Podman. This platform provides
 * consistent environments across development, testing, and production deployments.
 * 
 * Capabilities:
 * - Auto-detects and uses available container runtime (Docker or Podman)
 * - Creates containers with resource limits based on service requirements
 * - Manages container lifecycle (start, stop, restart, update)
 * - Supports volume mounts for persistent storage
 * - Provides network isolation and port mapping
 * - Enables exec into running containers for debugging
 * 
 * Requirements Handling:
 * - Compute: Sets memory limits and CPU shares on containers
 * - Network: Maps container ports to host ports, creates networks
 * - Storage: Mounts volumes for persistent and ephemeral storage
 * - Dependencies: Ensures dependent containers are running and networked
 * - Build: Can build images from Dockerfile when specified
 */

import { execSync } from 'child_process';
import { Platform, LogOptions, LogEntry } from '../../core/platform.js';
import { Service } from '../../core/service-interface.js';
import { HandlerRegistry } from '../../core/handlers/registry.js';
import { handlers } from './handlers/index.js';
import { StateManager } from '../../core/state-manager.js';

export class ContainerPlatform extends Platform {

  private runtime: 'docker' | 'podman';
  
  constructor() {
    super();
    this.runtime = this.detectContainerRuntime();
    this.registerHandlers();
  }
  
  private registerHandlers(): void {
    const registry = HandlerRegistry.getInstance();
    registry.registerHandlers('container', handlers);
  }
  
  getPlatformName(): string {
    return 'container';
  }

  
  /**
   * Helper method to detect container runtime
   */
  private detectContainerRuntime(): 'docker' | 'podman' {
    try {
      execSync('docker version', { stdio: 'ignore' });
      return 'docker';
    } catch {
      try {
        execSync('podman version', { stdio: 'ignore' });
        return 'podman';
      } catch {
        throw new Error('No container runtime (Docker or Podman) found');
      }
    }
  }
  
  /**
   * Get standardized resource name for container
   */
  override getResourceName(service: Service): string {
    return `semiont-${service.name}-${service.environment}`;
  }
  
  
  /**
   * Quick check if a container is running using saved state
   * This is faster than doing a full check() call
   */
  override async quickCheckRunning(state: import('../../core/state-manager.js').ServiceState): Promise<boolean> {
    if (!state.resources || state.resources.platform !== 'container') {
      return false;
    }
    
    const containerId = state.resources.data.containerId;
    if (!containerId) {
      return false;
    }
    
    try {
      const status = execSync(
        `${this.runtime} inspect ${containerId} --format '{{.State.Status}}'`,
        { encoding: 'utf-8', stdio: 'pipe' }
      ).trim();
      
      return status === 'running';
    } catch {
      // Container doesn't exist or error checking
      return false;
    }
  }
  
  /**
   * Map service types to container handler types
   */
  protected override mapServiceType(declaredType: string): string {
    // Container uses 'web' handler for frontend/backend services
    if (declaredType === 'frontend' || declaredType === 'backend') {
      return 'web';
    }
    
    // Database gets special handler
    if (declaredType === 'database') return 'database';
    
    // Everything else uses generic handler
    return 'generic';
  }
  
  /**
   * Build platform-specific context extensions for handlers
   */
  async buildHandlerContextExtensions(service: Service, _requiresDiscovery: boolean): Promise<Record<string, any>> {
    const containerName = this.getResourceName(service);
    
    return {
      runtime: this.runtime,
      containerName
    };
  }
  
  /**
   * Collect logs for a container service
   * Uses docker/podman logs command
   */
  async collectLogs(service: Service, options?: LogOptions): Promise<LogEntry[] | undefined> {
    const serviceType = this.determineServiceType(service);
    const state = await StateManager.load(
      service.projectRoot,
      service.environment,
      service.name
    );
    
    // Get container ID from state
    const containerId = state?.resources?.platform === 'container' 
      ? state.resources.data.containerId 
      : undefined;
      
    if (!containerId) {
      // Try to find container by name as fallback
      const containerName = this.getResourceName(service);
      return this.collectContainerLogs(containerName, serviceType, options);
    }
    
    return this.collectContainerLogs(containerId, serviceType, options);
  }
  
  /**
   * Collect logs from a container
   */
  private async collectContainerLogs(
    containerIdOrName: string,
    serviceType: string,
    options?: LogOptions
  ): Promise<LogEntry[] | undefined> {
    const { tail = 10, since, filter, level } = options || {};
    const logs: LogEntry[] = [];
    
    try {
      // Build docker/podman logs command
      let cmd = `${this.runtime} logs ${containerIdOrName}`;
      
      // Add tail option
      cmd += ` --tail ${tail}`;
      
      // Add timestamps for parsing
      cmd += ' --timestamps';
      
      // Add since option if provided
      if (since) {
        const sinceStr = since.toISOString();
        cmd += ` --since "${sinceStr}"`;
      }
      
      // Execute command
      const output = execSync(cmd, { 
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'] // Capture both stdout and stderr
      });
      
      // Parse container log output
      const lines = output.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        const entry = this.parseContainerLogLine(line, serviceType);
        
        // Apply filters if specified
        if (filter && !entry.message.includes(filter)) {
          continue;
        }
        
        if (level && entry.level !== level) {
          continue;
        }
        
        logs.push(entry);
      }
      
      return logs.length > 0 ? logs : undefined;
      
    } catch (error) {
      // Container might not exist or logs might not be available
      console.debug(`Failed to collect logs for container ${containerIdOrName}:`, error);
      return undefined;
    }
  }
  
  /**
   * Parse a container log line
   * Docker/Podman format with --timestamps: 2024-01-01T12:00:00.000000000Z message
   */
  private parseContainerLogLine(line: string, serviceType: string): LogEntry {
    // Try to parse timestamp from beginning of line
    const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.[\d]+Z)\s+(.*)$/);
    
    let timestamp: Date;
    let message: string;
    
    if (timestampMatch) {
      timestamp = new Date(timestampMatch[1]);
      message = timestampMatch[2];
    } else {
      // No timestamp found, use current time
      timestamp = new Date();
      message = line;
    }
    
    // Try to detect log level from message
    let level: string | undefined;
    if (/\b(ERROR|ERR|FATAL|CRITICAL)\b/i.test(message)) {
      level = 'error';
    } else if (/\b(WARN|WARNING)\b/i.test(message)) {
      level = 'warn';
    } else if (/\b(DEBUG|TRACE)\b/i.test(message)) {
      level = 'debug';
    } else if (/\b(INFO|LOG)\b/i.test(message)) {
      level = 'info';
    }
    
    // Service-type specific parsing
    if (serviceType === 'database') {
      // Try to parse database-specific formats
      const dbEntry = this.parseDatabaseContainerLog(message);
      if (dbEntry.level) level = dbEntry.level;
      if (dbEntry.message) message = dbEntry.message;
    }
    
    return {
      timestamp,
      message,
      level,
      source: 'container'
    };
  }
  
  /**
   * Parse database-specific log formats in containers
   */
  private parseDatabaseContainerLog(message: string): { message?: string; level?: string } {
    // PostgreSQL in container
    const pgMatch = message.match(/^.*?(LOG|ERROR|WARNING|INFO|DEBUG):\s+(.*)$/);
    if (pgMatch) {
      return {
        level: pgMatch[1].toLowerCase(),
        message: pgMatch[2]
      };
    }
    
    // MySQL in container
    const mysqlMatch = message.match(/^.*?\[(\w+)\]\s+(.*)$/);
    if (mysqlMatch) {
      return {
        level: mysqlMatch[1].toLowerCase(),
        message: mysqlMatch[2]
      };
    }
    
    // MongoDB in container
    const mongoMatch = message.match(/^.*?"s":"(\w+)".*?"msg":"([^"]+)"/);
    if (mongoMatch) {
      const severityMap: Record<string, string> = {
        'F': 'error',  // Fatal
        'E': 'error',  // Error
        'W': 'warn',   // Warning
        'I': 'info',   // Info
        'D': 'debug'   // Debug
      };
      return {
        level: severityMap[mongoMatch[1]] || 'info',
        message: mongoMatch[2]
      };
    }
    
    return {};
  }
}