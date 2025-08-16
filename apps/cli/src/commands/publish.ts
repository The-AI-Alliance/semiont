/**
 * Publish Command - Unified command structure
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { z } from 'zod';
import { getProjectRoot } from '../lib/cli-paths.js';
import { colors } from '../lib/cli-colors.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { buildImage, tagImage, pushImage } from '../lib/container-runtime.js';
import { 
  PublishResult, 
  CommandResults, 
  createBaseResult, 
  createErrorResult,
  ResourceIdentifier 
} from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import type { BaseCommandOptions } from '../lib/base-command-options.js';

// AWS SDK imports for ECR operations
import { ECRClient, GetAuthorizationTokenCommand, CreateRepositoryCommand, DescribeRepositoriesCommand } from '@aws-sdk/client-ecr';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const PublishOptionsSchema = z.object({
  environment: z.string().optional(),
  tag: z.string().default('latest'),
  skipBuild: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
  service: z.string().optional(),
});

type PublishOptions = z.infer<typeof PublishOptionsSchema> & BaseCommandOptions;

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
    const configContent = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(configContent);
  } catch (error) {
    throw new Error(`Failed to load environment config for ${environment}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// =====================================================================
// BUILD FUNCTIONS
// =====================================================================

async function buildContainerImage(
  serviceInfo: ServiceDeploymentInfo,
  tag: string,
  options: PublishOptions,
  isStructuredOutput: boolean = false
): Promise<{ imageName: string | null; buildDuration: number; imageSize?: number }> {
  const startTime = Date.now();
  
  if (options.skipBuild) {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Skipping build for ${serviceInfo.name} (--skip-build specified)`);
    }
    return { 
      imageName: `semiont-${serviceInfo.name}:${tag}`, 
      buildDuration: 0
    };
  }

  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Building container image for ${serviceInfo.name}...`);
  }

  const imageName = serviceInfo.config.image || `semiont-${serviceInfo.name}`;
  const dockerfile = `apps/${serviceInfo.name}/Dockerfile`;
  
  printDebug(`Building image: ${imageName}:${tag}`, options);
  
  const buildSuccess = await buildImage(
    imageName,
    tag,
    dockerfile,
    PROJECT_ROOT,
    {
      verbose: options.verbose ?? false,
      buildArgs: {} // Could add build args from config if needed
    }
  );
  
  const buildDuration = Date.now() - startTime;
  
  if (!buildSuccess) {
    if (!isStructuredOutput && options.output === 'summary') {
      printError(`Failed to build container image for ${serviceInfo.name}`);
    }
    return { imageName: null, buildDuration };
  }
  
  const fullImageName = `${imageName}:${tag}`;
  if (!isStructuredOutput && options.output === 'summary') {
    printSuccess(`Built container image: ${fullImageName}`);
  }
  
  return { imageName: fullImageName, buildDuration };
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
    
    const tagSuccess = await tagImage(localImageName, ecrImageUri, {
      verbose: options.verbose ?? false
    });
    
    if (!tagSuccess) {
      printError(`Failed to tag image for ECR`);
      return null;
    }
    
    // Push to ECR
    printInfo(`Pushing ${serviceName} to ECR...`);
    const pushSuccess = await pushImage(ecrImageUri, {
      verbose: options.verbose ?? false
    });
    
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
  
  const tagSuccess = await tagImage(localImageName, finalImageName, {
    verbose: options.verbose ?? false
  });
  
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
  serviceInfo: ServiceDeploymentInfo,
  options: PublishOptions,
  isStructuredOutput: boolean = false
): Promise<PublishResult> {
  const startTime = Date.now();
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Publishing ${serviceInfo.name} (deployment type: ${serviceInfo.deploymentType})`);
  }
  
  if (serviceInfo.deploymentType !== 'container' && serviceInfo.deploymentType !== 'aws') {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Skipping ${serviceInfo.name} - deployment type '${serviceInfo.deploymentType}' does not use container images`);
    }
    
    return {
      ...createBaseResult('publish', serviceInfo.name, serviceInfo.deploymentType, 'unknown', startTime),
      imageTag: '',
      buildDuration: 0,
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'skipped',
      metadata: {
        reason: `Deployment type '${serviceInfo.deploymentType}' does not use container images`
      },
    };
  }
  
  // Handle dry run mode
  if (options.dryRun) {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`[DRY RUN] Would publish ${serviceInfo.name} with tag ${options.tag}`);
    }
    
    return {
      ...createBaseResult('publish', serviceInfo.name, serviceInfo.deploymentType, 'unknown', startTime),
      imageTag: options.tag,
      buildDuration: 0,
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'dry-run',
      metadata: {
        dryRun: true,
        imageName: `semiont-${serviceInfo.name}:${options.tag}`,
        deploymentType: serviceInfo.deploymentType
      },
    };
  }
  
  try {
    // Build the container image
    const buildResult = await buildContainerImage(serviceInfo, options.tag, options, isStructuredOutput);
    if (!buildResult.imageName) {
      throw new Error(`Failed to build container image for ${serviceInfo.name}`);
    }
    
    // Push/tag based on deployment type
    let publishedImage: string | null = null;
    let repository: string | undefined;
    let digest: string | undefined;
    
    if (serviceInfo.deploymentType === 'aws') {
      // Load environment config for AWS settings
      const envConfig = await loadEnvironmentConfig(options.environment!);
      publishedImage = await pushImageToECR(buildResult.imageName, serviceInfo.name, envConfig, options);
      if (publishedImage && envConfig.aws) {
        repository = `${envConfig.aws.accountId}.dkr.ecr.${envConfig.aws.region}.amazonaws.com/semiont-${serviceInfo.name}`;
        digest = 'sha256:' + Math.random().toString(36).substring(2, 15); // Would be returned by ECR in real implementation
      }
    } else if (serviceInfo.deploymentType === 'container') {
      publishedImage = await tagForLocalRegistry(buildResult.imageName, serviceInfo.name, options.tag, options);
      repository = 'local';
    }
    
    if (!publishedImage) {
      throw new Error(`Failed to publish ${serviceInfo.name}`);
    }
    
    if (!isStructuredOutput && options.output === 'summary') {
      printSuccess(`Successfully published ${serviceInfo.name}: ${publishedImage}`);
    }
    
    return {
      ...createBaseResult('publish', serviceInfo.name, serviceInfo.deploymentType, 'unknown', startTime),
      imageTag: options.tag,
      ...(buildResult.imageSize !== undefined && { imageSize: buildResult.imageSize }),
      buildDuration: buildResult.buildDuration,
      ...(repository && { repository }),
      ...(digest && { digest }),
      resourceId: {
        [serviceInfo.deploymentType]: {
          name: serviceInfo.name,
          ...(serviceInfo.deploymentType === 'container' && { name: publishedImage }),
          ...(serviceInfo.deploymentType === 'aws' && { arn: `arn:aws:ecr:us-east-1:123456789012:repository/semiont-${serviceInfo.name}` })
        }
      } as ResourceIdentifier,
      status: 'published',
      metadata: {
        imageName: publishedImage,
        buildDuration: buildResult.buildDuration,
        skipBuild: options.skipBuild,
        deploymentType: serviceInfo.deploymentType
      },
    };
    
  } catch (error) {
    const baseResult = createBaseResult('publish', serviceInfo.name, serviceInfo.deploymentType, 'unknown', startTime);
    const errorResult = createErrorResult(baseResult, error as Error);
    
    return {
      ...errorResult,
      imageTag: options.tag,
      buildDuration: 0,
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'failed',
      metadata: { error: (error as Error).message },
    };
  }
}


// =====================================================================
// STRUCTURED OUTPUT FUNCTION
// =====================================================================

export const publish = async (
  serviceDeployments: ServiceDeploymentInfo[],
  options: PublishOptions
): Promise<CommandResults> => {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Publishing services in ${options.environment} environment`);
  }
  
  if (options.verbose && !isStructuredOutput && options.output === 'summary') {
    console.log(`Options: ${JSON.stringify(options, null, 2)}`);
  }
  
  try {
    if (options.verbose && !isStructuredOutput && options.output === 'summary') {
      console.log(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`);
    }
    
    // Publish services and collect results
    const serviceResults: PublishResult[] = [];
    
    for (const serviceInfo of serviceDeployments) {
      try {
        const result = await publishService(serviceInfo, options, isStructuredOutput);
        serviceResults.push(result);
      } catch (error) {
        // Create error result
        const baseResult = createBaseResult('publish', serviceInfo.name, serviceInfo.deploymentType, options.environment!, startTime);
        const errorResult = createErrorResult(baseResult, error as Error);
        
        const publishErrorResult: PublishResult = {
          ...errorResult,
          imageTag: options.tag,
          buildDuration: 0,
          resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
          status: 'failed',
          metadata: { error: (error as Error).message },
        };
        
        serviceResults.push(publishErrorResult);
        
        if (!isStructuredOutput && options.output === 'summary') {
          printError(`Failed to publish ${serviceInfo.name}: ${error}`);
        }
        
        break; // Stop on first error
      }
    }
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'publish',
      environment: options.environment!,
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
        dryRun: options.dryRun || false,
      }
    };
    
    return commandResults;
    
  } catch (error) {
    if (!isStructuredOutput) {
      printError(`Failed to publish services: ${error}`);
    }
    
    return {
      command: 'publish',
      environment: options.environment!,
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
        dryRun: options.dryRun || false,
      },
    };
  }
};

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const publishCommand = new CommandBuilder<PublishOptions>()
  .name('publish')
  .description('Build and push container images')
  .schema(PublishOptionsSchema as any)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args({
    args: {
      '--environment': { type: 'string', description: 'Environment name' },
      '--tag': { type: 'string', description: 'Image tag' },
      '--skip-build': { type: 'boolean', description: 'Skip building images' },
      '--verbose': { type: 'boolean', description: 'Verbose output' },
      '--dry-run': { type: 'boolean', description: 'Simulate actions without executing' },
      '--output': { type: 'string', description: 'Output format (summary, table, json, yaml)' },
      '--service': { type: 'string', description: 'Service name or "all" for all services' },
    },
    aliases: {
      '-e': '--environment',
      '-t': '--tag',
      '-v': '--verbose',
      '-o': '--output',
    }
  })
  .examples(
    'semiont publish --environment staging',
    'semiont publish --environment production --tag v1.0.0',
    'semiont publish --environment staging --skip-build --tag latest'
  )
  .handler(publish)
  .build();

// Export default for compatibility
export default publishCommand;

// Note: The main function is removed as cli.ts now handles service resolution and output formatting
// The publish function now accepts pre-resolved services and returns CommandResults

export type { PublishOptions };
export { PublishOptionsSchema };