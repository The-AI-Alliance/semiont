/**
 * AWS Platform Strategy
 * 
 * Deploys and manages services on AWS cloud infrastructure. This platform leverages
 * AWS services like ECS, Fargate, Lambda, and RDS to provide scalable, production-ready
 * deployments with enterprise features.
 * 
 * Capabilities:
 * - Deploys containers to ECS with Fargate for serverless container management
 * - Provisions infrastructure using AWS CDK for infrastructure-as-code
 * - Manages service discovery through AWS Cloud Map
 * - Provides auto-scaling based on CPU/memory metrics
 * - Integrates with AWS services (RDS, S3, CloudWatch, etc.)
 * - Supports blue-green deployments for zero-downtime updates
 * 
 * Requirements Handling:
 * - Compute: Selects appropriate Fargate task sizes or Lambda memory
 * - Network: Configures ALB/NLB load balancers, security groups, and VPCs
 * - Storage: Provisions EBS volumes, S3 buckets, or RDS databases
 * - Dependencies: Uses service discovery and security groups for inter-service communication
 * - Security: Manages IAM roles, secrets in Secrets Manager, and KMS encryption
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { HandlerRegistry } from "../../core/handlers/registry.js";
import { handlers } from './handlers/index.js';
import { BasePlatformStrategy } from '../../core/platform-strategy.js';
import { Service } from '../../services/types.js';
import { printInfo, printSuccess } from '../../core/io/cli-logger.js';
import { loadEnvironmentConfig } from '../../core/platform-resolver.js';

// AWS SDK v3 clients
import { ECSClient } from '@aws-sdk/client-ecs';
import { RDSClient } from '@aws-sdk/client-rds';
import { EFSClient } from '@aws-sdk/client-efs';
import { CloudFormationClient, ListStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { CloudWatchLogsClient, FilterLogEventsCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';

export class AWSPlatformStrategy extends BasePlatformStrategy {
  private ecsClient?: ECSClient;
  private rdsClient?: RDSClient;
  private efsClient?: EFSClient;
  private cfnClient?: CloudFormationClient;
  private elbClient?: ElasticLoadBalancingV2Client;
  private logsClient?: CloudWatchLogsClient;
  
  constructor() {
    super();
    this.registerHandlers();
  }
  
  private registerHandlers(): void {
    const registry = HandlerRegistry.getInstance();
    registry.registerHandlers('aws', handlers);
  }
  
  /**
   * Get AWS configuration from service's environment
   */
  public getAWSConfig(service: Service): { 
    region: string; 
    accountId: string;
    dataStack?: string;
    appStack?: string;
  } {
    // Load the environment configuration to get AWS settings
    const { loadEnvironmentConfig } = require('../../core/platform-resolver.js');
    const envConfig = loadEnvironmentConfig(service.environment);
    
    // Get AWS config from environment file, fallback to env vars
    return {
      region: envConfig.aws?.region || process.env.AWS_REGION || 'us-east-1',
      accountId: envConfig.aws?.accountId || process.env.AWS_ACCOUNT_ID || '',
      dataStack: envConfig.aws?.stacks?.data,
      appStack: envConfig.aws?.stacks?.app
    };
  }
  
  /**
   * Get AWS account ID
   * Helper method for handlers that need just the account ID
   */
  public getAccountId(service: Service): string {
    return this.getAWSConfig(service).accountId;
  }
  
  /**
   * Get AWS SDK clients configured for the right region
   */
  public getAWSClients(region: string) {
    if (!this.ecsClient || this.ecsClient.config.region !== region) {
      this.ecsClient = new ECSClient({ region });
      this.rdsClient = new RDSClient({ region });
      this.efsClient = new EFSClient({ region });
      this.cfnClient = new CloudFormationClient({ region });
      this.elbClient = new ElasticLoadBalancingV2Client({ region });
      this.logsClient = new CloudWatchLogsClient({ region });
    }
    
    return {
      ecs: this.ecsClient!,
      rds: this.rdsClient!,
      efs: this.efsClient!,
      cfn: this.cfnClient!,
      elb: this.elbClient!,
      logs: this.logsClient!
    };
  }
  
  getPlatformName(): string {
    return 'aws';
  }
  
  /**
   * Get actual resource names from CloudFormation stacks
   */
  private async getStackResources(
    stackName: string, 
    region: string,
    resourceType: string
  ): Promise<any[]> {
    try {
      const { cfn } = this.getAWSClients(region);
      const response = await cfn.send(new ListStackResourcesCommand({
        StackName: stackName
      }));
      
      return (response.StackResourceSummaries || [])
        .filter(r => r.ResourceType === resourceType);
    } catch (error) {
      // Silently fail - stack might not exist
      return [];
    }
  }
  
  /**
   * Build platform-specific context extensions for handlers
   * Including CloudFormation resource discovery if needed
   */
  public async buildHandlerContextExtensions(service: Service, requiresDiscovery: boolean): Promise<Record<string, any>> {
    const awsConfig = this.getAWSConfig(service);
    
    let cfnDiscoveredResources = {};
    if (requiresDiscovery) {
      cfnDiscoveredResources = await this.discoverAndCacheResources(service);
    }
    
    // For provision handlers, provide the full AWS config
    // For other handlers, maintain backward compatibility
    return {
      cfnDiscoveredResources,
      region: awsConfig.region,
      accountId: awsConfig.accountId,
      resourceName: this.getResourceName(service),
      // Include full awsConfig for provision handlers
      awsConfig
    };
  }
  
  /**
   * Get all CloudFormation resources and cache them in StateManager
   */
  private async discoverAndCacheResources(service: Service): Promise<{
    clusterName?: string;
    serviceName?: string;
    dbInstanceId?: string;
    fileSystemId?: string;
    loadBalancerDns?: string;
    wafWebAclArn?: string;
  }> {
    const { region, dataStack, appStack } = this.getAWSConfig(service);
    const { StateManager } = await import('../../core/state-manager.js');
    
    // Load existing state for potential update
    const existingState = await StateManager.load(
      service.projectRoot,
      service.environment,
      service.name
    );
    
    // Check if we have cached resources in state (unless forceDiscovery is set)
    if (!service.forceDiscovery) {
      // Check if we have recent CloudFormation resource discovery
      if (existingState?.metadata?.cfnResources && 
          existingState?.metadata?.cfnDiscoveredAt &&
          Date.now() - existingState.metadata.cfnDiscoveredAt < 3600000) { // 1 hour cache
        if (service.verbose) {
          console.log(`[DEBUG] Using cached CloudFormation resources for ${service.name}`);
        }
        return existingState.metadata.cfnResources;
      }
    } else if (service.verbose) {
      console.log(`[DEBUG] Forcing CloudFormation discovery for ${service.name} (--force-discovery flag set)`);
    }
    
    // Discover all resources from CloudFormation
    const resources: any = {};
    
    if (service.verbose) {
      console.log(`[DEBUG] Starting CloudFormation resource discovery for ${service.name} (appStack: ${appStack}, dataStack: ${dataStack})`);
    }
    
    if (appStack) {
      // Get ECS Cluster
      const clusters = await this.getStackResources(appStack, region, 'AWS::ECS::Cluster');
      const clusterName = clusters[0]?.PhysicalResourceId;
      
      // Get ECS Services - match by service name dynamically
      const services = await this.getStackResources(appStack, region, 'AWS::ECS::Service');
      for (const svc of services) {
        const logicalId = svc.LogicalResourceId.toLowerCase();
        const serviceName = service.name.toLowerCase();
        
        // Match the service by name in the logical ID
        if (logicalId.includes(serviceName)) {
          resources[service.name] = resources[service.name] || {};
          resources[service.name].clusterName = clusterName;
          resources[service.name].serviceName = svc.PhysicalResourceId?.split('/').pop();
        }
      }
    }
    
    if (dataStack) {
      // Get RDS Instance - match database service
      if (service.name === 'database' || this.determineServiceType(service) === 'rds') {
        const databases = await this.getStackResources(dataStack, region, 'AWS::RDS::DBInstance');
        if (databases[0]) {
          resources[service.name] = { dbInstanceId: databases[0].PhysicalResourceId };
        }
      }
      
      // Get EFS FileSystem - match filesystem service
      if (service.name === 'filesystem' || this.determineServiceType(service) === 'efs') {
        const filesystems = await this.getStackResources(dataStack, region, 'AWS::EFS::FileSystem');
        if (filesystems[0]) {
          resources[service.name] = { fileSystemId: filesystems[0].PhysicalResourceId };
        }
      }
    }
    
    // Get resources for this specific service
    const serviceResources = resources[service.name] || {};
    
    // Get CloudFormation outputs for ALB and WAF information
    
    try {
      const { cfn } = this.getAWSClients(region);
      
      if (service.verbose) {
      }
      
      // Check app stack for outputs
      if (appStack) {
        try {
          const stackResponse = await cfn.send(new DescribeStacksCommand({
            StackName: appStack
          }));
          
          const outputs = stackResponse.Stacks?.[0]?.Outputs || [];
          
          
          // Look for LoadBalancer DNS
          const albOutput = outputs.find(o => 
            o.OutputKey === 'LoadBalancerDNS' || 
            o.OutputKey === 'ALBDNSName' ||
            o.OutputKey?.includes('LoadBalancer')
          );
          if (albOutput?.OutputValue) {
            // Add directly to serviceResources
            serviceResources.loadBalancerDns = albOutput.OutputValue;
            // Also add to all services in resources since ALB is shared
            for (const svcName in resources) {
              resources[svcName].loadBalancerDns = albOutput.OutputValue;
            }
          }
          
          // Look for WAF WebACL ARN
          const wafOutput = outputs.find(o => 
            o.OutputKey === 'WAFWebACLArn' || 
            o.OutputKey === 'WebACLArn' ||
            o.OutputKey?.includes('WAF')
          );
          if (wafOutput?.OutputValue) {
            // Add directly to serviceResources
            serviceResources.wafWebAclArn = wafOutput.OutputValue;
            // Also add to all services in resources since WAF protects the ALB
            for (const svcName in resources) {
              resources[svcName].wafWebAclArn = wafOutput.OutputValue;
            }
          }
        } catch (error) {
          // Stack might not exist or no permissions
        }
      }
    } catch (error) {
      // CloudFormation discovery failed
      if (service.verbose) {
        console.log(`[DEBUG] CloudFormation discovery failed: ${error}`);
      }
    }
    
    // Save discovered resources in state metadata
    if (Object.keys(serviceResources).length > 0) {
      const currentState = existingState || {
        entity: service.name,
        platform: 'aws',
        environment: service.environment,
        startTime: new Date().toISOString()
      };
      
      await StateManager.save(
        service.projectRoot,
        service.environment,
        service.name,
        {
          ...currentState,
          metadata: {
            ...currentState.metadata,
            cfnResources: serviceResources,
            cfnDiscoveredAt: Date.now()
          }
        }
      );
    }
    
    return serviceResources;
  }
  
  
  /**
   * Determine the AWS service type based on service name and requirements
   */
  public determineServiceType(service: Service): string {
    const requirements = service.getRequirements();
    
    // Check for stack provisioning (special case)
    if (service.name === '__aws_stack__') {
      return 'stack';
    }
    
    // Check explicit AWS service annotation first
    if (requirements.annotations?.['aws/service']) {
      return requirements.annotations['aws/service'];
    }
    
    // Service-specific mappings based on name
    switch (service.name) {
      case 'database':
        // Database is always RDS PostgreSQL in production
        return 'rds';
      
      case 'filesystem':
        // Filesystem is always EFS
        return 'efs';
      
      case 'frontend':
      case 'backend':
        // Frontend and backend are containerized services on ECS Fargate
        return 'ecs-fargate';
      
      default:
        // Check other annotations and requirements
        
        // Static content with CDN needs → S3 + CloudFront
        if (requirements.annotations?.['service/type'] === 'static' ||
            (requirements.network?.needsLoadBalancer && !requirements.resources?.cpu)) {
          return 's3-cloudfront';
        }
        
        // Database requirements → RDS
        if (requirements.annotations?.['service/type'] === 'database') {
          return requirements.annotations?.['aws/nosql'] === 'true' ? 'dynamodb' : 'rds';
        }
        
        // Serverless function → Lambda
        if (requirements.annotations?.['serverless'] === 'true') {
          return 'lambda';
        }
        
        // File storage → EFS
        if (requirements.annotations?.['service/type'] === 'filesystem' ||
            requirements.storage?.type === 'filesystem') {
          return 'efs';
        }
        
        // Container with resources → ECS Fargate
        if (requirements.build?.dockerfile || requirements.resources?.cpu || requirements.resources?.memory) {
          return 'ecs-fargate';
        }
        
        // Default to ECS Fargate for services
        return 'ecs-fargate';
    }
  }
  
  async update(service: Service): Promise<UpdateResult> {
    const { region } = this.getAWSConfig(service);
    const serviceType = this.determineServiceType(service);
    const resourceName = this.getResourceName(service);
    
    let previousVersion: string | undefined;
    let newVersion: string | undefined;
    let strategy: UpdateResult['strategy'] = 'rolling';
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Get resource IDs from CloudFormation (with caching)
        const cfnDiscoveredResources = await this.discoverAndCacheResources(service);
        
        // Get cluster and service names from discovered resources
        const clusterName = cfnDiscoveredResources.clusterName || `semiont-${service.environment}`;
        const serviceName = cfnDiscoveredResources.serviceName || this.getResourceName(service);
        
        if (!clusterName || !serviceName) {
          throw new Error(`Cluster or service not found for ${service.name}. Discovered: ${JSON.stringify(cfnDiscoveredResources)}`);
        }
        
        // Get current task definition revision
        previousVersion = await this.getCurrentTaskDefinition(clusterName, serviceName, region);
        
        // Force a new deployment with the current task definition
        // This will cause ECS to pull the image again, getting any updates if the tag is mutable (like 'latest')
        // For immutable tags (like git hashes), this will just restart the tasks
        const updateResult = execSync(
          `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --force-new-deployment --region ${region} --output json`,
          { encoding: 'utf-8' }
        );
        
        if (service.verbose) {
          // Get current task definition to show what image is being used
          try {
            // First get the service to find its current task definition
            const serviceData = execSync(
              `aws ecs describe-services --cluster ${clusterName} --services ${serviceName} --region ${region} --output json`,
              { encoding: 'utf-8' }
            );
            
            const ecsService = JSON.parse(serviceData).services?.[0];
            if (ecsService?.taskDefinition) {
              const currentTaskDef = execSync(
                `aws ecs describe-task-definition --task-definition ${ecsService.taskDefinition} --region ${region} --output json`,
                { encoding: 'utf-8' }
              );
              
              const taskDef = JSON.parse(currentTaskDef).taskDefinition;
              const images = taskDef.containerDefinitions?.map((c: any) => c.image).filter(Boolean);
              if (images?.length > 0) {
                console.log(`[DEBUG] Forcing new deployment with image(s): ${images.join(', ')}`);
              }
            }
          } catch (error) {
            // Ignore errors in verbose logging
            if (service.verbose) {
              console.log(`[DEBUG] Could not get current task definition: ${error}`);
            }
          }
        }
        
        // Parse the update result to get deployment ID
        const updateData = JSON.parse(updateResult);
        const deployments = updateData.service?.deployments || [];
        const newDeployment = deployments.find((d: any) => d.status === 'PRIMARY');
        const deploymentId = newDeployment?.id;
        
        // Wait for deployment if requested
        if (service.config?.wait && deploymentId) {
          const timeout = service.config.timeout || 300;
          if (!service.quiet) {
            printInfo(`Waiting for deployment to complete (timeout: ${timeout}s)...`);
          }
          
          await this.waitForECSDeployment(clusterName, serviceName, deploymentId, region, timeout, service.verbose);
        }
        
        // Get new task definition revision
        newVersion = await this.getCurrentTaskDefinition(clusterName, serviceName, region);
        strategy = 'rolling';
        break;
      
      case 'rds':
        // Apply pending modifications
        const instanceId = `${resourceName}-db`;
        
        // Create snapshot before update
        const snapshotId = `${instanceId}-update-${Date.now()}`;
        execSync(
          `aws rds create-db-snapshot --db-instance-identifier ${instanceId} --db-snapshot-identifier ${snapshotId} --region ${region}`
        );
        
        previousVersion = snapshotId;
        
        // Apply any pending modifications
        execSync(
          `aws rds modify-db-instance --db-instance-identifier ${instanceId} --apply-immediately --region ${region}`
        );
        
        strategy = 'rolling';
        break;
        
      default:
        // No update needed for other service types
        break;
    }
    
    return {
      entity: service.name,
      platform: 'aws',
      success: true,
      updateTime: new Date(),
      previousVersion,
      newVersion,
      strategy,
      metadata: {
        serviceType,
        region: region,
        resourceName
      }
    };
  }
  
  // Helper methods
  
  public override getResourceName(service: Service): string {
    return `semiont-${service.name}-${service.environment}`;
  }

  
  /**
   * Check ALB target health using target group ARN directly (avoids name length issues)
   */
  
  private async getCurrentTaskDefinition(cluster: string, service: string, region: string): Promise<string> {
    try {
      const taskDef = execSync(
        `aws ecs describe-services --cluster ${cluster} --services ${service} --query 'services[0].taskDefinition' --output text --region ${region}`,
        { encoding: 'utf-8' }
      ).trim();
      return taskDef.split(':').pop() || '';
    } catch {
      return '';
    }
  }
  
  /**
   * Wait for ECS deployment to complete with enhanced monitoring
   */
  private async waitForECSDeployment(
    clusterName: string,
    serviceName: string,
    deploymentId: string,
    region: string,
    timeout: number,
    verbose: boolean = false
  ): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 5000; // 5 seconds
    let imagePullDetected = false;
    let lastEventCount = 0;
    
    // Extend timeout if we detect image pulling
    let effectiveTimeout = timeout;
    
    while ((Date.now() - startTime) < (effectiveTimeout * 1000)) {
      try {
        // Get service details with events
        const serviceData = execSync(
          `aws ecs describe-services --cluster ${clusterName} --services ${serviceName} --region ${region} --output json`,
          { encoding: 'utf-8' }
        );
        
        const service = JSON.parse(serviceData).services?.[0];
        if (!service) {
          throw new Error(`Service ${serviceName} not found`);
        }
        
        const deployments = service.deployments || [];
        const events = service.events || [];
        const ourDeployment = deployments.find((d: any) => d.id === deploymentId);
        
        if (!ourDeployment) {
          // Deployment no longer exists - likely rolled back
          throw new Error(`Deployment ${deploymentId} no longer exists - likely failed or was rolled back`);
        }
        
        // Check for image pull events
        if (events.length > lastEventCount) {
          const newEvents = events.slice(0, events.length - lastEventCount);
          const pullEvents = newEvents.filter((e: any) => 
            e.message?.includes('pulling image') || 
            e.message?.includes('pull complete')
          );
          
          if (pullEvents.length > 0 && !imagePullDetected) {
            imagePullDetected = true;
            effectiveTimeout = timeout + 300; // Add 5 minutes for image pull
            if (!verbose) {
              process.stdout.write('\n');
            }
            printInfo('Image pull detected, extending timeout by 5 minutes...');
          }
          
          lastEventCount = events.length;
        }
        
        // Get detailed task counts by deployment version
        let taskDetails = { new: { total: 0, running: 0, healthy: 0, pending: 0 }, old: { total: 0, running: 0, healthy: 0, pending: 0 } };
        let taskHealthStatus = 'UNKNOWN'; // Track overall health status
        try {
          const tasksData = execSync(
            `aws ecs list-tasks --cluster ${clusterName} --service-name ${serviceName} --desired-status RUNNING --region ${region} --output json`,
            { encoding: 'utf-8' }
          );
          const taskArns = JSON.parse(tasksData).taskArns || [];
          
          if (taskArns.length > 0) {
            const taskDetailsJson = execSync(
              `aws ecs describe-tasks --cluster ${clusterName} --tasks ${taskArns.join(' ')} --region ${region} --output json`,
              { encoding: 'utf-8' }
            );
            const allTasks = JSON.parse(taskDetailsJson).tasks || [];
            
            // Group tasks by deployment (new vs old)
            for (const task of allTasks) {
              const isNewDeployment = task.taskDefinitionArn === ourDeployment.taskDefinition;
              const details = isNewDeployment ? taskDetails.new : taskDetails.old;
              
              details.total++;
              
              if (task.lastStatus === 'PENDING' || task.lastStatus === 'PROVISIONING') {
                details.pending++;
                if (isNewDeployment) {
                  taskHealthStatus = 'STARTING';
                }
              } else if (task.lastStatus === 'RUNNING') {
                details.running++;
                if (task.healthStatus === 'HEALTHY') {
                  details.healthy++;
                  if (isNewDeployment && taskHealthStatus !== 'STARTING') {
                    taskHealthStatus = 'HEALTHY';
                  }
                } else if (isNewDeployment && task.healthStatus === 'UNKNOWN') {
                  taskHealthStatus = 'STARTING';
                }
              }
            }
          }
        } catch {
          // Ignore task detail errors - just show deployment counts
        }
        
        // Check deployment status
        if (ourDeployment.status === 'PRIMARY') {
          const running = ourDeployment.runningCount || 0;
          const desired = ourDeployment.desiredCount || 0;
          
          // Deployment is only REALLY complete when:
          // 1. Our deployment has all tasks running
          // 2. There are NO other active deployments (old tasks drained)
          // 3. Tasks are healthy (if health checks configured)
          if (running === desired && desired > 0) {
            // Check if there are any other non-INACTIVE deployments
            const otherActiveDeployments = deployments.filter((d: any) => 
              d.id !== deploymentId && d.status !== 'INACTIVE'
            );
            
            if (otherActiveDeployments.length === 0 && taskHealthStatus !== 'STARTING') {
              // Only our deployment is active and tasks are ready
              if (!verbose) {
                process.stdout.write('\n');
              }
              printSuccess(`Deployment ${deploymentId} fully completed - all traffic switched (${running}/${desired} tasks running and healthy)`);
              return;
            } else {
              // Still draining old tasks or waiting for health
              if (verbose) {
                if (otherActiveDeployments.length > 0) {
                  console.log(`Waiting for ${otherActiveDeployments.length} old deployment(s) to drain...`);
                }
                if (taskHealthStatus === 'STARTING') {
                  console.log('Waiting for tasks to pass health checks...');
                }
              }
            }
          }
          
          // Show progress with phase information
          if (!verbose) {
            const progress = desired > 0 ? Math.round((running / desired) * 100) : 0;
            
            
            const barLength = 20;
            const filledLength = Math.round((progress / 100) * barLength);
            const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
            
            // Build detailed status text
            const newStatus = `new: ${taskDetails.new.healthy}h/${taskDetails.new.running}r/${taskDetails.new.total}t`;
            const oldStatus = taskDetails.old.total > 0 ? ` | old: ${taskDetails.old.healthy}h/${taskDetails.old.running}r/${taskDetails.old.total}t` : '';
            
            process.stdout.write(`\r  Deployment: [${bar}] ${progress}% (${running}/${desired}) [${newStatus}${oldStatus}]  `);
          } else {
            // Verbose mode - show raw counts
            const newStatus = `new: ${taskDetails.new.healthy}h/${taskDetails.new.running}r/${taskDetails.new.total}t`;
            const oldStatus = `old: ${taskDetails.old.healthy}h/${taskDetails.old.running}r/${taskDetails.old.total}t`;
            console.log(`Deployment progress: ${running}/${desired} tasks [${ourDeployment.status}] [${newStatus} | ${oldStatus}]`);
          }
        } else if (ourDeployment.status === 'INACTIVE') {
          // Deployment was replaced or rolled back
          throw new Error(`Deployment ${deploymentId} failed - status is INACTIVE`);
        }
        
        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      } catch (error) {
        if (error instanceof Error && error.message.includes('Deployment')) {
          if (!verbose) {
            process.stdout.write('\n');
          }
          throw error; // Re-throw deployment-specific errors
        }
        // Ignore other errors and keep trying
        if (verbose) {
          console.log(`Error checking deployment: ${error}`);
        }
      }
    }
    
    // Clear progress line
    if (!verbose) {
      process.stdout.write('\n');
    }
    
    throw new Error(`Deployment ${deploymentId} timed out after ${effectiveTimeout} seconds`);
  }
}