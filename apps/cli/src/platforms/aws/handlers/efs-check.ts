import { DescribeFileSystemsCommand } from '@aws-sdk/client-efs';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';
// import { AWSPlatformStrategy } from '../platform.js';

/**
 * EFS file system check handler implementation
 */
const efsCheckHandler = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service, cfnDiscoveredResources } = context;
  const { region } = platform.getAWSConfig(service);
  const resourceName = platform.getResourceName(service);
  const accountId = platform.getAccountId(service);
  
  const fileSystemId = cfnDiscoveredResources.fileSystemId || `${resourceName}-fs`;
  
  try {
    const { efs } = platform.getAWSClients(region);
    const response = await efs.send(new DescribeFileSystemsCommand({
      FileSystemId: fileSystemId
    }));
    
    const fileSystem = response.FileSystems?.[0];
    if (fileSystem) {
      const fsStatus = fileSystem.LifeCycleState;
      const status = fsStatus === 'available' ? 'running' : 
                    fsStatus === 'deleted' ? 'stopped' : 'unknown';
      
      // Get storage metrics
      const sizeInBytes = fileSystem?.SizeInBytes;
      const storageUsedBytes = sizeInBytes?.Value || 0;
      const storageUsedStandard = sizeInBytes?.ValueInStandard || 0;
      const storageUsedIA = sizeInBytes?.ValueInIA || 0;
      
      const health = {
        healthy: fsStatus === 'available',
        details: {
          fileSystemId,
          status: fsStatus,
          storageUsedBytes,
          storageUsedStandard,
          storageUsedIA,
          throughputMode: fileSystem?.ThroughputMode,
          performanceMode: fileSystem?.PerformanceMode,
          encrypted: fileSystem?.Encrypted,
          numberOfMountTargets: fileSystem?.NumberOfMountTargets,
          provisionedThroughputInMibps: fileSystem?.ProvisionedThroughputInMibps
        }
      };
      
      const platformResources = createPlatformResources('aws', {
        volumeId: fileSystemId,
        arn: fileSystem.FileSystemArn || `arn:aws:elasticfilesystem:${region}:${accountId}:file-system/${fileSystemId}`,
        region: region
      });
      
      // Build EFS-specific metadata
      const metadata: Record<string, any> = {
        efsFileSystemId: fileSystemId
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
      console.log(`[DEBUG] EFS check failed: ${error}`);
    }
    return { 
      success: false,
      status: 'unknown', 
      metadata: {},
      error: `EFS check failed: ${error}`
    };
  }
};

/**
 * EFS check handler descriptor
 * Explicitly declares this handler is for 'check' command on 'efs' service type
 */
export const efsCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  serviceType: 'efs',
  handler: efsCheckHandler
};