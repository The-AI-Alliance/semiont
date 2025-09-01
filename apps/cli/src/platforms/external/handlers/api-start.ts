import { StartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { PlatformResources } from '../../platform-resources.js';
import { printInfo } from '../../../core/io/cli-logger.js';

/**
 * Start handler for API services on External platform
 */
const startAPIService = async (context: StartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const requirements = service.getRequirements();
  
  // Get the external endpoint from requirements or service configuration
  const externalEndpoint = requirements.external?.endpoint || 
                          service.getEnvironmentVariables().API_ENDPOINT ||
                          service.getEnvironmentVariables().EXTERNAL_ENDPOINT;
  
  if (!externalEndpoint) {
    return {
      success: false,
      error: 'No external endpoint configured for API service',
      metadata: {
        serviceType: 'api',
        serviceName: service.name
      }
    };
  }
  
  // External services are already running, we just need to verify and track them
  if (!service.quiet) {
    printInfo(`Registering external API service: ${service.name}`);
    printInfo(`Endpoint: ${externalEndpoint}`);
  }
  
  // Check if we can reach the external API
  try {
    new URL(externalEndpoint);  // Validate URL format
    const healthPath = requirements.external?.healthPath || 
                      requirements.network?.healthCheckPath || 
                      '/health';
    
    // Attempt a simple connection check (would use fetch in real implementation)
    // For now, we'll assume it's available
    
    const resources: PlatformResources = {
      platform: 'external',
      data: {
        endpoint: externalEndpoint,
        path: healthPath,
        provider: requirements.external?.apiType || 'rest'
      }
    };
    
    return {
      success: true,
      endpoint: externalEndpoint,
      resources,
      metadata: {
        serviceType: 'api',
        endpoint: externalEndpoint,
        healthPath,
        apiType: requirements.external?.apiType || 'rest',
        authentication: requirements.external?.authentication ? 'configured' : 'none',
        headers: requirements.external?.headers ? Object.keys(requirements.external.headers) : []
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Invalid external endpoint: ${error}`,
      metadata: {
        serviceType: 'api',
        endpoint: externalEndpoint
      }
    };
  }
};

/**
 * Descriptor for API service start handler
 */
export const apiStartDescriptor: HandlerDescriptor<StartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'external',
  serviceType: 'api',
  handler: startAPIService
};