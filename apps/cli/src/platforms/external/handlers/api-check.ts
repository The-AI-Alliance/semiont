import { CheckHandlerResult } from '../../../core/handlers/types.js';

/**
 * Check handler for external API services
 */
const checkExternalAPI = async (context: any): Promise<CheckHandlerResult> => {
  const { service, endpoint } = context;
  const requirements = service.getRequirements();
  
  let status: 'running' | 'stopped' | 'unhealthy' | 'unknown' = 'unknown';
  let health: any = undefined;
  
  // Try health check if we have a health check path from requirements
  if (endpoint && requirements.network?.healthCheckPath) {
    try {
      const healthUrl = `${endpoint}${requirements.network.healthCheckPath}`;
      const startTime = Date.now();
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      const responseTime = Date.now() - startTime;
      
      status = response.ok ? 'running' : 'unhealthy';
      health = {
        endpoint: healthUrl,
        statusCode: response.status,
        healthy: response.ok,
        responseTime,
        details: { status: response.ok ? 'healthy' : 'unhealthy' }
      };
    } catch (error) {
      status = 'unhealthy';
      health = {
        endpoint: `${endpoint}${requirements.network.healthCheckPath}`,
        healthy: false,
        details: { error: error instanceof Error ? error.message : 'Health check failed' }
      };
    }
  } else if (endpoint) {
    // Just try to reach the base endpoint
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      
      status = response.ok ? 'running' : 'unhealthy';
      health = {
        endpoint,
        statusCode: response.status,
        healthy: response.ok
      };
    } catch (error) {
      status = 'stopped';
      health = {
        endpoint,
        healthy: false,
        error: error instanceof Error ? error.message : 'Cannot reach endpoint'
      };
    }
  }
  
  return {
    success: true,
    status,
    health,
    platformResources: endpoint ? {
      platform: 'external',
      data: { endpoint }
    } : undefined,
    metadata: {
      serviceType: 'api',
      endpoint,
      stateVerified: true
    }
  };
};

/**
 * Descriptor for external API check handler
 */
export const apiCheckDescriptor = {
  command: 'check',
  serviceType: 'api',
  handler: checkExternalAPI
};