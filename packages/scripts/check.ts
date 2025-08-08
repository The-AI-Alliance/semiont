
import { ECSClient, DescribeServicesCommand, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { EFSClient, DescribeFileSystemsCommand, DescribeMountTargetsCommand } from '@aws-sdk/client-efs';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { WAFV2Client, GetWebACLCommand } from '@aws-sdk/client-wafv2';
import { SemiontStackConfig } from './lib/stack-config';
import { ServiceType, AWSError } from './lib/types';
import { logger } from './lib/logger';
import { config } from '@semiont/config';
import React from 'react';
import { render, Text, Box } from 'ink';
import { SimpleTable } from './lib/ink-utils';

const stackConfig = new SemiontStackConfig();
const ecsClient = new ECSClient({ region: config.aws.region });
const rdsClient = new RDSClient({ region: config.aws.region });
const efsClient = new EFSClient({ region: config.aws.region });
const cloudWatchClient = new CloudWatchClient({ region: config.aws.region });
const costExplorerClient = new CostExplorerClient({ region: 'us-east-1' }); // Cost Explorer only works in us-east-1
const albClient = new ElasticLoadBalancingV2Client({ region: config.aws.region });
const wafClient = new WAFV2Client({ region: config.aws.region });

async function checkWebsiteHealth(url: string): Promise<{ status: number | string; healthy: boolean }> {
  try {
    const response = await fetch(url, { 
      method: 'HEAD',
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });
    return {
      status: response.status,
      healthy: response.status >= 200 && response.status < 400
    };
  } catch (error) {
    return {
      status: 'FAIL',
      healthy: false
    };
  }
}

async function getServiceStatus(serviceType: ServiceType) {
  const clusterName = await stackConfig.getClusterName();
  const serviceName = serviceType === 'frontend' 
    ? await stackConfig.getFrontendServiceName()
    : await stackConfig.getBackendServiceName();

  const response = await ecsClient.send(
    new DescribeServicesCommand({
      cluster: clusterName,
      services: [serviceName],
    })
  );

  const service = response.services?.[0];
  if (!service) {
    throw new AWSError(`${serviceType} service not found`, { serviceType });
  }

  return {
    type: serviceType,
    status: service.status,
    runningCount: service.runningCount,
    desiredCount: service.desiredCount,
    deploymentStatus: service.deployments?.[0]?.status,
    deployments: service.deployments?.map(deployment => ({
      status: deployment.status,
      taskDefinition: deployment.taskDefinition?.split('/').pop(),
      revision: deployment.taskDefinition?.split(':').pop(),
      createdAt: deployment.createdAt,
      updatedAt: deployment.updatedAt,
      rolloutState: deployment.rolloutState,
      rolloutStateReason: deployment.rolloutStateReason,
    })) || [],
    events: service.events?.slice(0, 5).map(event => ({
      message: event.message,
      createdAt: event.createdAt,
    })) || [],
  };
}

async function getRecentTasks(serviceType: ServiceType) {
  const clusterName = await stackConfig.getClusterName();
  const serviceName = serviceType === 'frontend' 
    ? await stackConfig.getFrontendServiceName()
    : await stackConfig.getBackendServiceName();

  const tasksResponse = await ecsClient.send(
    new ListTasksCommand({
      cluster: clusterName,
      serviceName: serviceName,
      maxResults: 3,
    })
  );

  if (!tasksResponse.taskArns || tasksResponse.taskArns.length === 0) {
    return [];
  }

  const tasksDetailResponse = await ecsClient.send(
    new DescribeTasksCommand({
      cluster: clusterName,
      tasks: tasksResponse.taskArns,
    })
  );

  return tasksDetailResponse.tasks?.map(task => ({
    id: task.taskArn?.split('/').pop(),
    status: task.lastStatus,
    health: task.healthStatus,
    createdAt: task.createdAt,
    taskDefinitionArn: task.taskDefinitionArn,
    revision: task.taskDefinitionArn?.split(':').pop(),
    serviceType,
  })) || [];
}

async function getTaskCPUMetrics(taskArns: string[], serviceType: ServiceType) {
  if (!taskArns || taskArns.length === 0) return [];

  const metrics: Array<{
    taskId: string | undefined;
    cpuUtilization: number | null;
    timestamp?: Date;
    error?: string;
  }> = [];
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 5 * 60 * 1000); // 5 minutes ago

  const serviceName = serviceType === 'frontend' 
    ? await stackConfig.getFrontendServiceName()
    : await stackConfig.getBackendServiceName();

  for (const taskArn of taskArns) {
    const taskId = taskArn.split('/').pop();
    try {
      const response = await cloudWatchClient.send(
        new GetMetricStatisticsCommand({
          Namespace: 'AWS/ECS',
          MetricName: 'CPUUtilization',
          Dimensions: [
            { Name: 'ServiceName', Value: serviceName },
            { Name: 'ClusterName', Value: await stackConfig.getClusterName() },
          ],
          StartTime: startTime,
          EndTime: endTime,
          Period: 300, // 5 minutes
          Statistics: ['Average'],
        })
      );

      const latestDatapoint = response.Datapoints?.sort(
        (a, b) => (b.Timestamp?.getTime() || 0) - (a.Timestamp?.getTime() || 0)
      )[0];

      metrics.push({
        taskId,
        cpuUtilization: latestDatapoint?.Average ? Math.round(latestDatapoint.Average * 10) / 10 : null,
        ...(latestDatapoint?.Timestamp && { timestamp: latestDatapoint.Timestamp }),
      });
    } catch (error) {
      metrics.push({
        taskId,
        cpuUtilization: null,
        error: 'Metrics unavailable',
      });
    }
  }

  return metrics;
}

