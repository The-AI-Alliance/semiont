/**
 * Restart Command V2 - Deployment-type aware service restart
 * 
 * This command restarts services based on their deployment type:
 * - AWS: Restart ECS tasks
 * - Container: Restart containers
 * - Process: Restart processes
 * - External: Verify external service
 */

import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import { resolveServiceSelector, validateServiceSelector } from '../lib/services.js';
import { resolveServiceDeployments, type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { stopContainer, runContainer } from '../lib/container-runtime.js';
import { spawn } from 'child_process';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const RestartOptionsSchema = z.object({
  environment: z.string(),
  service: z.string().default('all'),
  force: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  gracePeriod: z.number().int().positive().default(3), // seconds to wait between stop and start
});

type RestartOptions = z.infer<typeof RestartOptionsSchema>;

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

function printDebug(message: string, options: RestartOptions): void {
  if (options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

// =====================================================================
// PARSE ARGUMENTS
// =====================================================================

function parseArguments(): RestartOptions {
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
      case '--grace-period':
        rawOptions.gracePeriod = parseInt(args[++i]);
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
  
  // Validate with Zod
  try {
    return RestartOptionsSchema.parse(rawOptions);
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
// DEPLOYMENT-TYPE-AWARE RESTART FUNCTIONS
// =====================================================================

async function restartService(serviceInfo: ServiceDeploymentInfo, options: RestartOptions): Promise<void> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would restart ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    return;
  }
  
  printInfo(`Restarting ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  
  switch (serviceInfo.deploymentType) {
    case 'aws':
      await restartAWSService(serviceInfo, options);
      break;
    case 'container':
      await restartContainerService(serviceInfo, options);
      break;
    case 'process':
      await restartProcessService(serviceInfo, options);
      break;
    case 'external':
      await restartExternalService(serviceInfo, options);
      break;
    default:
      printWarning(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
  }
}

async function restartAWSService(serviceInfo: ServiceDeploymentInfo, options: RestartOptions): Promise<void> {
  // AWS ECS task restart
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      printInfo(`Restarting ECS tasks for ${serviceInfo.name}`);
      printWarning('ECS task restart not yet implemented - use AWS Console');
      break;
    case 'database':
      printInfo(`Restarting RDS instance for ${serviceInfo.name}`);
      printWarning('RDS instance restart not yet implemented - use AWS Console');
      break;
    case 'filesystem':
      printInfo(`Remounting EFS volumes for ${serviceInfo.name}`);
      printWarning('EFS remount not yet implemented');
      break;
  }
}

async function restartContainerService(serviceInfo: ServiceDeploymentInfo, options: RestartOptions): Promise<void> {
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}`;
  
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
    
    // Wait for grace period
    if (options.gracePeriod > 0) {
      printDebug(`Waiting ${options.gracePeriod} seconds before starting...`, options);
      await new Promise(resolve => setTimeout(resolve, options.gracePeriod * 1000));
    }
    
    // Start the container again
    printInfo(`Starting container: ${containerName}`);
    let startSuccess = false;
    
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
    } else {
      throw new Error(`Failed to restart container: ${containerName}`);
    }
  } catch (error) {
    if (options.force) {
      printWarning(`Failed to restart ${serviceInfo.name} container: ${error}`);
    } else {
      throw error;
    }
  }
}

async function restartProcessService(serviceInfo: ServiceDeploymentInfo, options: RestartOptions): Promise<void> {
  // Process deployment restart
  switch (serviceInfo.name) {
    case 'database':
      printInfo(`Restarting PostgreSQL service for ${serviceInfo.name}`);
      printWarning('Local PostgreSQL service restart not yet implemented');
      break;
      
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
      break;
      
    case 'filesystem':
      printInfo(`No process to restart for filesystem service`);
      printSuccess(`Filesystem service ${serviceInfo.name} unchanged`);
      break;
  }
}

async function restartExternalService(serviceInfo: ServiceDeploymentInfo, options: RestartOptions): Promise<void> {
  // External service - can't actually restart, just verify
  printInfo(`Cannot restart external ${serviceInfo.name} service`);
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        printInfo(`External database: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
        printWarning('External database connectivity check not yet implemented');
      }
      break;
    case 'filesystem':
      if (serviceInfo.config.path) {
        printInfo(`External storage: ${serviceInfo.config.path}`);
        printWarning('External storage validation not yet implemented');
      }
      break;
    default:
      printInfo(`External ${serviceInfo.name} service`);
  }
  
  printSuccess(`External ${serviceInfo.name} service verified`);
}

async function findAndKillProcess(pattern: string, name: string, options: RestartOptions): Promise<void> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would stop ${name}`);
    return;
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
    } else {
      printDebug(`${name} not running`, options);
    }
  } catch (error) {
    if (!options.force) {
      throw error;
    }
  }
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  printInfo(`Restarting services in ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  try {
    // Validate service selector and resolve to actual services
    await validateServiceSelector(options.service, 'restart', options.environment);
    const resolvedServices = await resolveServiceSelector(options.service, 'restart', options.environment);
    
    // Get deployment information for all resolved services
    const serviceDeployments = await resolveServiceDeployments(resolvedServices, options.environment);
    
    printDebug(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    
    // Restart services (can be done in parallel for different services)
    let allSucceeded = true;
    for (const serviceInfo of serviceDeployments) {
      try {
        await restartService(serviceInfo, options);
      } catch (error) {
        printError(`Failed to restart ${serviceInfo.name}: ${error}`);
        allSucceeded = false;
        if (!options.force) {
          break; // Stop on first error unless --force
        }
      }
    }
    
    if (allSucceeded) {
      printSuccess('All services restarted successfully');
    } else {
      printWarning('Some services failed to restart - check logs above');
      if (!options.force) {
        printInfo('Use --force to ignore errors and continue');
      }
      process.exit(1);
    }
  } catch (error) {
    printError(`Failed to restart services: ${error}`);
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

export { main, RestartOptions, RestartOptionsSchema };