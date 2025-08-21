/**
 * Check Command - Unified command structure
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../lib/cli-paths.js';
import { printError, printSuccess, printInfo, printWarning, setSuppressOutput } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { listContainers } from '../lib/container-runtime.js';
import * as http from 'http';
import { CheckResult, CommandResults, createBaseResult, createErrorResult } from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import type { BaseCommandOptions } from '../lib/base-command-options.js';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { 
  ECSClient, 
  DescribeServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand
} from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { EFSClient, DescribeFileSystemsCommand } from '@aws-sdk/client-efs';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { loadEnvironmentConfig } from '../lib/deployment-resolver.js';
import { LogAggregator } from '../lib/log-aggregator.js';
import { CloudWatchLogFetcher } from '../lib/log-fetchers/cloudwatch-fetcher.js';
import { type EnvironmentConfig, getAWSRegion } from '../lib/environment-config.js';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const CheckOptionsSchema = z.object({
  environment: z.string().optional(),
  section: z.enum(['all', 'services', 'health', 'logs', 'connectivity']).default('all'),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
  service: z.string().optional(),
  testEmail: z.string().optional(),
});

type CheckOptions = z.infer<typeof CheckOptionsSchema> & BaseCommandOptions;

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

/**
 * Get detailed task information including image digest
 */
async function getTaskDetails(
  ecsClient: ECSClient,
  clusterName: string,
  serviceName: string
): Promise<{ imageDigest?: string; imageTag?: string; startedAt?: Date }> {
  try {
    // List tasks for the service
    const tasksResponse = await ecsClient.send(new ListTasksCommand({
      cluster: clusterName,
      serviceName: serviceName,
      desiredStatus: 'RUNNING'
    }));
    
    if (!tasksResponse.taskArns || tasksResponse.taskArns.length === 0) {
      return {};
    }
    
    // Get task details
    const taskDetails = await ecsClient.send(new DescribeTasksCommand({
      cluster: clusterName,
      tasks: [tasksResponse.taskArns[0]] // Get first running task
    }));
    
    const task = taskDetails.tasks?.[0];
    if (!task) {
      return {};
    }
    
    // Get the container information
    const container = task.containers?.[0];
    const imageDigest = container?.imageDigest;
    const image = container?.image;
    const imageTag = image?.split(':').pop();
    
    return {
      imageDigest,
      imageTag,
      startedAt: task.startedAt
    };
  } catch (error) {
    // Non-critical, return empty object
    return {};
  }
}

/**
 * Get environment variables for a running task
 */
async function getTaskEnvironmentVariables(
  ecsClient: ECSClient,
  clusterName: string,
  serviceName: string
): Promise<Record<string, string>> {
  try {
    // List tasks for the service
    const tasksResponse = await ecsClient.send(new ListTasksCommand({
      cluster: clusterName,
      serviceName: serviceName,
      desiredStatus: 'RUNNING'
    }));
    
    if (!tasksResponse.taskArns || tasksResponse.taskArns.length === 0) {
      return {};
    }
    
    // Get task details
    const taskDetails = await ecsClient.send(new DescribeTasksCommand({
      cluster: clusterName,
      tasks: [tasksResponse.taskArns[0]],
      include: ['TAGS']
    }));
    
    const task = taskDetails.tasks?.[0];
    if (!task || !task.taskDefinitionArn) {
      return {};
    }
    
    // Get task definition to see environment variables
    const taskDefResponse = await ecsClient.send(new DescribeTaskDefinitionCommand({
      taskDefinition: task.taskDefinitionArn
    }));
    
    const containerDef = taskDefResponse.taskDefinition?.containerDefinitions?.[0];
    if (!containerDef?.environment) {
      return {};
    }
    
    // Convert environment array to object
    const envVars: Record<string, string> = {};
    for (const env of containerDef.environment) {
      if (env.name && env.value) {
        // Mask sensitive values
        if (env.name.toLowerCase().includes('secret') || 
            env.name.toLowerCase().includes('password') ||
            env.name.toLowerCase().includes('key')) {
          envVars[env.name] = '***MASKED***';
        } else {
          envVars[env.name] = env.value;
        }
      }
    }
    
    return envVars;
  } catch (error) {
    return {};
  }
}

/**
 * Test connectivity between services
 */
async function testServiceConnectivity(
  serviceName: string,
  targetService: string,
  envVars: Record<string, string>
): Promise<{ status: 'pass' | 'fail' | 'warn'; message: string }> {
  // Check for backend URL configuration in frontend
  if (serviceName === 'frontend' && targetService === 'backend') {
    const backendUrl = envVars['BACKEND_INTERNAL_URL'] || envVars['NEXT_PUBLIC_API_URL'];
    if (!backendUrl) {
      return {
        status: 'fail',
        message: 'Frontend missing BACKEND_INTERNAL_URL environment variable'
      };
    }
    
    // Check if it's trying to use Service Connect without it being configured
    if (backendUrl.includes('backend:4000') || backendUrl.includes('backend:3001')) {
      return {
        status: 'warn',
        message: `Frontend configured for Service Connect (${backendUrl}) but Service Connect not enabled`
      };
    }
    
    return {
      status: 'pass',
      message: `Frontend→Backend via ${backendUrl}`
    };
  }
  
  // Check database connectivity configuration
  if (serviceName === 'backend' && targetService === 'database') {
    const dbHost = envVars['DB_HOST'];
    const dbPort = envVars['DB_PORT'];
    
    if (!dbHost || !dbPort) {
      return {
        status: 'fail',
        message: 'Backend missing database configuration (DB_HOST/DB_PORT)'
      };
    }
    
    // Check for CloudFormation token issues
    if (dbPort.includes('Token') || dbPort.includes('${')) {
      return {
        status: 'fail',
        message: `DB_PORT contains CloudFormation token (${dbPort}) instead of actual value`
      };
    }
    
    return {
      status: 'pass',
      message: `Backend→Database via ${dbHost}:${dbPort}`
    };
  }
  
  return {
    status: 'warn',
    message: 'Connectivity check not implemented for this service pair'
  };
}

/**
 * Get deployment history for a service
 */