async function getDatabaseStatus() {
  try {
    const dbEndpoint = await stackConfig.getDatabaseEndpoint();
    
    const response = await rdsClient.send(
      new DescribeDBInstancesCommand({})
    );

    const database = response.DBInstances?.find(db => 
      db.Endpoint?.Address === dbEndpoint
    );

    if (!database) {
      return { status: 'NOT_FOUND', endpoint: dbEndpoint };
    }

    return {
      status: database.DBInstanceStatus,
      endpoint: database.Endpoint?.Address,
      engine: `${database.Engine} ${database.EngineVersion}`,
      instanceClass: database.DBInstanceClass,
      allocatedStorage: database.AllocatedStorage,
      storageEncrypted: database.StorageEncrypted,
      multiAZ: database.MultiAZ,
      backupRetentionPeriod: database.BackupRetentionPeriod,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to get database status', { error: errorMessage });
    return { status: 'ERROR', endpoint: 'N/A', error: errorMessage };
  }
}

async function getEFSStatus() {
  try {
    const fileSystemId = await stackConfig.getEfsFileSystemId();
    
    const response = await efsClient.send(
      new DescribeFileSystemsCommand({
        FileSystemId: fileSystemId
      })
    );

    const fileSystem = response.FileSystems?.[0];

    if (!fileSystem) {
      return { status: 'NOT_FOUND' };
    }

    // Get mount targets
    let mountTargets: any[] = [];
    try {
      const mountResponse = await efsClient.send(
        new DescribeMountTargetsCommand({
          FileSystemId: fileSystem.FileSystemId,
        })
      );
      mountTargets = mountResponse.MountTargets || [];
    } catch (error) {
      // Mount targets may not be accessible
    }

    return {
      status: fileSystem.LifeCycleState,
      fileSystemId: fileSystem.FileSystemId,
      sizeInBytes: fileSystem.SizeInBytes?.Value,
      throughputMode: fileSystem.ThroughputMode,
      performanceMode: fileSystem.PerformanceMode,
      encrypted: fileSystem.Encrypted,
      mountTargets: mountTargets.length,
    };
  } catch (error: any) {
    return { status: 'ERROR', error: error.message };
  }
}

async function getALBStatus() {
  try {
    const loadBalancerDns = await stackConfig.getLoadBalancerDNS();
    
    // Extract load balancer name from DNS name (unused but kept for reference)
    // const albName = loadBalancerDns.split('-')[0] + '-' + loadBalancerDns.split('-')[1] + '-' + loadBalancerDns.split('-')[2];
    
    const response = await albClient.send(
      new DescribeLoadBalancersCommand({})
    );

    const loadBalancer = response.LoadBalancers?.find(alb => 
      alb.DNSName === loadBalancerDns
    );

    if (!loadBalancer) {
      return { status: 'NOT_FOUND', dns: loadBalancerDns };
    }

    // Get target groups
    const targetGroupsResponse = await albClient.send(
      new DescribeTargetGroupsCommand({
        LoadBalancerArn: loadBalancer.LoadBalancerArn,
      })
    );

    let targetHealth: any[] = [];
    if (targetGroupsResponse.TargetGroups && targetGroupsResponse.TargetGroups.length > 0) {
      const targetGroup = targetGroupsResponse.TargetGroups[0];
      if (targetGroup?.TargetGroupArn) {
        try {
          const healthResponse = await albClient.send(
            new DescribeTargetHealthCommand({
              TargetGroupArn: targetGroup.TargetGroupArn,
            })
          );
          targetHealth = healthResponse.TargetHealthDescriptions || [];
        } catch (error) {
          // Target health may not be accessible
        }
      }
    }

    return {
      status: loadBalancer.State?.Code,
      loadBalancerArn: loadBalancer.LoadBalancerArn,
      dnsName: loadBalancer.DNSName,
      scheme: loadBalancer.Scheme,
      type: loadBalancer.Type,
      availabilityZones: loadBalancer.AvailabilityZones?.length || 0,
      targetGroups: targetGroupsResponse.TargetGroups?.length || 0,
      healthyTargets: targetHealth.filter(t => t.TargetHealth?.State === 'healthy').length,
      totalTargets: targetHealth.length,
    };
  } catch (error: any) {
    return { status: 'ERROR', error: error.message };
  }
}

async function getWAFStatus() {
  try {
    const wafArn = await stackConfig.getWAFWebACLArn();
    
    // Extract ID and Name from ARN
    // arn:aws:wafv2:us-east-2:571600854494:regional/webacl/SemiontWAF-TOihU0hvjLtC/7c8f7662-b0cc-44cb-91aa-bd0387ab0492
    const arnParts = wafArn.split('/');
    const wafName = arnParts[arnParts.length - 2];
    const wafId = arnParts[arnParts.length - 1];

    // Get detailed WAF information
    const detailsResponse = await wafClient.send(
      new GetWebACLCommand({
        Id: wafId,
        Name: wafName,
        Scope: 'REGIONAL',
      })
    );

    const webACL = detailsResponse.WebACL;

    return {
      status: 'ACTIVE',
      id: webACL?.Id,
      name: webACL?.Name,
      description: webACL?.Description,
      rules: webACL?.Rules?.length || 0,
      defaultAction: webACL?.DefaultAction?.Allow ? 'ALLOW' : 'BLOCK',
      capacity: webACL?.Capacity,
    };
  } catch (error: any) {
    return { status: 'ERROR', error: error.message };
  }
}

async function getCostEstimate(dbStatus: any, _efsStatus: any) {
  try {
    // Get last 7 days of costs
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 7);

    const costResponse = await costExplorerClient.send(
      new GetCostAndUsageCommand({
        TimePeriod: {
          Start: startDate.toISOString().split('T')[0],
          End: endDate.toISOString().split('T')[0],
        },
        Granularity: 'DAILY',
        Metrics: ['BlendedCost'],
        GroupBy: [
          {
            Type: 'DIMENSION',
            Key: 'SERVICE',
          },
        ],
      })
    );

    let totalWeeklyCost = 0;
    const serviceCosts: { [key: string]: number } = {};

    costResponse.ResultsByTime?.forEach(result => {
      result.Groups?.forEach(group => {
        const service = group.Keys?.[0] || 'Unknown';
        const cost = parseFloat(group.Metrics?.BlendedCost?.Amount || '0');
        totalWeeklyCost += cost;
        serviceCosts[service] = (serviceCosts[service] || 0) + cost;
      });
    });

    // Calculate estimated monthly cost
    const estimatedMonthlyCost = (totalWeeklyCost / 7) * 30;

    // Calculate resource-specific estimates based on current configuration
    const estimates = {
      // RDS costs (db.t3.micro in us-east-2)
      rds: dbStatus.instanceClass === 'db.t3.micro' ? 14.60 : 0, // ~$0.02/hour * 730 hours
      // EFS costs (very low for small usage)
      efs: 0.30, // $0.30/GB/month for Standard storage
      // ECS Fargate costs (assuming 1 task, 0.25 vCPU, 0.5 GB RAM)
      fargate: 7.30, // ~$0.01/hour * 730 hours
      // ALB costs
      alb: 18.40, // $0.0225/hour * 730 hours + $0.008/LCU
      // CloudFront (minimal usage)
      cloudfront: 1.00, // First 1TB free, minimal requests
      // WAF
      waf: 5.00, // $5/month base + rules
      // Secrets Manager
      secrets: 1.20, // $0.40/secret * 3 secrets
      // CloudWatch
      cloudwatch: 2.00, // Logs and metrics
    };

    const estimatedTotal = Object.values(estimates).reduce((sum, cost) => sum + cost, 0);

    return {
      actualWeeklyCost: totalWeeklyCost,
      estimatedMonthlyCost: estimatedMonthlyCost > 0 ? estimatedMonthlyCost : estimatedTotal,
      serviceCosts,
      estimates,
      hasActualData: totalWeeklyCost > 0,
    };
  } catch (error: any) {
    // Fallback to estimates if Cost Explorer fails
    const estimates = {
      rds: 14.60, // db.t3.micro
      efs: 0.30,
      fargate: 7.30,
      alb: 18.40,
      cloudfront: 1.00,
      waf: 5.00,
      secrets: 1.20,
      cloudwatch: 2.00,
    };

    const estimatedTotal = Object.values(estimates).reduce((sum, cost) => sum + cost, 0);

    return {
      actualWeeklyCost: 0,
      estimatedMonthlyCost: estimatedTotal,
      serviceCosts: {},
      estimates,
      hasActualData: false,
      error: error.message,
    };
  }
}

