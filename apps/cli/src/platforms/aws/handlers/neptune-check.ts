import {
  NeptuneClient,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand
} from '@aws-sdk/client-neptune';
import { AWSCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { GraphServiceConfig } from '@semiont/core';

/**
 * Check handler for AWS Neptune graph database
 * Neptune is provisioned via CDK and this handler checks its status
 */
const checkNeptune = async (context: AWSCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service, platform } = context;
  const awsConfig = platform.getAWSConfig(service);

  // Type narrowing for graph service config
  const serviceConfig = service.config as GraphServiceConfig;
  const graphType = serviceConfig.type || 'neptune';
  
  // Only handle Neptune type
  if (graphType !== 'neptune') {
    return {
      success: false,
      error: `AWS platform only supports Neptune graph databases, got: ${graphType}`,
      status: 'stopped',
      metadata: {
        serviceType: 'graph',
        graphType
      }
    };
  }
  
  const client = new NeptuneClient({ region: awsConfig.region });
  
  try {
    // List all Neptune clusters
    const clustersCommand = new DescribeDBClustersCommand({});
    const clustersResponse = await client.send(clustersCommand);
    
    if (!clustersResponse.DBClusters || clustersResponse.DBClusters.length === 0) {
      return {
        success: true,
        status: 'stopped',
        health: {
          healthy: false,
          details: {
            message: 'No Neptune clusters found in region'
          }
        },
        metadata: {
          serviceType: 'graph',
          graphType: 'neptune',
          region: awsConfig.region
        }
      };
    }
    
    // Find the Semiont Neptune cluster (created by CDK data stack)
    let neptuneCluster = null;
    for (const cluster of clustersResponse.DBClusters) {
      if (cluster.DBClusterIdentifier?.toLowerCase().includes('semiont') ||
          cluster.DBClusterIdentifier?.toLowerCase().includes(service.environment)) {
        neptuneCluster = cluster;
        break;
      }
    }
    
    if (!neptuneCluster) {
      return {
        success: true,
        status: 'stopped',
        health: {
          healthy: false,
          details: {
            message: `No Neptune cluster found for environment: ${service.environment}`
          }
        },
        metadata: {
          serviceType: 'graph',
          graphType: 'neptune',
          region: awsConfig.region
        }
      };
    }
    
    // Check cluster status
    const clusterStatus = neptuneCluster.Status || 'unknown';
    const isAvailable = clusterStatus === 'available';
    
    // Get instance details
    let instanceStatus = 'unknown';
    if (neptuneCluster.DBClusterMembers && neptuneCluster.DBClusterMembers.length > 0) {
      const instanceId = neptuneCluster.DBClusterMembers[0].DBInstanceIdentifier;
      if (instanceId) {
        const instanceCommand = new DescribeDBInstancesCommand({
          DBInstanceIdentifier: instanceId
        });
        try {
          const instanceResponse = await client.send(instanceCommand);
          if (instanceResponse.DBInstances && instanceResponse.DBInstances[0]) {
            instanceStatus = instanceResponse.DBInstances[0].DBInstanceStatus || 'unknown';
          }
        } catch (instanceError) {
          // Instance check is best-effort
        }
      }
    }
    
    const health = {
      healthy: isAvailable && instanceStatus === 'available',
      details: {
        clusterStatus,
        instanceStatus,
        endpoint: neptuneCluster.Endpoint,
        port: neptuneCluster.Port || 8182,
        readerEndpoint: neptuneCluster.ReaderEndpoint,
        engineVersion: neptuneCluster.EngineVersion,
        storageEncrypted: neptuneCluster.StorageEncrypted,
        iamAuthEnabled: neptuneCluster.IAMDatabaseAuthenticationEnabled
      }
    };
    
    const platformResources = {
      platform: 'aws' as const,
      data: {
        clusterId: neptuneCluster.DBClusterIdentifier,
        clusterArn: neptuneCluster.DBClusterArn,
        endpoint: neptuneCluster.Endpoint,
        port: neptuneCluster.Port || 8182,
        region: awsConfig.region
      }
    };
    
    // Get CloudWatch logs if available
    let logs: { recent: string[]; errors: string[] } | undefined;
    if (isAvailable && platform.collectLogs) {
      try {
        const logEntries = await platform.collectLogs(service, { tail: 10 });
        if (logEntries) {
          logs = {
            recent: logEntries.map(entry => entry.message),
            errors: logEntries.filter(entry => entry.level === 'error').map(entry => entry.message)
          };
        }
      } catch (logError) {
        // Log collection is best-effort
      }
    }
    
    return {
      success: true,
      status: isAvailable ? 'running' : 'stopped',
      platformResources,
      health,
      logs,
      metadata: {
        serviceType: 'graph',
        graphType: 'neptune',
        clusterId: neptuneCluster.DBClusterIdentifier,
        stateVerified: true
      }
    };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to check Neptune cluster: ${error.message}`,
      status: 'stopped',
      metadata: {
        serviceType: 'graph',
        graphType: 'neptune',
        region: awsConfig.region
      }
    };
  }
};

/**
 * Descriptor for AWS Neptune check handler
 */
export const neptuneCheckDescriptor: HandlerDescriptor<AWSCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'aws',
  serviceType: 'neptune',
  handler: checkNeptune
};