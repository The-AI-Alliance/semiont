/**
 * Stop Command V2 - Stop services with type-safe argument parsing
 * 
 * This version works with the new CLI structure using Zod validation
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { colors } from '../lib/cli-colors.js';
import { resolveServiceSelector, validateServiceSelector } from '../lib/services.js';
import { resolveServiceDeployments, type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { stopContainer } from '../lib/container-runtime.js';
import { 
  StopResult, 
  CommandResults, 
  createBaseResult, 
  createErrorResult,
  ResourceIdentifier 
} from '../lib/command-results.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const StopOptionsSchema = z.object({
  environment: z.string(),
  service: z.string().default('all'), // Will be validated at runtime against stoppable services
  force: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
});

type StopOptions = z.infer<typeof StopOptionsSchema>;

// Colors are now imported from centralized module

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

function printDebug(message: string, options: StopOptions): void {
  if (options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

// =====================================================================
// PARSE ARGUMENTS
// =====================================================================

function parseArguments(): StopOptions {
  const rawOptions: any = {
    environment: process.env.SEMIONT_ENV,
    verbose: process.env.SEMIONT_VERBOSE === '1',
    dryRun: process.env.SEMIONT_DRY_RUN === '1',
    output: process.env.SEMIONT_OUTPUT || 'summary',
  };
  
  // Parse command-line arguments
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--environment':
      case '-e':
        rawOptions.environment = args[++i];
        break;
      case '--service':
      case '-s':
        rawOptions.service = args[++i];
        break;
      case '--output':
      case '-o':
        rawOptions.output = args[++i];
        break;
      case '--force':
      case '-f':
        rawOptions.force = true;
        break;
      case '--verbose':
      case '-v':
        rawOptions.verbose = true;
        break;
      case '--dry-run':
        rawOptions.dryRun = true;
        break;
    }
  }
  
  try {
    return StopOptionsSchema.parse(rawOptions);
  } catch (error) {
    if (error instanceof z.ZodError) {
      printError('Invalid arguments:');
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

// =====================================================================
// ENVIRONMENT VALIDATION
// =====================================================================

async function validateEnvironment(options: StopOptions): Promise<void> {
  const validEnvironments = ['local', 'development', 'staging', 'production'];
  
  if (!validEnvironments.includes(options.environment)) {
    printError(`Invalid environment: ${options.environment}`);
    printInfo(`Available environments: ${validEnvironments.join(', ')}`);
    process.exit(1);
  }
  
  printDebug(`Validated environment: ${options.environment}`, options);
}

// =====================================================================
// SERVICE STOP FUNCTIONS
// =====================================================================

async function stopService(serviceInfo: ServiceDeploymentInfo, options: StopOptions, isStructuredOutput: boolean = false): Promise<StopResult> {
  const startTime = Date.now();
  
  if (options.dryRun) {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`[DRY RUN] Would stop ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    }
    
    return {
      ...createBaseResult('stop', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime),
      stopTime: new Date(),
      gracefulShutdown: true,
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'dry-run',
      metadata: { dryRun: true },
    };
  }
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Stopping ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  }
  
  try {
    switch (serviceInfo.deploymentType) {
      case 'aws':
        return await stopAWSService(serviceInfo, options, startTime, isStructuredOutput);
      case 'container':
        return await stopContainerService(serviceInfo, options, startTime, isStructuredOutput);
      case 'process':
        return await stopProcessService(serviceInfo, options, startTime, isStructuredOutput);
      case 'external':
        return await stopExternalService(serviceInfo, options, startTime, isStructuredOutput);
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

async function stopAWSService(serviceInfo: ServiceDeploymentInfo, options: StopOptions, startTime: number, isStructuredOutput: boolean = false): Promise<StopResult> {
  const baseResult = createBaseResult('stop', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  
  // AWS ECS service stop
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      if (!isStructuredOutput && options.output === 'summary') {
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
      if (!isStructuredOutput && options.output === 'summary') {
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
      if (!isStructuredOutput && options.output === 'summary') {
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

async function stopContainerService(serviceInfo: ServiceDeploymentInfo, options: StopOptions, startTime: number, isStructuredOutput: boolean = false): Promise<StopResult> {
  const baseResult = createBaseResult('stop', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}`;
  
  try {
    const success = await stopContainer(containerName, {
      force: options.force,
      verbose: options.verbose,
      timeout: 10
    });
    
    if (success) {
      if (!isStructuredOutput && options.output === 'summary') {
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
      if (!isStructuredOutput && options.output === 'summary') {
        printWarning(`Failed to stop ${serviceInfo.name} container: ${error}`);
      }
      
      return {
        ...baseResult,
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

async function stopProcessService(serviceInfo: ServiceDeploymentInfo, options: StopOptions, startTime: number, isStructuredOutput: boolean = false): Promise<StopResult> {
  const baseResult = createBaseResult('stop', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  
  // Process deployment (local development)
  switch (serviceInfo.name) {
    case 'database':
      if (!isStructuredOutput && options.output === 'summary') {
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
      const killed = await findAndKillProcess(`:${port}`, serviceInfo.name, options, isStructuredOutput);
      
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
      if (!isStructuredOutput && options.output === 'summary') {
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

async function stopExternalService(serviceInfo: ServiceDeploymentInfo, options: StopOptions, startTime: number, isStructuredOutput: boolean = false): Promise<StopResult> {
  const baseResult = createBaseResult('stop', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  
  // External service - can't actually stop, just report
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Cannot stop external ${serviceInfo.name} service`);
  }
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        if (!isStructuredOutput && options.output === 'summary') {
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
        if (!isStructuredOutput && options.output === 'summary') {
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
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`External ${serviceInfo.name} service`);
      }
  }
  
  if (!isStructuredOutput && options.output === 'summary') {
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

async function findAndKillProcess(pattern: string, name: string, options: StopOptions, isStructuredOutput: boolean = false): Promise<boolean> {
  if (options.dryRun) {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`[DRY RUN] Would stop ${name}`);
    }
    return true;
  }
  
  if (!isStructuredOutput && options.output === 'summary') {
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
      printDebug(`Found ${pidList.length} process(es) to stop`, options);
      
      for (const pid of pidList) {
        if (pid) {
          try {
            process.kill(parseInt(pid), options.force ? 'SIGKILL' : 'SIGTERM');
          } catch (err) {
            printDebug(`Failed to kill PID ${pid}: ${err}`, options);
          }
        }
      }
      
      if (!isStructuredOutput && options.output === 'summary') {
        printSuccess(`${name} stopped`);
      }
      return true;
    } else {
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`${name} not running`);
      }
      return false;
    }
  } catch (error) {
    if (options.force) {
      if (!isStructuredOutput && options.output === 'summary') {
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

export async function stop(options: StopOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Stopping services in ${colors.bright}${options.environment}${colors.reset} environment`);
  }
  
  if (options.verbose && !isStructuredOutput && options.output === 'summary') {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  // Validate environment
  await validateEnvironment(options);
  
  try {
    // Validate service selector and resolve to actual services
    await validateServiceSelector(options.service, 'stop', options.environment);
    const resolvedServices = await resolveServiceSelector(options.service, 'stop', options.environment);
    
    // Get deployment information for all resolved services
    const serviceDeployments = await resolveServiceDeployments(resolvedServices, options.environment);
    
    if (options.verbose && !isStructuredOutput && options.output === 'summary') {
      printDebug(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    }
    
    // Stop services in reverse order from start for clean shutdown
    const stopOrder = ['frontend', 'backend', 'database', 'filesystem'];
    const servicesToStop = serviceDeployments.sort((a, b) => {
      const aIndex = stopOrder.indexOf(a.name);
      const bIndex = stopOrder.indexOf(b.name);
      return bIndex - aIndex; // Reverse order
    });
    
    // Stop services and collect results
    const serviceResults: StopResult[] = [];
    
    for (const serviceInfo of servicesToStop) {
      try {
        const result = await stopService(serviceInfo, options, isStructuredOutput);
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
        
        if (!isStructuredOutput && options.output === 'summary') {
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
    
  } catch (error) {
    if (!isStructuredOutput) {
      printError(`Failed to stop services: ${error}`);
    }
    
    return {
      command: 'stop',
      environment: options.environment,
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
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  try {
    const results = await stop(options);
    
    // Handle structured output
    if (options.output !== 'summary') {
      const { formatResults } = await import('../lib/output-formatter.js');
      const formatted = formatResults(results, options.output);
      console.log(formatted);
      return;
    }
    
    // For summary format, show traditional output with final status
    if (results.summary.succeeded === results.summary.total) {
      printSuccess('Services stopped successfully');
    } else {
      printWarning('Some services failed to stop - check logs above');
      if (!options.force) {
        printInfo('Use --force to ignore errors and continue');
      }
      process.exit(1);
    }
    
    // Exit with appropriate code
    if (results.summary.failed > 0) {
      process.exit(1);
    }
    
  } catch (error) {
    printError(`Stop failed: ${error}`);
    process.exit(1);
  }
}

// Command file - no direct execution needed

export { main, StopOptions, StopOptionsSchema };