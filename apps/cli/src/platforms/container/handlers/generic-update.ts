import { execSync } from 'child_process';
import { UpdateHandlerContext, UpdateHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo } from '../../../core/io/cli-logger.js';

/**
 * Update handler for generic container services
 * 
 * Handles updating running containers with new images:
 * - Supports rolling updates for multi-replica services
 * - Supports recreate strategy for single containers
 * - Preserves Docker/Podman compatibility
 * - Maintains zero downtime when possible
 */
const updateGenericService = async (context: UpdateHandlerContext): Promise<UpdateHandlerResult> => {
  const { service, runtime, containerName } = context;
  const requirements = service.getRequirements();
  const oldContainerId = await getContainerId(runtime, containerName);
  
  // For containers with replicas > 1, use rolling update
  const replicas = requirements.resources?.replicas || 1;
  const strategy = replicas > 1 ? 'rolling' : 'recreate';
  
  if (strategy === 'rolling' && replicas > 1) {
    // Rolling update (simplified version)
    const newContainerName = `${containerName}-new`;
    
    try {
      // Start new container alongside old one
      const { ContainerPlatformStrategy } = await import('../platform.js');
      const platform = new ContainerPlatformStrategy();
      
      // Create a temporary service config for the new container
      const tempService = Object.create(service);
      tempService.getResourceName = () => newContainerName;
      
      // Start new container
      await platform.start(tempService);
      
      // Wait for new container to be healthy
      await waitForContainer(runtime, newContainerName, requirements);
      
      // Stop old container
      try {
        execSync(`${runtime} stop ${containerName}`, { stdio: 'ignore' });
        execSync(`${runtime} rm ${containerName}`, { stdio: 'ignore' });
      } catch {
        // Old container might not exist
      }
      
      // Rename new container to original name
      execSync(`${runtime} rename ${newContainerName} ${containerName}`);
      
      const newContainerId = await getContainerId(runtime, containerName);
      
      return {
        success: true,
        previousVersion: oldContainerId,
        newVersion: newContainerId,
        strategy: 'rolling',
        downtime: 0,
        metadata: {
          runtime,
          serviceType: 'generic',
          rollbackSupported: true
        }
      };
    } catch (error) {
      return {
        success: false,
        strategy: 'rolling',
        error: `Rolling update failed: ${error}`,
        metadata: {
          runtime,
          serviceType: 'generic'
        }
      };
    }
  } else {
    // Recreate strategy
    try {
      const startTime = Date.now();
      
      // Stop old container
      if (oldContainerId) {
        if (!service.quiet) {
          printInfo(`Stopping container ${containerName}...`);
        }
        try {
          execSync(`${runtime} stop ${containerName}`, { stdio: 'ignore' });
          execSync(`${runtime} rm ${containerName}`, { stdio: 'ignore' });
        } catch {
          // Container might not exist
        }
      }
      
      // Start new container
      const { ContainerPlatformStrategy } = await import('../platform.js');
      const platform = new ContainerPlatformStrategy();
      await platform.start(service);
      
      const downtime = Date.now() - startTime;
      const newContainerId = await getContainerId(runtime, containerName);
      
      return {
        success: true,
        previousVersion: oldContainerId,
        newVersion: newContainerId,
        strategy: 'recreate',
        downtime,
        metadata: {
          runtime,
          serviceType: 'generic',
          rollbackSupported: false
        }
      };
    } catch (error) {
      return {
        success: false,
        strategy: 'recreate',
        error: `Recreate update failed: ${error}`,
        metadata: {
          runtime,
          serviceType: 'generic'
        }
      };
    }
  }
};

/**
 * Get container ID by name
 */
async function getContainerId(runtime: string, containerName: string): Promise<string | undefined> {
  try {
    const id = execSync(
      `${runtime} ps -a --filter name=^${containerName}$ --format '{{.ID}}'`,
      { encoding: 'utf-8' }
    ).trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wait for container to be ready
 */
async function waitForContainer(runtime: string, containerName: string, requirements?: any): Promise<void> {
  const maxAttempts = 30;
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    try {
      const status = execSync(
        `${runtime} inspect ${containerName} --format '{{.State.Status}}'`,
        { encoding: 'utf-8' }
      ).trim();
      
      if (status === 'running') {
        // If health check is configured, wait for it
        if (requirements?.network?.healthCheckPath) {
          try {
            const health = execSync(
              `${runtime} inspect ${containerName} --format '{{.State.Health.Status}}'`,
              { encoding: 'utf-8' }
            ).trim();
            
            if (health === 'healthy') {
              return;
            }
          } catch {
            // No health status yet
          }
        } else {
          // No health check, container is running
          return;
        }
      }
    } catch {
      // Container doesn't exist yet
    }
    
    attempts++;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error(`Container ${containerName} failed to become ready`);
}

/**
 * Descriptor for generic container update handler
 */
export const genericUpdateDescriptor: HandlerDescriptor<UpdateHandlerContext, UpdateHandlerResult> = {
  command: 'update',
  serviceType: 'generic',
  handler: updateGenericService
};