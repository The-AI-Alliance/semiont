/**
 * Dashboard Data Sources
 * 
 * Provides real-time data collection and polling for dashboard components
 */

import { ECSClient, ListTasksCommand, DescribeTasksCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, GetLogEventsCommand, DescribeLogStreamsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { EFSClient, DescribeFileSystemsCommand } from '@aws-sdk/client-efs';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SemiontStackConfig } from './stack-config.js';
import { ServiceStatus, LogEntry, MetricData } from './dashboard-components.js';
import { DashboardData } from './dashboard-layouts.js';
import { ServiceType } from './types.js';
import { loadEnvironmentConfig, type EnvironmentConfig } from './deployment-resolver.js';

export class DashboardDataSource {
  private stackConfig: SemiontStackConfig;
  private ecsClient: ECSClient;
  private logsClient: CloudWatchLogsClient;
  private cloudWatchClient: CloudWatchClient;
  private rdsClient: RDSClient;
  private efsClient: EFSClient;
  private cfnClient: CloudFormationClient;
  private logCache: Map<string, LogEntry[]> = new Map();
  private lastLogTimestamp: Map<string, Date> = new Map();
  private config: EnvironmentConfig;

  constructor(environment: string) {
    this.config = loadEnvironmentConfig(environment);
    
    // AWS is required for dashboard data (can't monitor local services with AWS CloudWatch)
    if (!this.config.aws) {
      throw new Error(`Environment ${environment} does not have AWS configuration`);
    }
    
    this.stackConfig = new SemiontStackConfig(environment);
    this.ecsClient = new ECSClient({ region: this.config.aws.region });
    this.logsClient = new CloudWatchLogsClient({ region: this.config.aws.region });
    this.cloudWatchClient = new CloudWatchClient({ region: this.config.aws.region });
    this.rdsClient = new RDSClient({ region: this.config.aws.region });
    this.efsClient = new EFSClient({ region: this.config.aws.region });
    this.cfnClient = new CloudFormationClient({ region: this.config.aws.region });
  }

