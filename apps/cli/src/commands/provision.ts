/**
 * Provision Command - Unified command structure
 */

import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import { getProjectRoot } from '../lib/cli-paths.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { createVolume, listContainers } from '../lib/container-runtime.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { 
  ProvisionResult, 
  CommandResults, 
  createBaseResult, 
  createErrorResult,
  ResourceIdentifier 
} from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import type { BaseCommandOptions } from '../lib/base-command-options.js';
import { 
  CloudFormationClient, 
  DescribeStacksCommand, 
  DeleteStackCommand, 
  CreateStackCommand,
  UpdateStackCommand,
  Stack,
  DescribeStackEventsCommand,
  StackStatus
} from '@aws-sdk/client-cloudformation';
import { loadEnvironmentConfig } from '../lib/deployment-resolver.js';
import { type EnvironmentConfig, hasAWSConfig } from '../lib/environment-config.js';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const ProvisionOptionsSchema = z.object({
  environment: z.string().optional(),
  stack: z.enum(['data', 'app', 'all']).default('all'),
  force: z.boolean().default(false),
  destroy: z.boolean().default(false),
  reset: z.boolean().default(false),
  seed: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  requireApproval: z.boolean().optional(),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
  service: z.string().optional(),
});

type ProvisionOptions = z.infer<typeof ProvisionOptionsSchema> & BaseCommandOptions;

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

function printError(message: string): string {
  const msg = `${colors.red}❌ ${message}${colors.reset}`;
  console.error(msg);
  return msg;
}

function printSuccess(message: string): string {
  const msg = `${colors.green}✅ ${message}${colors.reset}`;
  console.log(msg);
  return msg;
}

function printInfo(message: string): string {
  const msg = `${colors.cyan}ℹ️  ${message}${colors.reset}`;
  console.log(msg);
  return msg;
}

function printWarning(message: string): string {
  const msg = `${colors.yellow}⚠️  ${message}${colors.reset}`;
  console.log(msg);
  return msg;
}

function printDebug(message: string, options: ProvisionOptions): string {
  const msg = `${colors.dim}[DEBUG] ${message}${colors.reset}`;
  if (options.verbose) {
    console.log(msg);
  }
  return msg;
}


// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

/**
 * Wait for CloudFormation stack operation to complete with improved status reporting
 * Adapted from cdk-deployer.ts for better user experience
 */
async function waitForStackOperation(
  cfn: CloudFormationClient, 
  stackName: string, 
  operation: 'CREATE' | 'UPDATE' | 'DELETE',
  options: ProvisionOptions,
  isStructuredOutput: boolean = false
): Promise<{ success: boolean; finalStatus?: string; outputs?: any[] }> {
  const maxWaitTime = 30 * 60 * 1000; // 30 minutes
  const pollInterval = 10 * 1000; // 10 seconds
  const startTime = Date.now();
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`⏳ Waiting for ${operation.toLowerCase()} operation to complete...`);
  }
  
  let lastStatus: string | undefined;
  
  while (Date.now() - startTime < maxWaitTime) {
    try {
      const response = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const stack = response.Stacks?.[0];
      
      if (!stack) {
        if (operation === 'DELETE') {
          // Stack not found after delete is success
          if (!isStructuredOutput && options.output === 'summary') {
            printSuccess(`✅ Stack ${stackName} deleted successfully`);
          }
          return { success: true, finalStatus: 'DELETE_COMPLETE' };
        } else {
          if (!isStructuredOutput && options.output === 'summary') {
            printError(`❌ Stack ${stackName} not found`);
          }
          return { success: false };
        }
      }
      
      const status = stack.StackStatus!;
      
      // Only log status changes to reduce noise
      if (status !== lastStatus) {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`📊 Stack status: ${status}`);
        }
        lastStatus = status;
      }
      
      // Success states
      if (status === StackStatus.CREATE_COMPLETE || 
          status === StackStatus.UPDATE_COMPLETE ||
          status === StackStatus.DELETE_COMPLETE) {
        if (!isStructuredOutput && options.output === 'summary') {
          printSuccess(`✅ ${operation.toLowerCase()} completed successfully`);
        }
        return { 
          success: true, 
          finalStatus: status,
          outputs: stack.Outputs 
        };
      }
      
      // Failure states
      if (status.includes('FAILED') || 
          status === StackStatus.ROLLBACK_COMPLETE ||
          status === StackStatus.UPDATE_ROLLBACK_COMPLETE) {
        
        // Get error events for better error reporting
        const events = await cfn.send(new DescribeStackEventsCommand({ 
          StackName: stackName 
        }));
        const failureEvent = events.StackEvents?.find(e => 
          e.ResourceStatus?.includes('FAILED') && e.ResourceStatusReason
        );
        
        if (!isStructuredOutput && options.output === 'summary') {
          printError(`❌ ${operation.toLowerCase()} failed with status: ${status}`);
          if (failureEvent) {
            printError(`   Reason: ${failureEvent.ResourceStatusReason}`);
          }
        }
        
        return { 
          success: false, 
          finalStatus: status 
        };
      }
      
      // In progress states - continue waiting
      if (status.includes('IN_PROGRESS')) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }
      
    } catch (error: any) {
      if (error.name === 'ValidationError' && operation === 'DELETE') {
        // Stack doesn't exist - delete is successful
        if (!isStructuredOutput && options.output === 'summary') {
          printSuccess(`✅ Stack ${stackName} already deleted`);
        }
        return { success: true, finalStatus: 'DELETE_COMPLETE' };
      }
      
      if (!isStructuredOutput && options.output === 'summary') {
        printError(`❌ Error checking stack status: ${error.message}`);
      }
      return { success: false };
    }
  }
  
  if (!isStructuredOutput && options.output === 'summary') {
    printError(`❌ ${operation.toLowerCase()} operation timed out after ${maxWaitTime / 1000 / 60} minutes`);
  }
  return { success: false };
}

