/**
 * Dashboard Data Sources
 * 
 * Provides real-time data collection and polling for dashboard components
 */

import { ECSClient, ListTasksCommand, DescribeTasksCommand, DescribeServicesCommand, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, GetLogEventsCommand, DescribeLogStreamsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { EFSClient, DescribeFileSystemsCommand } from '@aws-sdk/client-efs';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { Route53Client, ListHostedZonesCommand, ListResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { SemiontStackConfig } from './stack-config.js';
import { ServiceStatus, LogEntry, MetricData } from './dashboard-components.js';
import { DashboardData } from './dashboard-layouts.js';
import { ServiceType } from './types.js';
import { loadEnvironmentConfig, type EnvironmentConfig, resolveServiceDeployments } from './deployment-resolver.js';
import { spawn } from 'child_process';

export class DashboardDataSource {
  private stackConfig: SemiontStackConfig | null = null;
  private ecsClient: ECSClient | null = null;
  private logsClient: CloudWatchLogsClient | null = null;
  private cloudWatchClient: CloudWatchClient | null = null;
  private rdsClient: RDSClient | null = null;
  private efsClient: EFSClient | null = null;
  private cfnClient: CloudFormationClient | null = null;
  private elbClient: ElasticLoadBalancingV2Client | null = null;
  private route53Client: Route53Client | null = null;
  private logCache: Map<string, LogEntry[]> = new Map();
  private lastLogTimestamp: Map<string, Date> = new Map();
  private config: EnvironmentConfig;
  private environment: string;
  private isAWSEnvironment: boolean;

  constructor(environment: string) {
    this.environment = environment;
    this.config = loadEnvironmentConfig(environment);
    this.isAWSEnvironment = !!this.config.aws;
    
    // Initialize AWS clients only if AWS is configured
    if (this.isAWSEnvironment && this.config.aws) {
      this.stackConfig = new SemiontStackConfig(environment);
      this.ecsClient = new ECSClient({ region: this.config.aws.region });
      this.logsClient = new CloudWatchLogsClient({ region: this.config.aws.region });
      this.cloudWatchClient = new CloudWatchClient({ region: this.config.aws.region });
      this.rdsClient = new RDSClient({ region: this.config.aws.region });
      this.efsClient = new EFSClient({ region: this.config.aws.region });
      this.cfnClient = new CloudFormationClient({ region: this.config.aws.region });
      this.elbClient = new ElasticLoadBalancingV2Client({ region: this.config.aws.region });
      this.route53Client = new Route53Client({ region: 'us-east-1' }); // Route 53 is global, always use us-east-1
    }
  }

  // Get current services status
  async getServicesStatus(): Promise<ServiceStatus[]> {
    // If AWS environment, use AWS monitoring
    if (this.isAWSEnvironment && this.stackConfig && this.ecsClient) {
      return this.getAWSServicesStatus();
    }
    
    // Otherwise, use container monitoring
    return this.getContainerServicesStatus();
  }

  // Get AWS services status
  private async getAWSServicesStatus(): Promise<ServiceStatus[]> {
    const services: ServiceStatus[] = [];
    
    try {
      const clusterName = await this.stackConfig!.getClusterName();
      const serviceTypes: ServiceType[] = ['frontend', 'backend'];
      
      for (const serviceType of serviceTypes) {
        try {
          const serviceName = serviceType === 'frontend' 
            ? await this.stackConfig!.getFrontendServiceName()
            : await this.stackConfig!.getBackendServiceName();

          // Get service details first
          const serviceResponse = await this.ecsClient!.send(
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
            
            // Get deployment information
            const deployments = service.deployments || [];
            
            if (deployments.length > 1) {
              // Multiple deployments - rolling update in progress
              const primaryDeployment = deployments.find(d => d.status === 'PRIMARY');
              const activeDeployment = deployments.find(d => d.status === 'ACTIVE');
              
              const primaryRev = primaryDeployment?.taskDefinition?.match(/:(\d+)$/)?.[1] || 'unknown';
              const activeRev = activeDeployment?.taskDefinition?.match(/:(\d+)$/)?.[1] || 'unknown';
              
              // Calculate deployment progress
              const primaryRunning = primaryDeployment?.runningCount || 0;
              const primaryDesired = primaryDeployment?.desiredCount || 0;
              const progress = primaryDesired > 0 ? Math.round((primaryRunning / primaryDesired) * 100) : 0;
              
              // Create progress bar
              const barLength = 10;
              const filledLength = Math.round((progress / 100) * barLength);
              const progressBar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
              
              if (primaryRev === activeRev) {
                // Same revision but redeploying (common with :latest tag)
                deploymentStatus = `🔄 Redeploying rev:${primaryRev} [${progressBar}] ${progress}% (${primaryRunning}/${primaryDesired})`;
              } else {
                // Different revisions - actual update
                deploymentStatus = `🔄 rev:${activeRev}→${primaryRev} [${progressBar}] ${progress}%`;
              }
              
              taskDefinition = primaryDeployment?.taskDefinition;
            } else if (deployments.length === 1) {
              // Single deployment - stable
              const deployment = deployments[0];
              taskDefinition = deployment.taskDefinition;
              const revision = taskDefinition?.match(/:(\d+)$/)?.[1] || 'unknown';
              
              // Calculate deployment age
              const deploymentCreatedAt = deployment.createdAt;
              const deploymentAge = deploymentCreatedAt ? 
                Math.floor((Date.now() - new Date(deploymentCreatedAt).getTime()) / 1000 / 60) : 0;
              
              if (deployment.status === 'PRIMARY') {
                deploymentStatus = `Stable (rev:${revision}, ${deploymentAge}m ago)`;
              } else {
                deploymentStatus = deployment.status;
              }
            }
          }

          const response = await this.ecsClient!.send(
            new ListTasksCommand({
              cluster: clusterName,
              serviceName: serviceName,
              maxResults: 10,
            })
          );

          let status: ServiceStatus['status'] = 'unknown';
          let details = 'No tasks found';

          if (response.taskArns && response.taskArns.length > 0) {
            const tasksResponse = await this.ecsClient!.send(
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

          // Get service-specific metrics
          let cpuUtilization: number | undefined;
          let memoryUtilization: number | undefined;
          
          try {
            const now = new Date();
            const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
            
            // Get CPU utilization for this service
            const cpuResponse = await this.cloudWatchClient!.send(
              new GetMetricStatisticsCommand({
                Namespace: 'AWS/ECS',
                MetricName: 'CPUUtilization',
                Dimensions: [
                  { Name: 'ServiceName', Value: serviceName },
                  { Name: 'ClusterName', Value: clusterName }
                ],
                StartTime: fiveMinutesAgo,
                EndTime: now,
                Period: 300,
                Statistics: ['Average'],
              })
            );
            
            if (cpuResponse.Datapoints && cpuResponse.Datapoints.length > 0) {
              const latest = cpuResponse.Datapoints.sort((a, b) => 
                (b.Timestamp?.getTime() || 0) - (a.Timestamp?.getTime() || 0)
              )[0];
              cpuUtilization = latest.Average;
            }
            
            // Get Memory utilization for this service
            const memResponse = await this.cloudWatchClient!.send(
              new GetMetricStatisticsCommand({
                Namespace: 'AWS/ECS',
                MetricName: 'MemoryUtilization',
                Dimensions: [
                  { Name: 'ServiceName', Value: serviceName },
                  { Name: 'ClusterName', Value: clusterName }
                ],
                StartTime: fiveMinutesAgo,
                EndTime: now,
                Period: 300,
                Statistics: ['Average'],
              })
            );
            
            if (memResponse.Datapoints && memResponse.Datapoints.length > 0) {
              const latest = memResponse.Datapoints.sort((a, b) => 
                (b.Timestamp?.getTime() || 0) - (a.Timestamp?.getTime() || 0)
              )[0];
              memoryUtilization = latest.Average;
            }
          } catch (metricsError) {
            // Metrics fetch failed, but don't fail the whole service status
            console.debug(`Failed to get metrics for ${serviceName}: ${metricsError}`);
          }
          
          // Get the actual log group name and revision from the task definition
          let logGroupName: string | undefined;
          if (taskDefinition) {
            try {
              const describeTaskDefResponse = await this.ecsClient!.send(
                new DescribeTaskDefinitionCommand({
                  taskDefinition: taskDefinition
                })
              );
              
              // Get the revision from the task definition response
              revision = describeTaskDefResponse.taskDefinition?.revision;
              
              // Get the log configuration from the first container definition
              const containerDef = describeTaskDefResponse.taskDefinition?.containerDefinitions?.[0];
              if (containerDef?.logConfiguration?.options?.['awslogs-group']) {
                logGroupName = containerDef.logConfiguration.options['awslogs-group'];
              }
            } catch (error) {
              console.debug(`Failed to get task definition details: ${error}`);
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
            deploymentStatus,
            cpuUtilization,
            memoryUtilization,
            awsRegion: this.config.aws?.region,
            ecsServiceName: serviceName,
            ecsClusterName: clusterName,
            logGroupName
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
        const dbInstances = await this.rdsClient!.send(new DescribeDBInstancesCommand({}));
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
            lastUpdated: new Date(),
            // AWS Console links data
            awsRegion: this.config.aws?.region,
            rdsInstanceId: semiontDb.DBInstanceIdentifier
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
        const stackResult = await this.cfnClient!.send(new DescribeStacksCommand({
          StackName: 'SemiontDataStack'
        }));
        
        const outputs = stackResult.Stacks?.[0]?.Outputs || [];
        const efsIdOutput = outputs.find(o => 
          o.OutputKey === 'EfsFileSystemId' || o.OutputKey === 'EFSFileSystemId'
        );
        
        if (efsIdOutput?.OutputValue) {
          const efsResult = await this.efsClient!.send(new DescribeFileSystemsCommand({
            FileSystemId: efsIdOutput.OutputValue
          }));
          
          const filesystem = efsResult.FileSystems?.[0];
          if (filesystem) {
            const lifecycleState = filesystem.LifeCycleState;
            const fileSystemId = filesystem.FileSystemId!;
            
            // Get EFS metrics from CloudWatch
            let storageUsedBytes: number | undefined;
            let storageTotalBytes: number | undefined;
            let storageAvailableBytes: number | undefined;
            let storageUsedPercent: number | undefined;
            let throughputUtilization: number | undefined;
            let clientConnections: number | undefined;
            
            try {
              const endTime = new Date();
              const startTime = new Date(endTime.getTime() - 5 * 60 * 1000); // Last 5 minutes
              
              // Get storage metrics
              const [storageBytesMetric, clientConnectionsMetric, throughputMetric] = await Promise.all([
                // Storage bytes used
                this.cloudWatchClient!.send(new GetMetricStatisticsCommand({
                  Namespace: 'AWS/EFS',
                  MetricName: 'StorageBytes',
                  Dimensions: [
                    { Name: 'FileSystemId', Value: fileSystemId },
                    { Name: 'StorageClass', Value: 'Total' }
                  ],
                  StartTime: startTime,
                  EndTime: endTime,
                  Period: 300,
                  Statistics: ['Average']
                })),
                
                // Client connections
                this.cloudWatchClient!.send(new GetMetricStatisticsCommand({
                  Namespace: 'AWS/EFS',
                  MetricName: 'ClientConnections',
                  Dimensions: [
                    { Name: 'FileSystemId', Value: fileSystemId }
                  ],
                  StartTime: startTime,
                  EndTime: endTime,
                  Period: 60,
                  Statistics: ['Sum']
                })),
                
                // Throughput percentage
                this.cloudWatchClient!.send(new GetMetricStatisticsCommand({
                  Namespace: 'AWS/EFS',
                  MetricName: 'PercentIOLimit',
                  Dimensions: [
                    { Name: 'FileSystemId', Value: fileSystemId }
                  ],
                  StartTime: startTime,
                  EndTime: endTime,
                  Period: 60,
                  Statistics: ['Average']
                }))
              ]);
              
              // Process storage metrics
              if (storageBytesMetric.Datapoints && storageBytesMetric.Datapoints.length > 0) {
                storageUsedBytes = storageBytesMetric.Datapoints[0].Average;
                // EFS has effectively unlimited storage (8 EB limit)
                // Show 1TB as a reference total for percentage calculation
                storageTotalBytes = 1024 * 1024 * 1024 * 1024; // 1TB in bytes
                if (storageUsedBytes && storageTotalBytes) {
                  storageAvailableBytes = storageTotalBytes - storageUsedBytes;
                  storageUsedPercent = (storageUsedBytes / storageTotalBytes) * 100;
                }
              }
              
              // Process client connections
              if (clientConnectionsMetric.Datapoints && clientConnectionsMetric.Datapoints.length > 0) {
                clientConnections = clientConnectionsMetric.Datapoints[0].Sum;
              }
              
              // Process throughput
              if (throughputMetric.Datapoints && throughputMetric.Datapoints.length > 0) {
                throughputUtilization = throughputMetric.Datapoints[0].Average;
              }
              
            } catch (metricsError) {
              console.error('Failed to fetch EFS metrics:', metricsError);
            }
            
            services.push({
              name: 'Filesystem',
              status: lifecycleState === 'available' ? 'healthy' : 
                     lifecycleState === 'creating' || lifecycleState === 'updating' ? 'warning' : 'unhealthy',
              details: `EFS ${fileSystemId} - ${lifecycleState}`,
              storageUsedBytes,
              storageTotalBytes,
              storageAvailableBytes,
              storageUsedPercent,
              throughputUtilization,
              clientConnections,
              lastUpdated: new Date(),
              // AWS Console links data
              awsRegion: this.config.aws?.region,
              efsFileSystemId: fileSystemId
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
    
    // Add ALB status
    try {
      const albDns = await this.stackConfig!.getLoadBalancerDNS();
      if (albDns) {
        let albStatus = 'unknown';
        let albDetails = 'Load balancer information unavailable';
        let requestCount = 0;
        let albArn: string | undefined;
        
        try {
          // Get load balancer by DNS name
          const albResult = await this.elbClient!.send(new DescribeLoadBalancersCommand({}));
          
          const alb = albResult.LoadBalancers?.find(lb => lb.DNSName === albDns);
          if (alb) {
            albStatus = alb.State?.Code === 'active' ? 'healthy' : 'warning';
            const scheme = alb.Scheme === 'internet-facing' ? 'Public' : 'Private';
            const zones = alb.AvailabilityZones?.filter(z => z.ZoneName).length || 0;
            albDetails = `${scheme} ALB - ${zones} AZs`;
            albArn = alb.LoadBalancerArn;
            
            // Get request count metrics
            try {
              const now = new Date();
              const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
              
              // Use the ALB ARN directly - CloudWatch expects the full resource name
              if (alb.LoadBalancerArn) {
                // Extract the LoadBalancer dimension value from ARN
                // Format: arn:aws:elasticloadbalancing:region:account:loadbalancer/app/name/id
                const arnParts = alb.LoadBalancerArn.split('/');
                if (arnParts.length >= 3) {
                  const albDimensionValue = arnParts.slice(-3).join('/'); // app/name/id
                  
                  const metricsResponse = await this.cloudWatchClient!.send(
                    new GetMetricStatisticsCommand({
                      Namespace: 'AWS/ApplicationELB',
                      MetricName: 'RequestCount',
                      Dimensions: [{ Name: 'LoadBalancer', Value: albDimensionValue }],
                      StartTime: fiveMinutesAgo,
                      EndTime: now,
                      Period: 300,
                      Statistics: ['Sum'],
                    })
                  );
                
                  if (metricsResponse.Datapoints && metricsResponse.Datapoints.length > 0) {
                    const latest = metricsResponse.Datapoints.sort((a, b) => 
                      (b.Timestamp?.getTime() || 0) - (a.Timestamp?.getTime() || 0)
                    )[0];
                    requestCount = latest.Sum || 0;
                    if (requestCount > 0) {
                      albDetails += ` • ${requestCount} req/5m`;
                    }
                  }
                }
              }
            } catch (metricsError) {
              // Metrics optional
            }
          }
        } catch (error) {
          console.debug('Failed to get ALB details:', error);
        }
        
        services.push({
          name: 'Load Balancer',
          status: albStatus as any,
          details: albDetails,
          lastUpdated: new Date(),
          requestCount,
          // AWS Console links data
          awsRegion: this.config.aws?.region,
          albArn
        });
      }
    } catch (error) {
      console.debug('Failed to get ALB status:', error);
      services.push({
        name: 'Load Balancer',
        status: 'unknown',
        details: 'Failed to check ALB status',
        lastUpdated: new Date()
      });
    }
    
    // Add WAF status 
    // Note: Would need WAFv2 client and WebACL association to get real status
    // For now, check if WAF is mentioned in stack outputs
    try {
      const stackResult = await this.cfnClient!.send(new DescribeStacksCommand({
        StackName: 'SemiontAppStack'
      }));
      
      const outputs = stackResult.Stacks?.[0]?.Outputs || [];
      const wafOutput = outputs.find(o => 
        o.OutputKey?.includes('WAF') || o.OutputKey?.includes('WebACL')
      );
      
      if (wafOutput) {
        services.push({
          name: 'WAF',
          status: 'healthy',
          details: 'Web Application Firewall active',
          lastUpdated: new Date()
        });
      } else {
        services.push({
          name: 'WAF',
          status: 'unknown',
          details: 'WAF not configured',
          lastUpdated: new Date()
        });
      }
    } catch (error) {
      services.push({
        name: 'WAF',
        status: 'unknown',
        details: 'WAF status unavailable',
        lastUpdated: new Date()
      });
    }
    
    // Add Route 53 DNS status
    try {
      // List all hosted zones
      const zonesResult = await this.route53Client!.send(new ListHostedZonesCommand({}));
      const zones = zonesResult.HostedZones || [];
      
      let dnsStatus = 'unknown';
      let dnsDetails = 'No DNS zones configured';
      let recordCount = 0;
      
      if (zones.length > 0) {
        // Get the first zone (or look for one matching your domain)
        const zone = zones[0];
        const zoneName = zone.Name?.replace(/\.$/, ''); // Remove trailing dot
        
        try {
          // Count records in the zone - zone.Id is already in the correct format
          const recordsResult = await this.route53Client!.send(new ListResourceRecordSetsCommand({
            HostedZoneId: zone.Id // zone.Id already contains just the ID, no parsing needed
          }));
          
          recordCount = recordsResult.ResourceRecordSets?.length || 0;
          // const aRecords = recordsResult.ResourceRecordSets?.filter(r => r.Type === 'A').length || 0;
          // const cnameRecords = recordsResult.ResourceRecordSets?.filter(r => r.Type === 'CNAME').length || 0;
          
          dnsStatus = 'healthy';
          dnsDetails = `${zoneName} - ${recordCount} records`;
          
          // Check if there's an A record pointing to the ALB
          const albDns = await this.stackConfig!.getLoadBalancerDNS();
          const hasAlbRecord = recordsResult.ResourceRecordSets?.some(record => 
            record.Type === 'A' && 
            record.AliasTarget?.DNSName?.includes(albDns)
          );
          
          if (hasAlbRecord) {
            dnsDetails += ' • ALB configured';
          }
        } catch (error) {
          console.debug('Failed to get record details:', error);
        }
        
        services.push({
          name: 'DNS (Route 53)',
          status: dnsStatus as any,
          details: dnsDetails,
          lastUpdated: new Date()
        });
      } else {
        services.push({
          name: 'DNS (Route 53)',
          status: 'unknown',
          details: 'No hosted zones found',
          lastUpdated: new Date()
        });
      }
    } catch (error) {
      console.debug('Failed to get Route 53 status:', error);
      services.push({
        name: 'DNS (Route 53)',
        status: 'unknown',
        details: 'DNS status unavailable',
        lastUpdated: new Date()
      });
    }

    return services;
  }

  // Get container services status (Docker/Podman)
  private async getContainerServicesStatus(): Promise<ServiceStatus[]> {
    const services: ServiceStatus[] = [];
    const deployments = resolveServiceDeployments(['all'], this.environment);
    
    for (const deployment of deployments) {
      if (deployment.deploymentType === 'container') {
        const containerName = `semiont-${deployment.name}-${this.environment}`;
        const status = await this.getContainerStatus(containerName);
        services.push(status);
      } else if (deployment.deploymentType === 'process') {
        // For process deployments, check if process is running
        services.push({
          name: deployment.name.charAt(0).toUpperCase() + deployment.name.slice(1),
          status: 'unknown',
          details: 'Process monitoring not implemented',
          lastUpdated: new Date()
        });
      }
    }
    
    return services;
  }

  // Get status of a single container
  private async getContainerStatus(containerName: string): Promise<ServiceStatus> {
    // Try docker first, then podman
    const containerRuntime = await this.detectContainerRuntime();
    
    if (!containerRuntime) {
      return {
        name: containerName,
        status: 'unknown',
        details: 'No container runtime detected',
        lastUpdated: new Date()
      };
    }
    
    return new Promise((resolve) => {
      const inspectCmd = spawn(containerRuntime, ['inspect', '--format', '{{json .State}}', containerName]);
      let output = '';
      let errorOutput = '';
      
      inspectCmd.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      inspectCmd.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
      
      inspectCmd.on('close', (code) => {
        if (code === 0 && output) {
          try {
            const state = JSON.parse(output.trim());
            const isRunning = state.Running || state.Status === 'running';
            const health = state.Health?.Status || 'none';
            
            let status: ServiceStatus['status'] = 'unknown';
            let details = '';
            
            if (isRunning) {
              if (health === 'healthy') {
                status = 'healthy';
                details = 'Container running and healthy';
              } else if (health === 'unhealthy') {
                status = 'unhealthy';
                details = 'Container running but unhealthy';
              } else {
                status = 'healthy';
                details = 'Container running';
              }
            } else {
              status = 'unhealthy';
              details = `Container ${state.Status || 'stopped'}`;
            }
            
            // Extract service name from container name
            const serviceName = containerName.replace(`semiont-`, '').replace(`-${this.environment}`, '');
            
            resolve({
              name: serviceName.charAt(0).toUpperCase() + serviceName.slice(1),
              status,
              details,
              lastUpdated: new Date()
            });
          } catch (error) {
            resolve({
              name: containerName,
              status: 'unknown',
              details: 'Failed to parse container state',
              lastUpdated: new Date()
            });
          }
        } else {
          // Container doesn't exist
          const serviceName = containerName.replace(`semiont-`, '').replace(`-${this.environment}`, '');
          resolve({
            name: serviceName.charAt(0).toUpperCase() + serviceName.slice(1),
            status: 'unhealthy',
            details: 'Container not found',
            lastUpdated: new Date()
          });
        }
      });
    });
  }

  // Detect if docker or podman is available
  private async detectContainerRuntime(): Promise<string | null> {
    // Check for docker first
    const dockerCheck = spawn('docker', ['--version']);
    const dockerAvailable = await new Promise<boolean>((resolve) => {
      dockerCheck.on('close', (code) => resolve(code === 0));
      dockerCheck.on('error', () => resolve(false));
    });
    
    if (dockerAvailable) {
      return 'docker';
    }
    
    // Check for podman
    const podmanCheck = spawn('podman', ['--version']);
    const podmanAvailable = await new Promise<boolean>((resolve) => {
      podmanCheck.on('close', (code) => resolve(code === 0));
      podmanCheck.on('error', () => resolve(false));
    });
    
    if (podmanAvailable) {
      return 'podman';
    }
    
    return null;
  }

  // Get recent logs from all services
  async getLogs(maxEntries: number = 50): Promise<LogEntry[]> {
    const allLogs: LogEntry[] = [];
    
    if (this.isAWSEnvironment) {
      // For AWS, use CloudWatch logs
      const serviceTypes: ServiceType[] = ['frontend', 'backend'];

      for (const serviceType of serviceTypes) {
        try {
          const logs = await this.getServiceLogs(serviceType, maxEntries);
          allLogs.push(...logs);
        } catch (error) {
          console.error(`Failed to get ${serviceType} logs:`, error);
        }
      }

      // Also try to get RDS logs if available
      try {
        const rdsLogs = await this.getRDSLogs(maxEntries);
        allLogs.push(...rdsLogs);
      } catch (error) {
        // Silently skip RDS logs if not available
      }
    } else {
      // For container deployments, use docker/podman logs
      const deployments = resolveServiceDeployments(['all'], this.environment);
      
      for (const deployment of deployments) {
        if (deployment.deploymentType === 'container') {
          try {
            const containerName = `semiont-${deployment.name}-${this.environment}`;
            const logs = await this.getContainerLogs(containerName, deployment.name, maxEntries);
            allLogs.push(...logs);
          } catch (error) {
            console.debug(`Failed to get container logs for ${deployment.name}:`, error);
          }
        }
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
      const clusterName = await this.stackConfig!.getClusterName();
      const serviceName = serviceType === 'frontend' 
        ? await this.stackConfig!.getFrontendServiceName()
        : await this.stackConfig!.getBackendServiceName();

      const tasksResponse = await this.ecsClient!.send(
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

      const logGroupName = await this.stackConfig!.getLogGroupName();
      const response = await this.logsClient!.send(
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
    const logGroupName = await this.stackConfig!.getLogGroupName();
    const streamPrefix = `semiont-${service}/semiont-${service}/${taskId}`;
    
    try {
      const response = await this.logsClient!.send(
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

  // Get RDS logs
  private async getRDSLogs(maxEntries: number): Promise<LogEntry[]> {
    const cacheKey = 'rds-database';
    const cached = this.logCache.get(cacheKey) || [];
    const lastTimestamp = this.lastLogTimestamp.get(cacheKey) || new Date(Date.now() - 5 * 60 * 1000);

    try {
      // First, find the RDS instance
      const dbInstances = await this.rdsClient.send(new DescribeDBInstancesCommand({}));
      const semiontDb = dbInstances.DBInstances?.find(db => 
        db.DBInstanceIdentifier?.toLowerCase().includes('semiont')
      );
      
      if (!semiontDb || !semiontDb.DBInstanceIdentifier) {
        return cached;
      }

      // RDS logs are accessed through CloudWatch Logs
      // The log group name follows the pattern: /aws/rds/instance/{db-instance-id}/{log-type}
      const logTypes = ['postgresql', 'error/postgresql', 'slowquery/postgresql'];
      const allNewLogs: LogEntry[] = [];
      
      for (const logType of logTypes) {
        const logGroupName = `/aws/rds/instance/${semiontDb.DBInstanceIdentifier}/${logType}`;
        
        try {
          // Get the latest log stream
          const streamsResponse = await this.logsClient!.send(
            new DescribeLogStreamsCommand({
              logGroupName,
              orderBy: 'LastEventTime',
              descending: true,
              limit: 1
            })
          );

          const logStream = streamsResponse.logStreams?.[0];
          if (!logStream?.logStreamName) {
            continue;
          }

          // Fetch log events
          const response = await this.logsClient!.send(
            new GetLogEventsCommand({
              logGroupName,
              logStreamName: logStream.logStreamName,
              startTime: lastTimestamp.getTime(),
              limit: Math.floor(maxEntries / 3), // Divide among log types
            })
          );

          const newLogs: LogEntry[] = (response.events || [])
            .filter(event => event.timestamp && event.timestamp > lastTimestamp.getTime())
            .map(event => ({
              timestamp: new Date(event.timestamp || 0),
              level: this.parseRDSLogLevel(event.message || '', logType.includes('error')),
              service: 'database',
              message: this.cleanRDSLogMessage(event.message || '', logType.includes('slowquery')),
            }));

          allNewLogs.push(...newLogs);

        } catch (logError) {
          // Log group might not exist or might not have CloudWatch Logs enabled
          // This is expected when CloudWatch Logs aren't configured for RDS
          // Silently skip to avoid cluttering the console
        }
      }

      if (allNewLogs.length > 0) {
        const allRDSLogs = [...cached, ...allNewLogs]
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          .slice(0, maxEntries * 2);

        this.logCache.set(cacheKey, allRDSLogs);
        const latestLog = allNewLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
        if (latestLog) {
          this.lastLogTimestamp.set(cacheKey, latestLog.timestamp);
        }
        return allRDSLogs;
      }

      return cached;

    } catch (error) {
      // Silently handle RDS log fetch errors (e.g., when RDS instance doesn't exist)
      return cached;
    }
  }

  // Get container logs (Docker/Podman)
  private async getContainerLogs(containerName: string, serviceName: string, maxEntries: number): Promise<LogEntry[]> {
    const cacheKey = `container-${serviceName}`;
    const cached = this.logCache.get(cacheKey) || [];
    const lastTimestamp = this.lastLogTimestamp.get(cacheKey) || new Date(Date.now() - 5 * 60 * 1000);
    
    const containerRuntime = await this.detectContainerRuntime();
    if (!containerRuntime) {
      return cached;
    }
    
    return new Promise((resolve) => {
      // Use --since flag to get logs from last timestamp
      // Format: RFC3339 timestamp
      const sinceTime = lastTimestamp.toISOString();
      
      // Docker/Podman logs command with timestamps
      const logsCmd = spawn(containerRuntime, [
        'logs',
        '--timestamps',
        '--since', sinceTime,
        '--tail', maxEntries.toString(),
        containerName
      ]);
      
      let stdout = '';
      let stderr = '';
      
      logsCmd.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      logsCmd.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      logsCmd.on('close', () => {
        // Both stdout and stderr can contain logs
        const allOutput = stdout + stderr;
        const lines = allOutput.split('\n').filter(line => line.trim());
        
        const newLogs: LogEntry[] = [];
        
        for (const line of lines) {
          // Docker/Podman logs format: "2024-01-01T12:34:56.789Z message here"
          const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z?)\s+(.*)$/);
          
          if (timestampMatch) {
            const timestamp = new Date(timestampMatch[1]);
            const message = timestampMatch[2];
            
            // Only include logs newer than lastTimestamp
            if (timestamp > lastTimestamp) {
              newLogs.push({
                timestamp,
                level: this.parseContainerLogLevel(message),
                service: serviceName,
                message: this.cleanContainerLogMessage(message)
              });
            }
          } else if (line.trim()) {
            // If no timestamp, use current time (shouldn't happen with --timestamps flag)
            newLogs.push({
              timestamp: new Date(),
              level: this.parseContainerLogLevel(line),
              service: serviceName,
              message: this.cleanContainerLogMessage(line)
            });
          }
        }
        
        if (newLogs.length > 0) {
          // Merge with cache and update
          const allServiceLogs = [...cached, ...newLogs]
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
            .slice(0, maxEntries * 2);
          
          this.logCache.set(cacheKey, allServiceLogs);
          
          // Update last timestamp
          const latestLog = newLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
          if (latestLog) {
            this.lastLogTimestamp.set(cacheKey, latestLog.timestamp);
          }
          
          resolve(allServiceLogs.slice(0, maxEntries));
        } else {
          resolve(cached);
        }
      });
      
      logsCmd.on('error', () => {
        // Container or runtime not found
        resolve(cached);
      });
    });
  }

  // Parse container log level
  private parseContainerLogLevel(message: string): LogEntry['level'] {
    const upperMessage = message.toUpperCase();
    
    // Common log patterns
    if (upperMessage.includes('ERROR') || upperMessage.includes('FATAL') || upperMessage.includes('FAILED')) return 'error';
    if (upperMessage.includes('WARN') || upperMessage.includes('WARNING')) return 'warn';
    if (upperMessage.includes('DEBUG') || upperMessage.includes('TRACE')) return 'debug';
    
    // Framework-specific patterns
    // Node.js/Express
    if (message.match(/^\[ERROR\]/i) || message.match(/^Error:/i)) return 'error';
    if (message.match(/^\[WARN\]/i) || message.match(/^Warning:/i)) return 'warn';
    if (message.match(/^\[DEBUG\]/i)) return 'debug';
    
    // Next.js patterns
    if (message.includes('⨯') || message.includes('✗')) return 'error';
    if (message.includes('⚠')) return 'warn';
    if (message.includes('✓') || message.includes('○')) return 'info';
    
    return 'info';
  }

  // Clean container log messages
  private cleanContainerLogMessage(message: string): string {
    // Remove common prefixes and clean up
    return message
      .replace(/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?\]?\s*/, '') // Remove timestamps
      .replace(/^\[(ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\]\s*/i, '') // Remove log level prefixes
      .replace(/^(npm|yarn|pnpm) (ERR!|WARN|notice)\s*/i, '') // Remove package manager prefixes
      .replace(/^\s*>\s*/, '') // Remove npm script prefixes
      .replace(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+/i, '') // HTTP methods at start
      .trim();
  }

  // Parse RDS/PostgreSQL log level
  private parseRDSLogLevel(message: string, isErrorLog: boolean = false): LogEntry['level'] {
    // If it's from the error log, default to error level
    if (isErrorLog) return 'error';
    
    const upperMessage = message.toUpperCase();
    
    // PostgreSQL log patterns
    if (upperMessage.includes('FATAL:') || upperMessage.includes('PANIC:')) return 'error';
    if (upperMessage.includes('ERROR:')) return 'error';
    if (upperMessage.includes('WARNING:')) return 'warn';
    if (upperMessage.includes('DEBUG')) return 'debug';
    if (upperMessage.includes('LOG:') || upperMessage.includes('INFO:')) return 'info';
    
    // Generic patterns
    if (upperMessage.includes('FAILED') || upperMessage.includes('FAILURE')) return 'error';
    if (upperMessage.includes('WARN')) return 'warn';
    
    return 'info';
  }

  // Clean RDS/PostgreSQL log messages
  private cleanRDSLogMessage(message: string, isSlowQuery: boolean = false): string {
    // For slow query logs, include query duration info
    if (isSlowQuery) {
      // Extract and format slow query information
      const durationMatch = message.match(/duration: ([\d.]+) ms/);
      const queryMatch = message.match(/statement: (.+)/s);
      
      if (durationMatch && queryMatch) {
        const duration = parseFloat(durationMatch[1]);
        const query = queryMatch[1].trim().substring(0, 200); // Limit query length
        return `Slow query (${duration.toFixed(2)}ms): ${query}${queryMatch[1].length > 200 ? '...' : ''}`;
      }
    }
    
    // Remove PostgreSQL-specific prefixes
    return message
      .replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC:\s*/, '') // PostgreSQL timestamp
      .replace(/^LOG:\s*/i, '')
      .replace(/^ERROR:\s*/i, '')
      .replace(/^WARNING:\s*/i, '')
      .replace(/^FATAL:\s*/i, '')
      .replace(/^PANIC:\s*/i, '')
      .replace(/^DEBUG\d?:\s*/i, '')
      .replace(/^\[[^\]]+\]:\s*/, '') // Remove [username@database] prefixes
      .replace(/^\d+\.\d+\s+/, '') // Remove process IDs
      .trim();
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
      const albDns = await this.stackConfig!.getLoadBalancerDNS();
      const albName = this.extractALBName(albDns);
      
      const requestCountResponse = await this.cloudWatchClient!.send(
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
        const clusterName = await this.stackConfig!.getClusterName();
        
        // CPU Utilization
        const cpuResponse = await this.cloudWatchClient!.send(
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
        const memoryResponse = await this.cloudWatchClient!.send(
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
        const responseTimeResult = await this.cloudWatchClient!.send(
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
      const errorResponse = await this.cloudWatchClient!.send(
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