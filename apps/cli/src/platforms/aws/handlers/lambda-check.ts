import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';

const lambdaCheckHandler = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service, cfnDiscoveredResources } = context;
  const { region } = platform.getAWSConfig(service);
  const resourceName = platform.getResourceName(service);
  
  // Lambda doesn't use cfnDiscoveredResources, derive name directly
  const functionName = `${resourceName}-function`;
  
  try {
    // Dynamic import to avoid loading AWS SDK if not needed
    const { LambdaClient, GetFunctionCommand } = await import('@aws-sdk/client-lambda');
    const lambdaClient = new LambdaClient({ region });
    
    const response = await lambdaClient.send(new GetFunctionCommand({
      FunctionName: functionName
    }));
    
    if (response.Configuration) {
      const state = response.Configuration.State;
      const status = state === 'Active' ? 'running' : 
                     state === 'Failed' ? 'stopped' : 'unknown';
      
      const health = {
        healthy: state === 'Active',
        details: {
          state,
          runtime: response.Configuration.Runtime,
          codeSize: response.Configuration.CodeSize,
          memorySize: response.Configuration.MemorySize,
          timeout: response.Configuration.Timeout,
          lastModified: response.Configuration.LastModified
        }
      };
      
      const platformResources = createPlatformResources('aws', {
        functionArn: response.Configuration.FunctionArn,
        region: region
      });
      
      // Build Lambda-specific metadata
      const metadata: Record<string, any> = {
        functionName: functionName
      };
      
      return { 
        success: true,
        status, 
        health, 
        platformResources, 
        metadata 
      };
    } else {
      return { 
        success: true,
        status: 'stopped', 
        metadata: {} 
      };
    }
  } catch (error) {
    if (service.verbose) {
      console.log(`[DEBUG] Lambda check failed: ${error}`);
    }
    return { 
      success: false,
      status: 'unknown', 
      metadata: {},
      error: `Lambda check failed: ${error}`
    };
  }
};

export const lambdaCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  serviceType: 'lambda',
  handler: lambdaCheckHandler
};