/**
 * Publish Command - Build and push container images to registries
 * 
 * This command handles building container images and pushing them to appropriate
 * registries based on deployment type:
 * - AWS deployments: Push to ECR
 * - Container deployments: Tag for local registry or specified registry
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { getProjectRoot } from '../lib/cli-paths.js';
import { colors } from '../lib/cli-colors.js';

// AWS SDK imports for ECR operations
import { ECRClient, GetAuthorizationTokenCommand, CreateRepositoryCommand, DescribeRepositoriesCommand } from '@aws-sdk/client-ecr';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

interface PublishOptions {
  environment: string;
  verbose: boolean;
  dryRun: boolean;
  help: boolean;
  service: 'all' | 'frontend' | 'backend';
  tag: string;
  skipBuild: boolean;
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

function printDebug(message: string, options: PublishOptions): void {
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

function getServicesForPublish(config: EnvironmentConfig, requestedService: string): Array<{ name: string; config: ServiceConfig; deploymentType: string }> {
  const services: Array<{ name: string; config: ServiceConfig; deploymentType: string }> = [];
  const defaultDeploymentType = config.deployment?.default || 'container';
  
  for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
    // Skip if specific service requested and this isn't it
    if (requestedService !== 'all' && serviceName !== requestedService) {
      continue;
    }
    
    const deploymentType = serviceConfig.deployment?.type || defaultDeploymentType;
    
    // Only publish containerized services
    if (deploymentType === 'container' || deploymentType === 'aws') {
      services.push({
        name: serviceName,
        config: serviceConfig,
        deploymentType,
      });
    }
  }
  
  return services;
}

// =====================================================================
// BUILD FUNCTIONS
// =====================================================================

async function buildDockerImage(
  serviceName: string,
  serviceConfig: ServiceConfig,
  tag: string,
  options: PublishOptions
): Promise<string | null> {
  if (options.skipBuild) {
    printInfo(`Skipping build for ${serviceName} (--skip-build specified)`);
    return `semiont-${serviceName}:${tag}`;
  }

  printInfo(`Building Docker image for ${serviceName}...`);

  const imageName = serviceConfig.image || `semiont-${serviceName}`;
  const imageTag = `${imageName}:${tag}`;
  
  // Build the Docker image
  const buildCommand = [
    'docker', 'build',
    '-t', imageTag,
    '-f', `apps/${serviceName}/Dockerfile`,
    '.'
  ];
  
  printDebug(`Running: ${buildCommand.join(' ')}`, options);
  
  const buildSuccess = await runCommand(
    buildCommand,
    PROJECT_ROOT,
    `Build ${serviceName} Docker image`,
    options.verbose
  );
  
  if (!buildSuccess) {
    printError(`Failed to build Docker image for ${serviceName}`);
    return null;
  }
  
  printSuccess(`Built Docker image: ${imageTag}`);
  return imageTag;
}

// =====================================================================
// ECR FUNCTIONS
// =====================================================================

async function ensureECRRepository(repositoryName: string, ecrClient: ECRClient): Promise<boolean> {
  try {
    await ecrClient.send(new DescribeRepositoriesCommand({
      repositoryNames: [repositoryName]
    }));
    return true; // Repository exists
  } catch (error: any) {
    if (error.name === 'RepositoryNotFoundException') {
      // Create the repository
      try {
        await ecrClient.send(new CreateRepositoryCommand({
          repositoryName,
          imageScanningConfiguration: {
            scanOnPush: true
          }
        }));
        printSuccess(`Created ECR repository: ${repositoryName}`);
        return true;
      } catch (createError) {
        printError(`Failed to create ECR repository ${repositoryName}: ${createError}`);
        return false;
      }
    } else {
      printError(`Failed to check ECR repository ${repositoryName}: ${error}`);
      return false;
    }
  }
}

async function pushImageToECR(
  localImageName: string,
  serviceName: string,
  config: EnvironmentConfig,
  options: PublishOptions
): Promise<string | null> {
  if (!config.aws) {
    printError('AWS configuration not found in environment config');
    return null;
  }

  const { region, accountId } = config.aws;
  const ecrClient = new ECRClient({ region });
  
  try {
    // Get ECR authorization token
    printInfo(`Getting ECR authorization for ${region}...`);
    const authResponse = await ecrClient.send(new GetAuthorizationTokenCommand({}));
    const authToken = authResponse.authorizationData?.[0]?.authorizationToken;
    const registryUrl = authResponse.authorizationData?.[0]?.proxyEndpoint;
    
    if (!authToken || !registryUrl) {
      printError('Failed to get ECR authorization');
      return null;
    }
    
    // Ensure ECR repository exists
    const repositoryName = `semiont-${serviceName}`;
    const repoExists = await ensureECRRepository(repositoryName, ecrClient);
    if (!repoExists) {
      return null;
    }
    
    // Docker login to ECR
    printInfo(`Logging in to ECR registry...`);
    const loginSuccess = await runCommand(
      ['docker', 'login', '--username', 'AWS', '--password-stdin'],
      PROJECT_ROOT,
      'ECR login',
      false
    );
    
    if (!loginSuccess) {
      printError('Failed to login to ECR');
      return null;
    }
    
    // Tag image for ECR
    const ecrImageUri = `${accountId}.dkr.ecr.${region}.amazonaws.com/${repositoryName}:latest`;
    printInfo(`Tagging image for ECR: ${ecrImageUri}`);
    
    const tagSuccess = await runCommand(
      ['docker', 'tag', localImageName, ecrImageUri],
      PROJECT_ROOT,
      `Tag ${serviceName} for ECR`,
      options.verbose
    );
    
    if (!tagSuccess) {
      printError(`Failed to tag image for ECR`);
      return null;
    }
    
    // Push to ECR
    printInfo(`Pushing ${serviceName} to ECR...`);
    const pushSuccess = await runCommand(
      ['docker', 'push', ecrImageUri],
      PROJECT_ROOT,
      `Push ${serviceName} to ECR`,
      options.verbose
    );
    
    if (!pushSuccess) {
      printError(`Failed to push ${serviceName} to ECR`);
      return null;
    }
    
    printSuccess(`Successfully pushed to ECR: ${ecrImageUri}`);
    return ecrImageUri;
    
  } catch (error) {
    printError(`ECR operation failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function tagForLocalRegistry(
  localImageName: string,
  serviceName: string,
  tag: string,
  options: PublishOptions
): Promise<string | null> {
  // For local container deployment, just ensure image is properly tagged
  const finalImageName = `semiont-${serviceName}:${tag}`;
  
  if (localImageName === finalImageName) {
    printInfo(`Image already tagged as: ${finalImageName}`);
    return finalImageName;
  }
  
  printInfo(`Tagging for local registry: ${finalImageName}`);
  
  const tagSuccess = await runCommand(
    ['docker', 'tag', localImageName, finalImageName],
    PROJECT_ROOT,
    `Tag ${serviceName} for local registry`,
    options.verbose
  );
  
  if (!tagSuccess) {
    printError(`Failed to tag image for local registry`);
    return null;
  }
  
  printSuccess(`Tagged for local registry: ${finalImageName}`);
  return finalImageName;
}

// =====================================================================
// MAIN PUBLISH LOGIC
// =====================================================================

async function publishService(
  serviceName: string,
  serviceConfig: ServiceConfig,
  deploymentType: string,
  config: EnvironmentConfig,
  options: PublishOptions
): Promise<boolean> {
  printInfo(`Publishing ${serviceName} (deployment type: ${deploymentType})`);
  
  if (deploymentType !== 'container' && deploymentType !== 'aws') {
    printInfo(`Skipping ${serviceName} - deployment type '${deploymentType}' does not use container images`);
    return true;
  }
  
  // Build the Docker image
  const builtImage = await buildDockerImage(serviceName, serviceConfig, options.tag, options);
  if (!builtImage) {
    return false;
  }
  
  // Push/tag based on deployment type
  let publishedImage: string | null = null;
  
  if (deploymentType === 'aws') {
    publishedImage = await pushImageToECR(builtImage, serviceName, config, options);
  } else if (deploymentType === 'container') {
    publishedImage = await tagForLocalRegistry(builtImage, serviceName, options.tag, options);
  }
  
  if (!publishedImage) {
    printError(`Failed to publish ${serviceName}`);
    return false;
  }
  
  printSuccess(`Successfully published ${serviceName}: ${publishedImage}`);
  return true;
}

// =====================================================================
// ARGUMENT PARSING
// =====================================================================

function parseArguments(): PublishOptions {
  // Parse arguments manually to avoid type complications
  const args = process.argv.slice(2);
  let environment = 'local';
  let service: 'all' | 'frontend' | 'backend' = 'all';
  let tag = 'latest';
  let skipBuild = false;
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
      if (next && ['all', 'frontend', 'backend'].includes(next)) {
        service = next as 'all' | 'frontend' | 'backend';
        i++; // Skip next arg
      }
    } else if (arg === '--tag' || arg === '-t') {
      const next = args[i + 1];
      if (next) {
        tag = next;
        i++; // Skip next arg
      }
    } else if (arg === '--skip-build') {
      skipBuild = true;
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
    tag,
    skipBuild,
  };
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  if (options.dryRun) {
    printInfo(`[DRY RUN] Publish ${options.service} services to ${options.environment}`);
  } else {
    printInfo(`Publishing ${options.service} services to ${options.environment} environment`);
  }
  
  try {
    // Load environment configuration
    const config = await loadEnvironmentConfig(options.environment);
    
    // Get services to publish
    const servicesToPublish = getServicesForPublish(config, options.service);
    
    if (servicesToPublish.length === 0) {
      printInfo('No containerized services found to publish');
      return;
    }
    
    printInfo(`Found ${servicesToPublish.length} containerized service(s) to publish:`);
    for (const service of servicesToPublish) {
      printInfo(`  - ${service.name} (${service.deploymentType})`);
    }
    
    if (options.dryRun) {
      printInfo('[DRY RUN] Would build and publish the above services');
      return;
    }
    
    // Publish each service
    let allSucceeded = true;
    for (const service of servicesToPublish) {
      const success = await publishService(
        service.name,
        service.config,
        service.deploymentType,
        config,
        options
      );
      
      if (!success) {
        allSucceeded = false;
        break;
      }
    }
    
    if (allSucceeded) {
      printSuccess('All services published successfully!');
    } else {
      printError('Some services failed to publish');
      process.exit(1);
    }
    
  } catch (error) {
    printError(`Publish failed: ${error instanceof Error ? error.message : String(error)}`);
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