/**
 * Stop Command - Unified command structure
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { colors } from '../lib/cli-colors.js';
import { printError, printSuccess, printInfo, printWarning, printDebug, setSuppressOutput } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { stopContainer } from '../lib/container-runtime.js';
import { 
  StopResult, 
  CommandResults, 
  createBaseResult, 
  createErrorResult,
  ResourceIdentifier 
} from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import type { BaseCommandOptions } from '../lib/base-command-options.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const StopOptionsSchema = z.object({
  environment: z.string(),
  force: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
  services: z.array(z.string()).optional(),
});

type StopOptions = z.infer<typeof StopOptionsSchema> & BaseCommandOptions;

// Colors are now imported from centralized module

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

// Helper wrapper for printDebug that passes verbose option
function debugLog(message: string, options: StopOptions): void {
  printDebug(message, options.verbose);
}



// =====================================================================
// SERVICE STOP FUNCTIONS
// =====================================================================

async function stopServiceImpl(serviceInfo: ServiceDeploymentInfo, options: StopOptions): Promise<StopResult> {
  const startTime = Date.now();
  
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would stop ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    
    return {
      ...createBaseResult('stop', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime),
      stopTime: new Date(),
      gracefulShutdown: true,
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'dry-run',
      metadata: { dryRun: true },
    };
  }
  
  printInfo(`Stopping ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  
  try {
    switch (serviceInfo.deploymentType) {
      case 'aws':
        return await stopAWSService(serviceInfo, options, startTime);
      case 'container':
        return await stopContainerService(serviceInfo, options, startTime);
      case 'process':
        return await stopProcessService(serviceInfo, options, startTime);
      case 'external':
        return await stopExternalService(serviceInfo, options, startTime);
      default:
        throw new Error(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
    }
  } catch (error) {
    const baseResult = createBaseResult('stop', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
    const errorResult = createErrorResult(baseResult, error as Error);
    
    return {
      ...errorResult,
      stopTime: new Date(),
      gracefulShutdown: false,
      forcedTermination: true,
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'failed',
      metadata: { error: (error as Error).message },
    };
  }
}

async function stopAWSService(serviceInfo: ServiceDeploymentInfo, options: StopOptions, startTime: number): Promise<StopResult> {
  const baseResult = createBaseResult('stop', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  
  // AWS ECS service stop
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      {
        printInfo(`Stopping ${serviceInfo.name} ECS service`);
        printWarning('ECS service stop not yet implemented - use AWS Console');
      }
      
      return {
        ...baseResult,
        stopTime: new Date(),
        gracefulShutdown: true,
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
          implementation: 'pending'
        },
      };
      
    case 'database':
      {
        printInfo(`Stopping RDS instance for ${serviceInfo.name}`);
        printWarning('RDS instance stop not yet implemented - use AWS Console');
      }
      
      return {
        ...baseResult,
        stopTime: new Date(),
        gracefulShutdown: true,
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
          implementation: 'pending'
        },
      };
      
    case 'filesystem':
      {
        printInfo(`Unmounting EFS volumes for ${serviceInfo.name}`);
        printWarning('EFS unmount not yet implemented');
      }
      
      return {
        ...baseResult,
        stopTime: new Date(),
        gracefulShutdown: true,
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
          implementation: 'pending'
        },
      };
      
    default:
      throw new Error(`Unsupported AWS service: ${serviceInfo.name}`);
  }
}

async function stopContainerService(serviceInfo: ServiceDeploymentInfo, options: StopOptions, startTime: number): Promise<StopResult> {
  const baseResult = createBaseResult('stop', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}`;
  
  try {
    const success = await stopContainer(containerName, {
      force: options.force,
      verbose: options.verbose,
      timeout: 10
    });
    
    if (success) {
      {
        printSuccess(`Container stopped: ${containerName}`);
      }
      
      return {
        ...baseResult,
        stopTime: new Date(),
        gracefulShutdown: !options.force,
        forcedTermination: options.force,
        resourceId: {
          container: {
            id: containerName,
            name: containerName
          }
        },
        status: 'stopped',
        metadata: {
          containerName,
          forced: options.force,
          timeout: 10
        },
      };
    } else {
      throw new Error(`Failed to stop container: ${containerName}`);
    }
  } catch (error) {
    if (options.force) {
      {
        printWarning(`Failed to stop ${serviceInfo.name} container: ${error}`);
      }
      
      return {
        ...baseResult,
        success: false,
        stopTime: new Date(),
        gracefulShutdown: false,
        forcedTermination: true,
        resourceId: {
          container: {
            id: containerName,
            name: containerName
          }
        },
        status: 'force-stopped',
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

async function stopProcessService(serviceInfo: ServiceDeploymentInfo, options: StopOptions, startTime: number): Promise<StopResult> {
  const baseResult = createBaseResult('stop', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  
  // Process deployment (local development)
  switch (serviceInfo.name) {
    case 'database':
      {
        printInfo(`Stopping PostgreSQL service for ${serviceInfo.name}`);
        printWarning('Local PostgreSQL service stop not yet implemented');
      }
      
      return {
        ...baseResult,
        stopTime: new Date(),
        gracefulShutdown: true,
        resourceId: {
          process: {
            path: '/usr/local/var/postgres',
            port: 5432
          }
        },
        status: 'not-implemented',
        metadata: {
          implementation: 'pending',
          service: 'postgresql'
        },
      };
      
    case 'frontend':
    case 'backend':
      // Kill process on the service's port
      const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
      const killed = await findAndKillProcess(`:${port}`, serviceInfo.name, options);
      
      return {
        ...baseResult,
        stopTime: new Date(),
        gracefulShutdown: !options.force,
        forcedTermination: options.force,
        resourceId: {
          process: {
            port: port,
            path: `/tmp/${serviceInfo.name}-${options.environment}`
          }
        },
        status: killed ? 'stopped' : 'not-running',
        metadata: {
          port,
          processPattern: `:${port}`,
          killed,
          forced: options.force
        },
      };
      
    case 'filesystem':
      {
        printInfo(`No process to stop for filesystem service`);
        printSuccess(`Filesystem service ${serviceInfo.name} stopped`);
      }
      
      return {
        ...baseResult,
        stopTime: new Date(),
        gracefulShutdown: true,
        resourceId: {
          process: {
            path: serviceInfo.config.path || '/tmp/filesystem'
          }
        },
        status: 'no-action-needed',
        metadata: {
          reason: 'No process to stop for filesystem service'
        },
      };
      
    default:
      throw new Error(`Unsupported process service: ${serviceInfo.name}`);
  }
}

async function stopExternalService(serviceInfo: ServiceDeploymentInfo, options: StopOptions, startTime: number): Promise<StopResult> {
  const baseResult = createBaseResult('stop', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  
  // External service - can't actually stop, just report
  {
    printInfo(`Cannot stop external ${serviceInfo.name} service`);
  }
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        {
          printInfo(`External database: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
        }
        
        return {
          ...baseResult,
          stopTime: new Date(),
          gracefulShutdown: true,
          resourceId: {
            external: {
              endpoint: `${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`
            }
          },
          status: 'external',
          metadata: {
            host: serviceInfo.config.host,
            port: serviceInfo.config.port || 5432,
            reason: 'External services cannot be stopped remotely'
          },
        };
      }
      break;
      
    case 'filesystem':
      if (serviceInfo.config.path) {
        {
          printInfo(`External storage: ${serviceInfo.config.path}`);
        }
        
        return {
          ...baseResult,
          stopTime: new Date(),
          gracefulShutdown: true,
          resourceId: {
            external: {
              path: serviceInfo.config.path
            }
          },
          status: 'external',
          metadata: {
            path: serviceInfo.config.path,
            reason: 'External storage cannot be stopped remotely'
          },
        };
      }
      break;
      
    default:
      {
        printInfo(`External ${serviceInfo.name} service`);
      }
  }
  
  {
    printSuccess(`External ${serviceInfo.name} service acknowledged`);
  }
  
  return {
    ...baseResult,
    stopTime: new Date(),
    gracefulShutdown: true,
    resourceId: {
      external: {
        endpoint: 'external-service'
      }
    },
    status: 'external',
    metadata: {
      reason: 'External services cannot be stopped remotely'
    },
  };
}

async function findAndKillProcess(pattern: string, name: string, options: StopOptions): Promise<boolean> {
  if (options.dryRun) {
    {
      printInfo(`[DRY RUN] Would stop ${name}`);
    }
    return true;
  }
  
  {
    printInfo(`Stopping ${name}...`);
  }
  
  try {
    // Find process using lsof (for port) or pgrep (for name)
    const isPort = pattern.startsWith(':');
    const findCmd = isPort 
      ? spawn('lsof', ['-ti', pattern])
      : spawn('pgrep', ['-f', pattern]);
    
    let pids = '';
    findCmd.stdout?.on('data', (data) => {
      pids += data.toString();
    });
    
    await new Promise((resolve) => {
      findCmd.on('exit', () => resolve(void 0));
    });
    
    if (pids.trim()) {
      const pidList = pids.trim().split('\n');
      debugLog(`Found ${pidList.length} process(es) to stop`, options);
      
      for (const pid of pidList) {
        if (pid) {
          try {
            process.kill(parseInt(pid), options.force ? 'SIGKILL' : 'SIGTERM');
          } catch (err) {
            debugLog(`Failed to kill PID ${pid}: ${err}`, options);
          }
        }
      }
      
      {
        printSuccess(`${name} stopped`);
      }
      return true;
    } else {
      {
        printInfo(`${name} not running`);
      }
      return false;
    }
  } catch (error) {
    if (options.force) {
      {
        printWarning(`Failed to stop ${name}: ${error}`);
      }
      return false;
    } else {
      throw error;
    }
  }
}


// =====================================================================
// STRUCTURED OUTPUT FUNCTION  
// =====================================================================

export async function stop(
  serviceDeployments: ServiceDeploymentInfo[],
  options: StopOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  
  // Suppress output for structured formats
  const previousSuppressOutput = setSuppressOutput(isStructuredOutput);
  
  try {
    if (options.output === 'summary') {
      printInfo(`Stopping services in ${colors.bright}${options.environment}${colors.reset} environment`);
    }
    
    if (options.output === 'summary' && options.verbose) {
      debugLog(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    }
    
    // Stop services in reverse order from start for clean shutdown
    const stopOrder = ['database', 'filesystem', 'backend', 'frontend'];
    const servicesToStop = serviceDeployments.sort((a, b) => {
      const aIndex = stopOrder.indexOf(a.name);
      const bIndex = stopOrder.indexOf(b.name);
      return bIndex - aIndex; // Reverse order
    });
    
    // Stop services and collect results
    const serviceResults: StopResult[] = [];
    
    for (const serviceInfo of servicesToStop) {
      try {
        const result = await stopServiceImpl(serviceInfo, options);
        serviceResults.push(result);
      } catch (error) {
        // Create error result
        const baseResult = createBaseResult('stop', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
        const errorResult = createErrorResult(baseResult, error as Error);
        
        const stopErrorResult: StopResult = {
          ...errorResult,
          stopTime: new Date(),
          gracefulShutdown: false,
          forcedTermination: true,
          resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
          status: 'failed',
          metadata: { error: (error as Error).message },
        };
        
        serviceResults.push(stopErrorResult);
        
        {
          printError(`Failed to stop ${serviceInfo.name}: ${error}`);
        }
        
        if (!options.force) {
          break; // Stop on first error unless --force
        }
      }
    }
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'stop',
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
    setSuppressOutput(previousSuppressOutput);
  }
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const stopCommand = new CommandBuilder<StopOptions>()
  .name('stop')
  .description('Stop services in an environment')
  .schema(StopOptionsSchema as any)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args({
    args: {
      '--environment': { type: 'string', description: 'Environment name' },
      '--force': { type: 'boolean', description: 'Force stop services' },
      '--verbose': { type: 'boolean', description: 'Verbose output' },
      '--dry-run': { type: 'boolean', description: 'Simulate actions without executing' },
      '--output': { type: 'string', description: 'Output format (summary, table, json, yaml)' },
      '--services': { type: 'string', description: 'Comma-separated list of services' },
    },
    aliases: {
      '-e': '--environment',
      '-f': '--force',
      '-v': '--verbose',
      '-o': '--output',
    }
  })
  .examples(
    'semiont stop --environment local',
    'semiont stop --environment staging --force',
    'semiont stop --environment prod --services frontend,backend'
  )
  .handler(stop)
  .build();

// Export default for compatibility
export default stopCommand;

// Export schema
export { StopOptions, StopOptionsSchema };