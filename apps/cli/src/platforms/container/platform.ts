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
import * as path from "path";
import * as fs from 'fs';
import { BasePlatformStrategy } from '../../core/platform-strategy.js';
import { Service } from '../../services/types.js';
import type { 
  UpdateResult, 
  ProvisionResult,
  PublishResult,
  CheckResult 
} from '../../core/command-types.js';
import { printInfo, printWarning } from '../../core/io/cli-logger.js';
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
  
  async update(service: Service): Promise<UpdateResult> {
    const requirements = service.getRequirements();
    const containerName = this.getResourceName(service);
    const oldContainerId = await this.getContainerId(containerName);
    
    // For containers with replicas > 1, use rolling update
    const replicas = requirements.resources?.replicas || 1;
    const strategy = replicas > 1 ? 'rolling' : 'recreate';
    
    if (strategy === 'rolling' && replicas > 1) {
      // Rolling update (simplified version)
      const newContainerName = `${containerName}-new`;
      
      // Start new container
      // Create a new service instance for the rolling update
      const startResult = await this.start(service);
      
      // Wait for health check
      await this.waitForContainer(newContainerName, requirements);
      
      // Stop old container
      await this.stop(service);
      
      // Rename new container
      execSync(`${this.runtime} rename ${newContainerName} ${containerName}`);
      
      return {
        entity: service.name,
        platform: 'container',
        success: true,
        updateTime: new Date(),
        previousVersion: oldContainerId,
        newVersion: startResult.resources?.platform === 'container' ? 
          startResult.resources.data.containerId : undefined,
        strategy: 'rolling',
        metadata: {
          rollbackSupported: true,
          downtime: 0
        }
      };
    } else {
      // Recreate strategy
      await this.stop(service);
      const startResult = await this.start(service);
      
      return {
        entity: service.name,
        platform: 'container',
        success: true,
        updateTime: new Date(),
        previousVersion: oldContainerId,
        newVersion: startResult.resources?.platform === 'container' ? 
          startResult.resources.data.containerId : undefined,
        strategy: 'recreate',
        metadata: {
          rollbackSupported: false
        }
      };
    }
  }
  
  async provision(service: Service): Promise<ProvisionResult> {
    const requirements = service.getRequirements();
    
    if (!service.quiet) {
      printInfo(`Provisioning ${service.name} for container deployment...`);
    }
    
    // Ensure container runtime is available
    if (!this.runtime) {
      throw new Error('No container runtime (Docker or Podman) found');
    }
    
    const dependencies = requirements.dependencies?.services || [];
    const metadata: any = {
      runtime: this.runtime
    };
    
    // Create network if it doesn't exist
    const networkName = `semiont-${service.environment}`;
    try {
      execSync(`${this.runtime} network create ${networkName}`, { stdio: 'ignore' });
      metadata.network = networkName;
    } catch {
      // Network might already exist
    }
    
    // Create volumes from storage requirements
    if (requirements.storage) {
      const volumes: string[] = [];
      for (const storage of requirements.storage) {
        if (storage.persistent) {
          const volumeName = storage.volumeName || `semiont-${service.name}-data-${service.environment}`;
          try {
            execSync(`${this.runtime} volume create ${volumeName}`);
            volumes.push(volumeName);
            
            if (!service.quiet) {
              printInfo(`Created volume: ${volumeName}`);
            }
          } catch {
            // Volume might already exist
          }
        }
      }
      if (volumes.length > 0) {
        metadata.volumes = volumes;
      }
    }
    
    // Pull or build image based on build requirements
    if (requirements.build && !requirements.build.prebuilt) {
      // Build image from Dockerfile
      const dockerfile = requirements.build.dockerfile || 'Dockerfile';
      const buildContext = requirements.build.buildContext || service.projectRoot;
      const imageTag = `${service.name}:${service.environment}`;
      
      if (fs.existsSync(path.join(buildContext, dockerfile))) {
        if (!service.quiet) {
          printInfo(`Building image ${imageTag} from ${dockerfile}...`);
        }
        
        const buildArgs = [];
        if (requirements.build.buildArgs) {
          for (const [key, value] of Object.entries(requirements.build.buildArgs)) {
            buildArgs.push(`--build-arg ${key}=${value}`);
          }
        }
        
        if (requirements.build.target) {
          buildArgs.push(`--target ${requirements.build.target}`);
        }
        
        execSync(
          `${this.runtime} build -t ${imageTag} -f ${dockerfile} ${buildArgs.join(' ')} .`,
          { cwd: buildContext }
        );
        
        metadata.image = imageTag;
        metadata.built = true;
      }
    } else {
      // Pull pre-built image
      const image = service.getImage();
      if (!service.quiet) {
        printInfo(`Pulling image ${image}...`);
      }
      
      try {
        execSync(`${this.runtime} pull ${image}`);
        metadata.image = image;
        metadata.pulled = true;
      } catch (error) {
        printWarning(`Failed to pull image ${image}, will try to use local`);
      }
    }
    
    // Check external dependencies
    if (requirements.dependencies?.external) {
      for (const ext of requirements.dependencies.external) {
        if (ext.required && ext.healthCheck) {
          try {
            const response = await fetch(ext.healthCheck, {
              signal: AbortSignal.timeout(5000)
            });
            if (!response.ok && ext.required) {
              throw new Error(`Required external dependency '${ext.name}' is not available`);
            }
          } catch (error) {
            if (ext.required) {
              throw new Error(`Required external dependency '${ext.name}' is not reachable`);
            }
          }
        }
      }
    }
    
    return {
      entity: service.name,
      platform: 'container',
      success: true,
      provisionTime: new Date(),
      dependencies,
      metadata
    };
  }
  
  async publish(service: Service): Promise<PublishResult> {
    const requirements = service.getRequirements();
    const imageTag = `${service.name}:${service.environment}`;
    const version = new Date().toISOString().replace(/[:.]/g, '-');
    const versionedTag = `${service.name}:${version}`;
    
    if (!service.quiet) {
      printInfo(`Publishing ${service.name} for container deployment...`);
    }
    
    const artifacts: PublishResult['artifacts'] = {};
    
    // Build image if build requirements exist
    if (requirements.build && !requirements.build.prebuilt) {
      const dockerfile = requirements.build.dockerfile || 'Dockerfile';
      const buildContext = requirements.build.buildContext || 
        path.join(service.projectRoot, 'apps', service.name);
      
      if (fs.existsSync(path.join(buildContext, dockerfile))) {
        if (!service.quiet) {
          printInfo(`Building container image ${versionedTag}...`);
        }
        
        // Build with version tag
        const buildArgs = [];
        if (requirements.build.buildArgs) {
          for (const [key, value] of Object.entries(requirements.build.buildArgs)) {
            buildArgs.push(`--build-arg ${key}=${value}`);
          }
        }
        
        if (requirements.build.target) {
          buildArgs.push(`--target ${requirements.build.target}`);
        }
        
        execSync(
          `${this.runtime} build -t ${versionedTag} -t ${imageTag} -f ${dockerfile} ${buildArgs.join(' ')} .`,
          { cwd: buildContext }
        );
        
        artifacts.imageTag = versionedTag;
        artifacts.imageUrl = versionedTag; // Local image
        
        // Get image size (could be stored in metadata if needed)
        execSync(
          `${this.runtime} images ${versionedTag} --format "{{.Size}}"`,
          { encoding: 'utf-8' }
        ).trim();
      }
    }
    
    // Push to registry if specified in annotations
    const registryUrl = requirements.annotations?.['container/registry'];
    if (registryUrl && artifacts.imageTag) {
      const remoteTag = `${registryUrl}/${versionedTag}`;
      
      if (!service.quiet) {
        printInfo(`Pushing image to ${registryUrl}...`);
      }
      
      try {
        // Tag for remote registry
        execSync(`${this.runtime} tag ${versionedTag} ${remoteTag}`);
        
        // Push to registry
        execSync(`${this.runtime} push ${remoteTag}`);
        
        artifacts.imageUrl = remoteTag;
        artifacts.registry = registryUrl;
      } catch (error) {
        printWarning(`Failed to push to registry: ${error}`);
      }
    }
    
    // Export image to tar if requested
    if (requirements.annotations?.['container/export'] === 'true') {
      const exportPath = path.join(service.projectRoot, 'dist', `${service.name}-${version}.tar`);
      fs.mkdirSync(path.dirname(exportPath), { recursive: true });
      
      execSync(`${this.runtime} save -o ${exportPath} ${versionedTag}`);
      artifacts.bundleUrl = `file://${exportPath}`;
      // Store bundle size in metadata
    }
    
    return {
      entity: service.name,
      platform: 'container',
      success: true,
      publishTime: new Date(),
      artifacts,
      version: {
        current: version,
        previous: 'latest'
      },
      rollback: {
        supported: true,
        command: `${this.runtime} run ${imageTag}`
      },
      metadata: {
        runtime: this.runtime,
        buildRequirements: requirements.build
      }
    };
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
   * Wait for container to be ready
   */
  private async waitForContainer(containerName: string, requirements?: any): Promise<void> {
    const maxAttempts = 30;
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      try {
        const status = execSync(
          `${this.runtime} inspect ${containerName} --format '{{.State.Status}}'`,
          { encoding: 'utf-8' }
        ).trim();
        
        if (status === 'running') {
          // If health check is configured, wait for it
          if (requirements?.network?.healthCheckPath) {
            try {
              const health = execSync(
                `${this.runtime} inspect ${containerName} --format '{{.State.Health.Status}}'`,
                { encoding: 'utf-8' }
              ).trim();
              
              if (health === 'healthy') {
                return;
              }
            } catch {
              // No health status yet
            }
          } else {
            return; // Container is running, no health check configured
          }
        }
      } catch {
        // Container might not exist yet
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }
    
    throw new Error(`Container ${containerName} failed to start within ${maxAttempts} seconds`);
  }
  
  /**
   * Check if container is running
   */
  private isContainerRunning(containerName: string): boolean {
    try {
      const status = execSync(
        `${this.runtime} inspect ${containerName} --format '{{.State.Status}}'`,
        { encoding: 'utf-8' }
      ).trim();
      return status === 'running';
    } catch {
      return false;
    }
  }
  
  /**
   * Get container ID
   */
  private async getContainerId(containerName: string): Promise<string | undefined> {
    try {
      return execSync(
        `${this.runtime} inspect ${containerName} --format '{{.Id}}'`,
        { encoding: 'utf-8' }
      ).trim().substring(0, 12);
    } catch {
      return undefined;
    }
  }
  
  
  /**
   * Parse coverage output
   */
  private parseCoverageOutput(output: string, framework: string): any {
    const coverage: any = {};
    
    if (framework === 'jest') {
      const match = output.match(/Lines\s+:\s+([\d.]+)%.*?Branches\s+:\s+([\d.]+)%.*?Functions\s+:\s+([\d.]+)%.*?Statements\s+:\s+([\d.]+)%/s);
      if (match) {
        coverage.lines = parseFloat(match[1]);
        coverage.branches = parseFloat(match[2]);
        coverage.functions = parseFloat(match[3]);
        coverage.statements = parseFloat(match[4]);
      }
    }
    
    return Object.keys(coverage).length > 0 ? coverage : undefined;
  }
  
  /**
   * Parse test failures
   */
  private parseFailures(output: string, _framework: string): any[] {
    const failures: any[] = [];
    const failureRegex = /✕\s+(.+?)(?:\s+\([\d.]+\s*ms\))?$/gm;
    let match;
    
    while ((match = failureRegex.exec(output)) !== null) {
      failures.push({
        test: match[1],
        suite: 'unknown',
        error: 'Test failed'
      });
      
      if (failures.length >= 10) break;
    }
    
    return failures;
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