async function showAppStackStatus() {
  logger.simple('\n🏗️  App Stack');
  logger.simple('==============');

  try {
    // ALB Status
    logger.simple('\n⚖️  Application Load Balancer:');
    const albStatus = await getALBStatus();
    logger.simple(`   Status: ${albStatus.status}`);
    if (albStatus.dnsName) {
      logger.simple(`   DNS Name: ${albStatus.dnsName}`);
    }
    if (albStatus.scheme) {
      logger.simple(`   Scheme: ${albStatus.scheme}`);
    }
    if (albStatus.type) {
      logger.simple(`   Type: ${albStatus.type}`);
    }
    if (albStatus.availabilityZones) {
      logger.simple(`   Availability Zones: ${albStatus.availabilityZones}`);
    }
    if (albStatus.targetGroups) {
      logger.simple(`   Target Groups: ${albStatus.targetGroups}`);
    }
    if (albStatus.totalTargets !== undefined) {
      logger.simple(`   Target Health: ${albStatus.healthyTargets}/${albStatus.totalTargets} healthy`);
    }

    // WAF Status
    logger.simple('\n🛡️  Web Application Firewall:');
    const wafStatus = await getWAFStatus();
    logger.simple(`   Status: ${wafStatus.status}`);
    if (wafStatus.name) {
      logger.simple(`   Name: ${wafStatus.name}`);
    }
    if (wafStatus.rules !== undefined) {
      logger.simple(`   Rules: ${wafStatus.rules}`);
    }
    if (wafStatus.defaultAction) {
      logger.simple(`   Default Action: ${wafStatus.defaultAction}`);
    }
    if (wafStatus.capacity) {
      logger.simple(`   Capacity: ${wafStatus.capacity} WCU`);
    }

    // ECS Services Status with table
    const frontendStatus = await getServiceStatus('frontend');
    const backendStatus = await getServiceStatus('backend');
    await showECSServicesTable([frontendStatus, backendStatus]);
    
    // Show deployment details for both services if needed
    for (const service of [frontendStatus, backendStatus]) {
      if (service.deployments.length > 1 || 
          service.deployments.some(d => d.status !== 'PRIMARY')) {
        logger.simple(`\n📋 ${service.type.charAt(0).toUpperCase() + service.type.slice(1)} Deployment History:`);
        service.deployments.forEach((deployment) => {
          const age = deployment.createdAt ? 
            Math.round((Date.now() - deployment.createdAt.getTime()) / 1000 / 60) : 'unknown';
          const statusIcon = deployment.status === 'PRIMARY' ? '✅' : 
                            deployment.rolloutState === 'IN_PROGRESS' ? '🔄' : 
                            deployment.rolloutState === 'FAILED' ? '❌' : '⏸️';
          const revisionInfo = deployment.revision ? ` [Rev: ${deployment.revision}]` : '';
          logger.simple(`      ${statusIcon} ${deployment.status} (${deployment.rolloutState})${revisionInfo} - ${age}m ago`);
          if (deployment.rolloutStateReason) {
            logger.simple(`         ${deployment.rolloutStateReason}`);
          }
        });
      }

      // Show recent service events if there are deployment issues
      if (service.events.length > 0 && 
          (service.deployments.some(d => d.rolloutState === 'IN_PROGRESS') ||
           service.deployments.some(d => d.rolloutState === 'FAILED'))) {
        logger.simple(`\n📢 Recent ${service.type.charAt(0).toUpperCase() + service.type.slice(1)} Service Events:`);
        service.events.forEach(event => {
          const age = event.createdAt ? 
            Math.round((Date.now() - event.createdAt.getTime()) / 1000 / 60) : 'unknown';
          logger.simple(`      • ${event.message} (${age}m ago)`);
        });
      }
    }

    // Recent Tasks with CPU metrics for both services
    logger.simple('\n📋 Recent Tasks:');
    
    // Frontend tasks
    logger.simple('\n   📱 Frontend Tasks:');
    const frontendTasks = await getRecentTasks('frontend');
    if (frontendTasks.length === 0) {
      logger.simple('      No frontend tasks found');
    } else {
      const clusterName = await stackConfig.getClusterName();
      const frontendServiceName = await stackConfig.getFrontendServiceName();
      const frontendTasksResponse = await ecsClient.send(
        new ListTasksCommand({
          cluster: clusterName,
          serviceName: frontendServiceName,
          maxResults: 3,
        })
      );
      
      const frontendCpuMetrics = await getTaskCPUMetrics(frontendTasksResponse.taskArns || [], 'frontend');
      
      frontendTasks.forEach(task => {
        const age = task.createdAt ? 
          Math.round((Date.now() - task.createdAt.getTime()) / 1000 / 60) : 'unknown';
        const cpuMetric = frontendCpuMetrics.find(m => m.taskId === task.id);
        const cpuInfo = cpuMetric && cpuMetric.cpuUtilization !== null ? 
          ` - CPU: ${cpuMetric.cpuUtilization}%` : 
          cpuMetric?.error ? ' - CPU: unavailable' : '';
        const revisionInfo = task.revision ? ` [Rev: ${task.revision}]` : '';
        logger.simple(`      ${task.id}: ${task.status} (${task.health || 'unknown'})${revisionInfo} - ${age}m ago${cpuInfo}`);
      });
    }
    
    // Backend tasks
    logger.simple('\n   🚀 Backend Tasks:');
    const backendTasks = await getRecentTasks('backend');
    if (backendTasks.length === 0) {
      logger.simple('      No backend tasks found');
    } else {
      const clusterName = await stackConfig.getClusterName();
      const backendServiceName = await stackConfig.getBackendServiceName();
      const backendTasksResponse = await ecsClient.send(
        new ListTasksCommand({
          cluster: clusterName,
          serviceName: backendServiceName,
          maxResults: 3,
        })
      );
      
      const backendCpuMetrics = await getTaskCPUMetrics(backendTasksResponse.taskArns || [], 'backend');
      
      backendTasks.forEach(task => {
        const age = task.createdAt ? 
          Math.round((Date.now() - task.createdAt.getTime()) / 1000 / 60) : 'unknown';
        const cpuMetric = backendCpuMetrics.find(m => m.taskId === task.id);
        const cpuInfo = cpuMetric && cpuMetric.cpuUtilization !== null ? 
          ` - CPU: ${cpuMetric.cpuUtilization}%` : 
          cpuMetric?.error ? ' - CPU: unavailable' : '';
        const revisionInfo = task.revision ? ` [Rev: ${task.revision}]` : '';
        logger.simple(`      ${task.id}: ${task.status} (${task.health || 'unknown'})${revisionInfo} - ${age}m ago${cpuInfo}`);
      });
    }

    // Website Health
    logger.simple('\n🌐 Website Health:');
    const websiteUrl = await stackConfig.getWebsiteUrl();
    const health = await checkWebsiteHealth(websiteUrl);
    const healthIcon = health.healthy ? '✅' : '❌';
    logger.simple(`   ${healthIcon} ${websiteUrl} - HTTP ${health.status}`);

  } catch (error) {
    logger.error('❌ Failed to get app stack status:', { error });
  }
}

