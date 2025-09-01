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

import { HandlerRegistry } from "../../core/handlers/registry.js";
import { handlers } from './handlers/index.js';
import { BasePlatformStrategy } from '../../core/platform-strategy.js';
import { Service } from '../../services/types.js';

import { ECSClient } from '@aws-sdk/client-ecs';
import { RDSClient } from '@aws-sdk/client-rds';
import { EFSClient } from '@aws-sdk/client-efs';
import { CloudFormationClient, ListStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';

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
  
  // Helper methods
  
  public override getResourceName(service: Service): string {
    return `semiont-${service.name}-${service.environment}`;
  }

}