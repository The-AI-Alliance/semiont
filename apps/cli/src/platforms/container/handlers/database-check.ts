import { execSync } from 'child_process';
import { ContainerCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { DatabaseServiceConfig } from '@semiont/core';

/**
 * Check handler for containerized database services
 */
const checkDatabaseContainer = async (context: ContainerCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service, runtime, containerName } = context;
  const config = service.config as DatabaseServiceConfig;
  
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
    let logs: { recent: string[]; errors: string[] } | undefined = undefined;
    if (platform && typeof platform.collectLogs === 'function') {
      const logEntries = await platform.collectLogs(service, { tail: 10 });
      if (logEntries) {
        logs = {
          recent: logEntries.map(entry => entry.message),
          errors: logEntries.filter(entry => entry.level === 'error').map(entry => entry.message)
        };
      }
    }
    
    // Database-specific health check
    let health = { healthy: true, details: {} };

    // Get port from config
    const port = config.port;
    
    // Try to check if database is accepting connections
    try {
      // Check if port is listening inside container using netstat or nc
      try {
        // First try with netstat (most reliable)
        execSync(
          `${runtime} exec ${containerName} sh -c 'netstat -ln | grep :${port}'`,
          { encoding: 'utf-8' }
        );
      } catch {
        // Fallback to nc (netcat) if netstat is not available
        execSync(
          `${runtime} exec ${containerName} sh -c 'nc -z localhost ${port}'`,
          { encoding: 'utf-8' }
        );
      }
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
    const ports = config.port ? {
      [config.port]: String(config.port)
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
export const databaseCheckDescriptor: HandlerDescriptor<ContainerCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'container',
  serviceType: 'database',
  handler: checkDatabaseContainer
};