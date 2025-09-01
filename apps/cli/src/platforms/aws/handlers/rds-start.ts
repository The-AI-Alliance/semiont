import { execSync } from 'child_process';
import { StartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';
import { printInfo } from '../../../core/io/cli-logger.js';

/**
 * Start handler for RDS database instances
 */
const startRDSInstance = async (context: StartHandlerContext): Promise<StartHandlerResult> => {
  const { service, region } = context;
  const resourceName = `semiont-${service.name}-${service.environment}`;
  const instanceId = `${resourceName}-db`;
  
  try {
    execSync(
      `aws rds start-db-instance --db-instance-identifier ${instanceId} --region ${region}`,
      { encoding: 'utf-8' }
    );
    
    if (!service.quiet) {
      printInfo('RDS instance starting... this may take several minutes');
    }
    
    // Try to get endpoint
    let endpoint: string | undefined;
    try {
      endpoint = execSync(
        `aws rds describe-db-instances --db-instance-identifier ${instanceId} --query 'DBInstances[0].Endpoint.Address' --output text --region ${region}`,
        { encoding: 'utf-8' }
      ).trim();
      
      if (endpoint === 'None') {
        endpoint = undefined;
      }
    } catch {
      // Instance might not be ready yet
    }
    
    const resources = createPlatformResources('aws', {
      instanceId,
      region
    });
    
    return {
      success: true,
      endpoint,
      resources,
      metadata: {
        serviceType: 'rds',
        region,
        instanceId,
        message: 'RDS instance starting... this may take several minutes'
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to start RDS instance: ${error}`,
      metadata: {
        serviceType: 'rds',
        region,
        instanceId
      }
    };
  }
};

/**
 * Descriptor for RDS start handler
 */
export const rdsStartDescriptor: HandlerDescriptor<StartHandlerContext, StartHandlerResult> = {
  command: 'start',
  serviceType: 'rds',
  handler: startRDSInstance,
  requiresDiscovery: false
};