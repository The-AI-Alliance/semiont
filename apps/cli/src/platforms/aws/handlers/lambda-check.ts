import { FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { AWSCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';

const lambdaCheckHandler = async (context: AWSCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service, region, resourceName } = context;
  
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
      
      // Collect Lambda-specific logs if function is running
      let logs;
      if (status === 'running') {
        try {
          // const { LambdaClient } = await import('@aws-sdk/client-lambda');
          const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
          const logsClient = new CloudWatchLogsClient({ region });
          
          // Lambda log group is deterministic: /aws/lambda/{functionName}
          const logGroupName = `/aws/lambda/${functionName}`;
          
          try {
            const response = await logsClient.send(new FilterLogEventsCommand({
              logGroupName,
              startTime: Date.now() - 2 * 60 * 60 * 1000, // Last 2 hours
              limit: 20,
              interleaved: true
            }));
            
            if (response.events && response.events.length > 0) {
              const recentLogs = response.events
                .filter(e => e.message)
                .map(e => e.message!.trim());
              
              // Filter error logs
              const errorLogs = recentLogs.filter(log => 
                /\b(error|ERROR|Error|FATAL|fatal|Fatal|exception|Exception|EXCEPTION)\b/.test(log)
              );
              
              logs = {
                recent: recentLogs.slice(0, 10), // Return the 10 most recent logs
                errors: errorLogs.slice(0, 10) // Return up to 10 error logs
              };
            }
          } catch (error) {
            // Log group might not exist if function was never invoked
            if (service.verbose) {
              console.log(`[DEBUG] Lambda log group ${logGroupName} not found or no logs available`);
            }
          }
        } catch (error) {
          if (service.verbose) {
            console.log(`[DEBUG] Failed to collect Lambda logs: ${error}`);
          }
        }
      }
      
      return { 
        success: true,
        status, 
        health, 
        platformResources, 
        metadata,
        logs
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

export const lambdaCheckDescriptor: HandlerDescriptor<AWSCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'aws',
  serviceType: 'lambda',
  handler: lambdaCheckHandler
};