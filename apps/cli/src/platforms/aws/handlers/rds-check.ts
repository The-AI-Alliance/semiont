import { DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';

/**
 * RDS database instance check handler implementation
 */
const rdsCheckHandler = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service, cfnDiscoveredResources } = context;
  const { region } = platform.getAWSConfig(service);
  const resourceName = platform.getResourceName(service);
  const accountId = platform.getAccountId(service);
  
  const dbInstanceId = cfnDiscoveredResources.dbInstanceId || `${resourceName}-db`;
  
  try {
    const { rds } = platform.getAWSClients(region);
    const response = await rds.send(new DescribeDBInstancesCommand({
      DBInstanceIdentifier: dbInstanceId
    }));
    
    const dbInstance = response.DBInstances?.[0];
    if (dbInstance) {
      const dbStatus = dbInstance.DBInstanceStatus;
      const status = dbStatus === 'available' ? 'running' : 
                     dbStatus === 'stopped' ? 'stopped' : 'unknown';
      
      const health = {
        healthy: dbStatus === 'available',
        details: {
          status: dbStatus,
          engine: dbInstance.Engine,
          engineVersion: dbInstance.EngineVersion,
          instanceClass: dbInstance.DBInstanceClass,
          allocatedStorage: dbInstance.AllocatedStorage,
          multiAZ: dbInstance.MultiAZ,
          endpoint: dbInstance.Endpoint?.Address,
          port: dbInstance.Endpoint?.Port,
          backupRetention: dbInstance.BackupRetentionPeriod,
          storageEncrypted: dbInstance.StorageEncrypted
        }
      };
      
      const platformResources = createPlatformResources('aws', {
        instanceId: dbInstanceId,
        arn: dbInstance.DBInstanceArn || `arn:aws:rds:${region}:${accountId}:db:${dbInstanceId}`,
        region: region,
        endpoint: dbInstance.Endpoint?.Address
     });
      
      // Build RDS-specific metadata
      const metadata: Record<string, any> = {
        rdsInstanceId: dbInstanceId
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
      console.log(`[DEBUG] RDS check failed: ${error}`);
    }
    return { 
      success: false,
      status: 'unknown', 
      metadata: {},
      error: `RDS check failed: ${error}`
    };
  }
};

/**
 * RDS check handler descriptor
 * Explicitly declares this handler is for 'check' command on 'rds' service type
 */
export const rdsCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  serviceType: 'rds',
  handler: rdsCheckHandler
};