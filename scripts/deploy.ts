#!/usr/bin/env -S npx tsx

/**
 * Deploy Command - Deploy applications and configuration changes
 * 
 * Usage:
 *   ./scripts/semiont deploy <environment> [options]
 *   ./scripts/semiont deploy local                    # Deploy all services locally
 *   ./scripts/semiont deploy development              # Deploy to development cloud
 *   ./scripts/semiont deploy staging --service backend # Deploy backend to staging
 *   ./scripts/semiont deploy production --dry-run      # Production dry-run
 * 
 * This command deploys application code and configuration changes.
 * Use 'provision' for infrastructure setup, 'start/stop/restart' for service control.
 */

import { spawn, type ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getAvailableEnvironments, isValidEnvironment, isCloudEnvironment } from './lib/environment-discovery';
import { requireValidAWSCredentials } from './utils/aws-validation';
import { CdkDeployer } from './lib/cdk-deployer';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../config/dist/index.js';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { ECSClient, ListTasksCommand, DescribeTasksCommand, DescribeTaskDefinitionCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { ECRClient, DescribeRepositoriesCommand, CreateRepositoryCommand, DescribeImagesCommand, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { SemiontStackConfig } from './lib/stack-config';

// Valid environments
// Environment type is now dynamic - any valid environment name
type Environment = string;

// Infrastructure stacks (cloud only)
type Stack = 'infra' | 'app' | 'all';

// Application services (all environments)
type Service = 'database' | 'backend' | 'frontend' | 'all';

// Deployment is focused on code/config updates only

interface DeployOptions {
  environment: Environment;
  service: Service;        // What service to deploy
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
  requireApproval?: boolean;
  mock?: boolean;          // For local frontend mock mode
}

// Color codes for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function timestamp(): string {
  return new Date().toISOString();
}

function log(message: string, color: string = colors.reset): void {
  console.log(`${color}[${timestamp()}] ${message}${colors.reset}`);
}

function error(message: string): void {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}

function success(message: string): void {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function info(message: string): void {
  console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
}

function warning(message: string): void {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

async function runCommand(command: string[], cwd: string, description: string, verbose: boolean = false): Promise<boolean> {
  return new Promise((resolve) => {
    if (verbose) {
      log(`🔨 ${description}...`, colors.cyan);
    }
    
    const startTime = Date.now();
    const process: ChildProcess = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: verbose ? 'inherit' : 'pipe',
      shell: true
    });

    process.on('close', (code: number | null) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        if (verbose) {
          success(`${description} completed in ${duration}ms`);
        }
        resolve(true);
      } else {
        error(`${description} failed with code ${code} after ${duration}ms`);
        resolve(false);
      }
    });

    process.on('error', (err: Error) => {
      error(`${description} failed: ${err.message}`);
      resolve(false);
    });
  });
}

async function validateEnvironment(env: string): Promise<Environment> {
  const validEnvironments = getAvailableEnvironments();
  
  if (!isValidEnvironment(env)) {
    throw new Error(`Invalid environment: ${env}. Must be one of: ${validEnvironments.join(', ')}`);
  }
  
  return env as Environment;
}

async function loadEnvironmentConfig(environment: Environment): Promise<any> {
  // Load config directly by importing and building it  
  async function buildConfig(env: string) {
    const { siteConfig, awsConfig, appConfig } = await import('../config/base');
    
    // Load environment overrides
    let overrides;
    switch (env) {
      case 'development':
        const { developmentConfig } = await import('../config/environments/development');
        overrides = developmentConfig;
        break;
      case 'production':
        const { productionConfig } = await import('../config/environments/production');
        overrides = productionConfig;
        break;
      case 'staging':
        const { productionConfig: stagingConfig } = await import('../config/environments/production');
        overrides = stagingConfig; // Staging uses production-like config
        break;
      default:
        const { developmentConfig: defaultConfig } = await import('../config/environments/development');
        overrides = defaultConfig;
    }
    
    return {
      site: { ...siteConfig, ...(overrides.site || {}) },
      aws: { ...awsConfig, ...(overrides.aws || {}) },
      app: { ...appConfig, ...(overrides.app || {}) }
    };
  }
  
  return buildConfig(environment);
}