async function showInfraStackStatus() {
  logger.simple('\n🏗️  Infra Stack');
  logger.simple('================');

  try {
    // Database Status with table
    const dbStatus = await getDatabaseStatus();
    await showDatabaseStatusTable(dbStatus);

    // EFS Status with table
    const efsStatus = await getEFSStatus();
    await showEFSStatusTable(efsStatus);

    // Cost Information
    logger.simple('\n💰 Cost Estimate:');
    const costInfo = await getCostEstimate(await getDatabaseStatus(), efsStatus);
    
    if (costInfo.hasActualData) {
      logger.simple(`   Last 7 days: $${costInfo.actualWeeklyCost.toFixed(2)}`);
      logger.simple(`   Projected monthly: $${costInfo.estimatedMonthlyCost.toFixed(2)}`);
      
      // Show top service costs if available
      const topServices = Object.entries(costInfo.serviceCosts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3);
      
      if (topServices.length > 0) {
        logger.simple('   Top services:');
        topServices.forEach(([service, cost]) => {
          logger.simple(`     • ${service}: $${cost.toFixed(2)}`);
        });
      }
    } else {
      logger.simple(`   Estimated monthly: $${costInfo.estimatedMonthlyCost.toFixed(2)}`);
      logger.simple('   Breakdown:');
      logger.simple(`     • RDS (${(await getDatabaseStatus()).instanceClass || 'db.t3.micro'}): $${costInfo.estimates.rds.toFixed(2)}`);
      logger.simple(`     • Application Load Balancer: $${costInfo.estimates.alb.toFixed(2)}`);
      logger.simple(`     • ECS Fargate: $${costInfo.estimates.fargate.toFixed(2)}`);
      logger.simple(`     • WAF: $${costInfo.estimates.waf.toFixed(2)}`);
      logger.simple(`     • CloudWatch: $${costInfo.estimates.cloudwatch.toFixed(2)}`);
      logger.simple(`     • Secrets Manager: $${costInfo.estimates.secrets.toFixed(2)}`);
      logger.simple(`     • CloudFront: $${costInfo.estimates.cloudfront.toFixed(2)}`);
      logger.simple(`     • EFS: $${costInfo.estimates.efs.toFixed(2)}`);
      
      if (costInfo.error) {
        logger.simple(`   Note: Using estimates (${costInfo.error})`);
      } else {
        logger.simple('   Note: Using estimates (actual costs available after 24h)');
      }
    }

  } catch (error) {
    logger.error('❌ Failed to get infra stack status:', { error });
  }
}

