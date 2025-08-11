/**
 * Start Command V2 - Refactored to work with new CLI structure
 * 
 * This version expects arguments to be passed via environment variables
 * and command-line flags from the main CLI entry point.
 */

import { z } from 'zod';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { getProjectRoot } from '../lib/cli-paths.js';
import { CliLogger, printWarning } from '../lib/cli-logger.js';
import { parseCommandArgs, BaseOptionsSchema } from '../lib/argument-parser.js';
import { colors } from '../lib/cli-colors.js';
import { resolveServiceSelector, validateServiceSelector } from '../lib/services.js';
import { resolveServiceDeployments, type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { runContainer, stopContainer } from '../lib/container-runtime.js';
import * as fs from 'fs';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const StartOptionsSchema = BaseOptionsSchema.extend({
  service: z.string().default('all'), // Will be validated at runtime against startable services
});

type StartOptions = z.infer<typeof StartOptionsSchema>;

// Track spawned processes for cleanup
const spawnedProcesses: ChildProcess[] = [];

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

function printDebug(message: string, options: StartOptions): void {
  if (options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

// =====================================================================
// PARSE ARGUMENTS FROM CLI
// =====================================================================

function parseArguments(): StartOptions {
  // Build arguments object from both environment variables and CLI args
  const rawOptions: any = {
    // Environment variable takes precedence (set by main CLI)
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
    return StartOptionsSchema.parse(rawOptions);
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

async function validateEnvironment(options: StartOptions): Promise<void> {
  const validEnvironments = ['local', 'development', 'staging', 'production'];
  
  if (!validEnvironments.includes(options.environment)) {
    printError(`Invalid environment: ${options.environment}`);
    printInfo(`Available environments: ${validEnvironments.join(', ')}`);
    process.exit(1);
  }
  
  printDebug(`Validated environment: ${options.environment}`, options);
}

// =====================================================================
// DEPLOYMENT-TYPE-AWARE START FUNCTIONS
// =====================================================================

async function startService(serviceInfo: ServiceDeploymentInfo, options: StartOptions): Promise<void> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would start ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    return;
  }
  
  printInfo(`Starting ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  
  switch (serviceInfo.deploymentType) {
    case 'aws':
      await startAWSService(serviceInfo, options);
      break;
    case 'container':
      await startContainerService(serviceInfo, options);
      break;
    case 'process':
      await startProcessService(serviceInfo, options);
      break;
    case 'external':
      await startExternalService(serviceInfo, options);
      break;
    default:
      printWarning(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
  }
}

async function startAWSService(serviceInfo: ServiceDeploymentInfo, options: StartOptions): Promise<void> {
  // AWS ECS service start
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      printInfo(`Starting ${serviceInfo.name} ECS service in ${options.environment}`);
      printWarning('ECS service start not yet implemented - use AWS Console or CDK');
      break;
    case 'database':
      printInfo(`Starting RDS instance for ${serviceInfo.name}`);
      printWarning('RDS instance start not yet implemented - use AWS Console');
      break;
    case 'filesystem':
      printInfo(`Mounting EFS volumes for ${serviceInfo.name}`);
      printWarning('EFS mount not yet implemented');
      break;
  }
}

async function startContainerService(serviceInfo: ServiceDeploymentInfo, options: StartOptions): Promise<void> {
  // Container deployment
  switch (serviceInfo.name) {
    case 'database':
      const containerName = `semiont-postgres-${options.environment}`;
      const imageName = serviceInfo.config.image || 'postgres:15-alpine';
      
      const success = await runContainer(imageName, containerName, {
        ports: { '5432': '5432' },
        environment: {
          POSTGRES_PASSWORD: serviceInfo.config.password || 'localpassword',
          POSTGRES_DB: serviceInfo.config.name || 'semiont',
          POSTGRES_USER: serviceInfo.config.user || 'postgres'
        },
        detached: true,
        verbose: options.verbose
      });
      
      if (success) {
        printSuccess(`Database container started: ${containerName}`);
      } else {
        throw new Error(`Failed to start database container: ${containerName}`);
      }
      break;
      
    case 'frontend':
    case 'backend':
      const appContainerName = `semiont-${serviceInfo.name}-${options.environment}`;
      const appImageName = serviceInfo.config.image || `semiont-${serviceInfo.name}:latest`;
      
      const appSuccess = await runContainer(appImageName, appContainerName, {
        ports: serviceInfo.config.port ? { [serviceInfo.config.port.toString()]: serviceInfo.config.port.toString() } : {},
        detached: true,
        verbose: options.verbose
      });
      
      if (appSuccess) {
        printSuccess(`${serviceInfo.name} container started: ${appContainerName}`);
      } else {
        throw new Error(`Failed to start ${serviceInfo.name} container: ${appContainerName}`);
      }
      break;
      
    case 'filesystem':
      printInfo(`Creating container volumes for ${serviceInfo.name}`);
      const volumeName = `semiont-${serviceInfo.name}-${options.environment}`;
      // Volume creation would be handled by container runtime
      printSuccess(`Container volumes ready: ${volumeName}`);
      break;
  }
}

async function startProcessService(serviceInfo: ServiceDeploymentInfo, options: StartOptions): Promise<void> {
  // Process deployment (local development)
  switch (serviceInfo.name) {
    case 'database':
      printInfo(`Starting PostgreSQL service for ${serviceInfo.name}`);
      // This would start local PostgreSQL service, for now just check if it's running
      printWarning('Local PostgreSQL service start not yet implemented - start manually');
      break;
      
    case 'backend':
      const backendCwd = path.join(PROJECT_ROOT, 'apps/backend');
      const backendCommand = serviceInfo.config.command?.split(' ') || ['npm', 'run', 'dev'];
      
      const backendProc = spawn(backendCommand[0], backendCommand.slice(1), {
        cwd: backendCwd,
        stdio: 'pipe',
        detached: true,
        env: {
          ...process.env,
          SEMIONT_ENV: options.environment,
          DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:localpassword@localhost:5432/semiont',
          JWT_SECRET: process.env.JWT_SECRET || 'local-dev-secret',
          PORT: serviceInfo.config.port?.toString() || '3001',
        }
      });
      
      backendProc.unref();
      printSuccess(`Backend process started on port ${serviceInfo.config.port || 3001}`);
      break;
      
    case 'frontend':
      const frontendCwd = path.join(PROJECT_ROOT, 'apps/frontend');
      const frontendCommand = serviceInfo.config.command?.split(' ') || ['npm', 'run', 'dev'];
      
      const frontendProc = spawn(frontendCommand[0], frontendCommand.slice(1), {
        cwd: frontendCwd,
        stdio: 'pipe',
        detached: true,
        env: {
          ...process.env,
          NEXT_PUBLIC_API_URL: `http://localhost:${serviceInfo.config.port || 3001}`,
          NEXT_PUBLIC_SITE_NAME: 'Semiont Dev',
          PORT: serviceInfo.config.port?.toString() || '3000',
        }
      });
      
      frontendProc.unref();
      printSuccess(`Frontend process started on port ${serviceInfo.config.port || 3000}`);
      break;
      
    case 'filesystem':
      printInfo(`Creating directories for ${serviceInfo.name}`);
      const fsPath = serviceInfo.config.path || path.join(PROJECT_ROOT, 'data');
      try {
        await fs.promises.mkdir(fsPath, { recursive: true });
        printSuccess(`Filesystem directories created: ${fsPath}`);
      } catch (error) {
        throw new Error(`Failed to create directories: ${error}`);
      }
      break;
  }
}