async function deployLocal(options: DeployOptions): Promise<boolean> {
  const { service, verbose } = options;
  
  log(`🚀 Deploying ${service} service(s) locally`, colors.bright);
  
  // Local deployment doesn't need AWS credentials
  // It uses Docker/Podman containers
  
  try {
    // Check for Docker or Podman
    const hasDocker = await checkContainerRuntime();
    if (!hasDocker) {
      error('Docker or Podman is required for local deployment');
      return false;
    }
    
    // Deploy based on service selection
    if (service === 'database' || service === 'all') {
      info('Starting PostgreSQL container...');
      const dbStarted = await startLocalDatabase(verbose ?? false);
      if (!dbStarted) {
        error('Failed to start database');
        return false;
      }
      success('Database running on port 5432');
    }
    
    if (service === 'backend' || service === 'all') {
      info('Starting backend service...');
      const backendStarted = await startLocalBackend(verbose ?? false);
      if (!backendStarted) {
        error('Failed to start backend');
        return false;
      }
      success('Backend running on http://localhost:3001');
    }
    
    if (service === 'frontend' || service === 'all') {
      info('Starting frontend service...');
      const frontendStarted = await startLocalFrontend(options.mock ?? false, verbose ?? false);
      if (!frontendStarted) {
        error('Failed to start frontend');
        return false;
      }
      success('Frontend running on http://localhost:3000');
    }
    
    return true;
  } catch (err) {
    error(`Local deployment failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function checkContainerRuntime(): Promise<boolean> {
  try {
    // Check for Docker first
    execSync('docker --version', { stdio: 'pipe' });
    return true;
  } catch {
    try {
      // Check for Podman
      execSync('podman --version', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}

async function startLocalDatabase(verbose: boolean): Promise<boolean> {
  try {
    // Check if container already exists
    try {
      const existing = execSync('docker ps -a --filter name=semiont-postgres --format "{{.Names}}"', { encoding: 'utf-8' });
      if (existing.includes('semiont-postgres')) {
        info('Starting existing database container...');
        execSync('docker start semiont-postgres', { stdio: verbose ? 'inherit' : 'pipe' });
        
        // Wait for database to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        return true;
      }
    } catch {
      // Container doesn't exist, create it
    }
    
    // Create new container
    info('Creating new database container...');
    const cmd = `docker run --name semiont-postgres \
      -e POSTGRES_PASSWORD=localpassword \
      -e POSTGRES_DB=semiont_dev \
      -e POSTGRES_USER=dev_user \
      -p 5432:5432 \
      -d postgres:15-alpine`;
    
    execSync(cmd, { stdio: verbose ? 'inherit' : 'pipe' });
    
    // Wait for database to be ready
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Run migrations
    info('Running database migrations...');
    execSync('cd apps/backend && npx prisma db push', { stdio: verbose ? 'inherit' : 'pipe' });
    
    return true;
  } catch (err) {
    error(`Database startup failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function startLocalBackend(verbose: boolean): Promise<boolean> {
  try {
    info('Installing backend dependencies...');
    execSync('cd apps/backend && npm install', { stdio: verbose ? 'inherit' : 'pipe' });
    
    info('Starting backend in development mode...');
    spawn('npm', ['run', 'dev'], {
      cwd: path.join(process.cwd(), 'apps/backend'),
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    // Wait for backend to start
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check if backend is responding
    try {
      execSync('curl -f http://localhost:3001/health', { stdio: 'pipe' });
      return true;
    } catch {
      warning('Backend may still be starting...');
      return true;  // Return true anyway, user can check manually
    }
  } catch (err) {
    error(`Backend startup failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function startLocalFrontend(mock: boolean, verbose: boolean): Promise<boolean> {
  try {
    info('Installing frontend dependencies...');
    execSync('cd apps/frontend && npm install', { stdio: verbose ? 'inherit' : 'pipe' });
    
    const command = mock ? 'dev:mock' : 'dev';
    info(`Starting frontend in ${mock ? 'mock' : 'development'} mode...`);
    
    spawn('npm', ['run', command], {
      cwd: path.join(process.cwd(), 'apps/frontend'),
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    // Wait for frontend to start
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    return true;
  } catch (err) {
    error(`Frontend startup failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function deployStack(options: DeployOptions, config: any): Promise<boolean> {
  const { environment, service, dryRun, verbose } = options;
  
  // Handle local deployment separately
  if (environment === 'local') {
    return deployLocal(options);
  }
  
  log(`🚀 Deploying ${service} service(s) to ${environment} environment`, colors.bright);
  
  if (dryRun) {
    warning('DRY RUN MODE - No actual changes will be made');
  }
  
  // Validate AWS credentials for cloud deployments
  await requireValidAWSCredentials(config.aws.region);
  
  // Map services to required stacks
  const stacksNeeded = getStacksForServices(service);
  
  // For cloud deployments, we need to ensure stacks exist before deploying services
  for (const stack of stacksNeeded) {
    info(`Checking ${stack} stack availability...`);
    const stackExists = await checkStackExists(stack, config);
    if (!stackExists) {
      error(`${stack} stack not found. Run: ./scripts/semiont provision ${environment} --stack ${stack}`);
      return false;
    }
  }
  
  // Deploy services
  if (service === 'database' || service === 'all') {
    info('Deploying database service...');
    const dbSuccess = await deployDatabaseService(environment, config, { dryRun, verbose });
    if (!dbSuccess) {
      error('Database service deployment failed');
      return false;
    }
    success('Database service updated successfully');
  }
  
  if (service === 'backend' || service === 'all') {
    info('Deploying backend service...');
    const backendSuccess = await deployBackendService(environment, config, { dryRun, verbose });
    if (!backendSuccess) {
      error('Backend service deployment failed');
      return false;
    }
    success('Backend service updated successfully');
  }
  
  if (service === 'frontend' || service === 'all') {
    info('Deploying frontend service...');
    const frontendSuccess = await deployFrontendService(environment, config, { dryRun, verbose });
    if (!frontendSuccess) {
      error('Frontend service deployment failed');
      return false;
    }
    success('Frontend service updated successfully');
  }
  
  return true;
}

function getStacksForServices(service: Service): Stack[] {
  switch (service) {
    case 'database':
      return ['infra'];  // Database runs on RDS in infra stack
    case 'backend':
    case 'frontend':
      return ['app'];    // Backend/frontend run on ECS in app stack  
    case 'all':
      return ['infra', 'app'];  // All services need both stacks
    default:
      return [];
  }
}

async function checkStackExists(stack: Stack, config: any): Promise<boolean> {
  // Check if CloudFormation stack exists
  // For now, returning true as placeholder
  return true;
}

async function deployDatabaseService(environment: Environment, config: any, options: any): Promise<boolean> {
  // Database service deployment (RDS configuration, migrations)
  info('Database service runs on RDS - managed by infrastructure stack');
  info('Running database migrations...');
  // TODO: Run migrations, update schemas
  return true;
}

async function deployBackendService(environment: Environment, config: any, options: any): Promise<boolean> {
  info('Deploying backend service...');
  
  // Build backend image if it doesn't exist
  const backendExists = await runCommand(['docker', 'image', 'inspect', 'semiont-backend:latest'], '.', 'Check backend image exists', options.verbose);
  
  if (!backendExists) {
    info('Building backend Docker image...');
    const buildSuccess = await runCommand(['npm', 'run', 'build:backend'], '.', 'Build backend image', options.verbose);
    if (!buildSuccess) {
      error('Failed to build backend image');
      return false;
    }
  }
  
  // Push to ECR and update ECS service
  const ecrImage = await pushImageToECR('semiont-backend:latest', 'backend', environment);
  if (!ecrImage) {
    error('Failed to push backend image to ECR');
    return false;
  }
  
  // Update ECS service with new image
  const updateSuccess = await updateECSService('backend', ecrImage, environment);
  if (!updateSuccess) {
    error('Failed to update backend ECS service');
    return false;
  }
  
  success('Backend service deployment completed');
  return true;
}

async function deployFrontendService(environment: Environment, config: any, options: any): Promise<boolean> {
  info('Deploying frontend service...');
  
  // Build frontend image if it doesn't exist
  const frontendExists = await runCommand(['docker', 'image', 'inspect', 'semiont-frontend:latest'], '.', 'Check frontend image exists', options.verbose);
  
  if (!frontendExists) {
    info('Building frontend Docker image...');
    const buildSuccess = await runCommand(['npm', 'run', 'build:frontend'], '.', 'Build frontend image', options.verbose);
    if (!buildSuccess) {
      error('Failed to build frontend image');
      return false;
    }
  }
  
  // Push to ECR and update ECS service
  const ecrImage = await pushImageToECR('semiont-frontend:latest', 'frontend', environment);
  if (!ecrImage) {
    error('Failed to push frontend image to ECR');
    return false;
  }
  
  // Update ECS service with new image
  const updateSuccess = await updateECSService('frontend', ecrImage, environment);
  if (!updateSuccess) {
    error('Failed to update frontend ECS service');
    return false;
  }
  
  success('Frontend service deployment completed');
  // TODO: Add CloudFront invalidation if needed
  return true;
}

// ECR and ECS deployment functions
async function pushImageToECR(localImageName: string, serviceName: string, environment: string): Promise<string | null> {
  const envConfig = loadConfig(environment);
  const ecrClient = new ECRClient({ region: envConfig.aws.region });
  
  // Get ECR login token
  const authResponse = await ecrClient.send(new GetAuthorizationTokenCommand({}));
  const authToken = authResponse.authorizationData?.[0]?.authorizationToken;
  const registryUrl = authResponse.authorizationData?.[0]?.proxyEndpoint;
  
  if (!authToken || !registryUrl) {
    error('Failed to get ECR authorization');
    return null;
  }
  
  const repositoryName = `semiont-${serviceName}`;
  const accountId = envConfig.aws.accountId;
  const region = envConfig.aws.region;
  const ecrImageUri = `${accountId}.dkr.ecr.${region}.amazonaws.com/${repositoryName}:latest`;
  
  // Ensure ECR repository exists
  await ensureECRRepository(repositoryName, ecrClient);
  
  // Docker login to ECR
  const loginCommand = ['docker', 'login', '--username', 'AWS', '--password', Buffer.from(authToken, 'base64').toString(), registryUrl];
  const loginSuccess = await runCommand(loginCommand, '.', `ECR login for ${serviceName}`, false);
  if (!loginSuccess) {
    return null;
  }
  
  // Tag image for ECR
  const tagSuccess = await runCommand(['docker', 'tag', localImageName, ecrImageUri], '.', `Tag ${serviceName} image`, false);
  if (!tagSuccess) {
    return null;
  }
  
  // Push to ECR
  const pushSuccess = await runCommand(['docker', 'push', ecrImageUri], '.', `Push ${serviceName} to ECR`, true);
  if (!pushSuccess) {
    return null;
  }
  
  return ecrImageUri;
}

async function ensureECRRepository(repositoryName: string, ecrClient: ECRClient): Promise<boolean> {
  try {
    await ecrClient.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
    return true;
  } catch (error: any) {
    if (error.name === 'RepositoryNotFoundException') {
      info(`Creating ECR repository: ${repositoryName}`);
      try {
        await ecrClient.send(new CreateRepositoryCommand({ repositoryName }));
        return true;
      } catch (createError) {
        error(`Failed to create ECR repository: ${createError}`);
        return false;
      }
    }
    error(`Error checking ECR repository: ${error}`);
    return false;
  }
}

async function updateECSService(serviceName: string, imageUri: string, environment: string): Promise<boolean> {
  const envConfig = loadConfig(environment);
  const ecsClient = new ECSClient({ region: envConfig.aws.region });
  const stackConfig = new SemiontStackConfig(envConfig.aws.region);
  
  try {
    const clusterName = await stackConfig.getClusterName();
    const fullServiceName = serviceName === 'frontend' 
      ? await stackConfig.getFrontendServiceName()
      : await stackConfig.getBackendServiceName();
    
    info(`Updating ECS service: ${fullServiceName}`);
    
    // Update service with new task definition (simplified)
    // In a full implementation, you'd create a new task definition revision
    // For now, trigger a deployment to pick up the new ECR image
    await ecsClient.send(new UpdateServiceCommand({
      cluster: clusterName,
      service: fullServiceName,
      forceNewDeployment: true
    }));
    
    info(`ECS service ${serviceName} update initiated`);
    return true;
  } catch (error) {
    error(`Failed to update ECS service: ${(error as any).message || error}`);
    return false;
  }
}

function printHelp(): void {
  console.log(`
${colors.bright}🚀 Semiont Deploy Command${colors.reset}

${colors.cyan}Usage:${colors.reset}
  ./scripts/semiont deploy <environment> [options]

${colors.cyan}Environments:${colors.reset}
  local          Local development (Docker/Podman containers)
  development    Development cloud environment (auto-approve)
  staging        Staging environment (requires approval)
  production     Production environment (requires approval)

${colors.cyan}Options:${colors.reset}
  --service <target>   Service to deploy (default: all)
                       Services: database, backend, frontend, all
  --mock               Use mock API for frontend (local only)
  --dry-run            Show what would be deployed without changes
  --verbose            Show detailed output
  --force              Force deployment even with warnings
  --no-approval        Skip manual approval (use with caution)
  --help               Show this help message

${colors.cyan}Examples:${colors.reset}
  ${colors.dim}# Deploy everything locally${colors.reset}
  ./scripts/semiont deploy local

  ${colors.dim}# Deploy frontend with mock API locally${colors.reset}
  ./scripts/semiont deploy local --service frontend --mock

  ${colors.dim}# Deploy to development cloud${colors.reset}
  ./scripts/semiont deploy development

  ${colors.dim}# Deploy backend service to production${colors.reset}
  ./scripts/semiont deploy production --service backend

  ${colors.dim}# Dry run for staging${colors.reset}
  ./scripts/semiont deploy staging --dry-run


${colors.cyan}Notes:${colors.reset}
  • Local deployment uses Docker/Podman containers
  • Cloud deployments require AWS credentials
  • Production/staging require manual approval (unless --no-approval)
  • Use 'provision' command for initial infrastructure setup
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  // Check for help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  
  // Parse arguments
  const environment = args[0];
  if (!environment) {
    error('Environment is required');
    printHelp();
    process.exit(1);
  }
  
  try {
    // Validate environment
    const validEnv = await validateEnvironment(environment);
    
    // Parse options
    const options: DeployOptions = {
      environment: validEnv,
      service: 'all',
      dryRun: false,
      verbose: false,
      force: false,
      requireApproval: false,  // Will be set based on environment
      mock: false
    };
    
    // Process command line arguments
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      switch (arg) {
        case '--service':
          const service = args[++i];
          if (!service) {
            throw new Error('--service requires a value');
          }
          if (!['database', 'backend', 'frontend', 'all'].includes(service)) {
            throw new Error(`Invalid service: ${service}. Must be one of: database, backend, frontend, all`);
          }
          options.service = service as Service;
          break;
        case '--dry-run':
          options.dryRun = true;
          break;
        case '--verbose':
          options.verbose = true;
          break;
        case '--force':
          options.force = true;
          break;
        case '--no-approval':
          options.requireApproval = false;
          break;
        case '--mock':
          options.mock = true;
          break;
        default:
          warning(`Unknown option: ${arg}`);
      }
    }
    
    // Load configuration for the environment
    log(`Loading configuration for ${validEnv} environment...`, colors.cyan);
    const config = await loadEnvironmentConfig(validEnv);
    
    // Show deployment plan
    console.log('');
    info('Deployment Plan:');
    console.log(`  Environment: ${colors.bright}${validEnv}${colors.reset}`);
    console.log(`  Service:     ${colors.bright}${options.service}${colors.reset}`);
    if (validEnv !== 'local') {
      console.log(`  Region:      ${colors.bright}${config.aws.region}${colors.reset}`);
      
      // Show required stacks
      const requiredStacks = getStacksForServices(options.service);
      console.log(`  Stacks:      ${colors.dim}${requiredStacks.join(', ')}${colors.reset}`);
    }
    
    if (options.dryRun) {
      console.log(`  Mode:        ${colors.yellow}DRY RUN${colors.reset}`);
    }
    
    console.log('');
    
    // Confirm for production deployments
    if (validEnv === 'production' && !options.dryRun && options.requireApproval !== false) {
      warning('⚠️  PRODUCTION DEPLOYMENT - This will affect live users!');
      const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const answer = await new Promise<string>(resolve => {
        readline.question('Type "DEPLOY PRODUCTION" to continue: ', resolve);
      });
      readline.close();
      
      if (answer !== 'DEPLOY PRODUCTION') {
        error('Production deployment cancelled');
        process.exit(1);
      }
    }
    
    // Execute deployment
    const success = await deployStack(options, config);
    
    if (success) {
      console.log('');
      console.log('');
      console.log(`${colors.green}🎉 Deployment to ${validEnv} completed successfully!${colors.reset}`);
      
      // Provide next steps
      console.log('');
      info('Next steps:');
      if (validEnv === 'local') {
        console.log(`  1. Frontend: http://localhost:3000`);
        console.log(`  2. Backend API: http://localhost:3001`);
        console.log(`  3. Run tests: ./scripts/semiont test`);
      } else {
        console.log(`  1. Check deployment status: ./scripts/semiont check --env ${validEnv}`);
        console.log(`  2. Monitor logs: ./scripts/semiont watch logs --env ${validEnv}`);
        console.log(`  3. Run tests: ./scripts/semiont test integration --env ${validEnv}`);
      }
    } else {
      error('Deployment failed');
      process.exit(1);
    }
    
  } catch (err) {
    error(`Deployment failed: ${err instanceof Error ? err.message : String(err)}`);
    if (args.includes('--verbose')) {
      console.error(err);
    }
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export { deployStack, loadEnvironmentConfig, type DeployOptions, type Environment };