// Table display functions using ink
async function showECSServicesTable(services: any[]): Promise<void> {
  return new Promise((resolve) => {
    const serviceData = services.map(service => ({
      Service: service.type === 'frontend' ? '📱 Frontend' : '🚀 Backend',
      Status: service.status,
      Running: `${service.runningCount}/${service.desiredCount}`,
      Deployment: service.deploymentStatus || 'N/A'
    }));

    const ServicesTable = React.createElement(
      Box,
      { flexDirection: 'column' },
      [
        React.createElement(Text, { bold: true, color: 'cyan', key: 'title' }, '\n🐳 ECS Services'),
        React.createElement(SimpleTable, { 
          data: serviceData, 
          columns: ['Service', 'Status', 'Running', 'Deployment'],
          key: 'services-table' 
        }),
        React.createElement(Text, { key: 'spacing' }, '\n')
      ]
    );

    const { unmount } = render(ServicesTable);
    
    setTimeout(() => {
      unmount();
      resolve();
    }, 100);
  });
}

async function showDatabaseStatusTable(dbStatus: any): Promise<void> {
  return new Promise((resolve) => {
    const dbData = [
      { Property: 'Status', Value: dbStatus.status },
      { Property: 'Endpoint', Value: dbStatus.endpoint },
      { Property: 'Engine', Value: dbStatus.engine || 'N/A' },
      { Property: 'Instance', Value: dbStatus.instanceClass || 'N/A' },
      { Property: 'Storage', Value: dbStatus.allocatedStorage ? 
        `${dbStatus.allocatedStorage}GB ${dbStatus.storageEncrypted ? '(encrypted)' : '(unencrypted)'}` : 'N/A' },
      { Property: 'Multi-AZ', Value: dbStatus.multiAZ !== undefined ? 
        (dbStatus.multiAZ ? 'enabled' : 'disabled') : 'N/A' },
      { Property: 'Backup Retention', Value: dbStatus.backupRetentionPeriod !== undefined ? 
        `${dbStatus.backupRetentionPeriod} days` : 'N/A' }
    ];

    const DatabaseTable = React.createElement(
      Box,
      { flexDirection: 'column' },
      [
        React.createElement(Text, { bold: true, color: 'cyan', key: 'title' }, '\n🗃️ Database Status'),
        React.createElement(SimpleTable, { 
          data: dbData, 
          columns: ['Property', 'Value'],
          key: 'database-table' 
        }),
        React.createElement(Text, { key: 'spacing' }, '\n')
      ]
    );

    const { unmount } = render(DatabaseTable);
    
    setTimeout(() => {
      unmount();
      resolve();
    }, 100);
  });
}

