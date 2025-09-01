import { CheckHandlerResult } from '../../../core/handlers/types.js';

/**
 * Check handler for external static sites/CDNs
 */
export async function checkExternalStatic(context: any): Promise<CheckHandlerResult> {
  const { service, endpoint } = context;
  
  let status: 'running' | 'stopped' | 'unhealthy' | 'unknown' = 'unknown';
  let health: any = undefined;
  
  if (endpoint) {
    try {
      // For static sites, just check if we can GET the root
      const startTime = Date.now();
      const response = await fetch(endpoint, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      const responseTime = Date.now() - startTime;
      
      // Static sites should return 200 or 304 (not modified)
      const isHealthy = response.ok || response.status === 304;
      status = isHealthy ? 'running' : 'unhealthy';
      
      health = {
        endpoint,
        statusCode: response.status,
        healthy: isHealthy,
        responseTime,
        details: {
          contentType: response.headers.get('content-type'),
          cacheControl: response.headers.get('cache-control')
        }
      };
    } catch (error) {
      status = 'stopped';
      health = {
        endpoint,
        healthy: false,
        error: error instanceof Error ? error.message : 'Cannot reach site'
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
      serviceType: 'static',
      endpoint,
      stateVerified: true
    }
  };
}