import { execSync } from 'child_process';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';

/**
 * Check handler for containerized web services
 */
const checkWebContainer = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
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
    
    // Check Docker native health status if available
    let dockerHealthStatus: string | undefined;
    try {
      dockerHealthStatus = execSync(
        `${runtime} inspect ${containerName} --format '{{.State.Health.Status}}'`,
        { encoding: 'utf-8' }
      ).trim();
    } catch {
      // No health check configured in container
    }
    
    // Collect logs if platform provides collectLogs
    let logs = undefined;
    if (platform && typeof platform.collectLogs === 'function') {
      const logEntries = await platform.collectLogs(service, { tail: 10 });
      logs = logEntries;
    }
    
    // Perform health check if available
    let health = { healthy: true, details: {} };
    if (requirements.network?.healthCheckPath) {
      try {
        const port = requirements.network?.healthCheckPort || requirements.network?.ports?.[0] || 3000;
        const healthUrl = `http://localhost:${port}${requirements.network.healthCheckPath}`;
        
        // Try external health check first
        try {
          const response = await fetch(healthUrl, {
            signal: AbortSignal.timeout(5000)
          });
          health = {
            endpoint: healthUrl,
            statusCode: response.status,
            healthy: response.ok && dockerHealthStatus !== 'unhealthy',
            details: { 
              status: response.ok ? 'healthy' : 'unhealthy',
              containerHealth: 'running',
              dockerHealthStatus
            }
          };
        } catch {
          // Fall back to container exec
          const healthCheck = execSync(
            `${runtime} exec ${containerName} curl -f -s ${healthUrl}`,
            { encoding: 'utf-8' }
          );
          health.healthy = true;
          health.details = { healthCheck: 'passed', containerHealth: 'running' };
        }
      } catch (error) {
        health = {
          healthy: false,
          details: { 
            endpoint: `http://localhost:${requirements.network?.healthCheckPort || requirements.network?.ports?.[0]}${requirements.network.healthCheckPath}`,
            error: error instanceof Error ? error.message : 'Health check failed',
            containerHealth: 'running'
          }
        };
      }
    }
    
    // Build port mapping for resources
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
      health,
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
 * Descriptor for web container check handler
 */
export const webCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'container',
  serviceType: 'web',
  handler: checkWebContainer
};