/**
 * Update Command V2 - Deployment-type aware service updates
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
import { resolveServiceSelector, validateServiceSelector } from '../lib/services.js';
import { resolveServiceDeployments, type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { stopContainer, runContainer } from '../lib/container-runtime.js';
import { getProjectRoot } from '../lib/cli-paths.js';

// AWS SDK imports for ECS operations
import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const UpdateOptionsSchema = z.object({
  environment: z.string(),
  service: z.string().default('all'),
  skipTests: z.boolean().default(false),
  skipBuild: z.boolean().default(false),
  force: z.boolean().default(false),
  gracePeriod: z.number().int().positive().default(3), // seconds to wait between stop and start
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

type UpdateOptions = z.infer<typeof UpdateOptionsSchema>;

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

function printDebug(message: string, options: UpdateOptions): void {
  if (options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

async function runCommand(
  command: string[],
  cwd: string,
  _description: string,
  verbose: boolean = false
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: verbose ? 'inherit' : 'pipe',
    });

    proc.on('exit', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

// =====================================================================
// PARSE ARGUMENTS
// =====================================================================

function parseArguments(): UpdateOptions {
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
      case '--skip-tests':
        rawOptions.skipTests = true;
        break;
      case '--skip-build':
        rawOptions.skipBuild = true;
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
    return UpdateOptionsSchema.parse(rawOptions);
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
// DEPLOYMENT-TYPE-AWARE UPDATE FUNCTIONS
// =====================================================================

async function updateService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions): Promise<void> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would update ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    return;
  }
  
  printInfo(`Updating ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  
  switch (serviceInfo.deploymentType) {
    case 'aws':
      await updateAWSService(serviceInfo, options);
      break;
    case 'container':
      await updateContainerService(serviceInfo, options);
      break;
    case 'process':
      await updateProcessService(serviceInfo, options);
      break;
    case 'external':
      await updateExternalService(serviceInfo, options);
      break;
    default:
      printWarning(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
  }
}

async function updateAWSService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions): Promise<void> {
  // AWS ECS service updates
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      printInfo(`Triggering ECS deployment for ${serviceInfo.name}`);
      
      if (!serviceInfo.config.aws || !serviceInfo.config.aws.region) {
        printError('AWS configuration not found in service config');
        throw new Error('Missing AWS configuration');
      }
      
      const ecsClient = new ECSClient({ region: serviceInfo.config.aws.region });
      const clusterName = `semiont-${options.environment}`;
      const fullServiceName = `semiont-${options.environment}-${serviceInfo.name}`;
      
      try {
        await ecsClient.send(new UpdateServiceCommand({
          cluster: clusterName,
          service: fullServiceName,
          forceNewDeployment: true
        }));
        
        printSuccess(`ECS deployment initiated for ${serviceInfo.name}`);
      } catch (error) {
        printError(`Failed to update ECS service ${serviceInfo.name}: ${error}`);
        throw error;
      }
      break;
      
    case 'database':
      printInfo(`RDS instances cannot be updated via this command`);
      printWarning('Use AWS Console or RDS CLI to update database instances');
      break;
      
    case 'filesystem':
      printInfo(`EFS filesystems do not require updates`);
      printSuccess(`EFS ${serviceInfo.name} requires no action`);
      break;
  }
}

async function updateContainerService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions): Promise<void> {
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}`;
  
  try {
    // Stop the current container
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
    
    // Start the container again with updated image
    printInfo(`Starting updated container: ${containerName}`);
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
        // Volumes don't need updating
        printInfo(`Container volumes don't require updates`);
        startSuccess = true;
        break;
    }
    
    if (startSuccess) {
      printSuccess(`Container updated: ${containerName}`);
    } else {
      throw new Error(`Failed to start updated container: ${containerName}`);
    }
  } catch (error) {
    if (options.force) {
      printWarning(`Failed to update ${serviceInfo.name} container: ${error}`);
    } else {
      throw error;
    }
  }
}

async function updateProcessService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions): Promise<void> {
  // Process deployment updates
  switch (serviceInfo.name) {
    case 'database':
      printInfo(`PostgreSQL service updates require manual intervention`);
      printWarning('Use your system\'s package manager to update PostgreSQL');
      break;
      
    case 'frontend':
    case 'backend':
      // Kill and restart process with updated code
      const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
      
      // Find and kill existing process
      printInfo(`Stopping process on port ${port}`);
      await findAndKillProcess(`:${port}`, serviceInfo.name, options);
      
      // Wait for grace period
      if (options.gracePeriod > 0) {
        printDebug(`Waiting ${options.gracePeriod} seconds before starting...`, options);
        await new Promise(resolve => setTimeout(resolve, options.gracePeriod * 1000));
      }
      
      // Start new process with updated code
      printInfo(`Starting updated process for ${serviceInfo.name}`);
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
      printSuccess(`Process updated on port ${port}`);
      break;
      
    case 'filesystem':
      printInfo(`No updates required for filesystem service`);
      printSuccess(`Filesystem service ${serviceInfo.name} unchanged`);
      break;
  }
}

async function updateExternalService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions): Promise<void> {
  // External service - can't actually update, just verify
  printInfo(`Cannot update external ${serviceInfo.name} service`);
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        printInfo(`External database: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
        printWarning('External database updates must be managed by the database provider');
      }
      break;
    case 'filesystem':
      if (serviceInfo.config.path) {
        printInfo(`External storage: ${serviceInfo.config.path}`);
        printWarning('External storage updates must be managed by the storage provider');
      }
      break;
    default:
      printInfo(`External ${serviceInfo.name} service`);
      printWarning('External service updates must be managed separately');
  }
  
  printSuccess(`External ${serviceInfo.name} service noted`);
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
  
  printInfo(`Updating services in ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  try {
    // Validate service selector and resolve to actual services
    await validateServiceSelector(options.service, 'start', options.environment);
    const resolvedServices = await resolveServiceSelector(options.service, 'start', options.environment);
    
    // Get deployment information for all resolved services
    const serviceDeployments = await resolveServiceDeployments(resolvedServices, options.environment);
    
    printDebug(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    
    if (options.dryRun) {
      printInfo('[DRY RUN] Would update the following services:');
      for (const serviceInfo of serviceDeployments) {
        printInfo(`  - ${serviceInfo.name} (${serviceInfo.deploymentType})`);
      }
      return;
    }
    
    // Update services (can be done in parallel for different services)
    let allSucceeded = true;
    for (const serviceInfo of serviceDeployments) {
      try {
        await updateService(serviceInfo, options);
      } catch (error) {
        printError(`Failed to update ${serviceInfo.name}: ${error}`);
        allSucceeded = false;
        if (!options.force) {
          break; // Stop on first error unless --force
        }
      }
    }
    
    if (allSucceeded) {
      printSuccess('All services updated successfully');
      printInfo('Services are now running with the latest updates');
    } else {
      printWarning('Some services failed to update - check logs above');
      if (!options.force) {
        printInfo('Use --force to ignore errors and continue');
      }
      process.exit(1);
    }
  } catch (error) {
    printError(`Failed to update services: ${error}`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('❌ Unexpected error:', error);
    process.exit(1);
  });
}

export { main, UpdateOptions, UpdateOptionsSchema };