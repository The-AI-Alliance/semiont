import { execSync } from 'child_process';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';

/**
 * Check handler for containerized database services
 */
const checkDatabaseContainer = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
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
    
    // Collect logs if platform provides collectLogs
    let logs = undefined;
    if (platform && typeof platform.collectLogs === 'function') {
      const logEntries = await platform.collectLogs(service, { tail: 10 });
      logs = logEntries;
    }
    
    // Database-specific health check
    let health = { healthy: true, details: {} };
    
    // Determine database port based on service name or requirements
    const dbPorts: Record<string, number> = {
      postgres: 5432,
      postgresql: 5432,
      mysql: 3306,
      mongodb: 27017,
      redis: 6379
    };
    
    const serviceName = service.name.toLowerCase();
    const defaultPort = dbPorts[serviceName] || 5432;
    const port = requirements.network?.ports?.[0] || defaultPort;
    
    // Try to check if database is accepting connections
    try {
      // Check if port is listening inside container
      execSync(
        `${runtime} exec ${containerName} sh -c 'echo > /dev/tcp/localhost/${port}'`,
        { encoding: 'utf-8' }
      );
      health.healthy = true;
      health.details = { 
        database: 'accepting connections',
        port,
        containerHealth: 'running'
      };
    } catch {
      health.healthy = false;
      health.details = { 
        database: 'not accepting connections',
        port,
        containerHealth: 'running'
      };
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
        serviceType: 'database',
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
 * Descriptor for database container check handler
 */
export const databaseCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'container',
  serviceType: 'database',
  handler: checkDatabaseContainer
};