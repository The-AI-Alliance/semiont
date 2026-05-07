import { execFileSync } from 'child_process';
import { AWSStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';
import { printInfo } from '../../../core/io/cli-logger.js';
import { checkAwsCredentials, checkCommandAvailable, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Start handler for RDS database instances
 */
const startRDSInstance = async (context: AWSStartHandlerContext): Promise<StartHandlerResult> => {
  const { service, region } = context;
  const resourceName = `semiont-${service.name}-${service.environment}`;
  const instanceId = `${resourceName}-db`;
  
  try {
    execFileSync('aws', ['rds', 'start-db-instance', '--db-instance-identifier', instanceId, '--region', region], {
      encoding: 'utf-8'
    });
    
    if (!service.quiet) {
      printInfo('RDS instance starting... this may take several minutes');
    }
    
    // Try to get endpoint
    let endpoint: string | undefined;
    try {
      endpoint = execFileSync('aws', [
        'rds', 'describe-db-instances', '--db-instance-identifier', instanceId,
        '--query', 'DBInstances[0].Endpoint.Address', '--output', 'text', '--region', region
      ], { encoding: 'utf-8' }).trim();
      
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
        serviceType: 'database',
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
        serviceType: 'database',
        region,
        instanceId
      }
    };
  }
};

/**
 * Descriptor for RDS start handler
 */
const preflightRdsStart = async (_context: AWSStartHandlerContext): Promise<PreflightResult> => {
  return preflightFromChecks([checkCommandAvailable('aws'), checkAwsCredentials()]);
};

export const rdsStartDescriptor: HandlerDescriptor<AWSStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'aws',
  serviceType: 'database',
  handler: startRDSInstance,
  preflight: preflightRdsStart,
  requiresDiscovery: false
};