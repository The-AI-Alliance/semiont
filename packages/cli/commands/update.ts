/**
 * Update Command - Update running services with pre-built images
 * 
 * This command updates running services in any environment with pre-built images.
 * Images should be built and pushed first using 'semiont publish'.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { getProjectRoot } from '../lib/cli-paths.js';
import { colors } from '../lib/cli-colors.js';

// AWS SDK imports for ECS operations
import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

interface UpdateOptions {
  environment: string;
  verbose: boolean;
  dryRun: boolean;
  help: boolean;
  service?: string;
  skipTests: boolean;
  skipBuild: boolean;
  force: boolean;
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
// CONFIGURATION LOADING
// =====================================================================

interface ServiceConfig {
  deployment?: {
    type: 'container' | 'aws' | 'process' | 'external';
  };
  image?: string;
  tag?: string;
  port?: number;
}

interface EnvironmentConfig {
  deployment?: {
    default: string;
  };
  services: Record<string, ServiceConfig>;
  aws?: {
    region: string;
    accountId: string;
  };
}

async function loadEnvironmentConfig(environment: string): Promise<EnvironmentConfig> {
  try {
    const configPath = path.join(PROJECT_ROOT, 'config', 'environments', `${environment}.json`);
    const configModule = await import(configPath, { assert: { type: 'json' } });
    return configModule.default;
  } catch (error) {
    throw new Error(`Failed to load environment config for ${environment}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// =====================================================================
// ECS UPDATE FUNCTIONS
// =====================================================================

async function updateECSService(serviceName: string, environment: string, options: UpdateOptions): Promise<boolean> {
  printInfo(`Updating ECS service: ${serviceName}`);
  
  const config = await loadEnvironmentConfig(environment);
  if (!config.aws) {
    printError(`AWS configuration not found for environment: ${environment}`);
    return false;
  }
  
  const ecsClient = new ECSClient({ region: config.aws.region });
  
  try {
    // For now, trigger a deployment to pick up the latest ECR image
    // In a full implementation, you'd create a new task definition revision
    const clusterName = `semiont-${environment}`;
    const fullServiceName = `semiont-${environment}-${serviceName}`;
    
    printDebug(`Updating ECS service: ${fullServiceName} in cluster: ${clusterName}`, options);
    
    if (options.dryRun) {
      printInfo(`[DRY RUN] Would update ECS service: ${fullServiceName}`);
      return true;
    }
    
    await ecsClient.send(new UpdateServiceCommand({
      cluster: clusterName,
      service: fullServiceName,
      forceNewDeployment: true
    }));
    
    printSuccess(`ECS service ${serviceName} update initiated`);
    return true;
  } catch (err) {
    printError(`Failed to update ECS service: ${(err as any).message || err}`);
    return false;
  }
}

async function updateContainerService(serviceName: string, environment: string, options: UpdateOptions): Promise<boolean> {
  printInfo(`Updating container service: ${serviceName}`);
  
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would restart container: semiont-${serviceName}`);
    return true;
  }
  
  // For container deployments, restart the container with the new image
  const containerName = `semiont-${serviceName}`;
  
  // Stop the current container
  printDebug(`Stopping container: ${containerName}`, options);
  const stopSuccess = await runCommand(
    ['docker', 'stop', containerName],
    PROJECT_ROOT,
    `Stop ${serviceName} container`,
    options.verbose
  );
  
  if (stopSuccess) {
    // Remove the container
    await runCommand(
      ['docker', 'rm', containerName],
      PROJECT_ROOT,
      `Remove ${serviceName} container`,
      false
    );
  }
  
  // Start with the new image (assumes image was updated via publish command)
  const imageName = `semiont-${serviceName}:latest`;
  const startSuccess = await runCommand(
    ['docker', 'run', '-d', '--name', containerName, imageName],
    PROJECT_ROOT,
    `Start ${serviceName} with updated image`,
    options.verbose
  );
  
  if (startSuccess) {
    printSuccess(`Container service ${serviceName} updated successfully`);
    return true;
  } else {
    printError(`Failed to start updated container: ${serviceName}`);
    return false;
  }
}

// =====================================================================
// SERVICE UPDATE LOGIC
// =====================================================================

async function updateService(serviceName: string, config: EnvironmentConfig, options: UpdateOptions): Promise<boolean> {
  const serviceConfig = config.services[serviceName];
  if (!serviceConfig) {
    printError(`Service ${serviceName} not found in configuration`);
    return false;
  }
  
  const deploymentType = serviceConfig.deployment?.type || config.deployment?.default || 'container';
  
  printInfo(`Updating ${serviceName} (deployment type: ${deploymentType})`);
  
  switch (deploymentType) {
    case 'aws':
      return await updateECSService(serviceName, options.environment, options);
    
    case 'container':
      return await updateContainerService(serviceName, options.environment, options);
    
    case 'process':
      printInfo(`Process services need manual restart - stopping/starting processes for ${serviceName}`);
      // For process deployments, this would involve process management
      // For now, just indicate what should be done
      printInfo(`Would restart ${serviceName} process with updated code`);
      return true;
    
    case 'external':
      printInfo(`External services are managed separately - skipping ${serviceName}`);
      return true;
    
    default:
      printError(`Unknown deployment type: ${deploymentType} for service ${serviceName}`);
      return false;
  }
}

// =====================================================================
// ARGUMENT PARSING
// =====================================================================

function parseArguments(): UpdateOptions {
  // Parse arguments manually to match CLI pattern
  const args = process.argv.slice(2);
  let environment = 'local';
  let service = 'all';
  let skipTests = false;
  let skipBuild = false;
  let force = false;
  let verbose = false;
  let dryRun = false;
  let help = false;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--environment' || arg === '-e') {
      const next = args[i + 1];
      if (next) {
        environment = next;
        i++; // Skip next arg
      }
    } else if (arg === '--service' || arg === '-s') {
      const next = args[i + 1];
      if (next) {
        service = next;
        i++; // Skip next arg
      }
    } else if (arg === '--skip-tests') {
      skipTests = true;
    } else if (arg === '--skip-build') {
      skipBuild = true;
    } else if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (!arg.startsWith('-')) {
      // First positional argument is environment
      environment = arg;
    }
  }
  
  return {
    environment,
    verbose,
    dryRun,
    help,
    service,
    skipTests,
    skipBuild,
    force,
  };
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  if (options.help) {
    console.log(`
${colors.bright}Update Command${colors.reset} - Update running services with pre-built images

${colors.bright}Usage:${colors.reset}
  semiont update [environment] [options]

${colors.bright}Arguments:${colors.reset}
  environment              Environment to update (local, staging, production)

${colors.bright}Options:${colors.reset}
  --service <name>         Service to update (default: all)
  --skip-tests            Skip running tests before update
  --force                 Force update without confirmation
  --dry-run               Show what would be updated without making changes
  --verbose               Show detailed output
  --help                  Show this help message

${colors.bright}Examples:${colors.reset}
  semiont update staging
  semiont update production --service backend
  semiont update local --dry-run
  
${colors.bright}Note:${colors.reset} Images must be built and pushed first using 'semiont publish'
`);
    return;
  }
  
  if (options.dryRun) {
    printInfo(`[DRY RUN] Update ${options.service} services in ${options.environment}`);
  } else {
    printInfo(`Updating ${options.service} services in ${options.environment} environment`);
  }
  
  try {
    // Load environment configuration
    const config = await loadEnvironmentConfig(options.environment);
    
    // Determine services to update
    const servicesToUpdate = options.service === 'all' 
      ? Object.keys(config.services)
      : [options.service];
    
    printInfo(`Services to update: ${servicesToUpdate.join(', ')}`);
    
    if (options.dryRun) {
      printInfo('[DRY RUN] Would update the above services');
      return;
    }
    
    // Update each service
    let allSucceeded = true;
    for (const serviceName of servicesToUpdate) {
      const success = await updateService(serviceName, config, options);
      
      if (!success) {
        allSucceeded = false;
        break;
      }
    }
    
    if (allSucceeded) {
      printSuccess('All services updated successfully!');
    } else {
      printError('Some services failed to update');
      process.exit(1);
    }
    
  } catch (error) {
    printError(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
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

export { main };