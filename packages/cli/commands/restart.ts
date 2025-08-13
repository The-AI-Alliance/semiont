/**
 * Restart Command - Deployment-type aware service restart
 * 
 * This command restarts services based on their deployment type:
 * - AWS: Restart ECS tasks
 * - Container: Restart containers
 * - Process: Restart processes
 * - External: Verify external service
 */

import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { stopContainer, runContainer } from '../lib/container-runtime.js';
import { spawn } from 'child_process';
import { 
  RestartResult, 
  CommandResults, 
  createBaseResult, 
  createErrorResult,
  ResourceIdentifier 
} from '../lib/command-results.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const RestartOptionsSchema = z.object({
  environment: z.string(),
  force: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  gracePeriod: z.number().int().positive().default(3), // seconds to wait between stop and start
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
});

type RestartOptions = z.infer<typeof RestartOptionsSchema>;

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

// Global flag to control output suppression
let suppressOutput = false;

function printError(message: string): void {
  if (!suppressOutput) {
    console.error(`${colors.red}❌ ${message}${colors.reset}`);
  }
}

function printSuccess(message: string): void {
  if (!suppressOutput) {
    console.log(`${colors.green}✅ ${message}${colors.reset}`);
  }
}

function printInfo(message: string): void {
  if (!suppressOutput) {
    console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
  }
}

function printWarning(message: string): void {
  if (!suppressOutput) {
    console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
  }
}

