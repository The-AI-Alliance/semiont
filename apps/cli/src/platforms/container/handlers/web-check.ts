import { execSync } from 'child_process';
import { ContainerCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { FrontendServiceConfig, BackendServiceConfig } from '@semiont/core';
import { baseUrl } from '@semiont/core';
import { SemiontApiClient } from '@semiont/api-client';

/**
 * Check handler for containerized web services
 */
const checkWebContainer = async (context: ContainerCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service, runtime, containerName } = context;
  const config = service.config as FrontendServiceConfig | BackendServiceConfig;
  
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
    
    // Perform health check
    let health = { healthy: true, details: {} };

    // Determine if this is a backend service (has publicURL)
    const isBackend = 'publicURL' in config;

    try {
      if (isBackend) {
        // Backend service - use API client
        const backendConfig = config as BackendServiceConfig;
        const client = new SemiontApiClient({ baseUrl: baseUrl(backendConfig.publicURL) });

        try {
          const healthData = await client.healthCheck();
          health = {
            healthy: dockerHealthStatus !== 'unhealthy',
            details: {
              health: healthData,
              endpoint: '/api/health',
              containerHealth: 'running',
              dockerHealthStatus
            }
          };
        } catch (error) {
          health = {
            healthy: false,
            details: {
              endpoint: '/api/health',
              error: error instanceof Error ? error.message : 'Health check failed',
              containerHealth: 'running'
            }
          };
        }
      } else {
        // Frontend service - check root endpoint
        const frontendConfig = config as FrontendServiceConfig;
        const healthUrl = frontendConfig.publicURL;

        if (!healthUrl) {
          return {
            success: true,
            status: 'running',
            health: {
              healthy: false,
              details: {
                error: 'Frontend publicURL not configured',
                containerHealth: 'running'
              }
            },
            metadata: { containerStatus: 'running', containerId }
          };
        }

        try {
          const response = await fetch(healthUrl, {
            signal: AbortSignal.timeout(5000)
          });
          health = {
            healthy: response.ok && dockerHealthStatus !== 'unhealthy',
            details: {
              endpoint: healthUrl,
              statusCode: response.status,
              status: response.ok ? 'healthy' : 'unhealthy',
              containerHealth: 'running',
              dockerHealthStatus
            }
          };
        } catch (error) {
          health = {
            healthy: false,
            details: {
              endpoint: healthUrl,
              error: error instanceof Error ? error.message : 'Health check failed',
              containerHealth: 'running'
            }
          };
        }
      }
    } catch (error) {
      health = {
        healthy: false,
        details: {
          error: error instanceof Error ? error.message : 'Health check failed',
          containerHealth: 'running'
        }
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
export const webCheckDescriptor: HandlerDescriptor<ContainerCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'container',
  serviceType: 'web',
  handler: checkWebContainer
};