  // Get current services status
  async getServicesStatus(): Promise<ServiceStatus[]> {
    const services: ServiceStatus[] = [];
    
    try {
      const clusterName = await this.stackConfig.getClusterName();
      const serviceTypes: ServiceType[] = ['frontend', 'backend'];
      
      for (const serviceType of serviceTypes) {
        try {
          const serviceName = serviceType === 'frontend' 
            ? await this.stackConfig.getFrontendServiceName()
            : await this.stackConfig.getBackendServiceName();

          // Get service details first
          const serviceResponse = await this.ecsClient.send(
            new DescribeServicesCommand({
              cluster: clusterName,
              services: [serviceName],
            })
          );

          const service = serviceResponse.services?.[0];
          let revision: number | undefined;
          let desiredCount: number | undefined;
          let runningCount: number | undefined;
          let pendingCount: number | undefined;
          let deploymentStatus: string | undefined;
          let taskDefinition: string | undefined;

          if (service) {
            desiredCount = service.desiredCount;
            runningCount = service.runningCount;
            pendingCount = service.pendingCount;
            
            // Get the latest deployment
            const latestDeployment = service.deployments?.[0];
            if (latestDeployment) {
              const taskDefArn = latestDeployment.taskDefinition;
              if (taskDefArn) {
                // Extract revision number from task definition ARN
                const revisionMatch = taskDefArn.match(/:([0-9]+)$/);
                if (revisionMatch) {
                  revision = parseInt(revisionMatch[1]);
                }
                // Extract task definition family name
                taskDefinition = taskDefArn.split('/').pop()?.split(':')[0];
              }
              deploymentStatus = latestDeployment.status;
            }

            // Check for ongoing deployments
            if (service.deployments && service.deployments.length > 1) {
              deploymentStatus = 'Deploying...';
            }
          }

          const response = await this.ecsClient.send(
            new ListTasksCommand({
              cluster: clusterName,
              serviceName: serviceName,
              maxResults: 10,
            })
          );

          let status: ServiceStatus['status'] = 'unknown';
          let details = 'No tasks found';

          if (response.taskArns && response.taskArns.length > 0) {
            const tasksResponse = await this.ecsClient.send(
              new DescribeTasksCommand({
                cluster: clusterName,
                tasks: response.taskArns,
              })
            );

            const runningTasks = tasksResponse.tasks?.filter(t => t.lastStatus === 'RUNNING') || [];
            const healthyTasks = runningTasks.filter(t => t.healthStatus === 'HEALTHY');
            
            if (healthyTasks.length > 0) {
              status = 'healthy';
              details = `${healthyTasks.length}/${runningTasks.length} healthy tasks`;
            } else if (runningTasks.length > 0) {
              status = 'warning';
              details = `${runningTasks.length} running, health checks pending`;
            } else {
              status = 'unhealthy';
              details = 'No running tasks';
            }
          }

          services.push({
            name: serviceType === 'frontend' ? 'Frontend' : 'Backend',
            status,
            details,
            lastUpdated: new Date(),
            revision,
            desiredCount,
            runningCount,
            pendingCount,
            taskDefinition,
            cluster: clusterName,
            deploymentStatus
          });

        } catch (error) {
          services.push({
            name: serviceType === 'frontend' ? 'Frontend' : 'Backend',
            status: 'unhealthy',
            details: `Error: ${error instanceof Error ? error.message : 'Unknown'}`,
            lastUpdated: new Date()
          });
        }
      }

      // Add infrastructure services
      // Check database status
      try {
        const dbInstances = await this.rdsClient.send(new DescribeDBInstancesCommand({}));
        const semiontDb = dbInstances.DBInstances?.find(db => 
          db.DBInstanceIdentifier?.toLowerCase().includes('semiont')
        );
        
        if (semiontDb) {
          const dbStatus = semiontDb.DBInstanceStatus;
          services.push({
            name: 'Database',
            status: dbStatus === 'available' ? 'healthy' : 
                   dbStatus === 'backing-up' || dbStatus === 'maintenance' ? 'warning' : 'unhealthy',
            details: `${semiontDb.Engine} ${semiontDb.EngineVersion} - ${dbStatus}`,
            lastUpdated: new Date()
          });
        } else {
          services.push({
            name: 'Database',
            status: 'unknown',
            details: 'RDS instance not found',
            lastUpdated: new Date()
          });
        }
      } catch (error) {
        services.push({
          name: 'Database',
          status: 'unknown',
          details: 'Failed to check RDS status',
          lastUpdated: new Date()
        });
      }

      // Check filesystem status
      try {
        // Get EFS filesystem ID from CloudFormation stack
        const stackResult = await this.cfnClient.send(new DescribeStacksCommand({
          StackName: 'SemiontInfraStack'
        }));
        
        const outputs = stackResult.Stacks?.[0]?.Outputs || [];
        const efsIdOutput = outputs.find(o => 
          o.OutputKey === 'EfsFileSystemId' || o.OutputKey === 'EFSFileSystemId'
        );
        
        if (efsIdOutput?.OutputValue) {
          const efsResult = await this.efsClient.send(new DescribeFileSystemsCommand({
            FileSystemId: efsIdOutput.OutputValue
          }));
          
          const filesystem = efsResult.FileSystems?.[0];
          if (filesystem) {
            const lifecycleState = filesystem.LifeCycleState;
            services.push({
              name: 'Filesystem',
              status: lifecycleState === 'available' ? 'healthy' : 
                     lifecycleState === 'creating' || lifecycleState === 'updating' ? 'warning' : 'unhealthy',
              details: `EFS ${filesystem.FileSystemId} - ${lifecycleState}`,
              lastUpdated: new Date()
            });
          }
        } else {
          services.push({
            name: 'Filesystem',
            status: 'unknown',
            details: 'EFS filesystem not found',
            lastUpdated: new Date()
          });
        }

      } catch (error) {
        // Infrastructure checks failed
      }

    } catch (error) {
      console.error('Failed to get services status:', error);
    }

    return services;
  }