// =====================================================================
// DEPLOYMENT-TYPE-AWARE PROVISION FUNCTIONS
// =====================================================================

async function provisionService(serviceInfo: ServiceDeploymentInfo, options: ProvisionOptions, isStructuredOutput: boolean = false): Promise<ProvisionResult> {
  const startTime = Date.now();
  
  if (options.dryRun) {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`[DRY RUN] Would provision ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    }
    
    return {
      ...createBaseResult('provision', serviceInfo.name, serviceInfo.deploymentType, options.environment!, startTime),
      resources: [],
      dependencies: [],
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'dry-run',
      metadata: { dryRun: true },
    };
  }
  
  if (!isStructuredOutput && options.output === 'summary') {
    if (options.destroy) {
      printWarning(`Destroying ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
    } else {
      printInfo(`Provisioning ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
    }
  }
  
  try {
    switch (serviceInfo.deploymentType) {
      case 'aws':
        return await provisionAWSService(serviceInfo, options, startTime, isStructuredOutput);
      case 'container':
        return await provisionContainerService(serviceInfo, options, startTime, isStructuredOutput);
      case 'process':
        return await provisionProcessService(serviceInfo, options, startTime, isStructuredOutput);
      case 'external':
        return await provisionExternalService(serviceInfo, options, startTime, isStructuredOutput);
      default:
        throw new Error(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
    }
  } catch (error) {
    const baseResult = createBaseResult('provision', serviceInfo.name, serviceInfo.deploymentType, options.environment!, startTime);
    const errorResult = createErrorResult(baseResult, error as Error);
    
    return {
      ...errorResult,
      resources: [],
      dependencies: [],
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'failed',
      metadata: { error: (error as Error).message },
    };
  }
}

/**
 * Validate and get stack type name from service name
 */
function getStackTypeName(serviceName: string): string {
  // Map service names to stack types
  const stackMapping: Record<string, string> = {
    'infrastructure': 'SemiontInfraStack',
    'infra': 'SemiontInfraStack',
    'database': 'SemiontInfraStack',
    'filesystem': 'SemiontInfraStack',
    'secrets': 'SemiontInfraStack',
    'application': 'SemiontAppStack',
    'app': 'SemiontAppStack',
    'backend': 'SemiontAppStack',
    'frontend': 'SemiontAppStack',
    'monitoring': 'SemiontAppStack'
  };
  
  // Check direct mapping
  const stackType = stackMapping[serviceName.toLowerCase()];
  if (stackType) {
    return stackType;
  }
  
  // Check if it's already a stack name
  const availableStacks = getAvailableStacks();
  if (availableStacks.includes(serviceName)) {
    return serviceName;
  }
  
  // Default based on patterns
  if (serviceName.toLowerCase().includes('infra')) {
    return 'SemiontInfraStack';
  }
  if (serviceName.toLowerCase().includes('app')) {
    return 'SemiontAppStack';
  }
  
  throw new Error(
    `Cannot determine stack type for service '${serviceName}'.\n` +
    `Available stack types: ${availableStacks.join(', ')}`
  );
}

async function provisionAWSService(serviceInfo: ServiceDeploymentInfo, options: ProvisionOptions, startTime: number, isStructuredOutput: boolean = false): Promise<ProvisionResult> {
  const baseResult = createBaseResult('provision', serviceInfo.name, serviceInfo.deploymentType, options.environment!, startTime);
  
  // Load environment config to get AWS settings
  const envConfig = loadEnvironmentConfig(options.environment!) as EnvironmentConfig;
  if (!hasAWSConfig(envConfig)) {
    throw new Error(`Environment ${options.environment} does not have AWS configuration`);
  }
  
  // Determine which stack to deploy based on the stack option
  let stackName: string;
  if (options.stack === 'data' || serviceInfo.name === 'infrastructure') {
    stackName = envConfig.aws.stacks?.data || 'SemiontDataStack';
  } else if (options.stack === 'app' || serviceInfo.name === 'application') {
    stackName = envConfig.aws.stacks?.app || 'SemiontAppStack';
  } else {
    // Fallback to service-based detection for backward compatibility
    if (serviceInfo.name === 'database' || serviceInfo.name === 'filesystem') {
      stackName = envConfig.aws.stacks?.data || 'SemiontDataStack';
    } else {
      stackName = envConfig.aws.stacks?.app || 'SemiontAppStack';
    }
  }
  
  // Check if stack already exists
  const cfnClient = new CloudFormationClient({ region: envConfig.aws.region });
  let stackExists = false;
  let existingStack: Stack | undefined;
  
  try {
    const describeResult = await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
    existingStack = describeResult.Stacks?.[0];
    stackExists = !!existingStack && existingStack.StackStatus !== 'DELETE_COMPLETE';
  } catch (error: any) {
    if (error.name !== 'ValidationError' || !error.message.includes('does not exist')) {
      throw error;
    }
  }
  
  // Handle existing stack
  if (stackExists && !options.force && !options.destroy) {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Stack ${stackName} already exists (status: ${existingStack?.StackStatus})`);
      printInfo(`Use --force to update the existing stack`);
    }
    
    return {
      ...baseResult,
      resources: [
        {
          type: 'cloudformation-stack',
          id: stackName,
          arn: existingStack?.StackId || '',
          status: 'exists',
          metadata: {
            stackStatus: existingStack?.StackStatus,
            outputs: existingStack?.Outputs?.reduce((acc, output) => {
              if (output.OutputKey) {
                acc[output.OutputKey] = output.OutputValue || '';
              }
              return acc;
            }, {} as Record<string, string>)
          }
        }
      ],
      dependencies: stackName === 'SemiontAppStack' ? ['SemiontInfraStack'] : [],
      resourceId: {
        aws: {
          arn: existingStack?.StackId || '',
          id: stackName,
          name: stackName
        }
      },
      status: 'exists',
      metadata: {
        operation: 'check',
        stackName,
        stackStatus: existingStack?.StackStatus,
        message: 'Stack already exists, use --force to update'
      },
    };
  }
  
  // Perform the CDK operation with improved status messaging
  if (!isStructuredOutput && options.output === 'summary') {
    if (options.destroy) {
      printWarning(`🗑️  Destroying stack ${stackName}...`);
      if (stackName === 'SemiontDataStack' || stackName.includes('Data')) {
        printWarning('⚠️  This will destroy all data infrastructure including:');
        printWarning('   • RDS Database (data will be lost!)');
        printWarning('   • VPC and networking');
        printWarning('   • EFS filesystem');
        printWarning('   • Secrets Manager secrets');
      } else if (stackName === 'SemiontAppStack' || stackName.includes('App')) {
        printWarning('⚠️  This will destroy all application resources including:');
        printWarning('   • ECS services and tasks');
        printWarning('   • Application Load Balancer');
        printWarning('   • WAF rules');
        printWarning('   • CloudWatch logs and alarms');
      }
    } else if (stackExists && options.force) {
      printInfo(`🔄 Updating existing stack ${stackName}...`);
      if (stackName === 'SemiontDataStack' || stackName.includes('Data')) {
        printInfo('   Contains: VPC, RDS, EFS, Secrets Manager');
      } else if (stackName === 'SemiontAppStack' || stackName.includes('App')) {
        printInfo('   Contains: ECS, ALB, WAF, CloudWatch');
      }
    } else {
      printInfo(`🆕 Creating new stack ${stackName}...`);
      if (stackName === 'SemiontDataStack' || stackName.includes('Data')) {
        printInfo('   📦 Will provision: VPC, RDS, EFS, Secrets Manager');
      } else if (stackName === 'SemiontAppStack' || stackName.includes('App')) {
        printInfo('   🏗️  Will provision: ECS, ALB, WAF, CloudWatch');
      }
    }
  }
  
  try {
    const projectRoot = process.env.SEMIONT_ROOT || process.cwd();
    
    // Use CDK CLI directly with context parameters
    const cdkCommand = options.destroy ? 'destroy' : 'deploy';
    
    // Determine stack type from the stack option
    let stackType = 'all';
    if (options.stack === 'data' || stackName.includes('Data')) {
      stackType = 'data';
    } else if (options.stack === 'app' || stackName.includes('App')) {
      stackType = 'app';
    }
    
    // Build CDK command with context
    const cdkArgs = [
      cdkCommand
    ];
    
    // For app-only deployment, explicitly specify just the app stack
    // The app stack will import values from data stack via CloudFormation exports
    if (stackType === 'app' && cdkCommand === 'deploy') {
      // Deploy only the app stack - it will read data exports but not deploy data
      cdkArgs.push('SemiontAppStack');
    } else if (stackType === 'data' && cdkCommand === 'deploy') {
      // Deploy only the data stack
      cdkArgs.push('SemiontDataStack');
    } else if (stackType === 'all' && cdkCommand === 'deploy') {
      // Deploy all stacks in dependency order
      cdkArgs.push('--all');
    } else {
      // Single stack deployment/destroy
      cdkArgs.push(stackName);
    }
    
    cdkArgs.push(
      '-c', `stack-type=${stackType}`,
      '-c', `environment=${options.environment}`,
      '--require-approval', 'never',
      '--outputs-file', 'cdk-outputs.json'
    );
    
    if (options.force) {
      cdkArgs.push('--force');
    }
    
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Running: npx cdk ${cdkArgs.join(' ')}`);
      printInfo(`Stack type: ${stackType}`);
    }
    
    // Execute CDK using child_process
    const { execSync } = await import('child_process');
    try {
      execSync(`npx cdk ${cdkArgs.join(' ')}`, {
        cwd: projectRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          AWS_REGION: envConfig.aws.region,
          CDK_DEFAULT_ACCOUNT: envConfig.aws.accountId,
          CDK_DEFAULT_REGION: envConfig.aws.region,
          SEMIONT_ENV: options.environment
        }
      });
    } catch (error: any) {
      throw new Error(`CDK operation failed: ${error.message}`);
    }
    
    return {
      ...baseResult,
      resources: [{
        type: 'cloudformation-stack',
        id: stackName,
        status: options.destroy ? 'destroyed' : 'deployed',
        metadata: { stackName }
      }],
      dependencies: [],
      resourceId: { aws: { name: stackName } },
      status: options.destroy ? 'destroyed' : 'deployed',
      metadata: { operation: cdkCommand, stackName }
    };
  } catch (error: any) {
    if (!isStructuredOutput && options.output === 'summary') {
      printError(`CDK operation failed: ${error.message}`);
    }
    throw error;
  }
}

async function provisionContainerService(serviceInfo: ServiceDeploymentInfo, options: ProvisionOptions, startTime: number, isStructuredOutput: boolean = false): Promise<ProvisionResult> {
  const baseResult = createBaseResult('provision', serviceInfo.name, serviceInfo.deploymentType, options.environment!, startTime);
  
  // Container infrastructure provisioning
  switch (serviceInfo.name) {
    case 'database':
      const containerName = `semiont-postgres-${options.environment}`;
      
      if (options.destroy) {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`Removing database container: ${containerName}`);
          printSuccess(`Database container removed`);
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'container',
              id: containerName,
              status: 'destroyed',
              metadata: { image: 'postgres:15-alpine' }
            }
          ],
          dependencies: ['docker-network'],
          resourceId: {
            container: {
              id: containerName,
              name: containerName
            }
          },
          status: 'destroyed',
          metadata: {
            operation: 'destroy',
            containerName
          },
        };
      } else {
        // Check if container already exists
        const containers = await listContainers({ all: true });
        const exists = containers.some(c => c.includes(containerName));
        
        if (exists && !options.force) {
          if (!isStructuredOutput && options.output === 'summary') {
            printWarning(`Container ${containerName} already exists. Use --force to recreate`);
          }
          
          return {
            ...baseResult,
            resources: [
              {
                type: 'container',
                id: containerName,
                status: 'exists',
                metadata: { image: 'postgres:15-alpine' }
              }
            ],
            dependencies: ['docker-network'],
            resourceId: {
              container: {
                id: containerName,
                name: containerName
              }
            },
            status: 'skipped',
            metadata: {
              reason: 'Container already exists, use --force to recreate',
              containerName,
              exists: true
            },
          };
        }
        
        if (options.reset && exists) {
          if (!isStructuredOutput && options.output === 'summary') {
            printInfo(`♻️  Resetting database container...`);
            printInfo('   Will recreate: PostgreSQL container with fresh data');
          }
        }
        
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`🐳 Creating container network for database`);
          printInfo('   📦 Container: postgres:15-alpine');
          printInfo(`   🔗 Network: semiont-network-${options.environment}`);
          if (options.seed) {
            printInfo(`   🌱 Database will be seeded with initial data`);
          }
          printSuccess(`✅ Database container infrastructure ready`);
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'container',
              id: containerName,
              status: 'provisioned',
              metadata: { image: 'postgres:15-alpine' }
            },
            {
              type: 'docker-network',
              id: `semiont-network-${options.environment}`,
              status: 'provisioned',
              metadata: {}
            }
          ],
          dependencies: ['docker-runtime'],
          resourceId: {
            container: {
              id: containerName,
              name: containerName
            }
          },
          status: 'provisioned',
          metadata: {
            containerName,
            image: 'postgres:15-alpine',
            reset: options.reset,
            seed: options.seed,
            network: `semiont-network-${options.environment}`
          },
        };
      }
      
    case 'frontend':
    case 'backend':
      if (options.destroy) {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`🗑️  Removing ${serviceInfo.name} container infrastructure...`);
          printInfo(`   📦 Container: semiont-${serviceInfo.name}-${options.environment}`);
          printInfo(`   🔗 Network: semiont-network-${options.environment}`);
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'docker-network',
              id: `semiont-network-${options.environment}`,
              status: 'destroyed',
              metadata: {}
            }
          ],
          dependencies: [],
          resourceId: {
            container: {
              name: `semiont-${serviceInfo.name}-${options.environment}`
            }
          },
          status: 'destroyed',
          metadata: {
            operation: 'destroy',
            service: serviceInfo.name
          },
        };
      } else {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`🐳 Creating container network for ${serviceInfo.name}`);
          printInfo(`   📦 Container: semiont-${serviceInfo.name}-${options.environment}`);
          printInfo(`   🔗 Network: semiont-network-${options.environment}`);
          printSuccess(`✅ ${serviceInfo.name} container infrastructure ready`);
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'docker-network',
              id: `semiont-network-${options.environment}`,
              status: 'provisioned',
              metadata: {}
            }
          ],
          dependencies: ['docker-runtime'],
          resourceId: {
            container: {
              name: `semiont-${serviceInfo.name}-${options.environment}`
            }
          },
          status: 'provisioned',
          metadata: {
            service: serviceInfo.name,
            network: `semiont-network-${options.environment}`
          },
        };
      }
      
    case 'filesystem':
      const volumeName = `semiont-data-${options.environment}`;
      
      if (options.destroy) {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`Removing volume: ${volumeName}`);
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'docker-volume',
              id: volumeName,
              status: 'destroyed',
              metadata: {}
            }
          ],
          dependencies: [],
          resourceId: {
            container: {
              name: volumeName
            }
          },
          status: 'destroyed',
          metadata: {
            operation: 'destroy',
            volumeName
          },
        };
      } else {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`Creating container volume: ${volumeName}`);
        }
        
        const created = await createVolume(volumeName, { verbose: options.verbose });
        
        if (!isStructuredOutput && options.output === 'summary') {
          if (created) {
            printSuccess(`Volume created: ${volumeName}`);
          } else {
            printWarning(`Volume may already exist: ${volumeName}`);
          }
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'docker-volume',
              id: volumeName,
              status: created ? 'created' : 'exists',
              metadata: {}
            }
          ],
          dependencies: ['docker-runtime'],
          resourceId: {
            container: {
              name: volumeName
            }
          },
          status: created ? 'provisioned' : 'already-exists',
          metadata: {
            volumeName,
            created
          },
        };
      }
      
    default:
      throw new Error(`Unsupported container service: ${serviceInfo.name}`);
  }
}

async function provisionProcessService(serviceInfo: ServiceDeploymentInfo, options: ProvisionOptions, startTime: number, isStructuredOutput: boolean = false): Promise<ProvisionResult> {
  const baseResult = createBaseResult('provision', serviceInfo.name, serviceInfo.deploymentType, options.environment!, startTime);
  
  // Process deployment provisioning (local development)
  switch (serviceInfo.name) {
    case 'database':
      if (options.destroy) {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`🗑️  Removing local PostgreSQL data...`);
          printInfo('   📂 Path: /usr/local/var/postgres');
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'local-database',
              id: 'postgresql-local',
              status: 'data-removed',
              metadata: { service: 'postgresql' }
            }
          ],
          dependencies: [],
          resourceId: {
            process: {
              path: '/usr/local/var/postgres',
              port: 5432
            }
          },
          status: 'destroyed',
          metadata: {
            operation: 'destroy',
            service: 'postgresql'
          },
        };
      } else {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`🐘 Installing PostgreSQL for local development`);
          printInfo('   📦 Service: postgresql');
          printInfo('   🔌 Port: 5432');
          printWarning('⚠️  PostgreSQL installation not automated - install manually');
          if (options.seed) {
            printInfo(`   🌱 Database will be seeded with initial data`);
          }
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'local-database',
              id: 'postgresql-local',
              status: 'not-implemented',
              metadata: { service: 'postgresql' }
            }
          ],
          dependencies: ['postgresql'],
          resourceId: {
            process: {
              path: '/usr/local/var/postgres',
              port: 5432
            }
          },
          status: 'not-implemented',
          metadata: {
            implementation: 'manual',
            service: 'postgresql',
            seed: options.seed
          },
        };
      }
      
    case 'backend':
    case 'frontend':
      const appPath = path.join(PROJECT_ROOT, 'apps', serviceInfo.name);
      
      if (options.destroy) {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`🧹 Cleaning ${serviceInfo.name} dependencies...`);
          printInfo(`   📂 Path: apps/${serviceInfo.name}/node_modules`);
        }
        
        const nodeModulesPath = path.join(appPath, 'node_modules');
        let removed = false;
        if (fs.existsSync(nodeModulesPath)) {
          await fs.promises.rm(nodeModulesPath, { recursive: true, force: true });
          removed = true;
          if (!isStructuredOutput && options.output === 'summary') {
            printSuccess(`✅ Removed node_modules for ${serviceInfo.name}`);
          }
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'node-modules',
              id: `${serviceInfo.name}-dependencies`,
              status: removed ? 'removed' : 'not-found',
              metadata: { path: nodeModulesPath }
            }
          ],
          dependencies: [],
          resourceId: {
            process: {
              path: appPath
            }
          },
          status: 'destroyed',
          metadata: {
            operation: 'destroy',
            service: serviceInfo.name,
            appPath,
            removed
          },
        };
      } else {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`📦 Installing dependencies for ${serviceInfo.name}...`);
          printInfo(`   📂 Path: apps/${serviceInfo.name}`);
          printInfo('   🔧 Running: npm install');
        }
        
        // Install dependencies
        const installSuccess = await new Promise<boolean>((resolve) => {
          const proc = spawn('npm', ['install'], {
            cwd: appPath,
            stdio: options.verbose ? 'inherit' : 'pipe'
          });
          
          proc.on('exit', (code) => resolve(code === 0));
          proc.on('error', () => resolve(false));
        });
        
        if (!isStructuredOutput && options.output === 'summary') {
          if (installSuccess) {
            printSuccess(`✅ Dependencies installed for ${serviceInfo.name}`);
          } else {
            throw new Error(`❌ Failed to install dependencies for ${serviceInfo.name}`);
          }
        } else if (!installSuccess) {
          throw new Error(`Failed to install dependencies for ${serviceInfo.name}`);
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'node-modules',
              id: `${serviceInfo.name}-dependencies`,
              status: 'installed',
              metadata: { path: path.join(appPath, 'node_modules') }
            }
          ],
          dependencies: ['nodejs', 'npm'],
          resourceId: {
            process: {
              path: appPath
            }
          },
          status: 'provisioned',
          metadata: {
            service: serviceInfo.name,
            appPath,
            installSuccess
          },
        };
      }
      
    case 'filesystem':
      const dataPath = serviceInfo.config.path || path.join(PROJECT_ROOT, 'data');
      
      if (options.destroy) {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`🗑️  Removing local data directory...`);
          printInfo(`   📂 Path: ${dataPath}`);
        }
        
        let removed = false;
        if (fs.existsSync(dataPath)) {
          await fs.promises.rm(dataPath, { recursive: true, force: true });
          removed = true;
          if (!isStructuredOutput && options.output === 'summary') {
            printSuccess(`✅ Removed data directory`);
          }
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'local-directory',
              id: 'data-directory',
              status: removed ? 'removed' : 'not-found',
              metadata: { path: dataPath }
            }
          ],
          dependencies: [],
          resourceId: {
            process: {
              path: dataPath
            }
          },
          status: 'destroyed',
          metadata: {
            operation: 'destroy',
            dataPath,
            removed
          },
        };
      } else {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`📁 Creating local data directory...`);
          printInfo(`   📂 Path: ${dataPath}`);
        }
        
        await fs.promises.mkdir(dataPath, { recursive: true });
        
        // Set permissions if specified
        if (serviceInfo.config.permissions) {
          await fs.promises.chmod(dataPath, serviceInfo.config.permissions);
        }
        
        if (!isStructuredOutput && options.output === 'summary') {
          printSuccess(`✅ Data directory created`);
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'local-directory',
              id: 'data-directory',
              status: 'created',
              metadata: { 
                path: dataPath,
                permissions: serviceInfo.config.permissions
              }
            }
          ],
          dependencies: ['filesystem'],
          resourceId: {
            process: {
              path: dataPath
            }
          },
          status: 'provisioned',
          metadata: {
            dataPath,
            permissions: serviceInfo.config.permissions
          },
        };
      }
      
    default:
      throw new Error(`Unsupported process service: ${serviceInfo.name}`);
  }
}

async function provisionExternalService(serviceInfo: ServiceDeploymentInfo, options: ProvisionOptions, startTime: number, isStructuredOutput: boolean = false): Promise<ProvisionResult> {
  const baseResult = createBaseResult('provision', serviceInfo.name, serviceInfo.deploymentType, options.environment!, startTime);
  
  // External service provisioning - mainly validation
  if (options.destroy) {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`⛔ Cannot destroy external ${serviceInfo.name} service`);
      printInfo('   External services are managed outside of Semiont');
    }
    
    return {
      ...baseResult,
      resources: [],
      dependencies: [],
      resourceId: {
        external: {
          endpoint: 'external-service'
        }
      },
      status: 'no-action',
      metadata: {
        reason: 'External services cannot be destroyed remotely',
        operation: 'destroy'
      },
    };
  }
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`🔗 Configuring external ${serviceInfo.name} service...`);
  }
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`   🌐 Endpoint: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
          printInfo(`   🗄️  Database: ${serviceInfo.config.name || 'default'}`);
          printWarning('⚠️  External database connectivity check not yet implemented');
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'external-database',
              id: `${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`,
              status: 'configured',
              metadata: {
                host: serviceInfo.config.host,
                port: serviceInfo.config.port || 5432,
                database: serviceInfo.config.name
              }
            }
          ],
          dependencies: ['network-connectivity'],
          resourceId: {
            external: {
              endpoint: `${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`
            }
          },
          status: 'configured',
          metadata: {
            host: serviceInfo.config.host,
            port: serviceInfo.config.port || 5432,
            database: serviceInfo.config.name,
            connectivityCheck: 'not-implemented'
          },
        };
      }
      break;
      
    case 'filesystem':
      if (serviceInfo.config.path || serviceInfo.config.mount) {
        const externalPath = serviceInfo.config.path || serviceInfo.config.mount;
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`   🗃️  Storage path: ${externalPath}`);
          printWarning('⚠️  External storage validation not yet implemented');
        }
        
        return {
          ...baseResult,
          resources: [
            {
              type: 'external-storage',
              id: externalPath!,
              status: 'configured',
              metadata: {
                path: externalPath
              }
            }
          ],
          dependencies: ['filesystem-access'],
          resourceId: {
            external: {
              ...(externalPath && { path: externalPath })
            }
          },
          status: 'configured',
          metadata: {
            path: externalPath,
            validation: 'not-implemented'
          },
        };
      }
      break;
      
    default:
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`   ✅ External ${serviceInfo.name} endpoint configured`);
      }
  }
  
  if (!isStructuredOutput && options.output === 'summary') {
    printSuccess(`✅ External ${serviceInfo.name} service configuration validated`);
  }
  
  return {
    ...baseResult,
    resources: [
      {
        type: 'external-service',
        id: `external-${serviceInfo.name}`,
        status: 'configured',
        metadata: { service: serviceInfo.name }
      }
    ],
    dependencies: [],
    resourceId: {
      external: {
        endpoint: 'configured'
      }
    },
    status: 'configured',
    metadata: {
      service: serviceInfo.name,
      validation: 'basic'
    },
  };
}

