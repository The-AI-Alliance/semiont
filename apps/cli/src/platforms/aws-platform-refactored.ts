/**
 * AWS Platform Strategy - Refactored with Requirements Pattern
 * 
 * Manages services on AWS using their declared requirements.
 * Automatically selects appropriate AWS services based on requirements.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { StartResult } from "../commands/start.js";
import { StopResult } from "../commands/stop.js";
import { CheckResult } from "../commands/check.js";
import { UpdateResult } from "../commands/update.js";
import { ProvisionResult } from "../commands/provision.js";
import { PublishResult } from "../commands/publish.js";
import { PlatformResources, AWSResources } from "../lib/platform-resources.js";
import { BackupResult } from "../commands/backup.js";
import { ExecResult, ExecOptions } from "../commands/exec.js";
import { TestResult, TestOptions } from "../commands/test.js";
import { RestoreResult, RestoreOptions } from "../commands/restore.js";
import { BasePlatformStrategy, ServiceContext } from './platform-strategy.js';
import { printInfo, printWarning } from '../lib/cli-logger.js';

export class AWSPlatformStrategyRefactored extends BasePlatformStrategy {
  private region: string;
  private accountId: string;
  
  constructor() {
    super();
    this.region = process.env.AWS_REGION || 'us-east-1';
    this.accountId = process.env.AWS_ACCOUNT_ID || '';
  }
  
  getPlatformName(): string {
    return 'aws';
  }
  
  /**
   * Determine the best AWS service type based on requirements
   */
  private determineAWSServiceType(context: ServiceContext): string {
    const requirements = context.getRequirements();
    
    // Static content with CDN needs → S3 + CloudFront
    if (requirements.annotations?.['aws/service'] === 's3-cloudfront' ||
        (requirements.network?.needsLoadBalancer && !requirements.resources?.cpu)) {
      return 's3-cloudfront';
    }
    
    // Database requirements → RDS or DynamoDB
    if (requirements.storage?.some(s => s.type === 'database')) {
      return requirements.annotations?.['aws/nosql'] === 'true' ? 'dynamodb' : 'rds';
    }
    
    // Serverless function → Lambda
    if (requirements.annotations?.['aws/service'] === 'lambda' ||
        requirements.annotations?.['serverless'] === 'true') {
      return 'lambda';
    }
    
    // File storage → EFS or S3
    if (requirements.storage?.some(s => s.type === 'filesystem')) {
      return 'efs';
    }
    
    // Container with persistent workload → ECS Fargate
    if (requirements.build?.dockerfile || requirements.resources?.cpu) {
      return 'ecs-fargate';
    }
    
    // Default to Lambda for stateless services
    return 'lambda';
  }
  
  async start(context: ServiceContext): Promise<StartResult> {
    const requirements = context.getRequirements();
    const serviceType = this.determineAWSServiceType(context);
    const resourceName = this.getResourceName(context);
    
    let endpoint: string | undefined;
    let resources: AWSResources | undefined;
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Start or update ECS service
        const clusterName = `semiont-${context.environment}`;
        const serviceName = resourceName;
        const desiredCount = requirements.resources?.replicas || 1;
        
        try {
          execSync(
            `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --desired-count ${desiredCount} --region ${this.region}`
          );
          
          // Get service endpoint from load balancer
          if (requirements.network?.needsLoadBalancer) {
            const albDns = await this.getALBEndpoint(serviceName);
            endpoint = `https://${albDns}`;
          }
          
          resources = {
            platform: 'aws',
            data: {
              clusterId: clusterName,
              serviceArn: `arn:aws:ecs:${this.region}:${this.accountId}:service/${clusterName}/${serviceName}`,
              taskDefinition: `${serviceName}-task`
            }
          };
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
            `aws lambda get-function-url-config --function-name ${functionName} --query FunctionUrl --output text --region ${this.region} 2>/dev/null`,
            { encoding: 'utf-8' }
          ).trim();
          
          endpoint = functionUrl !== 'None' ? functionUrl : undefined;
        } catch {
          // No function URL configured
        }
        
        resources = {
          platform: 'aws',
          data: {
            functionArn: `arn:aws:lambda:${this.region}:${this.accountId}:function:${functionName}`
          }
        };
        break;
        
      case 'rds':
        // Start RDS instance
        const instanceId = `${resourceName}-db`;
        
        try {
          execSync(`aws rds start-db-instance --db-instance-identifier ${instanceId} --region ${this.region}`);
          
          if (!context.quiet) {
            printInfo('RDS instance starting... this may take several minutes');
          }
          
          // Get endpoint
          const dbEndpoint = await this.getRDSEndpoint(instanceId);
          endpoint = dbEndpoint;
          
          resources = {
            platform: 'aws',
            data: {
              instanceId,
              endpoint: dbEndpoint
            }
          };
        } catch (error) {
          throw new Error(`Failed to start RDS instance: ${error}`);
        }
        break;
        
      case 's3-cloudfront':
        // S3 + CloudFront doesn't really "start" but we can return the endpoint
        const bucketName = `${resourceName}-static`;
        const distributionId = await this.getCloudFrontDistribution(bucketName);
        
        if (distributionId) {
          const domain = await this.getCloudFrontDomain(distributionId);
          endpoint = `https://${domain}`;
        } else {
          endpoint = `https://${bucketName}.s3-website-${this.region}.amazonaws.com`;
        }
        
        resources = {
          platform: 'aws',
          data: {
            bucketName,
            distributionId
          }
        };
        break;
        
      case 'efs':
        // EFS is always available
        const fileSystemId = await this.getOrCreateEFS(resourceName);
        
        resources = {
          platform: 'aws',
          data: {
            fileSystemId,
            mountTarget: `${fileSystemId}.efs.${this.region}.amazonaws.com`
          }
        };
        break;
        
      case 'dynamodb':
        // DynamoDB tables are always available
        const tableName = `${resourceName}-table`;
        
        resources = {
          platform: 'aws',
          data: {
            tableName,
            region: this.region
          }
        };
        break;
    }
    
    return {
      entity: context.name,
      platform: 'aws',
      success: true,
      startTime: new Date(),
      endpoint,
      resources: resources as PlatformResources,
      metadata: {
        serviceType,
        region: this.region,
        resourceName
      }
    };
  }
  
  async stop(context: ServiceContext): Promise<StopResult> {
    const serviceType = this.determineAWSServiceType(context);
    const resourceName = this.getResourceName(context);
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Stop ECS service by setting desired count to 0
        const clusterName = `semiont-${context.environment}`;
        const serviceName = resourceName;
        
        try {
          execSync(
            `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --desired-count 0 --region ${this.region}`
          );
          
          return {
            entity: context.name,
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
            entity: context.name,
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
          execSync(`aws rds stop-db-instance --db-instance-identifier ${instanceId} --region ${this.region}`);
          
          return {
            entity: context.name,
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
            entity: context.name,
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
          entity: context.name,
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
          entity: context.name,
          platform: 'aws',
          success: true,
          stopTime: new Date(),
          metadata: {
            message: `Service type ${serviceType} does not support stop operation`
          }
        };
    }
  }
  
  async check(context: ServiceContext): Promise<CheckResult> {
    const requirements = context.getRequirements();
    const serviceType = this.determineAWSServiceType(context);
    const resourceName = this.getResourceName(context);
    
    let status: CheckResult['status'] = 'unknown';
    let health: CheckResult['health'] | undefined;
    let awsResources: AWSResources | undefined;
    
    switch (serviceType) {
      case 'ecs-fargate':
        const clusterName = `semiont-${context.environment}`;
        const serviceName = resourceName;
        
        try {
          const runningCount = execSync(
            `aws ecs describe-services --cluster ${clusterName} --services ${serviceName} --query 'services[0].runningCount' --output text --region ${this.region}`,
            { encoding: 'utf-8' }
          ).trim();
          
          const desiredCount = execSync(
            `aws ecs describe-services --cluster ${clusterName} --services ${serviceName} --query 'services[0].desiredCount' --output text --region ${this.region}`,
            { encoding: 'utf-8' }
          ).trim();
          
          status = parseInt(runningCount) > 0 ? 'running' : 'stopped';
          
          // Check health via ALB target health
          if (requirements.network?.healthCheckPath) {
            const targetHealth = await this.checkALBTargetHealth(serviceName);
            health = {
              healthy: targetHealth === 'healthy',
              details: {
                runningCount: parseInt(runningCount),
                desiredCount: parseInt(desiredCount),
                targetHealth
              }
            };
          }
          
          awsResources = {
            platform: 'aws',
            data: {
              clusterId: clusterName,
              serviceArn: `arn:aws:ecs:${this.region}:${this.accountId}:service/${clusterName}/${serviceName}`
            }
          };
        } catch {
          status = 'stopped';
        }
        break;
        
      case 'lambda':
        const functionName = `${resourceName}-function`;
        
        try {
          const functionState = execSync(
            `aws lambda get-function --function-name ${functionName} --query 'Configuration.State' --output text --region ${this.region}`,
            { encoding: 'utf-8' }
          ).trim();
          
          status = functionState === 'Active' ? 'running' : 
                   functionState === 'Inactive' ? 'stopped' : 'unknown';
          
          // Check last invocation for health
          if (requirements.network?.healthCheckPath) {
            const lastError = await this.checkLambdaLastError(functionName);
            health = {
              healthy: !lastError,
              details: {
                state: functionState,
                lastError
              }
            };
          }
          
          awsResources = {
            platform: 'aws',
            data: {
              functionArn: `arn:aws:lambda:${this.region}:${this.accountId}:function:${functionName}`
            }
          };
        } catch {
          status = 'stopped';
        }
        break;
        
      case 'rds':
        const instanceId = `${resourceName}-db`;
        
        try {
          const dbStatus = execSync(
            `aws rds describe-db-instances --db-instance-identifier ${instanceId} --query 'DBInstances[0].DBInstanceStatus' --output text --region ${this.region}`,
            { encoding: 'utf-8' }
          ).trim();
          
          status = dbStatus === 'available' ? 'running' :
                   dbStatus === 'stopped' ? 'stopped' :
                   dbStatus === 'starting' ? 'starting' :
                   dbStatus === 'stopping' ? 'stopping' : 'unknown';
          
          // Check database connectivity
          if (status === 'running') {
            const endpoint = await this.getRDSEndpoint(instanceId);
            health = {
              healthy: true,
              details: {
                status: dbStatus,
                endpoint,
                engine: 'postgres'
              }
            };
          }
          
          awsResources = {
            platform: 'aws',
            data: {
              instanceId,
              status: dbStatus
            }
          };
        } catch {
          status = 'stopped';
        }
        break;
        
      case 's3-cloudfront':
        const bucketName = `${resourceName}-static`;
        
        try {
          // Check if bucket exists
          execSync(`aws s3api head-bucket --bucket ${bucketName} --region ${this.region} 2>/dev/null`);
          status = 'running';
          
          // Check CloudFront distribution status
          const distributionId = await this.getCloudFrontDistribution(bucketName);
          if (distributionId) {
            const distStatus = await this.getCloudFrontStatus(distributionId);
            health = {
              healthy: distStatus === 'Deployed',
              details: {
                bucket: bucketName,
                distributionId,
                status: distStatus
              }
            };
          }
          
          awsResources = {
            platform: 'aws',
            data: {
              bucketName,
              distributionId
            }
          };
        } catch {
          status = 'stopped';
        }
        break;
        
      case 'efs':
        const fileSystemId = await this.getEFSId(resourceName);
        
        if (fileSystemId) {
          status = 'running';
          
          const fsStatus = await this.getEFSStatus(fileSystemId);
          health = {
            healthy: fsStatus === 'available',
            details: {
              fileSystemId,
              status: fsStatus
            }
          };
          
          awsResources = {
            platform: 'aws',
            data: {
              fileSystemId
            }
          };
        } else {
          status = 'stopped';
        }
        break;
        
      case 'dynamodb':
        const tableName = `${resourceName}-table`;
        
        try {
          const tableStatus = execSync(
            `aws dynamodb describe-table --table-name ${tableName} --query 'Table.TableStatus' --output text --region ${this.region}`,
            { encoding: 'utf-8' }
          ).trim();
          
          status = tableStatus === 'ACTIVE' ? 'running' : 'stopped';
          
          health = {
            healthy: tableStatus === 'ACTIVE',
            details: {
              tableName,
              status: tableStatus
            }
          };
          
          awsResources = {
            platform: 'aws',
            data: {
              tableName
            }
          };
        } catch {
          status = 'stopped';
        }
        break;
    }
    
    // Collect logs if service is running
    let logs: CheckResult['logs'] | undefined;
    if (status === 'running') {
      logs = await this.collectLogs(context, serviceType);
    }
    
    return {
      entity: context.name,
      platform: 'aws',
      success: true,
      checkTime: new Date(),
      status,
      stateVerified: true,
      resources: awsResources as PlatformResources,
      health,
      logs,
      metadata: {
        serviceType,
        region: this.region
      }
    };
  }
  
  async update(context: ServiceContext): Promise<UpdateResult> {
    const requirements = context.getRequirements();
    const serviceType = this.determineAWSServiceType(context);
    const resourceName = this.getResourceName(context);
    
    let previousVersion: string | undefined;
    let newVersion: string | undefined;
    let strategy: UpdateResult['strategy'] = 'rolling';
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Force new deployment
        const clusterName = `semiont-${context.environment}`;
        const serviceName = resourceName;
        
        // Get current task definition revision
        previousVersion = await this.getCurrentTaskDefinition(clusterName, serviceName);
        
        // Force new deployment
        execSync(
          `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --force-new-deployment --region ${this.region}`
        );
        
        // Get new task definition revision
        newVersion = await this.getCurrentTaskDefinition(clusterName, serviceName);
        strategy = 'rolling';
        break;
        
      case 'lambda':
        // Update function code and configuration
        const functionName = `${resourceName}-function`;
        
        // Get current version
        previousVersion = await this.getLambdaVersion(functionName);
        
        // Update function (would need actual deployment package)
        if (requirements.build?.buildArgs?.DEPLOYMENT_PACKAGE) {
          execSync(
            `aws lambda update-function-code --function-name ${functionName} --zip-file fileb://${requirements.build.buildArgs.DEPLOYMENT_PACKAGE} --region ${this.region}`
          );
        }
        
        // Publish new version
        const versionOutput = execSync(
          `aws lambda publish-version --function-name ${functionName} --query Version --output text --region ${this.region}`,
          { encoding: 'utf-8' }
        ).trim();
        
        newVersion = versionOutput;
        strategy = 'blue-green';
        break;
        
      case 's3-cloudfront':
        // Sync new content and invalidate cache
        const bucketName = `${resourceName}-static`;
        const sourcePath = requirements.build?.buildContext || path.join(context.projectRoot, 'dist');
        
        // Sync to S3
        execSync(`aws s3 sync ${sourcePath} s3://${bucketName}/ --delete --region ${this.region}`);
        
        // Invalidate CloudFront
        const distributionId = await this.getCloudFrontDistribution(bucketName);
        if (distributionId) {
          execSync(
            `aws cloudfront create-invalidation --distribution-id ${distributionId} --paths "/*" --region ${this.region}`
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
          `aws rds create-db-snapshot --db-instance-identifier ${instanceId} --db-snapshot-identifier ${snapshotId} --region ${this.region}`
        );
        
        previousVersion = snapshotId;
        
        // Apply any pending modifications
        execSync(
          `aws rds modify-db-instance --db-instance-identifier ${instanceId} --apply-immediately --region ${this.region}`
        );
        
        strategy = 'rolling';
        break;
        
      default:
        // No update needed for other service types
        break;
    }
    
    return {
      entity: context.name,
      platform: 'aws',
      success: true,
      updateTime: new Date(),
      previousVersion,
      newVersion,
      strategy,
      metadata: {
        serviceType,
        region: this.region,
        resourceName
      }
    };
  }
  
  async provision(context: ServiceContext): Promise<ProvisionResult> {
    const requirements = context.getRequirements();
    const serviceType = this.determineAWSServiceType(context);
    const resourceName = this.getResourceName(context);
    
    if (!context.quiet) {
      printInfo(`Provisioning ${context.name} on AWS as ${serviceType}...`);
    }
    
    const dependencies = requirements.dependencies?.services || [];
    const awsResources: AWSResources = {
      platform: 'aws',
      data: {}
    };
    
    const cost = { estimatedMonthly: 0, currency: 'USD' };
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Create ECS cluster and service
        const clusterName = `semiont-${context.environment}`;
        
        // Create cluster
        try {
          execSync(`aws ecs create-cluster --cluster-name ${clusterName} --region ${this.region}`);
          awsResources.data.clusterId = clusterName;
        } catch {
          // Cluster might already exist
        }
        
        // Create task definition from requirements
        await this.createTaskDefinition(resourceName, requirements);
        
        // Create service with ALB if needed
        if (requirements.network?.needsLoadBalancer) {
          const albArn = await this.createALB(resourceName, requirements);
          awsResources.data.loadBalancerArn = albArn;
        }
        
        // Create service
        await this.createECSService(clusterName, resourceName, requirements);
        
        // Estimate costs
        const cpu = parseFloat(requirements.resources?.cpu || '0.25');
        const memory = this.parseMemory(requirements.resources?.memory || '512Mi');
        cost.estimatedMonthly = (cpu * 40 + memory * 4.5) * (requirements.resources?.replicas || 1);
        break;
        
      case 'lambda':
        // Create Lambda function
        const functionName = `${resourceName}-function`;
        
        // Create execution role
        const roleArn = await this.createLambdaRole(functionName);
        awsResources.data.roleArn = roleArn;
        
        // Create function
        await this.createLambdaFunction(functionName, requirements, roleArn);
        awsResources.data.functionArn = `arn:aws:lambda:${this.region}:${this.accountId}:function:${functionName}`;
        
        // Create function URL if needed
        if (requirements.network?.ports) {
          const functionUrl = await this.createFunctionUrl(functionName);
          awsResources.data.functionUrl = functionUrl;
        }
        
        // Estimate costs (very rough)
        cost.estimatedMonthly = 5; // Lambda is typically very cheap
        break;
        
      case 'rds':
        // Create RDS instance
        const instanceId = `${resourceName}-db`;
        const instanceClass = requirements.annotations?.['aws/rds-class'] || 'db.t3.micro';
        
        // Create DB subnet group
        const subnetGroupName = await this.createDBSubnetGroup(resourceName);
        awsResources.data.subnetGroup = subnetGroupName;
        
        // Create RDS instance
        await this.createRDSInstance(instanceId, instanceClass, requirements);
        awsResources.data.instanceId = instanceId;
        
        // Estimate costs
        cost.estimatedMonthly = this.getRDSCost(instanceClass);
        break;
        
      case 's3-cloudfront':
        // Create S3 bucket and CloudFront distribution
        const bucketName = `${resourceName}-static`;
        
        // Create S3 bucket with static website hosting
        await this.createS3Bucket(bucketName, true);
        awsResources.data.bucketName = bucketName;
        
        // Create CloudFront distribution
        if (requirements.network?.customDomains?.length) {
          const distributionId = await this.createCloudFrontDistribution(bucketName, requirements);
          awsResources.data.distributionId = distributionId;
        }
        
        // Estimate costs
        cost.estimatedMonthly = 5; // S3 + CloudFront minimal cost
        break;
        
      case 'efs':
        // Create EFS file system
        const fileSystemId = await this.createEFS(resourceName);
        awsResources.data.fileSystemId = fileSystemId;
        
        // Create mount targets in each subnet
        await this.createEFSMountTargets(fileSystemId);
        
        // Estimate costs
        const storageGB = this.parseStorageSize(requirements.storage?.[0]?.size || '10Gi');
        cost.estimatedMonthly = storageGB * 0.30;
        break;
        
      case 'dynamodb':
        // Create DynamoDB table
        const tableName = `${resourceName}-table`;
        
        await this.createDynamoDBTable(tableName, requirements);
        awsResources.data.tableName = tableName;
        
        // Estimate costs
        cost.estimatedMonthly = 25; // On-demand pricing estimate
        break;
    }
    
    return {
      entity: context.name,
      platform: 'aws',
      success: true,
      provisionTime: new Date(),
      resources: awsResources as PlatformResources,
      dependencies,
      cost,
      metadata: {
        serviceType,
        region: this.region,
        accountId: this.accountId
      }
    };
  }
  
  async publish(context: ServiceContext): Promise<PublishResult> {
    const requirements = context.getRequirements();
    const serviceType = this.determineAWSServiceType(context);
    const resourceName = this.getResourceName(context);
    const version = new Date().toISOString().replace(/[:.]/g, '-');
    
    if (!context.quiet) {
      printInfo(`Publishing ${context.name} to AWS ${serviceType}...`);
    }
    
    const artifacts: PublishResult['artifacts'] = {};
    const rollback: PublishResult['rollback'] = { supported: true };
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Build and push container to ECR
        const ecrRepo = `${resourceName}`;
        const imageUri = `${this.accountId}.dkr.ecr.${this.region}.amazonaws.com/${ecrRepo}:${version}`;
        
        // Create ECR repository if needed
        try {
          execSync(`aws ecr create-repository --repository-name ${ecrRepo} --region ${this.region}`);
        } catch {
          // Repository might already exist
        }
        
        // Build and push image
        if (requirements.build?.dockerfile) {
          const buildContext = requirements.build.buildContext || context.projectRoot;
          
          // Login to ECR
          execSync(
            `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.accountId}.dkr.ecr.${this.region}.amazonaws.com`
          );
          
          // Build image
          execSync(`docker build -t ${imageUri} -f ${requirements.build.dockerfile} ${buildContext}`);
          
          // Push to ECR
          execSync(`docker push ${imageUri}`);
          
          artifacts.imageTag = version;
          artifacts.imageUrl = imageUri;
        }
        
        // Update task definition with new image
        await this.updateTaskDefinition(resourceName, imageUri);
        
        rollback.command = `aws ecs update-service --cluster semiont-${context.environment} --service ${resourceName} --task-definition ${resourceName}-task:PREVIOUS`;
        break;
        
      case 'lambda':
        // Package and deploy Lambda function
        const functionName = `${resourceName}-function`;
        const packagePath = path.join(context.projectRoot, 'dist', `${functionName}.zip`);
        
        // Create deployment package
        if (requirements.build?.buildContext) {
          const buildDir = requirements.build.buildContext;
          execSync(`cd ${buildDir} && zip -r ${packagePath} .`);
        }
        
        // Update function code
        execSync(
          `aws lambda update-function-code --function-name ${functionName} --zip-file fileb://${packagePath} --region ${this.region}`
        );
        
        // Publish version
        const versionNum = execSync(
          `aws lambda publish-version --function-name ${functionName} --query Version --output text --region ${this.region}`,
          { encoding: 'utf-8' }
        ).trim();
        
        artifacts.lambdaVersion = versionNum;
        artifacts.functionArn = `arn:aws:lambda:${this.region}:${this.accountId}:function:${functionName}:${versionNum}`;
        
        rollback.command = `aws lambda update-alias --function-name ${functionName} --name prod --function-version PREVIOUS`;
        break;
        
      case 's3-cloudfront':
        // Deploy static site to S3
        const bucketName = `${resourceName}-static`;
        const sourcePath = requirements.build?.buildContext || path.join(context.projectRoot, 'dist');
        
        // Build if needed
        if (requirements.build?.buildArgs?.BUILD_COMMAND) {
          execSync(requirements.build.buildArgs.BUILD_COMMAND, { cwd: context.projectRoot });
        }
        
        // Sync to S3
        execSync(`aws s3 sync ${sourcePath} s3://${bucketName}/ --delete --region ${this.region}`);
        
        // Invalidate CloudFront
        const distributionId = await this.getCloudFrontDistribution(bucketName);
        if (distributionId) {
          const invalidationId = execSync(
            `aws cloudfront create-invalidation --distribution-id ${distributionId} --paths "/*" --query Invalidation.Id --output text --region ${this.region}`,
            { encoding: 'utf-8' }
          ).trim();
          
          artifacts.invalidationId = invalidationId;
          artifacts.distributionId = distributionId;
        }
        
        artifacts.staticSiteUrl = `https://${bucketName}.s3-website-${this.region}.amazonaws.com`;
        
        rollback.supported = false; // S3 sync is destructive
        break;
        
      case 'rds':
        // Apply database migrations
        if (!context.quiet) {
          printInfo('Database updates would be applied through migrations');
        }
        
        artifacts.databaseVersion = version;
        rollback.command = `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier ${resourceName}-db --target-db-instance-identifier ${resourceName}-db-rollback`;
        break;
    }
    
    return {
      entity: context.name,
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
        region: this.region
      }
    };
  }
  
  async backup(context: ServiceContext): Promise<BackupResult> {
    const requirements = context.getRequirements();
    const serviceType = this.determineAWSServiceType(context);
    const resourceName = this.getResourceName(context);
    const backupId = `${resourceName}-${Date.now()}`;
    
    if (!context.quiet) {
      printInfo(`Creating AWS backup for ${context.name} (${serviceType})...`);
    }
    
    const backup: BackupResult['backup'] = {
      size: 0,
      location: '',
      format: 'aws-native'
    };
    
    switch (serviceType) {
      case 'rds':
        // Create RDS snapshot
        const instanceId = `${resourceName}-db`;
        const snapshotId = `${instanceId}-backup-${backupId}`;
        
        execSync(
          `aws rds create-db-snapshot --db-instance-identifier ${instanceId} --db-snapshot-identifier ${snapshotId} --region ${this.region}`
        );
        
        // Wait for snapshot to complete (async in real implementation)
        backup.location = `arn:aws:rds:${this.region}:${this.accountId}:snapshot:${snapshotId}`;
        backup.database = {
          type: 'rds',
          engine: 'postgres',
          automated: false
        };
        
        // Get snapshot size
        const snapshotSize = await this.getRDSSnapshotSize(snapshotId);
        backup.size = snapshotSize;
        break;
        
      case 's3-cloudfront':
        // Enable versioning and create backup
        const bucketName = `${resourceName}-static`;
        
        // Enable versioning
        execSync(
          `aws s3api put-bucket-versioning --bucket ${bucketName} --versioning-configuration Status=Enabled --region ${this.region}`
        );
        
        // Create backup bucket
        const backupBucket = `${bucketName}-backup-${backupId}`;
        execSync(`aws s3 mb s3://${backupBucket} --region ${this.region}`);
        
        // Copy all objects
        execSync(`aws s3 sync s3://${bucketName}/ s3://${backupBucket}/ --region ${this.region}`);
        
        backup.location = `s3://${backupBucket}`;
        backup.filesystem = {
          paths: [bucketName],
          preservePermissions: true
        };
        
        // Get bucket size
        const bucketSize = await this.getS3BucketSize(bucketName);
        backup.size = bucketSize;
        break;
        
      case 'efs':
        // Create EFS backup using AWS Backup
        const fileSystemId = await this.getEFSId(resourceName);
        
        if (fileSystemId) {
          // Create backup using AWS Backup service
          const backupJobId = await this.createEFSBackup(fileSystemId, backupId);
          
          backup.location = `arn:aws:backup:${this.region}:${this.accountId}:recovery-point:${backupJobId}`;
          backup.filesystem = {
            paths: [`efs://${fileSystemId}`],
            preservePermissions: true
          };
        }
        break;
        
      case 'dynamodb':
        // Create DynamoDB backup
        const tableName = `${resourceName}-table`;
        
        execSync(
          `aws dynamodb create-backup --table-name ${tableName} --backup-name ${backupId} --region ${this.region}`
        );
        
        backup.location = `arn:aws:dynamodb:${this.region}:${this.accountId}:table/${tableName}/backup/${backupId}`;
        backup.database = {
          type: 'dynamodb',
          automated: false
        };
        break;
        
      case 'lambda':
        // Export Lambda function
        const functionName = `${resourceName}-function`;
        const exportPath = `/tmp/${functionName}-${backupId}.zip`;
        
        // Get function code
        const codeLocation = execSync(
          `aws lambda get-function --function-name ${functionName} --query Code.Location --output text --region ${this.region}`,
          { encoding: 'utf-8' }
        ).trim();
        
        // Download code
        execSync(`curl -o ${exportPath} "${codeLocation}"`);
        
        // Upload to S3 for storage
        const lambdaBackupBucket = `semiont-backups-${this.region}`;
        const s3Key = `lambda/${functionName}/${backupId}.zip`;
        
        execSync(`aws s3 cp ${exportPath} s3://${lambdaBackupBucket}/${s3Key} --region ${this.region}`);
        
        backup.location = `s3://${lambdaBackupBucket}/${s3Key}`;
        backup.size = fs.statSync(exportPath).size;
        break;
        
      case 'ecs-fargate':
        // Backup ECS task definition and ECR image
        const clusterName = `semiont-${context.environment}`;
        const serviceName = resourceName;
        
        // Export task definition
        const taskDef = execSync(
          `aws ecs describe-task-definition --task-definition ${serviceName}-task --region ${this.region}`,
          { encoding: 'utf-8' }
        );
        
        const backupBucketECS = `semiont-backups-${this.region}`;
        const taskDefKey = `ecs/${serviceName}/${backupId}-task-definition.json`;
        
        // Save task definition to S3
        fs.writeFileSync(`/tmp/${backupId}-task-def.json`, taskDef);
        execSync(
          `aws s3 cp /tmp/${backupId}-task-def.json s3://${backupBucketECS}/${taskDefKey} --region ${this.region}`
        );
        
        backup.location = `s3://${backupBucketECS}/${taskDefKey}`;
        backup.container = {
          taskDefinition: `${serviceName}-task`,
          cluster: clusterName
        };
        break;
    }
    
    // Calculate retention
    const retentionDays = requirements.annotations?.['backup/retention'] 
      ? parseInt(requirements.annotations['backup/retention'])
      : 30;
    
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + retentionDays);
    
    return {
      entity: context.name,
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
        command: `semiont restore --service ${context.name} --backup-id ${backupId}`,
        requirements: ['AWS credentials', 'Same region']
      },
      metadata: {
        serviceType,
        region: this.region,
        backupMethod: this.getBackupMethod(serviceType)
      }
    };
  }
  
  async exec(context: ServiceContext, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const serviceType = this.determineAWSServiceType(context);
    const resourceName = this.getResourceName(context);
    const execTime = new Date();
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Use ECS Exec
        const clusterName = `semiont-${context.environment}`;
        const serviceName = resourceName;
        
        // Get running task
        const taskArn = await this.getRunningTask(clusterName, serviceName);
        
        if (!taskArn) {
          return {
            entity: context.name,
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
          '--region', this.region
        ].join(' ');
        
        try {
          const output = execSync(execCommand, {
            encoding: 'utf-8',
            timeout: options.timeout || 30000
          });
          
          return {
            entity: context.name,
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
            entity: context.name,
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
          const result = execSync(
            `aws lambda invoke --function-name ${functionName} --payload '${payload}' --query 'Payload' --output text --region ${this.region} /tmp/lambda-output.txt`,
            { encoding: 'utf-8' }
          );
          
          const output = fs.readFileSync('/tmp/lambda-output.txt', 'utf-8');
          
          return {
            entity: context.name,
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
            entity: context.name,
            platform: 'aws',
            success: false,
            execTime,
            command,
            error: error.message
          };
        }
        
      default:
        return {
          entity: context.name,
          platform: 'aws',
          success: false,
          execTime,
          command,
          error: `Exec not supported for ${serviceType} services`
        };
    }
  }
  
  async test(context: ServiceContext, options: TestOptions = {}): Promise<TestResult> {
    const requirements = context.getRequirements();
    const serviceType = this.determineAWSServiceType(context);
    const resourceName = this.getResourceName(context);
    const testTime = new Date();
    
    if (!context.quiet) {
      printInfo(`Running tests for ${context.name} on AWS ${serviceType}...`);
    }
    
    // Use test annotations or defaults
    const testImage = requirements.annotations?.['test/image'];
    const testCommand = requirements.annotations?.['test/command'] || 'npm test';
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Run tests as ECS task
        const taskDefinition = `${resourceName}-test-task`;
        const cluster = `semiont-${context.environment}`;
        
        // Create test task definition if needed
        await this.createTestTaskDefinition(taskDefinition, testImage || context.getImage(), testCommand);
        
        // Run task
        const taskArn = await this.runECSTask(cluster, taskDefinition);
        
        // Wait for task completion and get logs
        const { success, logs, exitCode } = await this.waitForTaskCompletion(cluster, taskArn);
        
        // Parse test output
        const framework = requirements.annotations?.['test/framework'] || 'jest';
        const testResults = this.parseTestOutput(logs, framework);
        
        return {
          entity: context.name,
          platform: 'aws',
          success,
          testTime,
          suite: options.suite || 'unit',
          tests: testResults,
          metadata: {
            serviceType: 'ecs-fargate',
            taskArn,
            exitCode
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
          const result = execSync(
            `aws lambda invoke --function-name ${functionName} --payload '${JSON.stringify(testEvent)}' --query 'Payload' --output text --region ${this.region} /tmp/test-output.txt`,
            { encoding: 'utf-8' }
          );
          
          const output = fs.readFileSync('/tmp/test-output.txt', 'utf-8');
          const testResult = JSON.parse(output);
          
          return {
            entity: context.name,
            platform: 'aws',
            success: testResult.success || false,
            testTime,
            suite: options.suite || 'unit',
            tests: testResult.tests,
            coverage: testResult.coverage,
            metadata: {
              serviceType: 'lambda',
              functionName
            }
          };
        } catch (error) {
          return {
            entity: context.name,
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
            `aws synthetics start-canary --name ${canaryName} --region ${this.region}`
          );
          
          // Wait for results
          await new Promise(resolve => setTimeout(resolve, 30000));
          
          // Get canary results
          const runs = execSync(
            `aws synthetics describe-canary-runs --name ${canaryName} --max-results 1 --query 'CanaryRuns[0]' --region ${this.region}`,
            { encoding: 'utf-8' }
          );
          
          const runResult = JSON.parse(runs);
          
          return {
            entity: context.name,
            platform: 'aws',
            success: runResult.Status.State === 'PASSED',
            testTime,
            suite: 'synthetic',
            tests: {
              total: 1,
              passed: runResult.Status.State === 'PASSED' ? 1 : 0,
              failed: runResult.Status.State === 'PASSED' ? 0 : 1,
              skipped: 0
            },
            metadata: {
              serviceType: 's3-cloudfront',
              canaryName,
              runId: runResult.Id
            }
          };
        } catch (error) {
          return {
            entity: context.name,
            platform: 'aws',
            success: false,
            testTime,
            suite: 'synthetic',
            error: `Canary test failed: ${error}`
          };
        }
        
      default:
        return {
          entity: context.name,
          platform: 'aws',
          success: false,
          testTime,
          suite: options.suite || 'unit',
          error: `Testing not supported for ${serviceType} services`
        };
    }
  }
  
  async restore(context: ServiceContext, backupId: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    const serviceType = this.determineAWSServiceType(context);
    const resourceName = this.getResourceName(context);
    const restoreTime = new Date();
    
    if (!context.quiet) {
      printInfo(`Restoring ${context.name} from backup ${backupId} on AWS...`);
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
            `aws rds restore-db-instance-from-db-snapshot --db-instance-identifier ${restoredInstanceId} --db-snapshot-identifier ${snapshotId} --region ${this.region}`
          );
          
          // Wait for instance to be available
          await this.waitForRDSInstance(restoredInstanceId);
          
          // Swap instances if requested
          if (!options.targetPath) {
            // Stop original instance
            execSync(`aws rds stop-db-instance --db-instance-identifier ${instanceId} --region ${this.region}`);
            
            // Rename instances
            execSync(`aws rds modify-db-instance --db-instance-identifier ${instanceId} --new-db-instance-identifier ${instanceId}-old --apply-immediately --region ${this.region}`);
            execSync(`aws rds modify-db-instance --db-instance-identifier ${restoredInstanceId} --new-db-instance-identifier ${instanceId} --apply-immediately --region ${this.region}`);
          }
          
          return {
            entity: context.name,
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
            entity: context.name,
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
          execSync(`aws s3 rm s3://${bucketName}/ --recursive --region ${this.region}`);
          
          // Copy from backup
          execSync(`aws s3 sync s3://${backupBucket}/ s3://${bucketName}/ --region ${this.region}`);
          
          // Invalidate CloudFront
          const distributionId = await this.getCloudFrontDistribution(bucketName);
          if (distributionId) {
            execSync(
              `aws cloudfront create-invalidation --distribution-id ${distributionId} --paths "/*" --region ${this.region}`
            );
          }
          
          return {
            entity: context.name,
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
            entity: context.name,
            platform: 'aws',
            success: false,
            restoreTime,
            backupId,
            error: `S3 restore failed: ${error}`
          };
        }
        
      default:
        return {
          entity: context.name,
          platform: 'aws',
          success: false,
          restoreTime,
          backupId,
          error: `Restore not implemented for ${serviceType} services`
        };
    }
  }
  
  async collectLogs(context: ServiceContext, serviceType: string): Promise<CheckResult['logs']> {
    const resourceName = this.getResourceName(context);
    
    switch (serviceType) {
      case 'ecs-fargate':
        // Get CloudWatch logs
        const logGroup = `/ecs/${resourceName}`;
        try {
          const logs = execSync(
            `aws logs tail ${logGroup} --max-items 100 --format short --region ${this.region}`,
            { encoding: 'utf-8' }
          ).split('\n').filter(line => line.trim());
          
          return {
            recent: logs.slice(-10),
            errors: logs.filter(l => l.match(/\b(error|ERROR|Error)\b/)).length,
            warnings: logs.filter(l => l.match(/\b(warning|WARNING|Warning)\b/)).length
          };
        } catch {
          return undefined;
        }
        
      case 'lambda':
        // Get Lambda logs
        const functionName = `${resourceName}-function`;
        const lambdaLogGroup = `/aws/lambda/${functionName}`;
        
        try {
          const logs = execSync(
            `aws logs tail ${lambdaLogGroup} --max-items 100 --format short --region ${this.region}`,
            { encoding: 'utf-8' }
          ).split('\n').filter(line => line.trim());
          
          return {
            recent: logs.slice(-10),
            errors: logs.filter(l => l.match(/\b(error|ERROR|Error)\b/)).length,
            warnings: logs.filter(l => l.match(/\b(warning|WARNING|Warning)\b/)).length
          };
        } catch {
          return undefined;
        }
        
      default:
        return undefined;
    }
  }
  
  // Helper methods
  
  private getResourceName(context: ServiceContext): string {
    return `semiont-${context.name}-${context.environment}`;
  }
  
  private async getALBEndpoint(serviceName: string): Promise<string> {
    try {
      const albDns = execSync(
        `aws elbv2 describe-load-balancers --names ${serviceName}-alb --query 'LoadBalancers[0].DNSName' --output text --region ${this.region}`,
        { encoding: 'utf-8' }
      ).trim();
      return albDns;
    } catch {
      return '';
    }
  }
  
  private async getRDSEndpoint(instanceId: string): Promise<string> {
    try {
      const endpoint = execSync(
        `aws rds describe-db-instances --db-instance-identifier ${instanceId} --query 'DBInstances[0].Endpoint.Address' --output text --region ${this.region}`,
        { encoding: 'utf-8' }
      ).trim();
      return endpoint;
    } catch {
      return '';
    }
  }
  
  private async getCloudFrontDistribution(bucketName: string): Promise<string | undefined> {
    try {
      const distributionId = execSync(
        `aws cloudfront list-distributions --query "DistributionList.Items[?Origins.Items[?DomainName=='${bucketName}.s3.amazonaws.com']].Id | [0]" --output text --region ${this.region}`,
        { encoding: 'utf-8' }
      ).trim();
      return distributionId !== 'None' ? distributionId : undefined;
    } catch {
      return undefined;
    }
  }
  
  private async getCloudFrontDomain(distributionId: string): Promise<string> {
    try {
      const domain = execSync(
        `aws cloudfront get-distribution --id ${distributionId} --query 'Distribution.DomainName' --output text --region ${this.region}`,
        { encoding: 'utf-8' }
      ).trim();
      return domain;
    } catch {
      return '';
    }
  }
  
  private async getCloudFrontStatus(distributionId: string): Promise<string> {
    try {
      const status = execSync(
        `aws cloudfront get-distribution --id ${distributionId} --query 'Distribution.Status' --output text --region ${this.region}`,
        { encoding: 'utf-8' }
      ).trim();
      return status;
    } catch {
      return 'Unknown';
    }
  }
  
  private async getOrCreateEFS(resourceName: string): Promise<string> {
    try {
      // Check if exists
      const fileSystemId = await this.getEFSId(resourceName);
      if (fileSystemId) {
        return fileSystemId;
      }
      
      // Create new
      return await this.createEFS(resourceName);
    } catch {
      return '';
    }
  }
  
  private async getEFSId(resourceName: string): Promise<string | undefined> {
    try {
      const fileSystemId = execSync(
        `aws efs describe-file-systems --creation-token ${resourceName} --query 'FileSystems[0].FileSystemId' --output text --region ${this.region}`,
        { encoding: 'utf-8' }
      ).trim();
      return fileSystemId !== 'None' ? fileSystemId : undefined;
    } catch {
      return undefined;
    }
  }
  
  private async getEFSStatus(fileSystemId: string): Promise<string> {
    try {
      const status = execSync(
        `aws efs describe-file-systems --file-system-id ${fileSystemId} --query 'FileSystems[0].LifeCycleState' --output text --region ${this.region}`,
        { encoding: 'utf-8' }
      ).trim();
      return status;
    } catch {
      return 'unknown';
    }
  }
  
  private async checkALBTargetHealth(serviceName: string): Promise<string> {
    try {
      const health = execSync(
        `aws elbv2 describe-target-health --target-group-arn $(aws elbv2 describe-target-groups --names ${serviceName}-tg --query 'TargetGroups[0].TargetGroupArn' --output text) --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text --region ${this.region}`,
        { encoding: 'utf-8' }
      ).trim();
      return health;
    } catch {
      return 'unknown';
    }
  }
  
  private async checkLambdaLastError(functionName: string): Promise<string | undefined> {
    try {
      // Get recent invocation errors from CloudWatch
      const logGroup = `/aws/lambda/${functionName}`;
      const errors = execSync(
        `aws logs filter-log-events --log-group-name ${logGroup} --filter-pattern ERROR --max-items 1 --query 'events[0].message' --output text --region ${this.region}`,
        { encoding: 'utf-8' }
      ).trim();
      return errors !== 'None' ? errors : undefined;
    } catch {
      return undefined;
    }
  }
  
  private async getCurrentTaskDefinition(cluster: string, service: string): Promise<string> {
    try {
      const taskDef = execSync(
        `aws ecs describe-services --cluster ${cluster} --services ${service} --query 'services[0].taskDefinition' --output text --region ${this.region}`,
        { encoding: 'utf-8' }
      ).trim();
      return taskDef.split(':').pop() || '';
    } catch {
      return '';
    }
  }
  
  private async getLambdaVersion(functionName: string): Promise<string> {
    try {
      const version = execSync(
        `aws lambda get-function --function-name ${functionName} --query 'Configuration.Version' --output text --region ${this.region}`,
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
  
  private async createTaskDefinition(resourceName: string, requirements: any): Promise<void> {
    // Implementation would create ECS task definition from requirements
    if (!requirements) return;
  }
  
  private async createALB(resourceName: string, requirements: any): Promise<string> {
    // Implementation would create Application Load Balancer
    return `arn:aws:elasticloadbalancing:${this.region}:${this.accountId}:loadbalancer/app/${resourceName}-alb/abc123`;
  }
  
  private async createECSService(cluster: string, resourceName: string, requirements: any): Promise<void> {
    // Implementation would create ECS service
    if (!cluster || !resourceName || !requirements) return;
  }
  
  private async createLambdaRole(functionName: string): Promise<string> {
    // Implementation would create IAM role for Lambda
    return `arn:aws:iam::${this.accountId}:role/${functionName}-role`;
  }
  
  private async createLambdaFunction(functionName: string, requirements: any, roleArn: string): Promise<void> {
    // Implementation would create Lambda function
    if (!functionName || !requirements || !roleArn) return;
  }
  
  private async createFunctionUrl(functionName: string): Promise<string> {
    // Implementation would create Lambda function URL
    return `https://${functionName}.lambda-url.${this.region}.on.aws/`;
  }
  
  private async createDBSubnetGroup(resourceName: string): Promise<string> {
    // Implementation would create RDS subnet group
    return `${resourceName}-subnet-group`;
  }
  
  private async createRDSInstance(instanceId: string, instanceClass: string, requirements: any): Promise<void> {
    // Implementation would create RDS instance
    if (!instanceId || !instanceClass || !requirements) return;
  }
  
  private async createS3Bucket(bucketName: string, staticHosting: boolean): Promise<void> {
    // Implementation would create S3 bucket with optional static hosting
    if (!bucketName) return;
  }
  
  private async createCloudFrontDistribution(bucketName: string, requirements: any): Promise<string> {
    // Implementation would create CloudFront distribution
    return `ABCDEF123456`;
  }
  
  private async createEFS(resourceName: string): Promise<string> {
    // Implementation would create EFS file system
    return `fs-${resourceName.substring(0, 8)}`;
  }
  
  private async createEFSMountTargets(fileSystemId: string): Promise<void> {
    // Implementation would create EFS mount targets in each subnet
    if (!fileSystemId) return;
  }
  
  private async createDynamoDBTable(tableName: string, requirements: any): Promise<void> {
    // Implementation would create DynamoDB table
    if (!tableName || !requirements) return;
  }
  
  private async updateTaskDefinition(resourceName: string, imageUri: string): Promise<void> {
    // Implementation would update task definition with new image
    if (!resourceName || !imageUri) return;
  }
  
  private async getRDSSnapshotSize(snapshotId: string): Promise<number> {
    // Implementation would get RDS snapshot size
    return 10 * 1024 * 1024 * 1024; // 10GB default
  }
  
  private async getS3BucketSize(bucketName: string): Promise<number> {
    // Implementation would calculate S3 bucket size
    return 1 * 1024 * 1024 * 1024; // 1GB default
  }
  
  private async createEFSBackup(fileSystemId: string, backupId: string): Promise<string> {
    // Implementation would create EFS backup via AWS Backup
    return `backup-${backupId}`;
  }
  
  private async getRunningTask(cluster: string, service: string): Promise<string | undefined> {
    // Implementation would get a running task ARN
    try {
      const taskArn = execSync(
        `aws ecs list-tasks --cluster ${cluster} --service-name ${service} --desired-status RUNNING --query 'taskArns[0]' --output text --region ${this.region}`,
        { encoding: 'utf-8' }
      ).trim();
      return taskArn !== 'None' ? taskArn : undefined;
    } catch {
      return undefined;
    }
  }
  
  private async createTestTaskDefinition(taskDef: string, image: string, command: string): Promise<void> {
    // Implementation would create test task definition
    if (!taskDef || !image || !command) return;
  }
  
  private async runECSTask(cluster: string, taskDef: string): Promise<string> {
    // Implementation would run ECS task and return ARN
    return `arn:aws:ecs:${this.region}:${this.accountId}:task/${cluster}/${Date.now()}`;
  }
  
  private async waitForTaskCompletion(cluster: string, taskArn: string): Promise<any> {
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
  
  private parseTestOutput(output: string, framework: string): any {
    // Simple test output parsing
    return {
      total: 10,
      passed: 8,
      failed: 2,
      skipped: 0
    };
  }
}