  // Get recent logs from all services
  async getLogs(maxEntries: number = 50): Promise<LogEntry[]> {
    const allLogs: LogEntry[] = [];
    const serviceTypes: ServiceType[] = ['frontend', 'backend'];

    for (const serviceType of serviceTypes) {
      try {
        const logs = await this.getServiceLogs(serviceType, maxEntries);
        allLogs.push(...logs);
      } catch (error) {
        console.error(`Failed to get ${serviceType} logs:`, error);
      }
    }

    // Sort by timestamp, newest first
    return allLogs
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, maxEntries);
  }

  // Get logs for a specific service
  private async getServiceLogs(serviceType: ServiceType, maxEntries: number): Promise<LogEntry[]> {
    const cacheKey = serviceType;
    const cached = this.logCache.get(cacheKey) || [];
    const lastTimestamp = this.lastLogTimestamp.get(cacheKey) || new Date(Date.now() - 5 * 60 * 1000);

    try {
      // Get latest task for this service
      const clusterName = await this.stackConfig.getClusterName();
      const serviceName = serviceType === 'frontend' 
        ? await this.stackConfig.getFrontendServiceName()
        : await this.stackConfig.getBackendServiceName();

      const tasksResponse = await this.ecsClient.send(
        new ListTasksCommand({
          cluster: clusterName,
          serviceName: serviceName,
          maxResults: 1,
        })
      );

      if (!tasksResponse.taskArns?.[0]) {
        return cached;
      }

      const taskId = tasksResponse.taskArns[0].split('/').pop() || 'unknown';
      const logStreamName = await this.getLogStreamForTask(taskId, serviceType);
      
      if (!logStreamName) {
        return cached;
      }

      const logGroupName = await this.stackConfig.getLogGroupName();
      const response = await this.logsClient.send(
        new GetLogEventsCommand({
          logGroupName,
          logStreamName,
          startTime: lastTimestamp.getTime(),
          limit: maxEntries,
        })
      );

      const newLogs: LogEntry[] = (response.events || [])
        .filter(event => event.timestamp && event.timestamp > lastTimestamp.getTime())
        .map(event => ({
          timestamp: new Date(event.timestamp || 0),
          level: this.parseLogLevel(event.message || ''),
          service: serviceType,
          message: this.cleanLogMessage(event.message || ''),
        }));

      if (newLogs.length > 0) {
        const allServiceLogs = [...cached, ...newLogs]
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          .slice(0, maxEntries * 2); // Keep some history

        this.logCache.set(cacheKey, allServiceLogs);
        if (newLogs.length > 0 && newLogs[0]) {
          this.lastLogTimestamp.set(cacheKey, newLogs[0].timestamp);
        }
        return allServiceLogs;
      }

      return cached;

    } catch (error) {
      console.error(`Failed to get logs for ${serviceType}:`, error);
      return cached;
    }
  }

  // Get log stream name for a task
  private async getLogStreamForTask(taskId: string, service: string): Promise<string | null> {
    const logGroupName = await this.stackConfig.getLogGroupName();
    const streamPrefix = `semiont-${service}/semiont-${service}/${taskId}`;
    
    try {
      const response = await this.logsClient.send(
        new DescribeLogStreamsCommand({
          logGroupName,
          logStreamNamePrefix: streamPrefix,
          limit: 1,
        })
      );
      
      return response.logStreams?.[0]?.logStreamName || null;
    } catch (error) {
      return null;
    }
  }

  // Parse log level from log message
  private parseLogLevel(message: string): LogEntry['level'] {
    const upperMessage = message.toUpperCase();
    if (upperMessage.includes('ERROR') || upperMessage.includes('FATAL')) return 'error';
    if (upperMessage.includes('WARN')) return 'warn';
    if (upperMessage.includes('DEBUG')) return 'debug';
    return 'info';
  }

  // Clean up log message (remove timestamps, etc.)
  private cleanLogMessage(message: string): string {
    // Remove common log prefixes like timestamps, log levels
    return message
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z?\s*/, '') // ISO timestamps
      .replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '') // [HH:MM:SS] timestamps
      .replace(/^\s*(INFO|WARN|ERROR|DEBUG)\s*:?\s*/i, '') // Log levels
      .trim();
  }

  // Get system metrics
  async getMetrics(): Promise<MetricData[]> {
    const metrics: MetricData[] = [];
    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

    try {
      // ALB Request Count
      const albDns = await this.stackConfig.getLoadBalancerDNS();
      const albName = this.extractALBName(albDns);
      
      const requestCountResponse = await this.cloudWatchClient.send(
        new GetMetricStatisticsCommand({
          Namespace: 'AWS/ApplicationELB',
          MetricName: 'RequestCount',
          Dimensions: [{ Name: 'LoadBalancer', Value: albName }],
          StartTime: thirtyMinutesAgo,
          EndTime: now,
          Period: 300,
          Statistics: ['Sum'],
        })
      );

      const totalRequests = requestCountResponse.Datapoints
        ?.reduce((sum, dp) => sum + (dp.Sum || 0), 0) || 0;

      metrics.push({
        name: 'Total Requests (30min)',
        value: totalRequests,
        trend: 'stable' // Could calculate trend from historical data
      });

      // Get ECS Cluster metrics
      try {
        const clusterName = await this.stackConfig.getClusterName();
        
        // CPU Utilization
        const cpuResponse = await this.cloudWatchClient.send(
          new GetMetricStatisticsCommand({
            Namespace: 'AWS/ECS',
            MetricName: 'CPUUtilization',
            Dimensions: [
              { Name: 'ClusterName', Value: clusterName }
            ],
            StartTime: thirtyMinutesAgo,
            EndTime: now,
            Period: 300,
            Statistics: ['Average'],
          })
        );
        
        const cpuDatapoints = cpuResponse.Datapoints || [];
        const currentCpu = cpuDatapoints.length > 0 
          ? cpuDatapoints.sort((a, b) => (b.Timestamp?.getTime() || 0) - (a.Timestamp?.getTime() || 0))[0].Average || 0
          : 0;
        
        metrics.push({
          name: 'Cluster CPU',
          value: Number(currentCpu.toFixed(1)),
          unit: '%',
          trend: cpuDatapoints.length > 1 && cpuDatapoints[0].Average! > cpuDatapoints[1].Average! ? 'up' : 'stable'
        });

        // Memory Utilization
        const memoryResponse = await this.cloudWatchClient.send(
          new GetMetricStatisticsCommand({
            Namespace: 'AWS/ECS',
            MetricName: 'MemoryUtilization',
            Dimensions: [
              { Name: 'ClusterName', Value: clusterName }
            ],
            StartTime: thirtyMinutesAgo,
            EndTime: now,
            Period: 300,
            Statistics: ['Average'],
          })
        );
        
        const memoryDatapoints = memoryResponse.Datapoints || [];
        const currentMemory = memoryDatapoints.length > 0
          ? memoryDatapoints.sort((a, b) => (b.Timestamp?.getTime() || 0) - (a.Timestamp?.getTime() || 0))[0].Average || 0
          : 0;
        
        metrics.push({
          name: 'Cluster Memory',
          value: Number(currentMemory.toFixed(1)),
          unit: '%',
          trend: memoryDatapoints.length > 1 && memoryDatapoints[0].Average! > memoryDatapoints[1].Average! ? 'up' : 'stable'
        });
      } catch (error) {
        // If we can't get cluster metrics, add defaults
        metrics.push({
          name: 'Cluster CPU',
          value: 0,
          unit: '%',
          trend: 'stable'
        });
        metrics.push({
          name: 'Cluster Memory',
          value: 0,
          unit: '%',
          trend: 'stable'
        });
      }

      // Response Time from ALB metrics
      try {
        const responseTimeResult = await this.cloudWatchClient.send(
          new GetMetricStatisticsCommand({
            Namespace: 'AWS/ApplicationELB',
            MetricName: 'TargetResponseTime',
            Dimensions: [{ Name: 'LoadBalancer', Value: albName }],
            StartTime: thirtyMinutesAgo,
            EndTime: now,
            Period: 300,
            Statistics: ['Average'],
          })
        );
        
        const responseDatapoints = responseTimeResult.Datapoints || [];
        const avgResponseTime = responseDatapoints.length > 0
          ? responseDatapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / responseDatapoints.length * 1000 // Convert to ms
          : 0;
        
        metrics.push({
          name: 'Avg Response Time',
          value: Number(avgResponseTime.toFixed(0)),
          unit: 'ms',
          trend: responseDatapoints.length > 1 && 
                 responseDatapoints[responseDatapoints.length - 1].Average! > responseDatapoints[0].Average! ? 'up' : 'down'
        });
      } catch (error) {
        metrics.push({
          name: 'Avg Response Time',
          value: 0,
          unit: 'ms',
          trend: 'stable'
        });
      }

      // Error Rate
      const errorResponse = await this.cloudWatchClient.send(
        new GetMetricStatisticsCommand({
          Namespace: 'AWS/ApplicationELB',
          MetricName: 'HTTPCode_Target_5XX_Count',
          Dimensions: [{ Name: 'LoadBalancer', Value: albName }],
          StartTime: thirtyMinutesAgo,
          EndTime: now,
          Period: 300,
          Statistics: ['Sum'],
        })
      );

      const totalErrors = errorResponse.Datapoints
        ?.reduce((sum, dp) => sum + (dp.Sum || 0), 0) || 0;
      
      const errorRate = totalRequests > 0 ? (totalErrors / totalRequests * 100) : 0;
      
      metrics.push({
        name: 'Error Rate (5xx)',
        value: Number(errorRate.toFixed(2)),
        unit: '%',
        trend: errorRate > 1 ? 'up' : 'stable'
      });

    } catch (error) {
      console.error('Failed to get metrics:', error);
      // Return mock metrics on error
      metrics.push(
        { name: 'Requests/30min', value: 0, trend: 'stable' },
        { name: 'CPU Usage', value: 0, unit: '%', trend: 'stable' },
        { name: 'Memory Usage', value: 0, unit: '%', trend: 'stable' },
        { name: 'Avg Response', value: 0, unit: 'ms', trend: 'stable' },
        { name: 'Error Rate', value: 0, unit: '%', trend: 'stable' }
      );
    }

    return metrics;
  }

  // Extract ALB name from DNS
  private extractALBName(albDns: string): string {
    const parts = albDns.split('-');
    const firstPart = albDns.split('.')[0];
    const id = firstPart ? firstPart.split('-').pop() : '';
    return `app/${parts[0]}-${parts[1]}-${parts[2]}/${id}`;
  }

  // Get all dashboard data
  async getDashboardData(): Promise<DashboardData> {
    const [services, logs, metrics] = await Promise.all([
      this.getServicesStatus(),
      this.getLogs(100),
      this.getMetrics()
    ]);

    return {
      services,
      logs,
      metrics,
      lastUpdate: new Date(),
      isRefreshing: false
    };
  }

  // Clear cache (useful for refresh)
  clearCache(): void {
    this.logCache.clear();
    this.lastLogTimestamp.clear();
  }
}