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

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const StopOptionsSchema = z.object({
  environment: z.string(),
  service: z.string().default('all'), // Will be validated at runtime against stoppable services
  force: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
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
    environment: process.env.SEMIONT_ENV || process.argv[2],
    verbose: process.env.SEMIONT_VERBOSE === '1',
    dryRun: process.env.SEMIONT_DRY_RUN === '1',
  };
  
  // Parse command-line arguments
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--service':
      case '-s':
        rawOptions.service = args[++i];
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

async function stopService(serviceInfo: ServiceDeploymentInfo, options: StopOptions): Promise<void> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would stop ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    return;
  }
  
  printInfo(`Stopping ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  
  switch (serviceInfo.deploymentType) {
    case 'aws':
      await stopAWSService(serviceInfo, options);
      break;
    case 'container':
      await stopContainerService(serviceInfo, options);
      break;
    case 'process':
      await stopProcessService(serviceInfo, options);
      break;
    case 'external':
      await stopExternalService(serviceInfo, options);
      break;
    default:
      printWarning(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
  }
}

async function stopAWSService(serviceInfo: ServiceDeploymentInfo, options: StopOptions): Promise<void> {
  // AWS ECS service stop
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      printInfo(`Stopping ${serviceInfo.name} ECS service`);
      printWarning('ECS service stop not yet implemented - use AWS Console');
      break;
    case 'database':
      printInfo(`Stopping RDS instance for ${serviceInfo.name}`);
      printWarning('RDS instance stop not yet implemented - use AWS Console');
      break;
    case 'filesystem':
      printInfo(`Unmounting EFS volumes for ${serviceInfo.name}`);
      printWarning('EFS unmount not yet implemented');
      break;
  }
}

async function stopContainerService(serviceInfo: ServiceDeploymentInfo, options: StopOptions): Promise<void> {
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}`;
  
  try {
    const success = await stopContainer(containerName, {
      force: options.force,
      verbose: options.verbose,
      timeout: 10
    });
    
    if (success) {
      printSuccess(`Container stopped: ${containerName}`);
    } else {
      throw new Error(`Failed to stop container: ${containerName}`);
    }
  } catch (error) {
    if (options.force) {
      printWarning(`Failed to stop ${serviceInfo.name} container: ${error}`);
    } else {
      throw error;
    }
  }
}

async function stopProcessService(serviceInfo: ServiceDeploymentInfo, options: StopOptions): Promise<void> {
  // Process deployment (local development)
  switch (serviceInfo.name) {
    case 'database':
      printInfo(`Stopping PostgreSQL service for ${serviceInfo.name}`);
      printWarning('Local PostgreSQL service stop not yet implemented');
      break;
      
    case 'frontend':
    case 'backend':
      // Kill process on the service's port
      const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
      await findAndKillProcess(`:${port}`, serviceInfo.name, options);
      break;
      
    case 'filesystem':
      printInfo(`No process to stop for filesystem service`);
      printSuccess(`Filesystem service ${serviceInfo.name} stopped`);
      break;
  }
}

async function stopExternalService(serviceInfo: ServiceDeploymentInfo, options: StopOptions): Promise<void> {
  // External service - can't actually stop, just report
  printInfo(`Cannot stop external ${serviceInfo.name} service`);
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        printInfo(`External database: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
      }
      break;
    case 'filesystem':
      if (serviceInfo.config.path) {
        printInfo(`External storage: ${serviceInfo.config.path}`);
      }
      break;
    default:
      printInfo(`External ${serviceInfo.name} service`);
  }
  
  printSuccess(`External ${serviceInfo.name} service acknowledged`);
}

async function findAndKillProcess(pattern: string, name: string, options: StopOptions): Promise<void> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would stop ${name}`);
    return;
  }
  
  printInfo(`Stopping ${name}...`);
  
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
      
      printSuccess(`${name} stopped`);
    } else {
      printInfo(`${name} not running`);
    }
  } catch (error) {
    if (options.force) {
      printWarning(`Failed to stop ${name}: ${error}`);
    } else {
      throw error;
    }
  }
}


// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  printInfo(`Stopping services in ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.verbose) {
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
    
    printDebug(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    
    // Stop services in reverse order from start for clean shutdown
    const stopOrder = ['frontend', 'backend', 'database', 'filesystem'];
    const servicesToStop = serviceDeployments.sort((a, b) => {
      const aIndex = stopOrder.indexOf(a.name);
      const bIndex = stopOrder.indexOf(b.name);
      return bIndex - aIndex; // Reverse order
    });
    
    let allSucceeded = true;
    for (const serviceInfo of servicesToStop) {
      try {
        await stopService(serviceInfo, options);
      } catch (error) {
        printError(`Failed to stop ${serviceInfo.name}: ${error}`);
        allSucceeded = false;
        if (!options.force) {
          break; // Stop on first error unless --force
        }
      }
    }
    
    if (allSucceeded) {
      printSuccess('Services stopped successfully');
    } else {
      printWarning('Some services failed to stop - check logs above');
      if (!options.force) {
        printInfo('Use --force to ignore errors and continue');
      }
      process.exit(1);
    }
  } catch (error) {
    printError(`Failed to stop services: ${error}`);
    if (!options.force) {
      printInfo('Use --force to ignore errors and continue');
    }
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    printError(`Unexpected error: ${error}`);
    process.exit(1);
  });
}

export { main, StopOptions, StopOptionsSchema };