async function showEFSStatusTable(efsStatus: any): Promise<void> {
  return new Promise((resolve) => {
    const efsData = [
      { Property: 'Status', Value: efsStatus.status },
      { Property: 'File System ID', Value: efsStatus.fileSystemId || 'N/A' },
      { Property: 'Size', Value: efsStatus.sizeInBytes !== undefined ? 
        `${(efsStatus.sizeInBytes / (1024 * 1024 * 1024)).toFixed(2)}GB` : 'N/A' },
      { Property: 'Throughput', Value: efsStatus.throughputMode || 'N/A' },
      { Property: 'Performance', Value: efsStatus.performanceMode || 'N/A' },
      { Property: 'Encryption', Value: efsStatus.encrypted !== undefined ? 
        (efsStatus.encrypted ? 'enabled' : 'disabled') : 'N/A' },
      { Property: 'Mount Targets', Value: efsStatus.mountTargets !== undefined ? 
        efsStatus.mountTargets.toString() : 'N/A' }
    ];

    const EFSTable = React.createElement(
      Box,
      { flexDirection: 'column' },
      [
        React.createElement(Text, { bold: true, color: 'cyan', key: 'title' }, '\n💾 File System (EFS)'),
        React.createElement(SimpleTable, { 
          data: efsData, 
          columns: ['Property', 'Value'],
          key: 'efs-table' 
        }),
        React.createElement(Text, { key: 'spacing' }, '\n')
      ]
    );

    const { unmount } = render(EFSTable);
    
    setTimeout(() => {
      unmount();
      resolve();
    }, 100);
  });
}