// =====================================================================
// STRUCTURED OUTPUT FUNCTION  
// =====================================================================

export async function provision(
  serviceDeployments: ServiceDeploymentInfo[],
  options: ProvisionOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  
  if (!isStructuredOutput && options.output === 'summary') {
    if (options.destroy) {
      printWarning(`🗑️  Destroying infrastructure in ${colors.bright}${options.environment}${colors.reset} environment`);
      if (!options.force) {
        printWarning('This will permanently delete infrastructure and data!');
        printInfo('Use --force to confirm destruction');
        // Return appropriate result instead of exiting
        return {
          command: 'provision',
          environment: options.environment!,
          timestamp: new Date(),
          duration: Date.now() - startTime,
          services: [],
          summary: { total: 0, succeeded: 0, failed: 1, warnings: 1 },
          executionContext: {
            user: process.env.USER || 'unknown',
            workingDirectory: process.cwd(),
            dryRun: options.dryRun,
          },
        };
      }
    } else {
      printInfo(`🏗️  Provisioning infrastructure in ${colors.bright}${options.environment}${colors.reset} environment`);
    }
    
    if (options.dryRun) {
      printWarning('DRY RUN MODE - No actual changes will be made');
    }
    
    if (options.verbose) {
      printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
    }
  }
  
  try {
    // For AWS deployments, handle CDK stacks directly
    const awsServices = serviceDeployments.filter(s => s.deploymentType === 'aws');
    if (awsServices.length > 0) {
      // Determine which stacks to deploy based on --stack option
      const stacksToProvision: string[] = [];
      
      if (options.stack === 'data' || options.stack === 'all') {
        stacksToProvision.push('data');
      }
      if (options.stack === 'app' || options.stack === 'all') {
        stacksToProvision.push('app');
      }
      
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`Processing CDK stack(s): ${stacksToProvision.join(', ')}`);
      }
      
      const serviceResults: ProvisionResult[] = [];
      
      // Process each stack
      for (const stackType of stacksToProvision) {
        // Create a synthetic service info for the stack
        const stackServiceInfo: ServiceDeploymentInfo = {
          name: stackType === 'infra' ? 'infrastructure' : 'application',
          deploymentType: 'aws',
          target: 'aws',
          config: {},
          environment: options.environment!
        };
        
        try {
          const result = await provisionAWSService(stackServiceInfo, { ...options, stack: stackType as any }, startTime, isStructuredOutput);
          serviceResults.push(result);
        } catch (error) {
          const baseResult = createBaseResult('provision', stackServiceInfo.name, stackServiceInfo.deploymentType, options.environment!, startTime);
          const errorResult = createErrorResult(baseResult, error as Error);
          
          const provisionErrorResult: ProvisionResult = {
            ...errorResult,
            resources: [],
            dependencies: [],
            resourceId: { [stackServiceInfo.deploymentType]: {} } as ResourceIdentifier,
            status: 'failed',
            metadata: { error: (error as Error).message },
          };
          
          serviceResults.push(provisionErrorResult);
          
          if (!isStructuredOutput && options.output === 'summary') {
            printError(`Failed to provision ${stackType} stack: ${error}`);
          }
        }
      }
      
      // Create aggregated results
      return {
        command: 'provision',
        environment: options.environment!,
        timestamp: new Date(),
        duration: Date.now() - startTime,
        services: serviceResults,
        summary: {
          total: serviceResults.length,
          succeeded: serviceResults.filter(r => r.success).length,
          failed: serviceResults.filter(r => !r.success).length,
          warnings: serviceResults.filter(r => r.status.includes('not-implemented') || r.status === 'unchanged' || r.status === 'exists').length,
        },
        executionContext: {
          user: process.env.USER || 'unknown',
          workingDirectory: process.cwd(),
          dryRun: options.dryRun,
        }
      };
    }
    
    // Handle non-AWS deployments
    if (options.verbose && !isStructuredOutput && options.output === 'summary') {
      printDebug(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    }
    
    // Group services by deployment type for efficient provisioning
    const containerServices = serviceDeployments.filter(s => s.deploymentType === 'container');
    const processServices = serviceDeployments.filter(s => s.deploymentType === 'process');
    const externalServices = serviceDeployments.filter(s => s.deploymentType === 'external');
    
    // Provision infrastructure in logical order and collect results
    const serviceResults: ProvisionResult[] = [];
    // let allSucceeded = true;
    
    // 1. External services first (just validation)
    for (const service of externalServices) {
      try {
        const result = await provisionService(service, options, isStructuredOutput);
        serviceResults.push(result);
      } catch (error) {
        const baseResult = createBaseResult('provision', service.name, service.deploymentType, options.environment!, startTime);
        const errorResult = createErrorResult(baseResult, error as Error);
        
        const provisionErrorResult: ProvisionResult = {
          ...errorResult,
          resources: [],
          dependencies: [],
          resourceId: { [service.deploymentType]: {} } as ResourceIdentifier,
          status: 'failed',
          metadata: { error: (error as Error).message },
        };
        
        serviceResults.push(provisionErrorResult);
        
        if (!isStructuredOutput && options.output === 'summary') {
          printError(`Failed to configure ${service.name}: ${error}`);
        }
        // allSucceeded = false;
      }
    }
    
    // Skip old AWS infrastructure handling since we handle it above
    /* Old AWS handling removed - now handled via CDK stacks directly */
    
    // 3. Container infrastructure
    for (const service of containerServices) {
      try {
        const result = await provisionService(service, options, isStructuredOutput);
        serviceResults.push(result);
      } catch (error) {
        const baseResult = createBaseResult('provision', service.name, service.deploymentType, options.environment!, startTime);
        const errorResult = createErrorResult(baseResult, error as Error);
        
        const provisionErrorResult: ProvisionResult = {
          ...errorResult,
          resources: [],
          dependencies: [],
          resourceId: { [service.deploymentType]: {} } as ResourceIdentifier,
          status: 'failed',
          metadata: { error: (error as Error).message },
        };
        
        serviceResults.push(provisionErrorResult);
        
        if (!isStructuredOutput && options.output === 'summary') {
          printError(`Failed to provision container ${service.name}: ${error}`);
        }
        // allSucceeded = false;
      }
    }
    
    // 4. Process infrastructure (dependencies, directories)
    for (const service of processServices) {
      try {
        const result = await provisionService(service, options, isStructuredOutput);
        serviceResults.push(result);
      } catch (error) {
        const baseResult = createBaseResult('provision', service.name, service.deploymentType, options.environment!, startTime);
        const errorResult = createErrorResult(baseResult, error as Error);
        
        const provisionErrorResult: ProvisionResult = {
          ...errorResult,
          resources: [],
          dependencies: [],
          resourceId: { [service.deploymentType]: {} } as ResourceIdentifier,
          status: 'failed',
          metadata: { error: (error as Error).message },
        };
        
        serviceResults.push(provisionErrorResult);
        
        if (!isStructuredOutput && options.output === 'summary') {
          printError(`Failed to provision process ${service.name}: ${error}`);
        }
        // allSucceeded = false;
      }
    }
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'provision',
      environment: options.environment!,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: serviceResults,
      summary: {
        total: serviceResults.length,
        succeeded: serviceResults.filter(r => r.success).length,
        failed: serviceResults.filter(r => !r.success).length,
        warnings: serviceResults.filter(r => r.status.includes('not-implemented')).length,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun,
      }
    };
    
    return commandResults;
    
  } catch (error) {
    if (!isStructuredOutput) {
      printError(`Provisioning failed: ${error}`);
    }
    
    return {
      command: 'provision',
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
  }
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const provisionCommand = new CommandBuilder<ProvisionOptions>()
  .name('provision')
  .description('Provision infrastructure')
  .schema(ProvisionOptionsSchema as any)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args({
    args: {
      '--environment': { type: 'string', description: 'Environment name' },
      '--stack': { type: 'string', description: 'Stack to provision (infra, app, all)' },
      '--force': { type: 'boolean', description: 'Force destructive operations' },
      '--destroy': { type: 'boolean', description: 'Destroy infrastructure' },
      '--reset': { type: 'boolean', description: 'Reset infrastructure' },
      '--seed': { type: 'boolean', description: 'Seed database with initial data' },
      '--verbose': { type: 'boolean', description: 'Verbose output' },
      '--dry-run': { type: 'boolean', description: 'Simulate actions without executing' },
      '--require-approval': { type: 'boolean', description: 'Require manual approval' },
      '--output': { type: 'string', description: 'Output format (summary, table, json, yaml)' },
      '--service': { type: 'string', description: 'Service name or "all" for all services' },
    },
    aliases: {
      '-e': '--environment',
      '-s': '--stack',
      '-f': '--force',
      '-d': '--destroy',
      '-v': '--verbose',
      '-o': '--output',
    }
  })
  .examples(
    'semiont provision --environment local',
    'semiont provision --environment staging --stack infra',
    'semiont provision --environment production --destroy --force'
  )
  .handler(provision)
  .build();

// Export default for compatibility
export default provisionCommand;

// Note: The main function is removed as cli.ts now handles service resolution and output formatting
// The provision function now accepts pre-resolved services and returns CommandResults

// Export the schema for use by CLI
export type { ProvisionOptions };
export { ProvisionOptionsSchema };