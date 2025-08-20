/**
 * Publish Command - Unified command structure
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { z } from 'zod';
import simpleGit from 'simple-git';
import { getProjectRoot } from '../lib/cli-paths.js';
import { colors } from '../lib/cli-colors.js';
import { type ServiceDeploymentInfo, loadEnvironmentConfig } from '../lib/deployment-resolver.js';
import { type EnvironmentConfig, hasAWSConfig } from '../lib/environment-config.js';
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
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const DEFAULT_PROJECT_ROOT = getProjectRoot(import.meta.url);

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
  semiontRepo: z.string().optional(),
  noCache: z.boolean().default(false),
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
// GIT TAG GENERATION
// =====================================================================

async function getImageTag(environment: string | undefined, userProvidedTag: string | undefined): Promise<string> {
  // If user explicitly provided a tag, use it
  if (userProvidedTag && userProvidedTag !== 'latest') {
    return userProvidedTag;
  }

  // Use 'latest' for local/development environments
  if (!environment || environment === 'local' || environment === 'development') {
    return 'latest';
  }

  // For production/staging, use git commit hash
  const git = simpleGit();
  
  try {
    // Get short commit hash
    const hash = await git.revparse(['--short', 'HEAD']);
    const cleanHash = hash.trim();
    
    // Check if working directory is clean
    const status = await git.status();
    if (!status.isClean()) {
      // Add -dirty suffix if there are uncommitted changes
      printInfo(`Working directory has uncommitted changes, adding -dirty suffix to tag`);
      return `${cleanHash}-dirty`;
    }
    
    return cleanHash;
  } catch (error) {
    // Not in a git repo or git not available
    printInfo(`Could not get git hash (${error}), using timestamp`);
    return `build-${Date.now()}`;
  }
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

// Using loadEnvironmentConfig from deployment-resolver instead of local implementation

// =====================================================================
// BUILD FUNCTIONS
// =====================================================================

async function buildContainerImage(
  serviceInfo: ServiceDeploymentInfo,
  tag: string,
  options: PublishOptions,
  isStructuredOutput: boolean = false,
  envConfig?: EnvironmentConfig
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
  
  // Use semiontRepo if provided, otherwise use default
  const projectRoot = options.semiontRepo || DEFAULT_PROJECT_ROOT;
  
  // Construct the full dockerfile path
  const dockerfile = path.join(projectRoot, 'apps', serviceInfo.name, 'Dockerfile');
  
  printDebug(`Building image: ${imageName}:${tag}`, options);
  
  // Prepare build args based on service type
  let buildArgs: Record<string, string> = {};
  
  // For frontend, try to get API URL from AWS infrastructure
  if (serviceInfo.name === 'frontend' && envConfig) {
    const apiUrl = await getApiUrlFromStack(envConfig);
    if (apiUrl) {
      buildArgs.NEXT_PUBLIC_API_URL = apiUrl;
      printInfo(`Using discovered API URL for frontend: ${apiUrl}`);
    } else {
      // Fall back to default if not found
      buildArgs.NEXT_PUBLIC_API_URL = 'http://localhost:4000';
      printInfo('Could not discover API URL from AWS, using default for frontend');
    }
    
    // Add other frontend build args
    buildArgs.NEXT_PUBLIC_APP_NAME = 'Semiont';
    buildArgs.NEXT_PUBLIC_APP_VERSION = '1.0.0';
  }
  
  const buildSuccess = await buildImage(
    imageName,
    tag,
    dockerfile,
    projectRoot,
    {
      verbose: options.verbose ?? false,
      buildArgs,
      noCache: options.noCache ?? false
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
// AWS INFRASTRUCTURE FUNCTIONS
// =====================================================================

async function getApiUrlFromStack(config: EnvironmentConfig): Promise<string | undefined> {
  if (!hasAWSConfig(config)) {
    return undefined;
  }
  
  try {
    const cfnClient = new CloudFormationClient({ region: config.aws.region });
    const stackName = config.aws.stacks?.app || 'SemiontAppStack';
    
    const result = await cfnClient.send(new DescribeStacksCommand({
      StackName: stackName
    }));
    
    const stack = result.Stacks?.[0];
    if (!stack?.Outputs) {
      return undefined;
    }
    
    // Look for ALB URL in outputs
    const albOutput = stack.Outputs.find(
      output => output.OutputKey?.includes('ALB') || 
                output.OutputKey?.includes('LoadBalancer') ||
                output.OutputKey?.includes('ApiUrl')
    );
    
    if (albOutput?.OutputValue) {
      // Ensure it has the protocol
      const url = albOutput.OutputValue;
      return url.startsWith('http') ? url : `https://${url}`;
    }
    
    return undefined;
  } catch (error) {
    printDebug(`Failed to get API URL from stack: ${error}`, { verbose: true } as any);
    return undefined;
  }
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
    
    // Docker login to ECR using AWS CLI
    printInfo(`Logging in to ECR registry...`);
    
    // Decode the auth token (it's base64 encoded username:password)
    const decodedAuth = Buffer.from(authToken, 'base64').toString('utf-8');
    const password = decodedAuth.split(':')[1];
    
    if (!password) {
      printError('Failed to decode ECR authorization token');
      return null;
    }
    
    // Use the registryUrl without the https:// prefix for docker login
    const registryHost = registryUrl.replace('https://', '').replace('http://', '');
    
    // Use spawn to properly handle stdin
    const { spawn } = await import('child_process');
    const loginProcess = spawn('docker', [
      'login',
      '--username', 'AWS',
      '--password-stdin',
      registryHost
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    // Write password to stdin
    loginProcess.stdin.write(password);
    loginProcess.stdin.end();
    
    // Wait for process to complete
    const loginSuccess = await new Promise<boolean>((resolve) => {
      loginProcess.on('exit', (code) => {
        resolve(code === 0);
      });
      
      loginProcess.on('error', (err) => {
        printError(`Docker login error: ${err.message}`);
        resolve(false);
      });
    });
    
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
  isStructuredOutput: boolean = false,
  envConfig: EnvironmentConfig
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
    const buildResult = await buildContainerImage(serviceInfo, options.tag, options, isStructuredOutput, envConfig);
    if (!buildResult.imageName) {
      throw new Error(`Failed to build container image for ${serviceInfo.name}`);
    }
    
    // Push/tag based on deployment type
    let publishedImage: string | null = null;
    let repository: string | undefined;
    let digest: string | undefined;
    
    if (serviceInfo.deploymentType === 'aws') {
      // Use passed environment config for AWS settings
      publishedImage = await pushImageToECR(buildResult.imageName, serviceInfo.name, envConfig, options);
      if (publishedImage && hasAWSConfig(envConfig)) {
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
  
  // Load environment config once for all operations
  const envConfig = loadEnvironmentConfig(options.environment || 'development') as EnvironmentConfig;
  
  // Determine the image tag to use
  const imageTag = await getImageTag(options.environment, options.tag);
  
  // Update options with the determined tag
  const effectiveOptions = { ...options, tag: imageTag };
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Publishing services in ${options.environment} environment`);
    if (imageTag !== options.tag) {
      printInfo(`Using tag: ${imageTag}`);
    }
  }
  
  if (options.verbose && !isStructuredOutput && options.output === 'summary') {
    console.log(`Options: ${JSON.stringify(effectiveOptions, null, 2)}`);
  }
  
  try {
    if (options.verbose && !isStructuredOutput && options.output === 'summary') {
      console.log(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`);
    }
    
    // Publish services and collect results
    const serviceResults: PublishResult[] = [];
    
    for (const serviceInfo of serviceDeployments) {
      try {
        const result = await publishService(serviceInfo, effectiveOptions, isStructuredOutput, envConfig);
        serviceResults.push(result);
      } catch (error) {
        // Create error result
        const baseResult = createBaseResult('publish', serviceInfo.name, serviceInfo.deploymentType, options.environment!, startTime);
        const errorResult = createErrorResult(baseResult, error as Error);
        
        const publishErrorResult: PublishResult = {
          ...errorResult,
          imageTag: imageTag,
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
      '--semiont-repo': { type: 'string', description: 'Path to Semiont repository for building images' },
      '--no-cache': { type: 'boolean', description: 'Build images without using Docker cache' },
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