async function showStatus(section: 'app' | 'infra' | 'both' = 'both') {
  const siteName = await stackConfig.getSiteName();
  logger.simple(`📊 ${siteName} Status Report`);
  logger.simple('==========================');

  if (section === 'app' || section === 'both') {
    await showAppStackStatus();
  }

  if (section === 'infra' || section === 'both') {
    await showInfraStackStatus();
  }

  logger.simple('\n💡 Quick Commands:');
  logger.simple('   View logs:    npx tsx scripts/logs.ts');
  logger.simple('   Restart:      npx tsx scripts/restart.ts');
  logger.simple('   Execute:      npx tsx scripts/exec.ts');
  logger.simple('   Secrets:      npx tsx scripts/secrets.ts');
}

// Parse command line arguments
const args = process.argv.slice(2);
const section = (args[0] as 'app' | 'infra' | 'both') || 'both';

if (!['app', 'infra', 'both'].includes(section)) {
  logger.simple('Usage: npx tsx status.ts [app|infra|both]');
  logger.simple('');
  logger.simple('Sections:');
  logger.simple('   app    Show Application Stack status (ALB, WAF, ECS, Website)');
  logger.simple('   infra  Show Infrastructure Stack status (RDS, EFS, Costs)');
  logger.simple('   both   Show both stacks (default)');
  logger.simple('');
  logger.simple('Examples:');
  logger.simple('   npx tsx status.ts app');
  logger.simple('   npx tsx status.ts infra');
  logger.simple('   npx tsx status.ts both');
  process.exit(1);
}

showStatus(section).catch(error => logger.error('Status check failed', { error }));