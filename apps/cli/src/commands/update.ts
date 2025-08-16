/**
 * Update Command - Deployment-type aware service updates
 * 
 * This command updates running services based on deployment type:
 * - AWS: Force new ECS deployments to pick up latest ECR images
 * - Container: Restart containers with updated images
 * - Process: Restart processes with updated code
 * - External: Skip (managed separately)
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { colors } from '../lib/cli-colors.js';
import { printDebug } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { stopContainer, runContainer } from '../lib/container-runtime.js';
import type { BaseCommandOptions } from '../lib/base-command-options.js';
// import { getProjectRoot } from '../lib/cli-paths.js';
import { 
  UpdateResult, 
  CommandResults, 
  createBaseResult, 
  createErrorResult,
  ResourceIdentifier 
} from '../lib/command-results.js';

// AWS SDK imports for ECS operations
import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';

// const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const UpdateOptionsSchema = z.object({
  environment: z.string().optional(),
  skipTests: z.boolean().default(false),
  skipBuild: z.boolean().default(false),
  force: z.boolean().default(false),
  gracePeriod: z.number().int().positive().default(3), // seconds to wait between stop and start
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
});

interface UpdateOptions extends BaseCommandOptions {
  skipTests?: boolean;
  skipBuild?: boolean;
  force?: boolean;
  gracePeriod?: number;
}

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

function printError(message: string): void {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}

function printSuccess(message: string): void {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function printInfo(message: string): void {
  console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
}

function printWarning(message: string): void {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

// Helper wrapper for printDebug that passes verbose option
function debugLog(_message: string, _options: any): void {
  // Debug logging disabled for now
}



// =====================================================================
// DEPLOYMENT-TYPE-AWARE UPDATE FUNCTIONS
// =====================================================================

async function updateService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions, isStructuredOutput: boolean = false): Promise<UpdateResult> {
  const startTime = Date.now();
  const environment = options.environment!; // Environment is guaranteed by command loader
  
  if (options.dryRun) {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`[DRY RUN] Would update ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    }
    
    return {
      ...createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime),
      updateTime: new Date(),
      previousVersion: 'unknown',
      newVersion: 'unknown',
      rollbackAvailable: true,
      changesApplied: [],
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'dry-run',
      metadata: { dryRun: true },
    };
  }
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Updating ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  }
  
  try {
    switch (serviceInfo.deploymentType) {
      case 'aws':
        return await updateAWSService(serviceInfo, options, startTime, isStructuredOutput);
      case 'container':
        return await updateContainerService(serviceInfo, options, startTime, isStructuredOutput);
      case 'process':
        return await updateProcessService(serviceInfo, options, startTime, isStructuredOutput);
      case 'external':
        return await updateExternalService(serviceInfo, options, startTime, isStructuredOutput);
      default:
        throw new Error(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
    }
  } catch (error) {
    const baseResult = createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
    const errorResult = createErrorResult(baseResult, error as Error);
    
    return {
      ...errorResult,
      updateTime: new Date(),
      previousVersion: 'unknown',
      newVersion: 'unknown',
      rollbackAvailable: false,
      changesApplied: [],
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'failed',
      metadata: { error: (error as Error).message },
    };
  }
}

async function updateAWSService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions, startTime: number, isStructuredOutput: boolean = false): Promise<UpdateResult> {
  const environment = options.environment!; // Environment is guaranteed by command loader
  const baseResult = createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
  
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`Triggering ECS deployment for ${serviceInfo.name}`);
      }
      
      try {
        // Get AWS region from service configuration or use default
        const awsRegion = (serviceInfo.config as any).aws?.region || 'us-east-1';
        const ecsClient = new ECSClient({ region: awsRegion });
        const clusterName = `semiont-${environment}`;
        const fullServiceName = `semiont-${environment}-${serviceInfo.name}`;
        const updateTime = new Date();
        
        if (!options.dryRun) {
          await ecsClient.send(new UpdateServiceCommand({
            cluster: clusterName,
            service: fullServiceName,
            forceNewDeployment: true
          }));
          
          if (!isStructuredOutput && options.output === 'summary') {
            printSuccess(`ECS deployment initiated for ${serviceInfo.name}`);
          }
        }
        
        return {
          ...baseResult,
          updateTime,
          previousVersion: 'latest',
          newVersion: 'latest-updated',
          rollbackAvailable: true,
          changesApplied: [{ type: 'infrastructure', description: `ECS deployment initiated for ${fullServiceName}` }],
          resourceId: {
            aws: {
              arn: `arn:aws:ecs:${awsRegion}:123456789012:service/${clusterName}/${fullServiceName}`,
              id: fullServiceName,
              name: fullServiceName
            }
          },
          status: options.dryRun ? 'dry-run' : 'updated',
          metadata: {
            serviceName: fullServiceName,
            cluster: clusterName,
            region: awsRegion,
            forceNewDeployment: true
          },
        };
      } catch (error) {
        if (!isStructuredOutput && options.output === 'summary') {
          printError(`Failed to update ECS service ${serviceInfo.name}: ${error}`);
        }
        throw error;
      }
      
    case 'database':
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`RDS instances cannot be updated via this command`);
        printWarning('Use AWS Console or RDS CLI to update database instances');
      }
      
      return {
        ...baseResult,
        updateTime: new Date(),
        previousVersion: 'postgres-15',
        newVersion: 'postgres-15',
        rollbackAvailable: true,
        changesApplied: [],
        resourceId: {
          aws: {
            arn: `arn:aws:rds:us-east-1:123456789012:db:semiont-${environment}-db`,
            id: `semiont-${environment}-db`,
            name: `semiont-${environment}-database`
          }
        },
        status: 'not-applicable',
        metadata: {
          instanceIdentifier: `semiont-${environment}-db`,
          reason: 'RDS instances require manual updates'
        },
      };
      
    case 'filesystem':
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`EFS filesystems do not require updates`);
        printSuccess(`EFS ${serviceInfo.name} requires no action`);
      }
      
      return {
        ...baseResult,
        updateTime: new Date(),
        previousVersion: 'efs-standard',
        newVersion: 'efs-standard',
        rollbackAvailable: true,
        changesApplied: [],
        resourceId: {
          aws: {
            arn: `arn:aws:efs:us-east-1:123456789012:file-system/fs-semiont${environment}`,
            id: `fs-semiont${environment}`,
            name: `semiont-${environment}-efs`
          }
        },
        status: 'no-action-needed',
        metadata: {
          fileSystemId: `fs-semiont${environment}`,
          reason: 'EFS filesystems do not require updates'
        },
      };
      
    default:
      throw new Error(`Unsupported AWS service: ${serviceInfo.name}`);
  }
}

async function updateContainerService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions, startTime: number, isStructuredOutput: boolean = false): Promise<UpdateResult> {
  const environment = options.environment!; // Environment is guaranteed by command loader
  const baseResult = createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${environment}`;
  
  try {
    const updateTime = new Date();
    
    // Stop the current container
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Stopping container: ${containerName}`);
    }
    const stopSuccess = await stopContainer(containerName, {
      force: options.force ?? false,
      verbose: options.verbose ?? false,
      timeout: 10
    });
    
    if (!stopSuccess && !options.force) {
      throw new Error(`Failed to stop container: ${containerName}`);
    }
    
    // Wait for grace period
    const gracePeriod = options.gracePeriod || 3;
    if (gracePeriod > 0) {
      printDebug(`Waiting ${gracePeriod} seconds before starting...`, options.verbose || false);
      await new Promise(resolve => setTimeout(resolve, gracePeriod * 1000));
    }
    
    // Start the container again with updated image
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Starting updated container: ${containerName}`);
    }
    let startSuccess = false;
    let imageName = '';
    
    switch (serviceInfo.name) {
      case 'database':
        imageName = serviceInfo.config.image || 'postgres:15-alpine';
        startSuccess = await runContainer(imageName, containerName, {
          ports: { '5432': '5432' },
          environment: {
            POSTGRES_PASSWORD: serviceInfo.config.password || 'localpassword',
            POSTGRES_DB: serviceInfo.config.name || 'semiont',
            POSTGRES_USER: serviceInfo.config.user || 'postgres'
          },
          detached: true,
          verbose: options.verbose ?? false
        });
        break;
        
      case 'frontend':
      case 'backend':
        imageName = serviceInfo.config.image || `semiont-${serviceInfo.name}:latest`;
        startSuccess = await runContainer(imageName, containerName, {
          ports: serviceInfo.config.port ? { [serviceInfo.config.port.toString()]: serviceInfo.config.port.toString() } : {},
          detached: true,
          verbose: options.verbose ?? false
        });
        break;
        
      case 'filesystem':
        // Volumes don't need updating
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`Container volumes don't require updates`);
        }
        startSuccess = true;
        imageName = 'volume';
        break;
    }
    
    if (startSuccess) {
      if (!isStructuredOutput && options.output === 'summary') {
        printSuccess(`Container updated: ${containerName}`);
      }
      
      return {
        ...baseResult,
        updateTime,
        previousVersion: imageName,
        newVersion: imageName,
        rollbackAvailable: !options.force,
        changesApplied: [{ type: 'infrastructure', description: `Container ${containerName} updated with image ${imageName}` }],
        resourceId: {
          container: {
            id: containerName,
            name: containerName
          }
        },
        status: 'updated',
        metadata: {
          containerName,
          image: imageName,
          gracePeriod: options.gracePeriod || 3,
          forced: options.force || false
        },
      };
    } else {
      throw new Error(`Failed to start updated container: ${containerName}`);
    }
  } catch (error) {
    if (options.force) {
      if (!isStructuredOutput && options.output === 'summary') {
        printWarning(`Failed to update ${serviceInfo.name} container: ${error}`);
      }
      
      return {
        ...baseResult,
        success: false,  // Even with force, this is still a failure
        updateTime: new Date(),
        previousVersion: 'unknown',
        newVersion: 'unknown',
        rollbackAvailable: false,
        changesApplied: [],
        resourceId: {
          container: {
            id: containerName,
            name: containerName
          }
        },
        status: 'force-continued',
        metadata: {
          containerName,
          error: (error as Error).message,
          forced: true
        },
      };
    } else {
      throw error;
    }
  }
}

async function updateProcessService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions, startTime: number, isStructuredOutput: boolean = false): Promise<UpdateResult> {
  const environment = options.environment!; // Environment is guaranteed by command loader
  const baseResult = createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
  
  switch (serviceInfo.name) {
    case 'database':
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`PostgreSQL service updates require manual intervention`);
        printWarning('Use your system\'s package manager to update PostgreSQL');
      }
      
      return {
        ...baseResult,
        updateTime: new Date(),
        previousVersion: 'postgres-local',
        newVersion: 'postgres-local',
        rollbackAvailable: true,
        changesApplied: [],
        resourceId: {
          process: {
            path: '/usr/local/var/postgres',
            port: 5432
          }
        },
        status: 'not-applicable',
        metadata: {
          reason: 'PostgreSQL service updates require manual intervention',
          service: 'postgresql'
        },
      };
      
    case 'frontend':
    case 'backend':
      // Kill and restart process with updated code
      const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
      
      // Find and kill existing process
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`Stopping process on port ${port}`);
      }
      await findAndKillProcess(`:${port}`, serviceInfo.name, options);
      
      // Wait for grace period
      const processGracePeriod = options.gracePeriod || 3;
      if (processGracePeriod > 0) {
        printDebug(`Waiting ${processGracePeriod} seconds before starting...`, options.verbose || false);
        await new Promise(resolve => setTimeout(resolve, processGracePeriod * 1000));
      }
      
      // Start new process with updated code
      const updateTime = new Date();
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`Starting updated process for ${serviceInfo.name}`);
      }
      const command = serviceInfo.config.command?.split(' ') || ['npm', 'run', 'dev'];
      const proc = spawn(command[0]!, command.slice(1), {
        cwd: `apps/${serviceInfo.name}`,
        stdio: 'pipe',
        detached: true,
        env: {
          ...process.env,
          PORT: port.toString(),
        }
      });
      
      proc.unref();
      if (!isStructuredOutput && options.output === 'summary') {
        printSuccess(`Process updated on port ${port}`);
      }
      
      return {
        ...baseResult,
        updateTime,
        previousVersion: 'development',
        newVersion: 'development-updated',
        rollbackAvailable: !options.force,
        changesApplied: [{ type: 'code', description: `Process updated on port ${port}` }],
        resourceId: {
          process: {
            pid: proc.pid || 0,
            port: port,
            path: `apps/${serviceInfo.name}`
          }
        },
        status: 'updated',
        metadata: {
          command: command.join(' '),
          port,
          workingDirectory: `apps/${serviceInfo.name}`,
          gracePeriod: options.gracePeriod
        },
      };
      
    case 'filesystem':
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`No updates required for filesystem service`);
        printSuccess(`Filesystem service ${serviceInfo.name} unchanged`);
      }
      
      return {
        ...baseResult,
        updateTime: new Date(),
        previousVersion: 'filesystem',
        newVersion: 'filesystem',
        rollbackAvailable: true,
        changesApplied: [],
        resourceId: {
          process: {
            path: serviceInfo.config.path || '/tmp/filesystem'
          }
        },
        status: 'no-action-needed',
        metadata: {
          reason: 'No updates required for filesystem service'
        },
      };
      
    default:
      throw new Error(`Unsupported process service: ${serviceInfo.name}`);
  }
}

async function updateExternalService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions, startTime: number, isStructuredOutput: boolean = false): Promise<UpdateResult> {
  const environment = options.environment!; // Environment is guaranteed by command loader
  const baseResult = createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Cannot update external ${serviceInfo.name} service`);
  }
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`External database: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
          printWarning('External database updates must be managed by the database provider');
        }
        
        return {
          ...baseResult,
          updateTime: new Date(),
          previousVersion: 'external',
          newVersion: 'external',
          rollbackAvailable: true,
          changesApplied: [],
          resourceId: {
            external: {
              endpoint: `${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`
            }
          },
          status: 'external',
          metadata: {
            host: serviceInfo.config.host,
            port: serviceInfo.config.port || 5432,
            reason: 'External database updates must be managed by the database provider'
          },
        };
      }
      break;
      
    case 'filesystem':
      if (serviceInfo.config.path) {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`External storage: ${serviceInfo.config.path}`);
          printWarning('External storage updates must be managed by the storage provider');
        }
        
        return {
          ...baseResult,
          updateTime: new Date(),
          previousVersion: 'external',
          newVersion: 'external',
          rollbackAvailable: true,
          changesApplied: [],
          resourceId: {
            external: {
              path: serviceInfo.config.path
            }
          },
          status: 'external',
          metadata: {
            path: serviceInfo.config.path,
            reason: 'External storage updates must be managed by the storage provider'
          },
        };
      }
      break;
      
    default:
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`External ${serviceInfo.name} service`);
        printWarning('External service updates must be managed separately');
      }
  }
  
  if (!isStructuredOutput && options.output === 'summary') {
    printSuccess(`External ${serviceInfo.name} service noted`);
  }
  
  return {
    ...baseResult,
    updateTime: new Date(),
    previousVersion: 'external',
    newVersion: 'external',
    rollbackAvailable: true,
    changesApplied: [],
    resourceId: {
      external: {
        endpoint: 'external-service'
      }
    },
    status: 'external',
    metadata: {
      reason: 'External service updates must be managed separately'
    },
  };
}

async function findAndKillProcess(pattern: string, name: string, options: UpdateOptions): Promise<void> {
  try {
    // Find process using lsof (for port) or pgrep (for name)
    const isPort = pattern.startsWith(':');
    const findCmd = spawn(isPort ? 'lsof' : 'pgrep', isPort ? ['-ti', pattern] : ['-f', pattern]);
    
    let pids = '';
    findCmd.stdout?.on('data', (data) => {
      pids += data.toString();
    });
    
    await new Promise((resolve) => {
      findCmd.on('exit', () => resolve(void 0));
    });
    
    if (pids.trim()) {
      const pidList = pids.trim().split('\n');
      for (const pid of pidList) {
        if (pid) {
          try {
            process.kill(parseInt(pid), options.force ? 'SIGKILL' : 'SIGTERM');
          } catch {
            debugLog(`Failed to kill PID ${pid}`, options);
          }
        }
      }
      debugLog(`Stopped ${name} process(es)`, options);
    } else {
      debugLog(`${name} not running`, options);
    }
  } catch (error) {
    if (!options.force) {
      throw error;
    }
  }
}

// =====================================================================
// STRUCTURED OUTPUT FUNCTION
// =====================================================================

export const update = async (
  serviceDeployments: ServiceDeploymentInfo[],
  options: UpdateOptions
): Promise<CommandResults> => {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  const environment = options.environment!; // Environment is guaranteed by command loader
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Updating services in ${colors.bright}${environment}${colors.reset} environment`);
  }
  
  if (options.verbose && !isStructuredOutput && options.output === 'summary') {
    console.log(`Options: ${JSON.stringify(options, null, 2)}`);
  }
  
  try {
    if (options.verbose && !isStructuredOutput && options.output === 'summary') {
      console.log(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`);
    }
    
    if (options.dryRun && !isStructuredOutput && options.output === 'summary') {
      printInfo('[DRY RUN] Would update the following services:');
      for (const serviceInfo of serviceDeployments) {
        printInfo(`  - ${serviceInfo.name} (${serviceInfo.deploymentType})`);
      }
    }
    
    // Update services and collect results
    const serviceResults: UpdateResult[] = [];
    
    for (const serviceInfo of serviceDeployments) {
      try {
        const result = await updateService(serviceInfo, options, isStructuredOutput);
        serviceResults.push(result);
        
        // Stop on first error unless --force is used
        if (!result.success && !options.force) {
          if (!isStructuredOutput && options.output === 'summary') {
            printError(`Stopping due to error. Use --force to continue despite errors.`);
          }
          break;
        }
      } catch (error) {
        // Create error result
        const baseResult = createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
        const errorResult = createErrorResult(baseResult, error as Error);
        
        const updateErrorResult: UpdateResult = {
          ...errorResult,
          updateTime: new Date(),
          previousVersion: 'unknown',
          newVersion: 'unknown',
          rollbackAvailable: false,
          changesApplied: [],
          resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
          status: 'failed',
          metadata: { error: (error as Error).message },
        };
        
        serviceResults.push(updateErrorResult);
        
        if (!isStructuredOutput && options.output === 'summary') {
          printError(`Failed to update ${serviceInfo.name}: ${error}`);
        }
        
        if (!options.force) {
          break; // Stop on first error unless --force
        }
      }
    }
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'update',
      environment: environment,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: serviceResults,
      summary: {
        total: serviceResults.length,
        succeeded: serviceResults.filter(r => r.success).length,
        failed: serviceResults.filter(r => !r.success).length,
        warnings: serviceResults.filter(r => r.status.includes('not-implemented') || r.status.includes('not-applicable')).length,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun || false,
      }
    };
    
    return commandResults;
    
  } catch (error) {
    if (!isStructuredOutput) {
      printError(`Failed to update services: ${error}`);
    }
    
    return {
      command: 'update',
      environment: environment,
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
        dryRun: options.dryRun || false,
      },
    };
  }
};

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

import { CommandBuilder } from '../lib/command-definition.js';

export const updateCommand = new CommandBuilder<UpdateOptions>()
  .name('update')
  .description('Update running services with latest code/images')
  .schema(UpdateOptionsSchema as any)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args({
    args: {
      '--environment': { type: 'string', description: 'Environment name', required: true },
      '--skip-tests': { type: 'boolean', description: 'Skip test suite after update' },
      '--skip-build': { type: 'boolean', description: 'Skip build step' },
      '--force': { type: 'boolean', description: 'Force update even on errors' },
      '--grace-period': { type: 'number', description: 'Seconds to wait between stop and start' },
      '--verbose': { type: 'boolean', description: 'Verbose output' },
      '--dry-run': { type: 'boolean', description: 'Simulate actions without executing' },
      '--output': { type: 'string', description: 'Output format (summary, table, json, yaml)' },
      '--service': { type: 'string', description: 'Service name or "all" for all services' },
    },
    aliases: {
      '-e': '--environment',
      '-f': '--force',
      '-v': '--verbose',
      '-o': '--output',
    }
  })
  .examples(
    'semiont update --environment staging',
    'semiont update --environment production --force',
    'semiont update --environment local --skip-tests'
  )
  .handler(update)
  .build();

// Export default for compatibility
export default updateCommand;

// Export the schema and options type for use by CLI
export type { UpdateOptions };
export { UpdateOptionsSchema };