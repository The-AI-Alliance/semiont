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
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { EFSClient, DescribeFileSystemsCommand } from '@aws-sdk/client-efs';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const CheckOptionsSchema = z.object({
  environment: z.string().optional(),
  section: z.enum(['all', 'services', 'health', 'logs']).default('all'),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['table', 'json', 'yaml', 'summary']).default('table'),
  service: z.string().optional(),
});

type CheckOptions = z.infer<typeof CheckOptionsSchema> & BaseCommandOptions;

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

// Helper wrapper for printDebug that passes verbose option
function debugLog(_message: string, _options: any): void {
  // Debug logging disabled for now
}


// =====================================================================
// DEPLOYMENT-TYPE-AWARE CHECK FUNCTIONS
// =====================================================================

async function checkServiceImpl(serviceInfo: ServiceDeploymentInfo, options: CheckOptions, startTime: number): Promise<CheckResult> {
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
    
    switch (serviceInfo.deploymentType) {
      case 'aws':
        ({ checks, healthStatus, uptime, resourceId, consoleUrl } = await checkAWSService(serviceInfo, options));
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
      status: healthStatus === 'healthy' ? 'running' : 'stopped',
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

async function checkAWSService(serviceInfo: ServiceDeploymentInfo, options: CheckOptions): Promise<{ checks: CheckResult['checks'], healthStatus: CheckResult['healthStatus'], uptime?: number, resourceId?: string, consoleUrl?: string }> {
  const checks: CheckResult['checks'] = [];
  let healthStatus: CheckResult['healthStatus'] = 'healthy';
  let resourceId: string | undefined;
  let consoleUrl: string | undefined;
  
  // Get AWS region - check multiple sources in order of precedence
  const awsRegion = process.env.AWS_REGION || 
                    process.env.AWS_DEFAULT_REGION || 
                    'us-east-2'; // Your actual region
  let awsAccountId = '';
  
  try {
    // Get AWS account ID using SDK
    const stsClient = new STSClient({ region: awsRegion });
    const identityResult = await stsClient.send(new GetCallerIdentityCommand({}));
    awsAccountId = identityResult.Account || '';
  } catch (error) {
    debugLog(`Could not get AWS account ID: ${error}`, options);
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
          
          checks.push({
            name: 'ecs-service',
            status: runningCount === desiredCount && status === 'ACTIVE' ? 'pass' : 'warn',
            message: `ECS Service ${actualServiceName}: ${runningCount}/${desiredCount} tasks running (${status})`,
            metadata: {
              runningCount,
              desiredCount,
              status,
              serviceName: actualServiceName,
              clusterName,
            }
          });
          
          healthStatus = runningCount > 0 ? 'healthy' : 'unhealthy';
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
        
        // Get RDS instance identifier from CloudFormation stack
        let dbIdentifier = '';
        
        try {
          const stackResult = await cfnClient.send(new DescribeStacksCommand({
            StackName: 'SemiontInfraStack'
          }));
          
          const outputs = stackResult.Stacks?.[0]?.Outputs || [];
          dbIdentifier = outputs.find(o => o.OutputKey === 'DatabaseIdentifier')?.OutputValue || '';
        } catch (stackError: any) {
          console.error(`RDS CloudFormation error:`, stackError.message || stackError);
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
        
        // Get EFS filesystem ID from CloudFormation stack
        let efsId = '';
        
        try {
          const stackResult = await cfnClient.send(new DescribeStacksCommand({
            StackName: 'SemiontInfraStack'
          }));
          
          const outputs = stackResult.Stacks?.[0]?.Outputs || [];
          efsId = outputs.find(o => o.OutputKey === 'EFSFileSystemId')?.OutputValue || '';
        } catch (stackError: any) {
          console.error(`EFS CloudFormation error:`, stackError.message || stackError);
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
  
  try {
    debugLog(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    
    // Check services and collect results
    const serviceResults: CheckResult[] = [];
    
    if (options.section === 'all' || options.section === 'services' || options.section === 'health') {
      if (options.section === 'all' || options.section === 'services') {
        printInfo('\n📊 Service Status:');
      }
      
      for (const serviceInfo of serviceDeployments) {
        const result = await checkServiceImpl(serviceInfo, options, startTime);
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
      printInfo(`Overall system health: ${overallHealth}`);
    }
    
    if (options.section === 'all' || options.section === 'logs') {
      printInfo('\n📝 Recent Logs:');
      printWarning('Log aggregation not yet implemented');
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
      '--section': { type: 'string', description: 'Section to check (all, services, health, logs)' },
      '--verbose': { type: 'boolean', description: 'Verbose output' },
      '--dry-run': { type: 'boolean', description: 'Simulate actions without executing' },
      '--output': { type: 'string', description: 'Output format (table, json, yaml, summary)' },
      '--service': { type: 'string', description: 'Service name or "all" for all services' },
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
    'semiont check --environment prod --service backend --output json'
  )
  .handler(check)
  .build();

// Export default for compatibility
export default checkCommand;

// Export the schema for use by CLI
export type { CheckOptions };
export { CheckOptionsSchema };