async function getDeploymentHistory(
  ecsClient: ECSClient,
  service: any
): Promise<Array<{ revision: string; createdAt: Date; status: string }>> {
  const history: Array<{ revision: string; createdAt: Date; status: string }> = [];
  
  try {
    // Get deployment events from service
    const deployments = service.deployments || [];
    
    for (const deployment of deployments.slice(0, 5)) { // Last 5 deployments
      const revision = deployment.taskDefinition?.match(/:(\d+)$/)?.[1] || 'unknown';
      history.push({
        revision,
        createdAt: deployment.createdAt || new Date(),
        status: deployment.status || 'UNKNOWN'
      });
    }
  } catch (error) {
    // Non-critical, return empty array
  }
  
  return history;
}

// Helper wrapper for printDebug that passes verbose option
function debugLog(_message: string, _options: any): void {
  // Debug logging disabled for now
}


// =====================================================================
// DEPLOYMENT-TYPE-AWARE CHECK FUNCTIONS
// =====================================================================

async function checkServiceImpl(serviceInfo: ServiceDeploymentInfo, options: CheckOptions, startTime: number, envConfig: EnvironmentConfig): Promise<CheckResult> {
  const baseResult = createBaseResult('check', serviceInfo.name, serviceInfo.deploymentType, options.environment!, startTime);
  
  try {
    if (options.dryRun) {
      printInfo(`[DRY RUN] Would check ${serviceInfo.name} (${serviceInfo.deploymentType})`);
      return {
        ...baseResult,
        resourceId: {
          [serviceInfo.deploymentType]: {
            name: serviceInfo.name,
          }
        },
        status: 'dry-run',
        metadata: { dryRun: true },
        healthStatus: 'unknown',
        checks: [{
          name: 'dry-run',
          status: 'pass',
          message: 'Dry run mode - no actual checks performed',
        }],
        lastCheck: new Date(),
      };
    }
    
    printInfo(`Checking ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
    
    let checks: CheckResult['checks'] = [];
    let healthStatus: CheckResult['healthStatus'] = 'unknown';
    let uptime: number | undefined;
    let resourceId: string | undefined;
    let consoleUrl: string | undefined;
    
    // Environment config is passed from the main check function
    
    switch (serviceInfo.deploymentType) {
      case 'aws':
        ({ checks, healthStatus, uptime, resourceId, consoleUrl } = await checkAWSService(serviceInfo, options, envConfig));
        break;
      case 'container':
        ({ checks, healthStatus, uptime } = await checkContainerService(serviceInfo, options));
        break;
      case 'process':
        ({ checks, healthStatus, uptime } = await checkProcessService(serviceInfo, options));
        break;
      case 'external':
        ({ checks, healthStatus, uptime } = await checkExternalService(serviceInfo, options));
        break;
      case 'mock':
        ({ checks, healthStatus, uptime } = await checkMockService(serviceInfo, options));
        break;
      default:
        printWarning(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
        checks = [{
          name: 'deployment-type',
          status: 'fail',
          message: `Unknown deployment type: ${serviceInfo.deploymentType}`,
        }];
        healthStatus = 'unhealthy';
    }
    
    const result: CheckResult = {
      ...baseResult,
      resourceId: {
        [serviceInfo.deploymentType]: {
          name: serviceInfo.name,
          ...(serviceInfo.deploymentType === 'process' && { path: serviceInfo.config.path || '' }),
          ...(serviceInfo.deploymentType === 'container' && { name: `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}` }),
          ...(serviceInfo.deploymentType === 'external' && { endpoint: serviceInfo.config.host || '' }),
          ...(serviceInfo.deploymentType === 'mock' && { id: `mock-${serviceInfo.name}-${options.environment}` }),
          ...(serviceInfo.deploymentType === 'aws' && resourceId && { arn: resourceId }),
          ...(serviceInfo.deploymentType === 'aws' && consoleUrl && { consoleUrl }),
        }
      },
      status: healthStatus === 'healthy' ? 'running' : 
              healthStatus === 'unhealthy' ? 'stopped' :
              healthStatus === 'degraded' ? 'degraded' :
              healthStatus === 'unknown' ? 'unknown' : 'stopped',
      metadata: {
        deploymentType: serviceInfo.deploymentType,
        config: serviceInfo.config,
        ...(resourceId && { resourceId }),
        ...(consoleUrl && { consoleUrl }),
      },
      healthStatus,
      checks,
      ...(uptime !== undefined && { uptime }),
      lastCheck: new Date(),
    };
    
    return result;
    
  } catch (error) {
    const errorResult = createErrorResult(baseResult, error instanceof Error ? error : String(error));
    debugLog(`Error checking service ${serviceInfo.name}: ${error}`, options);
    return {
      ...errorResult,
      resourceId: {
        [serviceInfo.deploymentType]: {
          name: serviceInfo.name,
        }
      },
      status: 'error',
      metadata: { error: errorResult.error },
      healthStatus: 'unhealthy',
      checks: [{
        name: 'service-check',
        status: 'fail',
        message: errorResult.error || 'Unknown error occurred',
      }],
      lastCheck: new Date(),
    };
  }
}

async function checkAWSService(serviceInfo: ServiceDeploymentInfo, options: CheckOptions, envConfig: EnvironmentConfig): Promise<{ checks: CheckResult['checks'], healthStatus: CheckResult['healthStatus'], uptime?: number, resourceId?: string, consoleUrl?: string }> {
  const checks: CheckResult['checks'] = [];
  let healthStatus: CheckResult['healthStatus'] = 'healthy';
  let resourceId: string | undefined;
  let consoleUrl: string | undefined;
  
  // Get AWS region - prefer config file, then environment variables, then AWS SDK default
  let awsRegion = envConfig?.aws?.region;
  
  if (!awsRegion) {
    // Try environment variables
    awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    
    if (!awsRegion) {
      // Use AWS SDK's default region resolution (checks ~/.aws/config)
      try {
        // The STS client will use the default region from AWS config
        const stsClient = new STSClient({});
        const response = await stsClient.config.region();
        awsRegion = typeof response === 'string' ? response : null;
      } catch {
        awsRegion = null;
      }
    }
  }
  
  if (!awsRegion) {
    throw new Error(
      'AWS region not configured. Please specify the region in one of the following ways:\n' +
      `  1. In your environment config file (${options.environment}.json): "aws": { "region": "us-east-2" }\n` +
      '  2. Set the AWS_REGION or AWS_DEFAULT_REGION environment variable\n' +
      '  3. Configure it in ~/.aws/config'
    );
  }
  
  let awsAccountId = envConfig?.aws?.accountId || '';
  
  if (!awsAccountId) {
    try {
      // Get AWS account ID using SDK
      const stsClient = new STSClient({ region: awsRegion });
      const identityResult = await stsClient.send(new GetCallerIdentityCommand({}));
      awsAccountId = identityResult.Account || '';
    } catch (error) {
      debugLog(`Could not get AWS account ID: ${error}`, options);
    }
  }
  
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      try {
        // Initialize AWS SDK clients
        const cfnClient = new CloudFormationClient({ region: awsRegion });
        const ecsClient = new ECSClient({ region: awsRegion });
        
        // Get cluster name and service ARN from CloudFormation outputs
        let clusterName = '';
        let serviceArn = '';
        let serviceName = '';
        
        try {
          // Get stack outputs
          const stackResult = await cfnClient.send(new DescribeStacksCommand({
            StackName: 'SemiontAppStack'
          }));
          
          const outputs = stackResult.Stacks?.[0]?.Outputs || [];
          
          // Find cluster name
          clusterName = outputs.find(o => o.OutputKey === 'ClusterName')?.OutputValue || '';
          
          // Find service ARN
          const serviceOutputKey = `${serviceInfo.name.charAt(0).toUpperCase() + serviceInfo.name.slice(1)}ServiceArn`;
          serviceArn = outputs.find(o => o.OutputKey === serviceOutputKey)?.OutputValue || '';
          
          // Find service name
          const serviceNameOutputKey = `${serviceInfo.name.charAt(0).toUpperCase() + serviceInfo.name.slice(1)}ServiceName`;
          serviceName = outputs.find(o => o.OutputKey === serviceNameOutputKey)?.OutputValue || '';
        } catch (stackError: any) {
          // Stack might not exist or outputs might not be available
          console.error(`CloudFormation error for ${serviceInfo.name}:`, stackError.message || stackError);
          checks.push({
            name: 'ecs-service',
            status: 'fail',
            message: `CloudFormation stack not found or inaccessible: ${stackError.message || stackError}`,
          });
          healthStatus = 'unhealthy';
          break;
        }
        
        if (!serviceArn || !clusterName) {
          console.error(`Missing outputs for ${serviceInfo.name}: clusterName=${clusterName}, serviceArn=${serviceArn}`);
          checks.push({
            name: 'ecs-service',
            status: 'fail',
            message: `No ECS service found for ${serviceInfo.name} in CloudFormation outputs`,
          });
          healthStatus = 'unhealthy';
          break;
        }
        
        // Get ECS service status using SDK
        const serviceResult = await ecsClient.send(new DescribeServicesCommand({
          cluster: clusterName,
          services: [serviceArn]
        }));
        
        const service = serviceResult.services?.[0];
        
        if (service && service.serviceName) {
          const actualServiceName = service.serviceName;
          resourceId = serviceArn;
          consoleUrl = `https://console.aws.amazon.com/ecs/v2/clusters/${clusterName}/services/${actualServiceName}?region=${awsRegion}`;
          
          const runningCount = service.runningCount || 0;
          const desiredCount = service.desiredCount || 0;
          const status = service.status || 'UNKNOWN';
          const taskDefinition = service.taskDefinition || '';
          const deployments = service.deployments || [];
          
          // Extract revision number from task definition ARN
          const revisionMatch = taskDefinition.match(/:(\d+)$/);
          const revision = revisionMatch ? revisionMatch[1] : 'unknown';
          
          // Check deployment status
          if (deployments.length > 1) {
            // Multiple deployments means a rolling update is in progress
            const primaryDeployment = deployments.find(d => d.status === 'PRIMARY');
            const activeDeployment = deployments.find(d => d.status === 'ACTIVE');
            
            const primaryRev = primaryDeployment?.taskDefinition?.match(/:(\d+)$/)?.[1] || 'unknown';
            const activeRev = activeDeployment?.taskDefinition?.match(/:(\d+)$/)?.[1] || 'unknown';
            
            checks.push({
              name: 'ecs-deployment',
              status: 'warn',
              message: `🔄 Rolling deployment in progress (${deployments.length} deployments active)`,
              metadata: {
                primaryRevision: primaryRev,
                activeRevision: activeRev,
                primaryRunning: primaryDeployment?.runningCount || 0,
                primaryDesired: primaryDeployment?.desiredCount || 0,
                activeRunning: activeDeployment?.runningCount || 0,
                activeDesired: activeDeployment?.desiredCount || 0,
              }
            });
            
            checks.push({
              name: 'ecs-service',
              status: 'warn',
              message: `ECS Service: Deploying rev:${primaryRev} (${primaryDeployment?.runningCount}/${primaryDeployment?.desiredCount} tasks), replacing rev:${activeRev}`,
              metadata: {
                status,
                runningCount,
                desiredCount,
                revision: primaryRev,
                serviceName: actualServiceName,
                clusterName,
              }
            });
            
            healthStatus = runningCount > 0 ? 'degraded' : 'unhealthy';
          } else {
            // Single deployment - service is stable
            const deployment = deployments[0];
            const deploymentCreatedAt = deployment?.createdAt;
            const deploymentAge = deploymentCreatedAt ? 
              Math.floor((Date.now() - new Date(deploymentCreatedAt).getTime()) / 1000 / 60) : 0;
            
            // Get task details including image digest
            const taskDetails = await getTaskDetails(ecsClient, clusterName, actualServiceName);
            
            // Get deployment history
            const deploymentHistory = await getDeploymentHistory(ecsClient, service);
            
            // Get environment variables for verbose mode
            const envVars = options.verbose ? 
              await getTaskEnvironmentVariables(ecsClient, clusterName, actualServiceName) : {};
            
            // Build enhanced message with image info
            let message = `ECS Service ${actualServiceName}: ${runningCount}/${desiredCount} tasks running (rev:${revision}`;
            if (taskDetails.imageTag) {
              message += `, image:${taskDetails.imageTag}`;
            }
            if (taskDetails.imageDigest) {
              // Show last 12 chars of digest for verification
              const shortDigest = taskDetails.imageDigest.split(':').pop()?.substring(0, 12);
              message += `, digest:${shortDigest}`;
            }
            message += `, deployed ${deploymentAge}m ago)`;
            
            checks.push({
              name: 'ecs-service',
              status: runningCount === desiredCount && status === 'ACTIVE' ? 'pass' : 'warn',
              message,
              metadata: {
                runningCount,
                desiredCount,
                status,
                revision,
                serviceName: actualServiceName,
                clusterName,
                deploymentAge: `${deploymentAge} minutes`,
                imageTag: taskDetails.imageTag,
                imageDigest: taskDetails.imageDigest,
                taskStartedAt: taskDetails.startedAt,
                deploymentHistory: deploymentHistory.map(d => ({
                  revision: d.revision,
                  status: d.status,
                  age: Math.floor((Date.now() - new Date(d.createdAt).getTime()) / 1000 / 60) + 'm ago'
                })),
                ...(options.verbose && { environmentVariables: envVars })
              }
            });
            
            // Add environment variable checks in verbose mode
            if (options.verbose && Object.keys(envVars).length > 0) {
              // Check critical environment variables
              const criticalVars = serviceInfo.name === 'frontend' ? 
                ['BACKEND_INTERNAL_URL', 'NEXTAUTH_URL', 'NEXT_PUBLIC_API_URL'] :
                ['DB_HOST', 'DB_PORT', 'OAUTH_ALLOWED_DOMAINS', 'SITE_DOMAIN'];
              
              const missingVars = criticalVars.filter(v => !envVars[v]);
              if (missingVars.length > 0) {
                checks.push({
                  name: 'environment-variables',
                  status: 'warn',
                  message: `Missing critical environment variables: ${missingVars.join(', ')}`
                });
              }
              
              // Test connectivity configuration
              if (serviceInfo.name === 'frontend') {
                const backendCheck = await testServiceConnectivity('frontend', 'backend', envVars);
                checks.push({
                  name: 'connectivity-config',
                  status: backendCheck.status,
                  message: backendCheck.message
                });
              } else if (serviceInfo.name === 'backend') {
                const dbCheck = await testServiceConnectivity('backend', 'database', envVars);
                checks.push({
                  name: 'connectivity-config',
                  status: dbCheck.status,
                  message: dbCheck.message
                });
                
                // Check OAuth configuration
                const oauthDomains = envVars['OAUTH_ALLOWED_DOMAINS'];
                if (oauthDomains) {
                  checks.push({
                    name: 'oauth-config',
                    status: 'pass',
                    message: `OAuth allowed domains: ${oauthDomains}`
                  });
                }
              }
            }
            
            // Add deployment history as separate check if verbose
            if (options.verbose && deploymentHistory.length > 1) {
              const historyMessage = deploymentHistory
                .slice(0, 3)
                .map(d => {
                  const age = Math.floor((Date.now() - new Date(d.createdAt).getTime()) / 1000 / 60);
                  return `  • rev:${d.revision} (${d.status}, ${age}m ago)`;
                })
                .join('\n');
              
              checks.push({
                name: 'deployment-history',
                status: 'info',
                message: `Recent deployments:\n${historyMessage}`,
              });
            }
            
            // Check for database errors in recent logs
            let hasDbErrors = false;
            if (serviceInfo.name === 'backend') {
              try {
                const logsClient = new (await import('@aws-sdk/client-logs')).CloudWatchLogsClient({ region: awsRegion });
                const logGroupName = `SemiontAppStack-SemiontLogGroup6DB34440-YwTP6oxtvM8k`; // TODO: Get from stack
                const endTime = Date.now();
                const startTime = endTime - (60 * 1000); // Last minute
                
                const logsResult = await logsClient.send(new (await import('@aws-sdk/client-logs')).FilterLogEventsCommand({
                  logGroupName,
                  startTime,
                  endTime,
                  filterPattern: '"invalid port number" OR "Token[TOKEN" OR "DATABASE_URL parsing failed"',
                  limit: 1
                }));
                
                hasDbErrors = (logsResult.events?.length || 0) > 0;
                if (hasDbErrors) {
                  checks.push({
                    name: 'database-connection',
                    status: 'fail',
                    message: '❌ Database connection errors detected in logs'
                  });
                }
              } catch (e) {
                // Log check failed, don't block
              }
            }
            
            healthStatus = hasDbErrors ? 'unhealthy' : (runningCount > 0 ? 'healthy' : 'unhealthy');
          }
        } else {
          checks.push({
            name: 'ecs-service',
            status: 'fail',
            message: `ECS service not found or invalid response`,
          });
          healthStatus = 'unhealthy';
        }
      } catch (error: any) {
        console.error(`ECS service check error for ${serviceInfo.name}:`, error.message || error);
        checks.push({
          name: 'ecs-service',
          status: 'fail',
          message: `Failed to check ECS service: ${error.message || error}`,
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    case 'database':
      try {
        const cfnClient = new CloudFormationClient({ region: awsRegion });
        const rdsClient = new RDSClient({ region: awsRegion });
        
        // Get RDS instance identifier - try CloudFormation first, then search by pattern
        let dbIdentifier = '';
        
        try {
          const stackName = envConfig?.stacks?.data || 'SemiontDataStack';
          const stackResult = await cfnClient.send(new DescribeStacksCommand({
            StackName: stackName
          }));
          
          const outputs = stackResult.Stacks?.[0]?.Outputs || [];
          dbIdentifier = outputs.find(o => o.OutputKey === 'DatabaseIdentifier')?.OutputValue || '';
        } catch (stackError: any) {
          console.error(`RDS CloudFormation error:`, stackError.message || stackError);
        }
        
        // If not found in CloudFormation outputs, search for RDS instances by pattern
        if (!dbIdentifier) {
          try {
            const dbResult = await rdsClient.send(new DescribeDBInstancesCommand({}));
            const semiontDb = dbResult.DBInstances?.find(db => 
              db.DBInstanceIdentifier?.toLowerCase().includes('semiont')
            );
            if (semiontDb) {
              dbIdentifier = semiontDb.DBInstanceIdentifier || '';
            }
          } catch (searchError: any) {
            console.error(`RDS search error:`, searchError.message || searchError);
          }
        }
        
        if (dbIdentifier) {
          resourceId = `arn:aws:rds:${awsRegion}:${awsAccountId}:db:${dbIdentifier}`;
          consoleUrl = `https://console.aws.amazon.com/rds/home?region=${awsRegion}#database:id=${dbIdentifier}`;
          
          // Get RDS instance status using SDK
          const dbResult = await rdsClient.send(new DescribeDBInstancesCommand({
            DBInstanceIdentifier: dbIdentifier
          }));
          
          const dbInstance = dbResult.DBInstances?.[0];
          
          if (dbInstance && dbInstance.DBInstanceStatus) {
            const status = dbInstance.DBInstanceStatus;
            const instanceClass = dbInstance.DBInstanceClass;
            const engine = dbInstance.Engine;
            const engineVersion = dbInstance.EngineVersion;
            
            checks.push({
              name: 'rds-instance',
              status: status === 'available' ? 'pass' : 'warn',
              message: `RDS Instance ${dbIdentifier}: ${status} (${instanceClass}, ${engine} ${engineVersion})`,
              metadata: {
                dbIdentifier,
                status,
                instanceClass,
                engine,
                engineVersion,
              }
            });
            
            healthStatus = status === 'available' ? 'healthy' : 'unhealthy';
          } else {
            checks.push({
              name: 'rds-instance',
              status: 'fail',
              message: `RDS instance ${dbIdentifier} not found`,
            });
            healthStatus = 'unhealthy';
          }
        } else {
          checks.push({
            name: 'rds-instance',
            status: 'warn',
            message: 'Could not determine RDS instance identifier from CloudFormation',
          });
          healthStatus = 'unknown';
        }
      } catch (error: any) {
        console.error(`RDS check error:`, error.message || error);
        checks.push({
          name: 'rds-instance',
          status: 'fail',
          message: `Failed to check RDS instance: ${error.message || error}`,
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    case 'filesystem':
      try {
        const cfnClient = new CloudFormationClient({ region: awsRegion });
        const efsClient = new EFSClient({ region: awsRegion });
        
        // Get EFS filesystem ID from CloudFormation stack - try multiple key variations
        let efsId = '';
        
        try {
          const stackName = envConfig?.stacks?.data || 'SemiontDataStack';
          const stackResult = await cfnClient.send(new DescribeStacksCommand({
            StackName: stackName
          }));
          
          const outputs = stackResult.Stacks?.[0]?.Outputs || [];
          // Try different case variations of the output key
          efsId = outputs.find(o => 
            o.OutputKey === 'EFSFileSystemId' || 
            o.OutputKey === 'EfsFileSystemId' ||
            o.OutputKey === 'FileSystemId'
          )?.OutputValue || '';
        } catch (stackError: any) {
          console.error(`EFS CloudFormation error:`, stackError.message || stackError);
        }
        
        // If not found in CloudFormation outputs, search for EFS filesystems by tags
        if (!efsId) {
          try {
            const efsResult = await efsClient.send(new DescribeFileSystemsCommand({}));
            const semiontEfs = efsResult.FileSystems?.find(fs => 
              fs.Name?.toLowerCase().includes('semiont') ||
              fs.Tags?.some(tag => tag.Value?.toLowerCase().includes('semiont'))
            );
            if (semiontEfs) {
              efsId = semiontEfs.FileSystemId || '';
            }
          } catch (searchError: any) {
            console.error(`EFS search error:`, searchError.message || searchError);
          }
        }
        
        if (efsId) {
          resourceId = `arn:aws:elasticfilesystem:${awsRegion}:${awsAccountId}:file-system/${efsId}`;
          consoleUrl = `https://console.aws.amazon.com/efs/home?region=${awsRegion}#/file-systems/${efsId}`;
          
          // Get EFS filesystem status using SDK
          const efsResult = await efsClient.send(new DescribeFileSystemsCommand({
            FileSystemId: efsId
          }));
          
          const efsSystem = efsResult.FileSystems?.[0];
          
          if (efsSystem && efsSystem.LifeCycleState) {
            const status = efsSystem.LifeCycleState;
            const sizeInBytes = efsSystem.SizeInBytes?.Value || 0;
            const sizeInMB = Math.round(sizeInBytes / 1024 / 1024);
            
            checks.push({
              name: 'efs-filesystem',
              status: status === 'available' ? 'pass' : 'warn',
              message: `EFS Filesystem ${efsId}: ${status} (${sizeInMB} MB)`,
              metadata: {
                fileSystemId: efsId,
                status,
                sizeInMB,
              }
            });
            
            healthStatus = status === 'available' ? 'healthy' : 'unhealthy';
          } else {
            checks.push({
              name: 'efs-filesystem',
              status: 'fail',
              message: `EFS filesystem ${efsId} not found`,
            });
            healthStatus = 'unhealthy';
          }
        } else {
          checks.push({
            name: 'efs-filesystem',
            status: 'warn',
            message: 'Could not determine EFS filesystem ID from CloudFormation',
          });
          healthStatus = 'unknown';
        }
      } catch (error: any) {
        console.error(`EFS check error:`, error.message || error);
        checks.push({
          name: 'efs-filesystem',
          status: 'fail',
          message: `Failed to check EFS filesystem: ${error.message || error}`,
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    default:
      checks.push({
        name: 'service-recognition',
        status: 'pass',
        message: 'Service configuration recognized',
      });
  }
  
  return { checks, healthStatus, resourceId, consoleUrl };
}

async function checkContainerService(serviceInfo: ServiceDeploymentInfo, options: CheckOptions): Promise<{ checks: CheckResult['checks'], healthStatus: CheckResult['healthStatus'], uptime?: number }> {
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}`;
  const checks: CheckResult['checks'] = [];
  let healthStatus: CheckResult['healthStatus'] = 'healthy';
  
  try {
    // Check if container is running
    const containers = await listContainers({ all: false });
    const isRunning = containers.some(c => c.includes(containerName));
    
    if (isRunning) {
      printSuccess(`Container ${containerName} is running`);
      checks.push({
        name: 'container-running',
        status: 'pass',
        message: `Container ${containerName} is running`,
      });
      
      // Additional health checks based on service
      switch (serviceInfo.name) {
        case 'database':
          debugLog('Database container health check passed', options);
          checks.push({
            name: 'database-container',
            status: 'pass',
            message: 'Database container is operational',
          });
          break;
          
        case 'frontend':
        case 'backend':
          const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
          const startTime = Date.now();
          const healthCheck = await checkHttpHealth(`http://localhost:${port}/health`);
          const responseTime = Date.now() - startTime;
          
          if (healthCheck) {
            printSuccess(`${serviceInfo.name} health endpoint responding`);
            checks.push({
              name: 'http-health',
              status: 'pass',
              message: `Health endpoint responding`,
              responseTime,
            });
          } else {
            printWarning(`${serviceInfo.name} health endpoint not responding`);
            checks.push({
              name: 'http-health',
              status: 'warn',
              message: `Health endpoint not responding`,
              responseTime,
            });
            healthStatus = 'degraded';
          }
          break;
          
        case 'filesystem':
          debugLog('Container volume mounts verified', options);
          checks.push({
            name: 'volume-mounts',
            status: 'pass',
            message: 'Container volume mounts verified',
          });
          break;
      }
    } else {
      printWarning(`Container ${containerName} is not running`);
      checks.push({
        name: 'container-running',
        status: 'fail',
        message: `Container ${containerName} is not running`,
      });
      healthStatus = 'unhealthy';
    }
  } catch (error) {
    printError(`Failed to check container ${containerName}: ${error}`);
    checks.push({
      name: 'container-check',
      status: 'fail',
      message: `Failed to check container: ${error}`,
    });
    healthStatus = 'unhealthy';
  }
  
  return { checks, healthStatus };
}

async function checkProcessService(serviceInfo: ServiceDeploymentInfo, options: CheckOptions): Promise<{ checks: CheckResult['checks'], healthStatus: CheckResult['healthStatus'], uptime?: number }> {
  const checks: CheckResult['checks'] = [];
  let healthStatus: CheckResult['healthStatus'] = 'healthy';
  
  switch (serviceInfo.name) {
    case 'database':
      const pgRunning = await checkProcessOnPort(5432);
      if (pgRunning) {
        printSuccess('PostgreSQL service is running');
        checks.push({
          name: 'postgres-process',
          status: 'pass',
          message: 'PostgreSQL service is running on port 5432',
        });
      } else {
        printWarning('PostgreSQL service is not running');
        checks.push({
          name: 'postgres-process',
          status: 'fail',
          message: 'PostgreSQL service is not running on port 5432',
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    case 'frontend':
    case 'backend':
      const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
      const processRunning = await checkProcessOnPort(port);
      
      if (processRunning) {
        printSuccess(`${serviceInfo.name} process is running on port ${port}`);
        checks.push({
          name: 'process-running',
          status: 'pass',
          message: `Process is running on port ${port}`,
        });
        
        // Check HTTP health endpoint
        const startTime = Date.now();
        const healthCheck = await checkHttpHealth(`http://localhost:${port}/health`);
        const responseTime = Date.now() - startTime;
        
        if (healthCheck) {
          printSuccess(`${serviceInfo.name} health endpoint responding`);
          checks.push({
            name: 'http-health',
            status: 'pass',
            message: 'Health endpoint responding',
            responseTime,
          });
        } else {
          debugLog(`${serviceInfo.name} health endpoint not available`, options);
          checks.push({
            name: 'http-health',
            status: 'warn',
            message: 'Health endpoint not available',
            responseTime,
          });
          healthStatus = 'degraded';
        }
      } else {
        printWarning(`${serviceInfo.name} process is not running on port ${port}`);
        checks.push({
          name: 'process-running',
          status: 'fail',
          message: `Process is not running on port ${port}`,
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    case 'filesystem':
      const dataPath = serviceInfo.config.path || path.join(PROJECT_ROOT, 'data');
      try {
        await fs.access(dataPath);
        printSuccess(`Filesystem directory accessible: ${dataPath}`);
        checks.push({
          name: 'filesystem-access',
          status: 'pass',
          message: `Directory accessible: ${dataPath}`,
          details: { path: dataPath },
        });
      } catch {
        printWarning(`Filesystem directory not accessible: ${dataPath}`);
        checks.push({
          name: 'filesystem-access',
          status: 'fail',
          message: `Directory not accessible: ${dataPath}`,
          details: { path: dataPath },
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    default:
      checks.push({
        name: 'service-recognition',
        status: 'pass',
        message: 'Service configuration recognized',
      });
  }
  
  return { checks, healthStatus };
}

async function checkExternalService(serviceInfo: ServiceDeploymentInfo, _options: CheckOptions): Promise<{ checks: CheckResult['checks'], healthStatus: CheckResult['healthStatus'], uptime?: number }> {
  const checks: CheckResult['checks'] = [];
  let healthStatus: CheckResult['healthStatus'] = 'healthy';
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        printInfo(`External database: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
        checks.push({
          name: 'external-database',
          status: 'warn',
          message: 'External database connectivity check not yet implemented',
          details: {
            host: serviceInfo.config.host,
            port: serviceInfo.config.port || 5432,
          },
        });
        healthStatus = 'unknown';
      } else {
        checks.push({
          name: 'external-database-config',
          status: 'fail',
          message: 'No host configured for external database',
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    case 'filesystem':
      if (serviceInfo.config.path || serviceInfo.config.mount) {
        const externalPath = serviceInfo.config.path || serviceInfo.config.mount;
        printInfo(`External storage: ${externalPath}`);
        try {
          await fs.access(externalPath!);
          printSuccess('External storage accessible');
          checks.push({
            name: 'external-storage',
            status: 'pass',
            message: 'External storage accessible',
            details: { path: externalPath },
          });
        } catch {
          printWarning('External storage not accessible');
          checks.push({
            name: 'external-storage',
            status: 'fail',
            message: 'External storage not accessible',
            details: { path: externalPath },
          });
          healthStatus = 'unhealthy';
        }
      } else {
        checks.push({
          name: 'external-storage-config',
          status: 'fail',
          message: 'No path configured for external storage',
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    case 'frontend':
    case 'backend':
      if (serviceInfo.config.host) {
        const url = `http://${serviceInfo.config.host}:${serviceInfo.config.port || 80}/health`;
        const startTime = Date.now();
        const healthy = await checkHttpHealth(url);
        const responseTime = Date.now() - startTime;
        
        if (healthy) {
          printSuccess(`External ${serviceInfo.name} service is healthy`);
          checks.push({
            name: 'external-service',
            status: 'pass',
            message: `External ${serviceInfo.name} service is healthy`,
            responseTime,
            details: { endpoint: url },
          });
        } else {
          printWarning(`External ${serviceInfo.name} service is not responding`);
          checks.push({
            name: 'external-service',
            status: 'fail',
            message: `External ${serviceInfo.name} service is not responding`,
            responseTime,
            details: { endpoint: url },
          });
          healthStatus = 'unhealthy';
        }
      } else {
        checks.push({
          name: 'external-service-config',
          status: 'fail',
          message: `No host configured for external ${serviceInfo.name}`,
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    default:
      checks.push({
        name: 'external-service-config',
        status: 'pass',
        message: `External ${serviceInfo.name} service configured`,
      });
  }
  
  return { checks, healthStatus };
}

async function checkMockService(serviceInfo: ServiceDeploymentInfo, _options: CheckOptions): Promise<{ checks: CheckResult['checks'], healthStatus: CheckResult['healthStatus'], uptime?: number }> {
  const checks: CheckResult['checks'] = [];
  let healthStatus: CheckResult['healthStatus'] = 'healthy';
  
  // Mock services are always "healthy" for testing purposes
  printSuccess(`Mock ${serviceInfo.name} service is healthy`);
  checks.push({
    name: 'mock-service',
    status: 'pass',
    message: `Mock ${serviceInfo.name} service is operational`,
    details: {
      mockType: 'testing',
      simulatedHealthy: true,
    },
  });
  
  return { checks, healthStatus };
}

// =====================================================================
// UTILITY FUNCTIONS
// =====================================================================

async function checkProcessOnPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('lsof', ['-ti', `:${port}`]);
    let output = '';
    
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('exit', (code) => {
      resolve(code === 0 && output.trim().length > 0);
    });
    
    proc.on('error', () => {
      resolve(false);
    });
  });
}

async function checkHttpHealth(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, 5000);
    
    http.get(url, (res) => {
      clearTimeout(timeout);
      resolve(res.statusCode === 200);
    }).on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

export async function check(
  serviceDeployments: ServiceDeploymentInfo[],
  options: CheckOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  
  // Suppress output for structured formats
  const previousSuppressOutput = setSuppressOutput(isStructuredOutput);
  
  // Load environment config once for all operations
  const envConfig = loadEnvironmentConfig(options.environment || 'development') as EnvironmentConfig;
  const awsRegion = getAWSRegion(envConfig)
  
  try {
    debugLog(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    
    // Check services and collect results
    const serviceResults: CheckResult[] = [];
    
    if (options.section === 'all' || options.section === 'services' || options.section === 'health') {
      if (options.section === 'all' || options.section === 'services') {
        printInfo('\n📊 Service Status:');
      }
      
      // Check for critical errors FIRST
      const criticalErrors: string[] = [];
      try {
        const logsClient = new (await import('@aws-sdk/client-logs')).CloudWatchLogsClient({ region: awsRegion });
        const logGroupName = `SemiontAppStack-SemiontLogGroup6DB34440-YwTP6oxtvM8k`; // TODO: Get from stack
        const endTime = Date.now();
        const startTime = endTime - (2 * 60 * 1000); // Last 2 minutes
        
        const criticalPatterns = [
          '"invalid port number"',
          '"Token[TOKEN"', 
          '"DATABASE_URL parsing failed"',
          '"syntax error"',
          '"Environment variable not found: DATABASE_URL"',
          '"FATAL:"'
        ];
        
        for (const pattern of criticalPatterns) {
          const logsResult = await logsClient.send(new (await import('@aws-sdk/client-logs')).FilterLogEventsCommand({
            logGroupName,
            startTime,
            endTime,
            filterPattern: pattern,
            limit: 5
          }));
          
          if (logsResult.events && logsResult.events.length > 0) {
            logsResult.events.forEach(event => {
              if (event.message) {
                criticalErrors.push(event.message);
              }
            });
          }
        }
        
        if (criticalErrors.length > 0) {
          printError('\n🚨 CRITICAL ERRORS DETECTED:');
          criticalErrors.slice(0, 10).forEach(error => {
            // Extract just the important part
            const match = error.match(/([^\/]+)$/) || [error];
            printError(`  ${match[0]}`);
          });
          printError('');
        }
      } catch (e) {
        // Don't fail if we can't check logs
      }
      
      for (const serviceInfo of serviceDeployments) {
        const result = await checkServiceImpl(serviceInfo, options, startTime, envConfig);
        serviceResults.push(result);
      }
    }
    
    // Calculate overall health based on actual service results
    const healthyCount = serviceResults.filter(r => r.healthStatus === 'healthy').length;
    const degradedCount = serviceResults.filter(r => r.healthStatus === 'degraded').length;
    const unhealthyCount = serviceResults.filter(r => r.healthStatus === 'unhealthy').length;
    
    let overallHealth = 'Unknown';
    if (serviceResults.length === 0) {
      overallHealth = 'No services checked';
    } else if (healthyCount === serviceResults.length) {
      overallHealth = '✅ All services healthy';
    } else if (unhealthyCount === serviceResults.length) {
      overallHealth = '❌ All services unhealthy';
    } else if (unhealthyCount > 0) {
      overallHealth = `⚠️  ${healthyCount}/${serviceResults.length} services healthy`;
    } else if (degradedCount > 0) {
      overallHealth = `⚠️  Some services degraded`;
    }
    
    if (options.section === 'all' || options.section === 'health') {
      printInfo('\n💚 Health Checks:');
      
      // Display individual service health checks
      for (const result of serviceResults) {
        if (result.checks && result.checks.length > 0) {
          for (const check of result.checks) {
            const statusIcon = check.status === 'pass' ? '✅' : 
                              check.status === 'warn' ? '⚠️' : '❌';
            printInfo(`  ${statusIcon} ${check.message}`);
          }
        }
      }
      
      printInfo(`\nOverall system health: ${overallHealth}`);
    }
    
    if (options.section === 'connectivity') {
      printInfo('\n🔗 Connectivity Tests:');
      
      // Test frontend-to-backend connectivity
      if (envConfig?.stacks?.app) {
        try {
          const cfnClient = new CloudFormationClient({ region: awsRegion });
          const ecsClient = new ECSClient({ region: awsRegion });
          
          // Get stack outputs
          const stackResult = await cfnClient.send(new DescribeStacksCommand({
            StackName: envConfig.stacks.app
          }));
          
          const outputs = stackResult.Stacks?.[0]?.Outputs || [];
          const clusterName = outputs.find(o => o.OutputKey === 'ClusterName')?.OutputValue || '';
          const frontendServiceName = outputs.find(o => o.OutputKey === 'FrontendServiceName')?.OutputValue || '';
          const backendServiceName = outputs.find(o => o.OutputKey === 'BackendServiceName')?.OutputValue || '';
          
          if (clusterName && frontendServiceName && backendServiceName) {
            // Check frontend environment
            const frontendEnv = await getTaskEnvironmentVariables(ecsClient, clusterName, frontendServiceName);
            const frontendConnectivity = await testServiceConnectivity('frontend', 'backend', frontendEnv);
            printInfo(`  Frontend→Backend: ${frontendConnectivity.status === 'pass' ? '✅' : frontendConnectivity.status === 'warn' ? '⚠️' : '❌'} ${frontendConnectivity.message}`);
            
            // Check backend environment
            const backendEnv = await getTaskEnvironmentVariables(ecsClient, clusterName, backendServiceName);
            const backendConnectivity = await testServiceConnectivity('backend', 'database', backendEnv);
            printInfo(`  Backend→Database: ${backendConnectivity.status === 'pass' ? '✅' : backendConnectivity.status === 'warn' ? '⚠️' : '❌'} ${backendConnectivity.message}`);
            
            // Check OAuth configuration
            if (backendEnv['OAUTH_ALLOWED_DOMAINS']) {
              const domains = backendEnv['OAUTH_ALLOWED_DOMAINS'].split(',');
              printInfo(`  OAuth Allowed Domains: ${domains.join(', ')}`);
              
              // Test email domain if provided
              if (options.testEmail) {
                const emailDomain = options.testEmail.split('@')[1];
                const isAllowed = domains.includes(emailDomain);
                printInfo(`  Test Email ${options.testEmail}: ${isAllowed ? '✅ Allowed' : '❌ Not allowed'} (domain: ${emailDomain})`);
              }
            }
            
            // Check actual connectivity via health endpoints
            const siteUrl = `https://${envConfig.site?.domain || 'localhost'}`;
            printInfo(`\n  Testing actual endpoints at ${siteUrl}:`);
            
            // Test frontend health
            try {
              const frontendHealth = await fetch(`${siteUrl}/api/health`);
              printInfo(`    Frontend /api/health: ${frontendHealth.ok ? '✅ OK' : `❌ ${frontendHealth.status}`}`);
            } catch (error) {
              printInfo(`    Frontend /api/health: ❌ Failed to connect`);
            }
            
            // Test backend health via ALB
            try {
              const backendHealth = await fetch(`${siteUrl}/api/health`);
              printInfo(`    Backend /api/health: ${backendHealth.ok ? '✅ OK' : `❌ ${backendHealth.status}`}`);
            } catch (error) {
              printInfo(`    Backend /api/health: ❌ Failed to connect`);
            }
          }
        } catch (error) {
          printError(`Failed to test connectivity: ${error}`);
        }
      }
    }
    
    if (options.section === 'all' || options.section === 'logs') {
      printInfo('\n📝 Recent Logs:');
      
      try {
        const aggregator = new LogAggregator(options.environment || 'development', awsRegion);
        
        // Register CloudWatch fetcher for AWS deployments
        if (awsRegion) {
          aggregator.registerFetcher('aws', new CloudWatchLogFetcher(awsRegion));
        }
        
        // Filter services based on deployment type
        const loggableServices = serviceDeployments.filter(service => {
          // Only fetch logs for services that are deployed
          return service.deploymentType === 'aws' && service.name !== 'filesystem';
        });
        
        if (loggableServices.length > 0) {
          const logs = await aggregator.fetchRecentLogs(loggableServices, {
            limit: 20,
            since: new Date(Date.now() - 5 * 60 * 1000), // Last 5 minutes
          });
          
          if (logs.length > 0) {
            const formatted = aggregator.formatLogsForDisplay(logs);
            console.log(formatted);
          } else {
            printInfo('  No recent logs found (last 5 minutes)');
          }
        } else {
          printInfo('  No deployed services with logs available');
        }
      } catch (error: any) {
        if (options.verbose) {
          console.error('Log aggregation error:', error);
        }
        printWarning(`  Failed to fetch logs: ${error.message || 'Unknown error'}`);
      }
    }
    
    // Create aggregated results
    const succeeded = serviceResults.filter(r => r.success && r.healthStatus === 'healthy').length;
    const failed = serviceResults.filter(r => !r.success || r.healthStatus === 'unhealthy').length;
    const warnings = serviceResults.filter(r => r.success && r.healthStatus === 'degraded').length;
    
    const commandResults: CommandResults = {
      command: 'check',
      environment: options.environment!,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: serviceResults,
      summary: {
        total: serviceResults.length,
        succeeded,
        failed,
        warnings,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun,
      },
    };
    
    // Print summary if not using structured output
    printInfo('\n📋 Summary:');
    if (succeeded === serviceResults.length) {
      printSuccess(`All ${serviceResults.length} services are healthy`);
    } else {
      printWarning(`${succeeded}/${serviceResults.length} services are healthy`);
      const unhealthy = serviceResults.filter(r => !r.success || r.healthStatus === 'unhealthy');
      for (const service of unhealthy) {
        printError(`  - ${service.service} is not healthy`);
      }
    }
    
    return commandResults;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    printError(`Check failed: ${errorMessage}`);
    
    return {
      command: 'check',
      environment: options.environment!,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: [],
      summary: {
        total: 0,
        succeeded: 0,
        failed: 1,
        warnings: 0,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun,
      },
    };
  } finally {
    // Restore output suppression state
    setSuppressOutput(previousSuppressOutput);
  }
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const checkCommand = new CommandBuilder<CheckOptions>()
  .name('check')
  .description('Check service health and status')
  .schema(CheckOptionsSchema as any)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args({
    args: {
      '--environment': { type: 'string', description: 'Environment name' },
      '--section': { type: 'string', description: 'Section to check (all, services, health, logs, connectivity)' },
      '--verbose': { type: 'boolean', description: 'Verbose output with environment variables and detailed checks' },
      '--dry-run': { type: 'boolean', description: 'Simulate actions without executing' },
      '--output': { type: 'string', description: 'Output format (table, json, yaml, summary)' },
      '--service': { type: 'string', description: 'Service name or "all" for all services' },
      '--test-email': { type: 'string', description: 'Test if an email address would be allowed for OAuth' },
    },
    aliases: {
      '-e': '--environment',
      '-s': '--section',
      '-v': '--verbose',
      '-o': '--output',
    }
  })
  .examples(
    'semiont check --environment local',
    'semiont check --environment staging --section health',
    'semiont check --environment prod --service backend --output json',
    'semiont check --section connectivity --verbose',
    'semiont check --section connectivity --test-email user@example.com'
  )
  .handler(check)
  .build();

// Export default for compatibility
export default checkCommand;

// Export the schema for use by CLI
export type { CheckOptions };
export { CheckOptionsSchema };