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
import { BasePlatformStrategy } from '../../core/platform-strategy.js';
import { Service } from '../../services/types.js';
import { HandlerRegistry } from '../../core/handlers/registry.js';
import { handlers } from './handlers/index.js';

export class ContainerPlatformStrategy extends BasePlatformStrategy {

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
  protected override detectContainerRuntime(): 'docker' | 'podman' {
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
   * Determine service type for handler selection
   */
  determineServiceType(service: Service): string {
    const requirements = service.getRequirements();
    const serviceName = service.name.toLowerCase();
    
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
    
    // Default to generic
    return 'generic';
  }
  
  /**
   * Build platform-specific context extensions for handlers
   */
  async buildHandlerContextExtensions(service: Service, requiresDiscovery: boolean): Promise<Record<string, any>> {
    const containerName = this.getResourceName(service);
    
    return {
      runtime: this.runtime,
      containerName
    };
  }
}