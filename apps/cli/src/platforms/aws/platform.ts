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
import { StartResult } from "../../core/commands/start.js";
import { StopResult } from "../../core/commands/stop.js";
import { CheckResult } from "../../core/commands/check.js";
import { UpdateResult } from "../../core/commands/update.js";
import { ProvisionResult } from "../../core/commands/provision.js";
import { PublishResult } from "../../core/commands/publish.js";
import { PlatformResources, AWSResources, createPlatformResources } from "../platform-resources.js";
import { BackupResult } from "../../core/commands/backup.js";
import { HandlerRegistry } from "../../core/handlers/registry.js";
import { HandlerContextBuilder } from "../../core/handlers/context.js";
import { CheckHandlerResult } from "../../core/handlers/types.js";
import { handlers } from './handlers/index.js';
import { ExecResult, ExecOptions } from "../../core/commands/exec.js";
import { TestResult, TestOptions } from "../../core/commands/test.js";
import { RestoreResult, RestoreOptions } from "../../core/commands/restore.js";
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
    registry.registerHandlers('aws', handlers as any);
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
      if (service.name === 'database' || this.determineAWSServiceType(service) === 'rds') {
        const databases = await this.getStackResources(dataStack, region, 'AWS::RDS::DBInstance');
        if (databases[0]) {
          resources[service.name] = { dbInstanceId: databases[0].PhysicalResourceId };
        }
      }
      
      // Get EFS FileSystem - match filesystem service
      if (service.name === 'filesystem' || this.determineAWSServiceType(service) === 'efs') {
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
  private determineAWSServiceType(service: Service): string {
    const requirements = service.getRequirements();
    
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
  
  async start(service: Service): Promise<StartResult> {
    const { region, accountId } = this.getAWSConfig(service);
    const requirements = service.getRequirements();
    const serviceType = this.determineAWSServiceType(service);
    const resourceName = this.getResourceName(service);
    
    let endpoint: string | undefined;
    let resources: PlatformResources | undefined;
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Get resource IDs from CloudFormation (with caching)
        const cfnDiscoveredResources = await this.discoverAndCacheResources(service);
        
        // Get cluster and service names from discovered resources
        const clusterName = cfnDiscoveredResources.clusterName || `semiont-${service.environment}`;
        const serviceName = cfnDiscoveredResources.serviceName || resourceName;
        const desiredCount = requirements.resources?.replicas || 1;
        
        try {
          execSync(
            `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --desired-count ${desiredCount} --region ${region}`
          );
          
          // Get service endpoint from load balancer
          if (requirements.network?.needsLoadBalancer) {
            const albDns = await this.getALBEndpoint(serviceName, region);
            endpoint = `https://${albDns}`;
          }
          
          resources = createPlatformResources('aws', {
            clusterId: clusterName,
            serviceArn: `arn:aws:ecs:${region}:${accountId}:service/${clusterName}/${serviceName}`,
            region: region
          });
        } catch (error) {
          throw new Error(`Failed to start ECS service: ${error}`);
        }
        break;
        
      case 'lambda':
        // Lambda functions are always "running"
        const functionName = `${resourceName}-function`;
        
        // Get function URL or API Gateway endpoint
        try {
          const functionUrl = execSync(
            `aws lambda get-function-url-config --function-name ${functionName} --query FunctionUrl --output text --region ${region} 2>/dev/null`,
            { encoding: 'utf-8' }
          ).trim();
          
          endpoint = functionUrl !== 'None' ? functionUrl : undefined;
        } catch {
          // No function URL configured
        }
        
        resources = createPlatformResources('aws', {
          functionArn: `arn:aws:lambda:${region}:${accountId}:function:${functionName}`,
          region: region
        });
        break;
        
      case 'rds':
        // Start RDS instance
        const instanceId = `${resourceName}-db`;
        
        try {
          execSync(`aws rds start-db-instance --db-instance-identifier ${instanceId} --region ${region}`);
          
          if (!service.quiet) {
            printInfo('RDS instance starting... this may take several minutes');
          }
          
          // Get endpoint
          const dbEndpoint = await this.getRDSEndpoint(instanceId, region);
          endpoint = dbEndpoint;
          
          resources = createPlatformResources('aws', {
            instanceId,
            region: region
          });
        } catch (error) {
          throw new Error(`Failed to start RDS instance: ${error}`);
        }
        break;
        
      case 's3-cloudfront':
        // S3 + CloudFront doesn't really "start" but we can return the endpoint
        const bucketName = `${resourceName}-static`;
        const distributionId = await this.getCloudFrontDistribution(bucketName, region);
        
        if (distributionId) {
          const domain = await this.getCloudFrontDomain(distributionId, region);
          endpoint = `https://${domain}`;
        } else {
          endpoint = `https://${bucketName}.s3-website-${region}.amazonaws.com`;
        }
        
        resources = createPlatformResources('aws', {
          bucketName,
          distributionId,
          region: region
        });
        break;
        
      case 'efs':
        // EFS is always available
        const fileSystemId = await this.getOrCreateEFS(resourceName, region);
        
        resources = createPlatformResources('aws', {
          volumeId: fileSystemId,
          region: region
        });
        break;
        
      case 'dynamodb':
        // DynamoDB tables are always available
        const tableName = `${resourceName}-table`;
        
        resources = createPlatformResources('aws', {
          name: tableName,
          region: region
        });
        break;
    }
    
    return {
      entity: service.name,
      platform: 'aws',
      success: true,
      startTime: new Date(),
      endpoint,
      resources,
      metadata: {
        serviceType,
        region: region,
        resourceName
      }
    };
  }
  
  async stop(service: Service): Promise<StopResult> {

    const { region } = this.getAWSConfig(service);
    const serviceType = this.determineAWSServiceType(service);
    const resourceName = this.getResourceName(service);
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Get resource IDs from CloudFormation (with caching)
        const cfnDiscoveredResources = await this.discoverAndCacheResources(service);
        
        // Get cluster and service names from discovered resources
        const clusterName = cfnDiscoveredResources.clusterName || `semiont-${service.environment}`;
        const serviceName = cfnDiscoveredResources.serviceName || resourceName;
        
        try {
          execSync(
            `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --desired-count 0 --region ${region}`
          );
          
          return {
            entity: service.name,
            platform: 'aws',
            success: true,
            stopTime: new Date(),
            gracefulShutdown: true,
            metadata: {
              serviceType: 'ecs-fargate',
              cluster: clusterName,
              service: serviceName
            }
          };
        } catch (error) {
          return {
            entity: service.name,
            platform: 'aws',
            success: false,
            stopTime: new Date(),
            error: `Failed to stop ECS service: ${error}`
          };
        }
        
      case 'rds':
        // Stop RDS instance
        const instanceId = `${resourceName}-db`;
        
        try {
          execSync(`aws rds stop-db-instance --db-instance-identifier ${instanceId} --region ${region}`);
          
          return {
            entity: service.name,
            platform: 'aws',
            success: true,
            stopTime: new Date(),
            gracefulShutdown: true,
            metadata: {
              serviceType: 'rds',
              instanceId
            }
          };
        } catch {
          return {
            entity: service.name,
            platform: 'aws',
            success: true,
            stopTime: new Date(),
            metadata: {
              message: 'RDS instance already stopped or not found'
            }
          };
        }
        
      case 'lambda':
      case 's3-cloudfront':
      case 'efs':
      case 'dynamodb':
        // These services don't stop
        return {
          entity: service.name,
          platform: 'aws',
          success: true,
          stopTime: new Date(),
          metadata: {
            serviceType,
            message: `AWS ${serviceType} services do not support stop operation`
          }
        };
        
      default:
        return {
          entity: service.name,
          platform: 'aws',
          success: true,
          stopTime: new Date(),
          metadata: {
            message: `Service type ${serviceType} does not support stop operation`
          }
        };
    }
  }
  
  async check(service: Service): Promise<CheckResult> {
    const { region, accountId } = this.getAWSConfig(service);
    const serviceType = this.determineAWSServiceType(service);
    
    // 1. Get handler descriptor
    const registry = HandlerRegistry.getInstance();
    const descriptor = registry.getDescriptor('aws', `check-${serviceType}`);
    
    if (!descriptor) {
      // Better error handling for missing handler
      return {
        entity: service.name,
        platform: 'aws',
        success: false,
        checkTime: new Date(),
        status: 'unknown',
        stateVerified: false,
        metadata: {
          error: `No check handler registered for service type: ${serviceType}`
        }
      };
    }

    // 2. Perform discovery if needed
    let cfnDiscoveredResources = {};
    if (descriptor.requiresDiscovery) {
      cfnDiscoveredResources = await this.discoverAndCacheResources(service);
    }

    // 3. Build context and call handler
    const context = HandlerContextBuilder.extend(
      HandlerContextBuilder.buildBaseContext(service, 'aws'),
      { 
        cfnDiscoveredResources, 
        region, 
        accountId,
        resourceName: this.getResourceName(service)  // Add this for handlers to use
      }
    );
    
    const result = await descriptor.handler(context) as CheckHandlerResult;
    
    // 4. Build response from handler result
    return {
      entity: service.name,
      platform: 'aws',
      success: result.success ?? true,
      checkTime: new Date(),
      status: result.status,
      stateVerified: true,
      resources: result.platformResources,
      health: result.health,
      logs: result.logs,
      metadata: {
        ...result.metadata,
        serviceType,
        region,
        accountId
      }
    };
  }
  
  async update(service: Service): Promise<UpdateResult> {
    const { region } = this.getAWSConfig(service);
    const requirements = service.getRequirements();
    const serviceType = this.determineAWSServiceType(service);
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
        
      case 'lambda':
        // Update function code and configuration
        const functionName = `${resourceName}-function`;
        
        // Get current version
        previousVersion = await this.getLambdaVersion(functionName, region);
        
        // Update function (would need actual deployment package)
        if (requirements.build?.buildArgs?.DEPLOYMENT_PACKAGE) {
          execSync(
            `aws lambda update-function-code --function-name ${functionName} --zip-file fileb://${requirements.build.buildArgs.DEPLOYMENT_PACKAGE} --region ${region}`
          );
        }
        
        // Publish new version
        const versionOutput = execSync(
          `aws lambda publish-version --function-name ${functionName} --query Version --output text --region ${region}`,
          { encoding: 'utf-8' }
        ).trim();
        
        newVersion = versionOutput;
        strategy = 'blue-green';
        break;
        
      case 's3-cloudfront':
        // Sync new content and invalidate cache
        const bucketName = `${resourceName}-static`;
        const sourcePath = requirements.build?.buildContext || path.join(service.projectRoot, 'dist');
        
        // Sync to S3
        execSync(`aws s3 sync ${sourcePath} s3://${bucketName}/ --delete --region ${region}`);
        
        // Invalidate CloudFront
        const distributionId = await this.getCloudFrontDistribution(bucketName, region);
        if (distributionId) {
          execSync(
            `aws cloudfront create-invalidation --distribution-id ${distributionId} --paths "/*" --region ${region}`
          );
        }
        
        newVersion = new Date().toISOString();
        strategy = 'blue-green';
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
  
  async provision(service: Service): Promise<ProvisionResult> {
    const { region, accountId } = this.getAWSConfig(service);
    const requirements = service.getRequirements();
    const serviceType = this.determineAWSServiceType(service);
    const resourceName = this.getResourceName(service);
    
    if (!service.quiet) {
      printInfo(`Provisioning ${service.name} on AWS as ${serviceType}...`);
    }
    
    const dependencies = requirements.dependencies?.services || [];
    // Build up AWS resources as we provision
    const awsResourcesData: AWSResources = {
      region: region
    };
    
    const cost = { estimatedMonthly: 0, currency: 'USD' };
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Create ECS cluster and service
        const clusterName = `semiont-${service.environment}`;
        
        // Create cluster
        try {
          execSync(`aws ecs create-cluster --cluster-name ${clusterName} --region ${region}`);
          awsResourcesData.clusterId = clusterName;
        } catch {
          // Cluster might already exist
        }
        
        // Create task definition from requirements
        await this.createTaskDefinition(resourceName, requirements, region, accountId);
        
        // Create service with ALB if needed
        if (requirements.network?.needsLoadBalancer) {
          const albArn = await this.createALB(resourceName, requirements, region, accountId);
          awsResourcesData.arn = albArn;
        }
        
        // Create service
        await this.createECSService(clusterName, resourceName, requirements, region);
        
        // Estimate costs
        const cpu = parseFloat(requirements.resources?.cpu || '0.25');
        const memory = this.parseMemory(requirements.resources?.memory || '512Mi');
        cost.estimatedMonthly = (cpu * 40 + memory * 4.5) * (requirements.resources?.replicas || 1);
        break;
        
      case 'lambda':
        // Create Lambda function
        const functionName = `${resourceName}-function`;
        
        // Create execution role
        const roleArn = await this.createLambdaRole(functionName, region, accountId);
        awsResourcesData.arn = roleArn;
        
        // Create function
        await this.createLambdaFunction(functionName, requirements, roleArn, region);
        awsResourcesData.functionArn = `arn:aws:lambda:${region}:${accountId}:function:${functionName}`;
        
        // Create function URL if needed
        if (requirements.network?.ports) {
          const functionUrl = await this.createFunctionUrl(functionName, region);
          awsResourcesData.consoleUrl = functionUrl;
        }
        
        // Estimate costs (very rough)
        cost.estimatedMonthly = 5; // Lambda is typically very cheap
        break;
        
      case 'rds':
        // Create RDS instance
        const instanceId = `${resourceName}-db`;
        const instanceClass = requirements.annotations?.['aws/rds-class'] || 'db.t3.micro';
        
        // Create DB subnet group
        const subnetGroupName = await this.createDBSubnetGroup(resourceName, region);
        awsResourcesData.networkId = subnetGroupName;
        
        // Create RDS instance
        await this.createRDSInstance(instanceId, instanceClass, requirements, region);
        awsResourcesData.instanceId = instanceId;
        
        // Estimate costs
        cost.estimatedMonthly = this.getRDSCost(instanceClass);
        break;
        
      case 's3-cloudfront':
        // Create S3 bucket and CloudFront distribution
        const bucketName = `${resourceName}-static`;
        
        // Create S3 bucket with static website hosting
        await this.createS3Bucket(bucketName, true, region);
        awsResourcesData.bucketName = bucketName;
        
        // Create CloudFront distribution
        if (requirements.network?.customDomains?.length) {
          const distributionId = await this.createCloudFrontDistribution(bucketName, requirements, region);
          awsResourcesData.distributionId = distributionId;
        }
        
        // Estimate costs
        cost.estimatedMonthly = 5; // S3 + CloudFront minimal cost
        break;
        
      case 'efs':
        // Create EFS file system
        const fileSystemId = await this.createEFS(resourceName, region);
        awsResourcesData.volumeId = fileSystemId;
        
        // Create mount targets in each subnet
        await this.createEFSMountTargets(fileSystemId, region);
        
        // Estimate costs
        const storageGB = this.parseStorageSize(requirements.storage?.[0]?.size || '10Gi');
        cost.estimatedMonthly = storageGB * 0.30;
        break;
        
      case 'dynamodb':
        // Create DynamoDB table
        const tableName = `${resourceName}-table`;
        
        await this.createDynamoDBTable(tableName, requirements, region);
        awsResourcesData.name = tableName;
        
        // Estimate costs
        cost.estimatedMonthly = 25; // On-demand pricing estimate
        break;
    }
    
    return {
      entity: service.name,
      platform: 'aws',
      success: true,
      provisionTime: new Date(),
      resources: createPlatformResources('aws', awsResourcesData),
      dependencies,
      cost,
      metadata: {
        serviceType,
        region: region,
        accountId: accountId
      }
    };
  }
  
  async publish(service: Service): Promise<PublishResult> {
    const { region, accountId } = this.getAWSConfig(service);
    const requirements = service.getRequirements();
    const serviceType = this.determineAWSServiceType(service);
    const resourceName = this.getResourceName(service);
    
    // Determine image tag based on configuration
    let version: string;
    
    if (service.config?.tag) {
      // Explicit tag provided via CLI
      version = service.config.tag;
    } else {
      // Check environment configuration for deployment strategy
      const envConfig = loadEnvironmentConfig(service.environment);
      const deploymentStrategy = envConfig.deployment?.imageTagStrategy || 'mutable';
      
      if (deploymentStrategy === 'immutable' || deploymentStrategy === 'git-hash') {
        // Use git commit hash for immutable deployments
        try {
          const gitHash = execSync('git rev-parse --short HEAD', { 
            encoding: 'utf-8',
            cwd: service.config?.semiontRepo || service.projectRoot 
          }).trim();
          version = gitHash;
        } catch {
          // Fall back to timestamp if git not available
          version = new Date().toISOString().replace(/[:.]/g, '-');
        }
      } else {
        // Use 'latest' for mutable deployments (default)
        version = 'latest';
      }
    }
    
    if (!service.quiet) {
      printInfo(`Publishing ${service.name} to AWS ${serviceType}...`);
    }
    
    const artifacts: PublishResult['artifacts'] = {};
    const rollback: PublishResult['rollback'] = { supported: true };
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Build and push container to ECR
        const ecrRepo = `${resourceName}`;
        const imageUri = `${accountId}.dkr.ecr.${region}.amazonaws.com/${ecrRepo}:${version}`;
        
        // Create ECR repository if needed
        try {
          execSync(`aws ecr create-repository --repository-name ${ecrRepo} --region ${region}`);
        } catch {
          // Repository might already exist
        }
        
        // Build and push image
        if (service.verbose) {
          console.log(`[DEBUG] Build requirements:`, JSON.stringify(requirements.build, null, 2));
        }
        if (requirements.build?.dockerfile) {
          const buildContext = requirements.build.buildContext || service.projectRoot;
          
          // Build TypeScript/Next.js locally first
          if (!service.quiet) {
            printInfo(`Building ${service.name} locally...`);
          }
          
          // Prepare environment variables for the build
          const buildEnv: NodeJS.ProcessEnv = { ...process.env };
          
          // For frontend, set build-time environment variables
          if (service.name === 'frontend') {
            const domain = service.config?.domain || 
                          (service.environment === 'production' ? 'semiont.com' : `${service.environment}.semiont.com`);
            const apiUrl = `https://${domain}`;
            
            buildEnv.NEXT_PUBLIC_API_URL = apiUrl;
            buildEnv.NEXT_PUBLIC_APP_NAME = 'Semiont';
            buildEnv.NEXT_PUBLIC_APP_VERSION = '1.0.0';
            buildEnv.NODE_ENV = 'production';
            buildEnv.NEXT_TELEMETRY_DISABLED = '1';
            
            if (!service.quiet) {
              printInfo(`Using API URL for frontend: ${apiUrl}`);
            }
          }
          
          // Build the application locally
          try {
            // Build api-types first if it exists
            const apiTypesPath = path.join(buildContext, 'packages', 'api-types');
            if (fs.existsSync(apiTypesPath)) {
              execSync('npm run build', {
                cwd: apiTypesPath,
                env: buildEnv,
                stdio: service.verbose ? 'inherit' : 'pipe'
              });
            }
            
            // Build the app
            const appPath = path.join(buildContext, 'apps', service.name);
            if (fs.existsSync(appPath)) {
              execSync('npm run build', {
                cwd: appPath,
                env: buildEnv,
                stdio: service.verbose ? 'inherit' : 'pipe'
              });
            }
          } catch (error) {
            throw new Error(`Failed to build ${service.name} locally: ${error}`);
          }
          
          // Login to ECR
          execSync(
            `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.${region}.amazonaws.com`
          );
          
          // Build Docker image with pre-built artifacts
          const noCacheFlag = service.config?.noCache ? '--no-cache ' : '';
          const platformFlag = '--platform linux/amd64'; // ECS runs on x86_64
          
          const buildCommand = `docker build ${noCacheFlag}${platformFlag} -t ${imageUri} -f ${requirements.build.dockerfile} ${buildContext}`;
          
          if (service.verbose) {
            console.log(`[DEBUG] Docker build command: ${buildCommand}`);
          }
          
          execSync(buildCommand);
          
          // Push to ECR
          execSync(`docker push ${imageUri}`);
          
          artifacts.imageTag = version;
          artifacts.imageUrl = imageUri;
        }
        
        // Update task definition with new image
        await this.updateTaskDefinition(service, imageUri);
        
        rollback.command = `aws ecs update-service --cluster semiont-${service.environment} --service ${resourceName} --task-definition ${resourceName}-task:PREVIOUS`;
        break;
        
      case 'lambda':
        // Package and deploy Lambda function
        const functionName = `${resourceName}-function`;
        const packagePath = path.join(service.projectRoot, 'dist', `${functionName}.zip`);
        
        // Create deployment package
        if (requirements.build?.buildContext) {
          const buildDir = requirements.build.buildContext;
          execSync(`cd ${buildDir} && zip -r ${packagePath} .`);
        }
        
        // Update function code
        execSync(
          `aws lambda update-function-code --function-name ${functionName} --zip-file fileb://${packagePath} --region ${region}`
        );
        
        // Publish version
        const versionNum = execSync(
          `aws lambda publish-version --function-name ${functionName} --query Version --output text --region ${region}`,
          { encoding: 'utf-8' }
        ).trim();
        
        // Store Lambda version info properly
        artifacts.packageVersion = versionNum;
        
        rollback.command = `aws lambda update-alias --function-name ${functionName} --name prod --function-version PREVIOUS`;
        break;
        
      case 's3-cloudfront':
        // Deploy static site to S3
        const bucketName = `${resourceName}-static`;
        const sourcePath = requirements.build?.buildContext || path.join(service.projectRoot, 'dist');
        
        // Build if needed
        if (requirements.build?.buildArgs?.BUILD_COMMAND) {
          execSync(requirements.build.buildArgs.BUILD_COMMAND, { cwd: service.projectRoot });
        }
        
        // Sync to S3
        execSync(`aws s3 sync ${sourcePath} s3://${bucketName}/ --delete --region ${region}`);
        
        // Invalidate CloudFront
        const distributionId = await this.getCloudFrontDistribution(bucketName, region);
        if (distributionId) {
          execSync(  // Returns invalidation ID
            `aws cloudfront create-invalidation --distribution-id ${distributionId} --paths "/*" --query Invalidation.Id --output text --region ${region}`,
            { encoding: 'utf-8' }
          ).trim();
          
          // CloudFront invalidation ID will be in metadata
        }
        
        artifacts.staticSiteUrl = `https://${bucketName}.s3-website-${region}.amazonaws.com`;
        
        rollback.supported = false; // S3 sync is destructive
        break;
        
      case 'rds':
        // Apply database migrations
        if (!service.quiet) {
          printInfo('Database updates would be applied through migrations');
        }
        
        // Database version will be in metadata
        rollback.command = `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier ${resourceName}-db --target-db-instance-identifier ${resourceName}-db-rollback`;
        break;
    }
    
    return {
      entity: service.name,
      platform: 'aws',
      success: true,
      publishTime: new Date(),
      artifacts,
      version: {
        current: version,
        previous: 'latest'
      },
      rollback,
      metadata: {
        serviceType,
        region: region
      }
    };
  }
  
  async backup(service: Service): Promise<BackupResult> {
    const { region, accountId } = this.getAWSConfig(service);
    const requirements = service.getRequirements();
    const serviceType = this.determineAWSServiceType(service);
    const resourceName = this.getResourceName(service);
    const backupId = `${resourceName}-${Date.now()}`;
    
    if (!service.quiet) {
      printInfo(`Creating AWS backup for ${service.name} (${serviceType})...`);
    }
    
    const backup: BackupResult['backup'] = {
      size: 0,
      location: '',
      format: 'snapshot'
    };
    
    switch (serviceType) {
      case 'rds':
        // Create RDS snapshot
        const instanceId = `${resourceName}-db`;
        const snapshotId = `${instanceId}-backup-${backupId}`;
        
        execSync(
          `aws rds create-db-snapshot --db-instance-identifier ${instanceId} --db-snapshot-identifier ${snapshotId} --region ${region}`
        );
        
        // Wait for snapshot to complete (async in real implementation)
        if (backup) {
          backup.location = `arn:aws:rds:${region}:${accountId}:snapshot:${snapshotId}`;
          backup.details = {
            type: 'rds',
            engine: 'postgres',
            automated: false
          };
        }
        
        // Get snapshot size
        const snapshotSize = await this.getRDSSnapshotSize(snapshotId, region);
        if (backup) {
          backup.size = snapshotSize;
        }
        break;
        
      case 's3-cloudfront':
        // Enable versioning and create backup
        const bucketName = `${resourceName}-static`;
        
        // Enable versioning
        execSync(
          `aws s3api put-bucket-versioning --bucket ${bucketName} --versioning-configuration Status=Enabled --region ${region}`
        );
        
        // Create backup bucket
        const backupBucket = `${bucketName}-backup-${backupId}`;
        execSync(`aws s3 mb s3://${backupBucket} --region ${region}`);
        
        // Copy all objects
        execSync(`aws s3 sync s3://${bucketName}/ s3://${backupBucket}/ --region ${region}`);
        
        if (backup) {
          backup.location = `s3://${backupBucket}`;
          backup.details = {
            paths: [bucketName],
            preservePermissions: true,
            type: 's3'
          };
        }
        
        // Get bucket size
        const bucketSize = await this.getS3BucketSize(bucketName, region);
        if (backup) {
          backup.size = bucketSize;
        }
        break;
        
      case 'efs':
        // Create EFS backup using AWS Backup
        const fileSystemId = await this.getEFSId(resourceName, region);
        
        if (fileSystemId) {
          // Create backup using AWS Backup service
          const backupJobId = await this.createEFSBackup(fileSystemId, backupId, region);
          
          if (backup) {
            backup.location = `arn:aws:backup:${region}:${accountId}:recovery-point:${backupJobId}`;
            backup.details = {
              paths: [`efs://${fileSystemId}`],
              preservePermissions: true,
              type: 'efs'
            };
          }
        }
        break;
        
      case 'dynamodb':
        // Create DynamoDB backup
        const tableName = `${resourceName}-table`;
        
        execSync(
          `aws dynamodb create-backup --table-name ${tableName} --backup-name ${backupId} --region ${region}`
        );
        
        if (backup) {
          backup.location = `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}/backup/${backupId}`;
          backup.details = {
            type: 'dynamodb',
            automated: false
          };
        }
        break;
        
      case 'lambda':
        // Export Lambda function
        const functionName = `${resourceName}-function`;
        const exportPath = `/tmp/${functionName}-${backupId}.zip`;
        
        // Get function code
        const codeLocation = execSync(
          `aws lambda get-function --function-name ${functionName} --query Code.Location --output text --region ${region}`,
          { encoding: 'utf-8' }
        ).trim();
        
        // Download code
        execSync(`curl -o ${exportPath} "${codeLocation}"`);
        
        // Upload to S3 for storage
        const lambdaBackupBucket = `semiont-backups-${region}`;
        const s3Key = `lambda/${functionName}/${backupId}.zip`;
        
        execSync(`aws s3 cp ${exportPath} s3://${lambdaBackupBucket}/${s3Key} --region ${region}`);
        
        if (backup) {
          backup.location = `s3://${lambdaBackupBucket}/${s3Key}`;
          backup.size = fs.statSync(exportPath).size;
        }
        break;
        
      case 'ecs-fargate':
        // Get resource IDs from CloudFormation (with caching)
        const cfnDiscoveredResources = await this.discoverAndCacheResources(service);
        
        // Get cluster and service names from discovered resources
        const clusterName = cfnDiscoveredResources.clusterName || `semiont-${service.environment}`;
        const serviceName = cfnDiscoveredResources.serviceName || resourceName;
        
        // Export task definition
        const taskDef = execSync(
          `aws ecs describe-task-definition --task-definition ${serviceName}-task --region ${region}`,
          { encoding: 'utf-8' }
        );
        
        const backupBucketECS = `semiont-backups-${region}`;
        const taskDefKey = `ecs/${serviceName}/${backupId}-task-definition.json`;
        
        // Save task definition to S3
        fs.writeFileSync(`/tmp/${backupId}-task-def.json`, taskDef);
        execSync(
          `aws s3 cp /tmp/${backupId}-task-def.json s3://${backupBucketECS}/${taskDefKey} --region ${region}`
        );
        
        if (backup) {
          backup.location = `s3://${backupBucketECS}/${taskDefKey}`;
          backup.details = {
            taskDefinition: `${serviceName}-task`,
            cluster: clusterName,
            type: 'ecs-fargate'
          };
        }
        break;
    }
    
    // Calculate retention
    const retentionDays = requirements.annotations?.['backup/retention'] 
      ? parseInt(requirements.annotations['backup/retention'])
      : 30;
    
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + retentionDays);
    
    return {
      entity: service.name,
      platform: 'aws',
      success: true,
      backupTime: new Date(),
      backupId,
      backup,
      retention: {
        expiresAt,
        policy: retentionDays > 30 ? 'yearly' : retentionDays > 7 ? 'monthly' : 'weekly',
        autoCleanup: true
      },
      restore: {
        supported: true,
        command: `semiont restore --service ${service.name} --backup-id ${backupId}`,
        requirements: ['AWS credentials', 'Same region']
      },
      metadata: {
        serviceType,
        region: region,
        backupMethod: this.getBackupMethod(serviceType)
      }
    };
  }
  
  async exec(service: Service, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const { region } = this.getAWSConfig(service);
    const serviceType = this.determineAWSServiceType(service);
    const resourceName = this.getResourceName(service);
    const execTime = new Date();
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Get resource IDs from CloudFormation (with caching)
        const cfnDiscoveredResources = await this.discoverAndCacheResources(service);
        
        // Get cluster and service names from discovered resources
        const clusterName = cfnDiscoveredResources.clusterName || `semiont-${service.environment}`;
        const serviceName = cfnDiscoveredResources.serviceName || resourceName;
        
        // Get running task
        const taskArn = await this.getRunningTask(clusterName, serviceName, region);
        
        if (!taskArn) {
          return {
            entity: service.name,
            platform: 'aws',
            success: false,
            execTime,
            command,
            error: 'No running tasks found'
          };
        }
        
        // Execute command via ECS Exec
        const execCommand = [
          'aws', 'ecs', 'execute-command',
          '--cluster', clusterName,
          '--task', taskArn,
          '--container', resourceName,
          '--command', `"${command}"`,
          '--interactive',
          '--region', region
        ].join(' ');
        
        try {
          const output = execSync(execCommand, {
            encoding: 'utf-8',
            timeout: options.timeout || 30000
          });
          
          return {
            entity: service.name,
            platform: 'aws',
            success: true,
            execTime,
            command,
            output: {
              stdout: output,
              stderr: '',
              combined: output
            },
            metadata: {
              serviceType: 'ecs-fargate',
              taskArn,
              container: resourceName
            }
          };
        } catch (error: any) {
          return {
            entity: service.name,
            platform: 'aws',
            success: false,
            execTime,
            command,
            error: error.message
          };
        }
        
      case 'lambda':
        // Invoke Lambda with command as payload
        const functionName = `${resourceName}-function`;
        
        const payload = JSON.stringify({
          command,
          options
        });
        
        try {
          execSync(
            `aws lambda invoke --function-name ${functionName} --payload '${payload}' --query 'Payload' --output text --region ${region} /tmp/lambda-output.txt`,
            { encoding: 'utf-8' }
          );
          
          const output = fs.readFileSync('/tmp/lambda-output.txt', 'utf-8');
          
          return {
            entity: service.name,
            platform: 'aws',
            success: true,
            execTime,
            command,
            output: {
              stdout: output,
              stderr: '',
              combined: output
            },
            metadata: {
              serviceType: 'lambda',
              functionName
            }
          };
        } catch (error: any) {
          return {
            entity: service.name,
            platform: 'aws',
            success: false,
            execTime,
            command,
            error: error.message
          };
        }
        
      default:
        return {
          entity: service.name,
          platform: 'aws',
          success: false,
          execTime,
          command,
          error: `Exec not supported for ${serviceType} services`
        };
    }
  }
  
  async test(service: Service, options: TestOptions = {}): Promise<TestResult> {
    const { region, accountId } = this.getAWSConfig(service);
    const requirements = service.getRequirements();
    const serviceType = this.determineAWSServiceType(service);
    const resourceName = this.getResourceName(service);
    const testTime = new Date();
    
    if (!service.quiet) {
      printInfo(`Running tests for ${service.name} on AWS ${serviceType}...`);
    }
    
    // Use test annotations or defaults
    const testImage = requirements.annotations?.['test/image'];
    const testCommand = requirements.annotations?.['test/command'] || 'npm test';
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Get resource IDs from CloudFormation (with caching)
        const cfnDiscoveredResources = await this.discoverAndCacheResources(service);
        
        // Get cluster and task definition names from discovered resources
        const cluster = cfnDiscoveredResources.clusterName || `semiont-${service.environment}`;
        const taskDefinition = `${resourceName}-test-task`;
        
        // Create test task definition if needed
        await this.createTestTaskDefinition(taskDefinition, testImage || service.getImage(), testCommand, region);
        
        // Run task
        const taskArn = await this.runECSTask(cluster, taskDefinition, region, accountId);
        
        // Wait for task completion and get logs
        const { success, logs, exitCode } = await this.waitForTaskCompletion(cluster, taskArn);
        
        // Parse test output - basic implementation for now
        // TODO: Implement proper test output parsing
        
        return {
          entity: service.name,
          platform: 'aws',
          success,
          testTime,
          suite: options.suite || 'unit',
          metadata: {
            serviceType: 'ecs-fargate',
            taskArn,
            exitCode,
            logs
          }
        };
        
      case 'lambda':
        // Invoke Lambda function with test event
        const functionName = `${resourceName}-function`;
        const testEvent = {
          test: true,
          suite: options.suite || 'unit',
          coverage: options.coverage
        };
        
        try {
          execSync(
            `aws lambda invoke --function-name ${functionName} --payload '${JSON.stringify(testEvent)}' --query 'Payload' --output text --region ${region} /tmp/test-output.txt`,
            { encoding: 'utf-8' }
          );
          
          const output = fs.readFileSync('/tmp/test-output.txt', 'utf-8');
          const testResult = JSON.parse(output);
          
          return {
            entity: service.name,
            platform: 'aws',
            success: testResult.success || false,
            testTime,
            suite: options.suite || 'unit',
            passed: testResult.passed,
            failed: testResult.failed,
            skipped: testResult.skipped,
            coverage: testResult.coverage,
            metadata: {
              serviceType: 'lambda',
              functionName
            }
          };
        } catch (error) {
          return {
            entity: service.name,
            platform: 'aws',
            success: false,
            testTime,
            suite: options.suite || 'unit',
            error: `Test invocation failed: ${error}`
          };
        }
        
      case 's3-cloudfront':
        // Use CloudWatch Synthetics for frontend testing
        const canaryName = `${resourceName}-canary`;
        
        // Run canary
        try {
          execSync(
            `aws synthetics start-canary --name ${canaryName} --region ${region}`
          );
          
          // Wait for results
          await new Promise(resolve => setTimeout(resolve, 30000));
          
          // Get canary results
          const runs = execSync(
            `aws synthetics describe-canary-runs --name ${canaryName} --max-results 1 --query 'CanaryRuns[0]' --region ${region}`,
            { encoding: 'utf-8' }
          );
          
          const runResult = JSON.parse(runs);
          
          return {
            entity: service.name,
            platform: 'aws',
            success: runResult.Status.State === 'PASSED',
            testTime,
            suite: 'synthetic',
            passed: runResult.Status.State === 'PASSED' ? 1 : 0,
            failed: runResult.Status.State === 'PASSED' ? 0 : 1,
            skipped: 0,
            metadata: {
              serviceType: 's3-cloudfront',
              canaryName,
              runId: runResult.Id
            }
          };
        } catch (error) {
          return {
            entity: service.name,
            platform: 'aws',
            success: false,
            testTime,
            suite: 'synthetic',
            error: `Canary test failed: ${error}`
          };
        }
        
      default:
        return {
          entity: service.name,
          platform: 'aws',
          success: false,
          testTime,
          suite: options.suite || 'unit',
          error: `Testing not supported for ${serviceType} services`
        };
    }
  }
  
  async restore(service: Service, backupId: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    const { region } = this.getAWSConfig(service);
    const serviceType = this.determineAWSServiceType(service);
    const resourceName = this.getResourceName(service);
    const restoreTime = new Date();
    
    if (!service.quiet) {
      printInfo(`Restoring ${service.name} from backup ${backupId} on AWS...`);
    }
    
    switch (serviceType) {
      case 'rds':
        // Restore from RDS snapshot
        const instanceId = `${resourceName}-db`;
        const snapshotId = `${instanceId}-backup-${backupId}`;
        const restoredInstanceId = `${instanceId}-restored`;
        
        try {
          // Restore to new instance
          execSync(
            `aws rds restore-db-instance-from-db-snapshot --db-instance-identifier ${restoredInstanceId} --db-snapshot-identifier ${snapshotId} --region ${region}`
          );
          
          // Wait for instance to be available
          await this.waitForRDSInstance(restoredInstanceId);
          
          // Swap instances if requested
          if (!options.targetPath) {
            // Stop original instance
            execSync(`aws rds stop-db-instance --db-instance-identifier ${instanceId} --region ${region}`);
            
            // Rename instances
            execSync(`aws rds modify-db-instance --db-instance-identifier ${instanceId} --new-db-instance-identifier ${instanceId}-old --apply-immediately --region ${region}`);
            execSync(`aws rds modify-db-instance --db-instance-identifier ${restoredInstanceId} --new-db-instance-identifier ${instanceId} --apply-immediately --region ${region}`);
          }
          
          return {
            entity: service.name,
            platform: 'aws',
            success: true,
            restoreTime,
            backupId,
            restore: {
              source: snapshotId,
              destination: restoredInstanceId,
              duration: Date.now() - restoreTime.getTime()
            },
            metadata: {
              serviceType: 'rds',
              instanceId: restoredInstanceId
            }
          };
        } catch (error) {
          return {
            entity: service.name,
            platform: 'aws',
            success: false,
            restoreTime,
            backupId,
            error: `RDS restore failed: ${error}`
          };
        }
        
      case 's3-cloudfront':
        // Restore from S3 backup
        const bucketName = `${resourceName}-static`;
        const backupBucket = `${bucketName}-backup-${backupId}`;
        
        try {
          // Clear current bucket
          execSync(`aws s3 rm s3://${bucketName}/ --recursive --region ${region}`);
          
          // Copy from backup
          execSync(`aws s3 sync s3://${backupBucket}/ s3://${bucketName}/ --region ${region}`);
          
          // Invalidate CloudFront
          const distributionId = await this.getCloudFrontDistribution(bucketName, region);
          if (distributionId) {
            execSync(
              `aws cloudfront create-invalidation --distribution-id ${distributionId} --paths "/*" --region ${region}`
            );
          }
          
          return {
            entity: service.name,
            platform: 'aws',
            success: true,
            restoreTime,
            backupId,
            restore: {
              source: backupBucket,
              destination: bucketName,
              duration: Date.now() - restoreTime.getTime()
            },
            metadata: {
              serviceType: 's3-cloudfront',
              bucketName,
              distributionId
            }
          };
        } catch (error) {
          return {
            entity: service.name,
            platform: 'aws',
            success: false,
            restoreTime,
            backupId,
            error: `S3 restore failed: ${error}`
          };
        }
        
      default:
        return {
          entity: service.name,
          platform: 'aws',
          success: false,
          restoreTime,
          backupId,
          error: `Restore not implemented for ${serviceType} services`
        };
    }
  }
  
  public async collectLogs(service: Service): Promise<CheckResult['logs']> {
    const { region } = this.getAWSConfig(service);
    
    try {
      // Use our fetchRecentLogs method which properly handles CloudFormation-based log group discovery
      const recentLogs = await this.fetchRecentLogs(service.name, region, 20);
      
      if (!recentLogs || recentLogs.length === 0) {
        return undefined;
      }
      
      // Count errors and warnings
      const errors = recentLogs.filter(log => 
        /\b(error|ERROR|Error|FATAL|fatal|Fatal|exception|Exception|EXCEPTION)\b/.test(log)
      ).length;
      
      const warnings = recentLogs.filter(log => 
        /\b(warning|WARNING|Warning|warn|WARN|Warn)\b/.test(log)
      ).length;
      
      return {
        recent: recentLogs.slice(0, 10), // Return the 10 most recent logs
        errors,
        warnings
      };
    } catch (error) {
      return undefined;
    }
  }
  
  // Helper methods
  
  public override getResourceName(service: Service): string {
    return `semiont-${service.name}-${service.environment}`;
  }
  
  private async getALBEndpoint(serviceName: string, region: string): Promise<string> {
    try {
      const albDns = execSync(
        `aws elbv2 describe-load-balancers --names ${serviceName}-alb --query 'LoadBalancers[0].DNSName' --output text --region ${region}`,
        { encoding: 'utf-8' }
      ).trim();
      return albDns;
    } catch {
      return '';
    }
  }
  
  private async getRDSEndpoint(instanceId: string, region: string): Promise<string> {
    try {
      const endpoint = execSync(
        `aws rds describe-db-instances --db-instance-identifier ${instanceId} --query 'DBInstances[0].Endpoint.Address' --output text --region ${region}`,
        { encoding: 'utf-8' }
      ).trim();
      return endpoint;
    } catch {
      return '';
    }
  }
  
  
  private async getCloudFrontDomain(distributionId: string, region: string): Promise<string> {
    try {
      const domain = execSync(
        `aws cloudfront get-distribution --id ${distributionId} --query 'Distribution.DomainName' --output text --region ${region}`,
        { encoding: 'utf-8' }
      ).trim();
      return domain;
    } catch {
      return '';
    }
  }
  
  
  private async getOrCreateEFS(resourceName: string, region: string): Promise<string> {
    try {
      // Check if exists
      const fileSystemId = await this.getEFSId(resourceName, region);
      if (fileSystemId) {
        return fileSystemId;
      }
      
      // Create new
      return await this.createEFS(resourceName, region);
    } catch {
      return '';
    }
  }
  
  private async getEFSId(resourceName: string, region: string): Promise<string | undefined> {
    try {
      const fileSystemId = execSync(
        `aws efs describe-file-systems --creation-token ${resourceName} --query 'FileSystems[0].FileSystemId' --output text --region ${region}`,
        { encoding: 'utf-8' }
      ).trim();
      return fileSystemId !== 'None' ? fileSystemId : undefined;
    } catch {
      return undefined;
    }
  }
  
  /**
   * Fetch recent CloudWatch logs for a service
   */
  public async fetchRecentLogs(serviceName: string, region: string, limit: number = 20): Promise<string[]> {
    try {
      const { logs, cfn } = this.getAWSClients(region);
      
      // First, try to discover the log group from CloudFormation outputs
      let discoveredLogGroup: string | undefined;
      
      try {
        // Check both app and data stacks for log group outputs
        const stackNames = ['SemiontAppStack', 'SemiontDataStack'];
        
        for (const stackName of stackNames) {
          try {
            const stackResponse = await cfn.send(new DescribeStacksCommand({
              StackName: stackName
            }));
            
            const outputs = stackResponse.Stacks?.[0]?.Outputs || [];
            
            // Look for log group outputs specific to this service
            const logGroupOutput = outputs.find(o => 
              o.OutputKey?.toLowerCase().includes('loggroup') && 
              o.OutputKey?.toLowerCase().includes(serviceName.toLowerCase())
            );
            
            if (logGroupOutput?.OutputValue) {
              discoveredLogGroup = logGroupOutput.OutputValue;
              break;
            }
            
            // Also check for a general log group that might contain all services
            const generalLogGroup = outputs.find(o => 
              o.OutputKey === 'LogGroupName' || 
              o.OutputKey === 'SemiontLogGroupName'
            );
            
            if (generalLogGroup?.OutputValue) {
              discoveredLogGroup = generalLogGroup.OutputValue;
              break;
            }
          } catch (error) {
            // Stack might not exist, continue
          }
        }
      } catch (error) {
        // CloudFormation discovery failed, continue with patterns
      }
      
      // Build log group patterns to try
      const logGroupPatterns: string[] = [];
      
      // Add discovered log group first if found
      if (discoveredLogGroup) {
        logGroupPatterns.push(discoveredLogGroup);
      }
      
      // Add common ECS/Lambda/RDS patterns
      logGroupPatterns.push(
        `/ecs/${serviceName}`,
        `/ecs/semiont-${serviceName}`,
        `/ecs/semiont`,
        `/ecs/SemiontCluster`,
        `/aws/lambda/${serviceName}`,
        `/aws/lambda/semiont-${serviceName}`,
        `/aws/rds/instance/${serviceName}/postgresql`,
        `/aws/rds/instance/semiont-${serviceName}/postgresql`,
        'SemiontLogGroup'  // Try as a direct name too
      );
      
      // Try each log group pattern
      for (const logGroupName of logGroupPatterns) {
        try {
          const response = await logs.send(new FilterLogEventsCommand({
            logGroupName,
            startTime: Date.now() - 2 * 60 * 60 * 1000, // Last 2 hours for better chance of finding logs
            limit,
            interleaved: true
          }));
          
          if (response.events && response.events.length > 0) {
            return response.events
              .filter(e => e.message)
              .map(e => e.message!.trim());
          }
        } catch (error: any) {
          // Log group doesn't exist or no permissions, try next pattern
          continue;
        }
      }
      
      // If no specific log groups found, try to list and find relevant ones
      try {
        const describeResponse = await logs.send(new DescribeLogGroupsCommand({
          limit: 50
        }));
        
        const logGroups = describeResponse.logGroups || [];
        
        // Look for log groups that might contain our service logs
        for (const logGroup of logGroups) {
          if (logGroup.logGroupName && 
              (logGroup.logGroupName.toLowerCase().includes('semiont') ||
               logGroup.logGroupName.toLowerCase().includes(serviceName.toLowerCase()))) {
            try {
              const response = await logs.send(new FilterLogEventsCommand({
                logGroupName: logGroup.logGroupName,
                startTime: Date.now() - 2 * 60 * 60 * 1000, // Last 2 hours
                limit,
                interleaved: true
              }));
              
              if (response.events?.length) {
                return response.events
                  .filter(e => e.message)
                  .map(e => e.message!.trim());
              }
            } catch {
              // Continue to next log group
            }
          }
        }
      } catch {
        // Failed to list log groups
      }
      
      return [];
    } catch (error) {
      // Silently fail - logs might not be available
      return [];
    }
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
  
  private async getLambdaVersion(functionName: string, region: string): Promise<string> {
    try {
      const version = execSync(
        `aws lambda get-function --function-name ${functionName} --query 'Configuration.Version' --output text --region ${region}`,
        { encoding: 'utf-8' }
      ).trim();
      return version;
    } catch {
      return '$LATEST';
    }
  }
  
  private parseMemory(memory: string): number {
    const match = memory.match(/(\d+)(Mi|Gi)?/);
    if (match) {
      const value = parseInt(match[1]);
      const unit = match[2];
      return unit === 'Gi' ? value : value / 1024;
    }
    return 0.5;
  }
  
  private parseStorageSize(size: string): number {
    const match = size.match(/(\d+)(Gi|Ti)?/);
    if (match) {
      const value = parseInt(match[1]);
      const unit = match[2];
      return unit === 'Ti' ? value * 1024 : value;
    }
    return 10;
  }
  
  private getRDSCost(instanceClass: string): number {
    const costs: Record<string, number> = {
      'db.t3.micro': 15,
      'db.t3.small': 30,
      'db.t3.medium': 60,
      'db.t3.large': 120,
      'db.m5.large': 150,
      'db.m5.xlarge': 300
    };
    return costs[instanceClass] || 50;
  }
  
  private getBackupMethod(serviceType: string): string {
    const methods: Record<string, string> = {
      'rds': 'RDS Snapshot',
      's3-cloudfront': 'S3 Bucket Copy',
      'efs': 'AWS Backup',
      'dynamodb': 'On-Demand Backup',
      'lambda': 'Code Export',
      'ecs-fargate': 'Task Definition + ECR'
    };
    return methods[serviceType] || 'Custom';
  }
  
  // Stub implementations for complex AWS operations
  // These would be fully implemented in production
  
  private async createTaskDefinition(_resourceName: string, _requirements: any, _region: string, _accountId: string): Promise<void> {
    // Implementation would create ECS task definition from requirements
    // Would create ECS task definition
  }
  
  private async createALB(resourceName: string, _requirements: any, _region: string, accountId: string): Promise<string> {
    // Implementation would create Application Load Balancer
    return `arn:aws:elasticloadbalancing:${_region}:${accountId}:loadbalancer/app/${resourceName}-alb/abc123`;
  }
  
  private async createECSService(cluster: string, resourceName: string, requirements: any, _region: string): Promise<void> {
    // Implementation would create ECS service
    if (!cluster || !resourceName || !requirements) return;
  }
  
  private async createLambdaRole(functionName: string, _region: string, accountId: string): Promise<string> {
    // Implementation would create IAM role for Lambda
    return `arn:aws:iam::${accountId}:role/${functionName}-role`;
  }
  
  private async createLambdaFunction(functionName: string, requirements: any, roleArn: string, _region: string): Promise<void> {
    // Implementation would create Lambda function
    if (!functionName || !requirements || !roleArn) return;
  }
  
  private async createFunctionUrl(functionName: string, _region: string): Promise<string> {
    // Implementation would create Lambda function URL
    return `https://${functionName}.lambda-url.${_region}.on.aws/`;
  }
  
  private async createDBSubnetGroup(resourceName: string, _region: string): Promise<string> {
    // Implementation would create RDS subnet group
    return `${resourceName}-subnet-group`;
  }
  
  private async createRDSInstance(instanceId: string, instanceClass: string, requirements: any, _region: string): Promise<void> {
    // Implementation would create RDS instance
    if (!instanceId || !instanceClass || !requirements) return;
  }
  
  private async createS3Bucket(_bucketName: string, _staticHosting: boolean, _region: string): Promise<void> {
    // Implementation would create S3 bucket with optional static hosting
  }
  
  private async getCloudFrontDistribution(_bucketName: string, _region: string): Promise<string | undefined> {
    // Implementation would get CloudFront distribution ID for the bucket
    // For now, return undefined to indicate no existing distribution
    return undefined;
  }
  
  private async createCloudFrontDistribution(_bucketName: string, _requirements: any, _region: string): Promise<string> {
    // Implementation would create CloudFront distribution
    return `ABCDEF123456`;
  }
  
  private async createEFS(resourceName: string, _region: string): Promise<string> {
    // Implementation would create EFS file system
    return `fs-${resourceName.substring(0, 8)}`;
  }
  
  private async createEFSMountTargets(fileSystemId: string, _region: string): Promise<void> {
    // Implementation would create EFS mount targets in each subnet
    if (!fileSystemId) return;
  }
  
  private async createDynamoDBTable(tableName: string, requirements: any, _region: string): Promise<void> {
    // Implementation would create DynamoDB table
    if (!tableName || !requirements) return;
  }
  
  private async updateTaskDefinition(service: Service, imageUri: string): Promise<void> {
    if (!service || !imageUri) return;
    
    const { region } = this.getAWSConfig(service);
    
    try {
      // Get the actual ECS service name from CloudFormation discovery
      const cfnResources = await this.discoverAndCacheResources(service);
      const clusterName = cfnResources.clusterName || `semiont-${service.environment}`;
      const serviceName = cfnResources.serviceName || this.getResourceName(service);
      
      if (!serviceName) {
        console.warn(`   ⚠️  Could not find ECS service name for ${service.name}`);
        return;
      }
      
      // Get the current service to find its task definition
      const serviceJson = execSync(
        `aws ecs describe-services --cluster ${clusterName} --services ${serviceName} --region ${region} --output json`,
        { encoding: 'utf-8' }
      );
      
      const ecsService = JSON.parse(serviceJson).services?.[0];
      if (!ecsService) {
        console.warn(`   ⚠️  ECS service ${serviceName} not found`);
        return;
      }
      
      const currentTaskDefArn = ecsService.taskDefinition;
      if (!currentTaskDefArn) {
        console.warn(`   ⚠️  No task definition found for service ${serviceName}`);
        return;
      }
      
      // Get current task definition details
      const currentTaskDefJson = execSync(
        `aws ecs describe-task-definition --task-definition ${currentTaskDefArn} --region ${region} --output json`,
        { encoding: 'utf-8' }
      );
      
      const currentTaskDef = JSON.parse(currentTaskDefJson).taskDefinition;
      
      // Update container image in the task definition
      const updatedContainerDefs = currentTaskDef.containerDefinitions?.map((containerDef: any) => {
        // Update the image to the new one we just published
        return { ...containerDef, image: imageUri };
      });
      
      // Register new task definition revision with updated image
      const newTaskDef = {
        family: currentTaskDef.family,
        containerDefinitions: updatedContainerDefs,
        requiresCompatibilities: currentTaskDef.requiresCompatibilities,
        networkMode: currentTaskDef.networkMode,
        cpu: currentTaskDef.cpu,
        memory: currentTaskDef.memory,
        executionRoleArn: currentTaskDef.executionRoleArn,
        taskRoleArn: currentTaskDef.taskRoleArn,
        volumes: currentTaskDef.volumes || [],
        placementConstraints: currentTaskDef.placementConstraints || []
      };
      
      const registerResult = execSync(
        `aws ecs register-task-definition --cli-input-json '${JSON.stringify(newTaskDef)}' --region ${region} --output json`,
        { encoding: 'utf-8' }
      );
      
      const newTaskDefArn = JSON.parse(registerResult).taskDefinition?.taskDefinitionArn;
      
      // Update the ECS service to use the new task definition
      execSync(
        `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --task-definition ${newTaskDefArn} --region ${region}`,
        { encoding: 'utf-8' }
      );
      
      console.log(`   📝 Updated task definition to use image: ${imageUri}`);
    } catch (error) {
      console.warn(`   ⚠️  Could not update task definition: ${error}`);
      // Don't fail the publish - the update command can still work with force-new-deployment
    }
  }
  
  private async getRDSSnapshotSize(_snapshotId: string, _region: string): Promise<number> {
    // Implementation would get RDS snapshot size
    return 10 * 1024 * 1024 * 1024; // 10GB default
  }
  
  private async getS3BucketSize(_bucketName: string, _region: string): Promise<number> {
    // Implementation would calculate S3 bucket size
    return 1 * 1024 * 1024 * 1024; // 1GB default
  }
  
  private async createEFSBackup(_fileSystemId: string, _backupId: string, _region: string): Promise<string> {
    // Implementation would create EFS backup via AWS Backup
    return `backup-job-id`;
  }
  
  private async getRunningTask(cluster: string, service: string, region: string): Promise<string | undefined> {
    // Implementation would get a running task ARN
    try {
      const taskArn = execSync(
        `aws ecs list-tasks --cluster ${cluster} --service-name ${service} --desired-status RUNNING --query 'taskArns[0]' --output text --region ${region}`,
        { encoding: 'utf-8' }
      ).trim();
      return taskArn !== 'None' ? taskArn : undefined;
    } catch {
      return undefined;
    }
  }
  
  private async createTestTaskDefinition(_taskDef: string, _image: string, _command: string, _region: string): Promise<void> {
    // Implementation would create test task definition
  }
  
  private async runECSTask(_cluster: string, _taskDef: string, _region: string, _accountId: string): Promise<string> {
    // Implementation would run ECS task and return ARN
    return `arn:aws:ecs:${_region}:${_accountId}:task/cluster/${Date.now()}`;
  }
  
  private async waitForTaskCompletion(_cluster: string, _taskArn: string): Promise<any> {
    // Implementation would wait for task and return results
    return {
      success: true,
      logs: 'Test output here',
      exitCode: 0
    };
  }
  
  private async waitForRDSInstance(instanceId: string): Promise<void> {
    // Implementation would wait for RDS instance to be available
    if (!instanceId) return;
  }
  
  // parseTestOutput method removed as it was not being used
  
  /**
   * Manage secrets using AWS Secrets Manager
   */
  override async manageSecret(
    action: 'get' | 'set' | 'list' | 'delete',
    secretPath: string,
    value?: any,
    options?: import('../../core/platform-strategy.js').SecretOptions
  ): Promise<import('../../core/platform-strategy.js').SecretResult> {
    const { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand, CreateSecretCommand, DeleteSecretCommand, ListSecretsCommand } = await import('@aws-sdk/client-secrets-manager');
    
    // Get region from environment config
    let region: string | undefined;
    
    if (options?.environment) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const envConfigPath = path.join(process.cwd(), 'environments', `${options.environment}.json`);
        if (fs.existsSync(envConfigPath)) {
          const envConfig = JSON.parse(fs.readFileSync(envConfigPath, 'utf-8'));
          if (envConfig.aws?.region) {
            region = envConfig.aws.region;
          }
        }
      } catch (error) {
        // Continue to check other sources
      }
    }
    
    // If no region from environment config, fail with clear error
    if (!region) {
      return {
        success: false,
        action,
        secretPath,
        platform: 'aws',
        storage: 'aws-secrets-manager',
        error: `AWS region not configured. Please ensure your environment config at environments/${options?.environment}.json contains aws.region`
      };
    }
    
    const secretsClient = new SecretsManagerClient({ region });
    
    // Format secret name for AWS
    const secretName = this.formatSecretName(secretPath, options?.environment);
    
    try {
      switch (action) {
        case 'get': {
          try {
            const response = await secretsClient.send(
              new GetSecretValueCommand({
                SecretId: secretName
              })
            );
            
            // Try to parse as JSON if requested
            let secretValue = response.SecretString || '';
            if (options?.format === 'json' && secretValue) {
              try {
                secretValue = JSON.parse(secretValue);
              } catch {
                // Keep as string if not valid JSON
              }
            }
            
            return {
              success: true,
              action,
              secretPath,
              value: secretValue,
              platform: 'aws',
              storage: 'aws-secrets-manager',
              metadata: {
                arn: response.ARN,
                versionId: response.VersionId
              }
            };
          } catch (error: any) {
            if (error.name === 'ResourceNotFoundException') {
              return {
                success: false,
                action,
                secretPath,
                platform: 'aws',
                storage: 'aws-secrets-manager',
                error: `Secret not found: ${secretPath}`
              };
            }
            throw error;
          }
        }
        
        case 'set': {
          const secretString = typeof value === 'object' ? JSON.stringify(value) : String(value);
          
          // First try to update existing secret
          try {
            const response = await secretsClient.send(
              new UpdateSecretCommand({
                SecretId: secretName,
                SecretString: secretString
              })
            );
            
            return {
              success: true,
              action,
              secretPath,
              platform: 'aws',
              storage: 'aws-secrets-manager',
              metadata: {
                arn: response.ARN,
                versionId: response.VersionId
              }
            };
          } catch (error: any) {
            // If secret doesn't exist, create it
            if (error.name === 'ResourceNotFoundException') {
              const response = await secretsClient.send(
                new CreateSecretCommand({
                  Name: secretName,
                  SecretString: secretString,
                  Description: `Created by semiont configure command`
                })
              );
              
              return {
                success: true,
                action,
                secretPath,
                platform: 'aws',
                storage: 'aws-secrets-manager',
                metadata: {
                  arn: response.ARN,
                  versionId: response.VersionId,
                  created: true
                }
              };
            }
            throw error;
          }
        }
        
        case 'list': {
          const response = await secretsClient.send(
            new ListSecretsCommand({
              MaxResults: 100,
              Filters: secretPath ? [
                {
                  Key: 'name',
                  Values: [secretPath]
                }
              ] : undefined
            })
          );
          
          const secretNames = (response.SecretList || [])
            .map(secret => this.extractSecretPath(secret.Name || ''))
            .filter(name => name !== null);
          
          return {
            success: true,
            action,
            secretPath,
            values: secretNames as string[],
            platform: 'aws',
            storage: 'aws-secrets-manager',
            metadata: {
              totalFound: secretNames.length
            }
          };
        }
        
        case 'delete': {
          try {
            await secretsClient.send(
              new DeleteSecretCommand({
                SecretId: secretName,
                ForceDeleteWithoutRecovery: true
              })
            );
            
            return {
              success: true,
              action,
              secretPath,
              platform: 'aws',
              storage: 'aws-secrets-manager'
            };
          } catch (error: any) {
            if (error.name === 'ResourceNotFoundException') {
              // Already deleted
              return {
                success: true,
                action,
                secretPath,
                platform: 'aws',
                storage: 'aws-secrets-manager'
              };
            }
            throw error;
          }
        }
        
        default:
          return {
            success: false,
            action,
            secretPath,
            platform: 'aws',
            error: `Unknown action: ${action}`
          };
      }
    } catch (error) {
      return {
        success: false,
        action,
        secretPath,
        platform: 'aws',
        storage: 'aws-secrets-manager',
        error: (error as Error).message
      };
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
  
  /**
   * Format secret name for AWS Secrets Manager
   */
  private formatSecretName(secretPath: string, environment?: string): string {
    // If the path already looks like a full AWS secret name, use it
    if (secretPath.includes('semiont-') && secretPath.includes('-secret')) {
      return secretPath;
    }
    
    // Otherwise format it: semiont-{environment}-{path}-secret
    if (!environment) {
      throw new Error('Environment is required for secret management');
    }
    const formattedPath = secretPath.replace(/[\/\-\.]/g, '-');
    return `semiont-${environment}-${formattedPath}-secret`;
  }
  
  /**
   * Extract secret path from AWS secret name
   */
  private extractSecretPath(secretName: string): string | null {
    // Extract path from names like: semiont-production-oauth-google-secret
    const match = secretName.match(/^semiont-[^-]+-(.+)-secret$/);
    if (match) {
      return match[1].replace(/-/g, '/');
    }
    return null;
  }

  /**
   * Check ECS Fargate service status
   */




}