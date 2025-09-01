import { execSync } from 'child_process';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';

/**
 * Check handler for generic containerized services
 */
const checkGenericContainer = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service, runtime, containerName } = context;
  const requirements = service.getRequirements();
  
  try {
    // Check container status
    const containerStatus = execSync(
      `${runtime} inspect ${containerName} --format '{{.State.Status}}'`,
      { encoding: 'utf-8' }
    ).trim();
    
    if (containerStatus !== 'running') {
      return {
        success: true,
        status: 'stopped',
        health: {
          healthy: false,
          details: { containerStatus }
        },
        metadata: { containerStatus }
      };
    }
    
    // Get container ID
    const containerId = execSync(
      `${runtime} inspect ${containerName} --format '{{.Id}}'`,
      { encoding: 'utf-8' }
    ).trim().substring(0, 12);
    
    // Collect logs using platform's collectLogs method
    let logs = undefined;
    if (platform && typeof platform.collectLogs === 'function') {
      logs = await platform.collectLogs(service);
    }
    
    // Build port mapping for resources if available
    const ports = requirements.network?.ports ? {
      [requirements.network.ports[0]]: String(requirements.network.ports[0])
    } : undefined;
    
    return {
      success: true,
      status: 'running',
      platformResources: {
        platform: 'container',
        data: { containerId, containerName, ports }
      },
      health: {
        healthy: true,
        details: { containerStatus: 'running' }
      },
      logs,
      metadata: {
        runtime,
        containerStatus: 'running',
        stateVerified: true
      }
    };
    
  } catch (error) {
    // Container doesn't exist
    return {
      success: true,
      status: 'stopped',
      health: {
        healthy: false,
        details: { error: 'Container not found' }
      },
      metadata: {}
    };
  }
};

/**
 * Descriptor for generic container check handler
 */
export const genericCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  serviceType: 'generic',
  handler: checkGenericContainer
};