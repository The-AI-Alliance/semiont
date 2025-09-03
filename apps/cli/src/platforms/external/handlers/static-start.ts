import { ExternalStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { PlatformResources } from '../../platform-resources.js';
import { printInfo } from '../../../core/io/cli-logger.js';

/**
 * Start handler for static services on External platform
 */
const startStaticService = async (context: ExternalStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const requirements = service.getRequirements();
  
  // Get the external CDN/static endpoint from requirements or service configuration
  const staticEndpoint = requirements.external?.endpoint || 
                        requirements.external?.cdnUrl ||
                        service.getEnvironmentVariables().CDN_URL ||
                        service.getEnvironmentVariables().STATIC_URL ||
                        service.getEnvironmentVariables().EXTERNAL_ENDPOINT;
  
  if (!staticEndpoint) {
    return {
      success: false,
      error: 'No external endpoint configured for static service',
      metadata: {
        serviceType: 'static',
        serviceName: service.name
      }
    };
  }
  
  // External static services are already deployed, we just track them
  if (!service.quiet) {
    printInfo(`Registering external static service: ${service.name}`);
    printInfo(`Endpoint: ${staticEndpoint}`);
  }
  
  // Build resource information for static content
  const resources: PlatformResources = {
    platform: 'external',
    data: {
      endpoint: staticEndpoint,
      provider: requirements.external?.cdnProvider || 'unknown'
    }
  };
  
  // Extract domain/bucket info if available
  let domain: string | undefined;
  let bucket: string | undefined;
  
  try {
    const url = new URL(staticEndpoint);
    domain = url.hostname;
    
    // Try to extract bucket name from common CDN patterns
    if (url.hostname.includes('s3')) {
      // S3 bucket patterns
      const bucketMatch = url.hostname.match(/^([^.]+)\.s3/);
      if (bucketMatch) {
        bucket = bucketMatch[1];
      } else if (url.pathname) {
        const pathParts = url.pathname.split('/').filter(p => p);
        if (pathParts.length > 0) {
          bucket = pathParts[0];
        }
      }
    } else if (url.hostname.includes('cloudfront')) {
      // CloudFront distribution
      bucket = 'cloudfront-distribution';
    } else if (url.hostname.includes('blob.core.windows')) {
      // Azure blob storage
      const containerMatch = url.pathname.match(/^\/([^\/]+)/);
      if (containerMatch) {
        bucket = containerMatch[1];
      }
    }
  } catch (error) {
    // Invalid URL, but we'll still try to register it
  }
  
  return {
    success: true,
    endpoint: staticEndpoint,
    resources,
    metadata: {
      serviceType: 'static',
      endpoint: staticEndpoint,
      domain,
      bucket,
      cdnProvider: requirements.external?.cdnProvider,
      cacheControl: requirements.external?.cacheControl,
      cors: requirements.external?.cors ? 'enabled' : 'disabled',
      indexDocument: requirements.external?.indexDocument || 'index.html',
      errorDocument: requirements.external?.errorDocument || 'error.html'
    }
  };
};

/**
 * Descriptor for static service start handler
 */
export const staticStartDescriptor: HandlerDescriptor<ExternalStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'external',
  serviceType: 'static',
  handler: startStaticService
};