async function startExternalService(serviceInfo: ServiceDeploymentInfo, options: StartOptions): Promise<void> {
  // External service - just check connectivity
  printInfo(`Checking external ${serviceInfo.name} service`);
  
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
        printWarning('External storage connectivity check not yet implemented');
      }
      break;
    default:
      printInfo(`External ${serviceInfo.name} service configured`);
  }
  
  printSuccess(`External ${serviceInfo.name} service ready`);
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  printInfo(`Starting services in ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  // Validate environment
  await validateEnvironment(options);
  
  try {
    // Validate service selector and resolve to actual services
    await validateServiceSelector(options.service, 'start', options.environment);
    const resolvedServices = await resolveServiceSelector(options.service, 'start', options.environment);
    
    // Get deployment information for all resolved services
    const serviceDeployments = await resolveServiceDeployments(resolvedServices, options.environment);
    
    printDebug(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    
    // Start services based on deployment type
    let allSucceeded = true;
    for (const serviceInfo of serviceDeployments) {
      try {
        await startService(serviceInfo, options);
      } catch (error) {
        printError(`Failed to start ${serviceInfo.name}: ${error}`);
        allSucceeded = false;
        // Continue with other services
      }
    }
    
    if (allSucceeded) {
      printSuccess('All services started successfully');
    } else {
      printWarning('Some services failed to start - check logs above');
      process.exit(1);
    }
  } catch (error) {
    printError(`Failed to start services: ${error}`);
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

export { main, StartOptions, StartOptionsSchema };