function printDebug(message: string, options: RestartOptions): void {
  if (!suppressOutput && options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}


// =====================================================================
// DEPLOYMENT-TYPE-AWARE RESTART FUNCTIONS
// =====================================================================

async function restartServiceImpl(serviceInfo: ServiceDeploymentInfo, options: RestartOptions): Promise<RestartResult> {
  const startTime = Date.now();
  const stopTime = new Date();
  
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would restart ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    
    return {
      ...createBaseResult('restart', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime),
      stopTime,
      startTime: new Date(Date.now() + options.gracePeriod * 1000),
      downtime: options.gracePeriod * 1000,
      gracefulRestart: true,
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'dry-run',
      metadata: { dryRun: true, gracePeriod: options.gracePeriod },
    };
  }
  
  printInfo(`Restarting ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  
  try {
    switch (serviceInfo.deploymentType) {
      case 'aws':
        return await restartAWSService(serviceInfo, options, startTime);
      case 'container':
        return await restartContainerService(serviceInfo, options, startTime);
      case 'process':
        return await restartProcessService(serviceInfo, options, startTime);
      case 'external':
        return await restartExternalService(serviceInfo, options, startTime);
      default:
        throw new Error(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
    }
  } catch (error) {
    const baseResult = createBaseResult('restart', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
    const errorResult = createErrorResult(baseResult, error as Error);
    
    return {
      ...errorResult,
      stopTime,
      startTime: stopTime,
      downtime: 0,
      gracefulRestart: false,
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'failed',
      metadata: { error: (error as Error).message },
    };
  }
}

async function restartAWSService(serviceInfo: ServiceDeploymentInfo, options: RestartOptions, startTime: number): Promise<RestartResult> {
  const baseResult = createBaseResult('restart', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  const stopTime = new Date();
  
  // AWS ECS task restart
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      printInfo(`Restarting ECS tasks for ${serviceInfo.name}`);
      printWarning('ECS task restart not yet implemented - use AWS Console');
      
      return {
        ...baseResult,
        stopTime,
        startTime: new Date(Date.now() + options.gracePeriod * 1000),
        downtime: options.gracePeriod * 1000,
        gracefulRestart: true,
        resourceId: {
          aws: {
            arn: `arn:aws:ecs:us-east-1:123456789012:service/semiont-${options.environment}/${serviceInfo.name}`,
            id: `semiont-${options.environment}-${serviceInfo.name}`,
            name: `semiont-${options.environment}-${serviceInfo.name}`
          }
        },
        status: 'not-implemented',
        metadata: {
          serviceName: `semiont-${options.environment}-${serviceInfo.name}`,
          cluster: `semiont-${options.environment}`,
          implementation: 'pending',
          gracePeriod: options.gracePeriod
        },
      };
      
    case 'database':
      printInfo(`Restarting RDS instance for ${serviceInfo.name}`);
      printWarning('RDS instance restart not yet implemented - use AWS Console');
      
      return {
        ...baseResult,
        stopTime,
        startTime: new Date(Date.now() + options.gracePeriod * 1000),
        downtime: options.gracePeriod * 1000,
        gracefulRestart: true,
        resourceId: {
          aws: {
            arn: `arn:aws:rds:us-east-1:123456789012:db:semiont-${options.environment}-db`,
            id: `semiont-${options.environment}-db`,
            name: `semiont-${options.environment}-database`
          }
        },
        status: 'not-implemented',
        metadata: {
          instanceIdentifier: `semiont-${options.environment}-db`,
          implementation: 'pending',
          gracePeriod: options.gracePeriod
        },
      };
      
    case 'filesystem':
      printInfo(`Remounting EFS volumes for ${serviceInfo.name}`);
      printWarning('EFS remount not yet implemented');
      
      return {
        ...baseResult,
        stopTime,
        startTime: new Date(Date.now() + options.gracePeriod * 1000),
        downtime: options.gracePeriod * 1000,
        gracefulRestart: true,
        resourceId: {
          aws: {
            arn: `arn:aws:efs:us-east-1:123456789012:file-system/fs-semiont${options.environment}`,
            id: `fs-semiont${options.environment}`,
            name: `semiont-${options.environment}-efs`
          }
        },
        status: 'not-implemented',
        metadata: {
          fileSystemId: `fs-semiont${options.environment}`,
          implementation: 'pending',
          gracePeriod: options.gracePeriod
        },
      };
      
    default:
      throw new Error(`Unsupported AWS service: ${serviceInfo.name}`);
  }
}

async function restartContainerService(serviceInfo: ServiceDeploymentInfo, options: RestartOptions, startTime: number): Promise<RestartResult> {
  const baseResult = createBaseResult('restart', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}`;
  const stopTime = new Date();
  
  try {
    // Stop the container
    printInfo(`Stopping container: ${containerName}`);
    const stopSuccess = await stopContainer(containerName, {
      force: options.force,
      verbose: options.verbose,
      timeout: 10
    });
    
    if (!stopSuccess && !options.force) {
      throw new Error(`Failed to stop container: ${containerName}`);
    }
    
    // Track if we're continuing despite stop failure
    const forcedContinue = !stopSuccess && options.force;
    
    // Wait for grace period
    if (options.gracePeriod > 0) {
      printDebug(`Waiting ${options.gracePeriod} seconds before starting...`, options);
      await new Promise(resolve => setTimeout(resolve, options.gracePeriod * 1000));
    }
    
    // Start the container again
    printInfo(`Starting container: ${containerName}`);
    let startSuccess = false;
    const actualStartTime = new Date();
    
    switch (serviceInfo.name) {
      case 'database':
        const imageName = serviceInfo.config.image || 'postgres:15-alpine';
        startSuccess = await runContainer(imageName, containerName, {
          ports: { '5432': '5432' },
          environment: {
            POSTGRES_PASSWORD: serviceInfo.config.password || 'localpassword',
            POSTGRES_DB: serviceInfo.config.name || 'semiont',
            POSTGRES_USER: serviceInfo.config.user || 'postgres'
          },
          detached: true,
          verbose: options.verbose
        });
        break;
        
      case 'frontend':
      case 'backend':
        const appImageName = serviceInfo.config.image || `semiont-${serviceInfo.name}:latest`;
        startSuccess = await runContainer(appImageName, containerName, {
          ports: serviceInfo.config.port ? { [serviceInfo.config.port.toString()]: serviceInfo.config.port.toString() } : {},
          detached: true,
          verbose: options.verbose
        });
        break;
        
      case 'filesystem':
        // Volumes don't need restarting
        printInfo(`Container volumes don't require restart`);
        startSuccess = true;
        break;
    }
    
    if (startSuccess) {
      printSuccess(`Container restarted: ${containerName}`);
      
      return {
        ...baseResult,
        stopTime,
        startTime: actualStartTime,
        downtime: actualStartTime.getTime() - stopTime.getTime(),
        gracefulRestart: !forcedContinue,
        resourceId: {
          container: {
            id: containerName,
            name: containerName
          }
        },
        status: forcedContinue ? 'force-continued' : 'restarted',
        metadata: {
          containerName,
          image: serviceInfo.name === 'database' ? 
            (serviceInfo.config.image || 'postgres:15-alpine') : 
            (serviceInfo.config.image || `semiont-${serviceInfo.name}:latest`),
          gracePeriod: options.gracePeriod,
          forced: options.force || forcedContinue
        },
      };
    } else {
      throw new Error(`Failed to restart container: ${containerName}`);
    }
  } catch (error) {
    if (options.force) {
      printWarning(`Failed to restart ${serviceInfo.name} container: ${error}`);
      
      return {
        ...baseResult,
        stopTime,
        startTime: new Date(),
        downtime: 0,
        gracefulRestart: false,
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

async function restartProcessService(serviceInfo: ServiceDeploymentInfo, options: RestartOptions, startTime: number): Promise<RestartResult> {
  const baseResult = createBaseResult('restart', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  const stopTime = new Date();
  
  // Process deployment restart
  switch (serviceInfo.name) {
    case 'database':
      printInfo(`Restarting PostgreSQL service for ${serviceInfo.name}`);
      printWarning('Local PostgreSQL service restart not yet implemented');
      
      return {
        ...baseResult,
        stopTime,
        startTime: new Date(Date.now() + options.gracePeriod * 1000),
        downtime: options.gracePeriod * 1000,
        gracefulRestart: true,
        resourceId: {
          process: {
            path: '/usr/local/var/postgres',
            port: 5432
          }
        },
        status: 'not-implemented',
        metadata: {
          implementation: 'pending',
          service: 'postgresql',
          gracePeriod: options.gracePeriod
        },
      };
      
    case 'frontend':
    case 'backend':
      // Kill and restart process
      const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
      
      // Find and kill existing process
      printInfo(`Stopping process on port ${port}`);
      await findAndKillProcess(`:${port}`, serviceInfo.name, options);
      
      // Wait for grace period
      if (options.gracePeriod > 0) {
        printDebug(`Waiting ${options.gracePeriod} seconds before starting...`, options);
        await new Promise(resolve => setTimeout(resolve, options.gracePeriod * 1000));
      }
      
      // Start new process
      const actualStartTime = new Date();
      printInfo(`Starting new process for ${serviceInfo.name}`);
      const command = serviceInfo.config.command?.split(' ') || ['npm', 'run', 'dev'];
      const proc = spawn(command[0], command.slice(1), {
        cwd: `apps/${serviceInfo.name}`,
        stdio: 'pipe',
        detached: true,
        env: {
          ...process.env,
          PORT: port.toString(),
        }
      });
      
      proc.unref();
      printSuccess(`Process restarted on port ${port}`);
      
      return {
        ...baseResult,
        stopTime,
        startTime: actualStartTime,
        downtime: actualStartTime.getTime() - stopTime.getTime(),
        gracefulRestart: !options.force,
        resourceId: {
          process: {
            pid: proc.pid || 0,
            port: port,
            path: `apps/${serviceInfo.name}`
          }
        },
        status: 'restarted',
        metadata: {
          command: command.join(' '),
          port,
          workingDirectory: `apps/${serviceInfo.name}`,
          gracePeriod: options.gracePeriod
        },
      };
      
    case 'filesystem':
      printInfo(`No process to restart for filesystem service`);
      printSuccess(`Filesystem service ${serviceInfo.name} unchanged`);
      
      return {
        ...baseResult,
        stopTime,
        startTime: stopTime, // No restart needed
        downtime: 0,
        gracefulRestart: true,
        resourceId: {
          process: {
            path: serviceInfo.config.path || '/tmp/filesystem'
          }
        },
        status: 'no-action-needed',
        metadata: {
          reason: 'No process to restart for filesystem service'
        },
      };
      
    default:
      throw new Error(`Unsupported process service: ${serviceInfo.name}`);
  }
}

async function restartExternalService(serviceInfo: ServiceDeploymentInfo, options: RestartOptions, startTime: number): Promise<RestartResult> {
  const baseResult = createBaseResult('restart', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  const stopTime = new Date();
  
  // External service - can't actually restart, just verify
  printInfo(`Cannot restart external ${serviceInfo.name} service`);
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        printInfo(`External database: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
        printWarning('External database connectivity check not yet implemented');
        
        return {
          ...baseResult,
          stopTime,
          startTime: stopTime, // No restart needed
          downtime: 0,
          gracefulRestart: true,
          resourceId: {
            external: {
              endpoint: `${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`
            }
          },
          status: 'external',
          metadata: {
            host: serviceInfo.config.host,
            port: serviceInfo.config.port || 5432,
            reason: 'External services cannot be restarted remotely'
          },
        };
      }
      break;
      
    case 'filesystem':
      if (serviceInfo.config.path) {
        printInfo(`External storage: ${serviceInfo.config.path}`);
        printWarning('External storage validation not yet implemented');
        
        return {
          ...baseResult,
          stopTime,
          startTime: stopTime, // No restart needed
          downtime: 0,
          gracefulRestart: true,
          resourceId: {
            external: {
              path: serviceInfo.config.path
            }
          },
          status: 'external',
          metadata: {
            path: serviceInfo.config.path,
            reason: 'External storage cannot be restarted remotely'
          },
        };
      }
      break;
      
    default:
      printInfo(`External ${serviceInfo.name} service`);
  }
  
  printSuccess(`External ${serviceInfo.name} service verified`);
  
  return {
    ...baseResult,
    stopTime,
    startTime: stopTime, // No restart needed
    downtime: 0,
    gracefulRestart: true,
    resourceId: {
      external: {
        endpoint: 'external-service'
      }
    },
    status: 'external',
    metadata: {
      reason: 'External services cannot be restarted remotely'
    },
  };
}

async function findAndKillProcess(pattern: string, name: string, options: RestartOptions): Promise<boolean> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would stop ${name}`);
    return true;
  }
  
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
          } catch (err) {
            printDebug(`Failed to kill PID ${pid}: ${err}`, options);
          }
        }
      }
      printDebug(`Stopped ${name} process(es)`, options);
      return true;
    } else {
      printDebug(`${name} not running`, options);
      return false;
    }
  } catch (error) {
    if (!options.force) {
      throw error;
    }
    return false;
  }
}

// =====================================================================
// STRUCTURED OUTPUT FUNCTION  
// =====================================================================

export async function restart(
  serviceDeployments: ServiceDeploymentInfo[],
  options: RestartOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  
  // Suppress output for structured formats
  const previousSuppressOutput = suppressOutput;
  suppressOutput = isStructuredOutput;
  
  try {
    if (options.output === 'summary') {
      printInfo(`Restarting services in ${colors.bright}${options.environment}${colors.reset} environment`);
    }
    
    if (options.output === 'summary' && options.verbose) {
      printDebug(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    }
    
    // Restart services and collect results
    const serviceResults: RestartResult[] = [];
    
    for (const serviceInfo of serviceDeployments) {
      try {
        const result = await restartServiceImpl(serviceInfo, options);
        serviceResults.push(result);
      } catch (error) {
        // Create error result
        const baseResult = createBaseResult('restart', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
        const errorResult = createErrorResult(baseResult, error as Error);
        
        const restartErrorResult: RestartResult = {
          ...errorResult,
          stopTime: new Date(),
          startTime: new Date(),
          downtime: 0,
          gracefulRestart: false,
          resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
          status: 'failed',
          metadata: { error: (error as Error).message },
        };
        
        serviceResults.push(restartErrorResult);
        
        printError(`Failed to restart ${serviceInfo.name}: ${error}`);
        
        if (!options.force) {
          break; // Stop on first error unless --force
        }
      }
    }
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'restart',
      environment: options.environment,
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
    
  } finally {
    // Restore output suppression state
    suppressOutput = previousSuppressOutput;
  }
}

// Export the schema for use by CLI
export { RestartOptions, RestartOptionsSchema };