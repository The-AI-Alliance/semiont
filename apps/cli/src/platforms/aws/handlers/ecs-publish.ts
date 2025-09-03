import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { AWSPublishHandlerContext, PublishHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { loadEnvironmentConfig } from '../../../core/platform-resolver.js';

/**
 * Publish handler for ECS Fargate services
 * 
 * Handles building and publishing of containerized services (frontend, backend)
 * to AWS ECR and updating ECS task definitions.
 * 
 * This handler:
 * 1. Builds the application locally (TypeScript/Next.js)
 * 2. Creates Docker image with the built artifacts
 * 3. Pushes the image to ECR
 * 4. Updates the ECS task definition with the new image
 */
const publishECSService = async (context: AWSPublishHandlerContext): Promise<PublishHandlerResult> => {
  const { service, awsConfig, resourceName, cfnDiscoveredResources } = context as any;
  const { region, accountId } = awsConfig;
  const requirements = service.getRequirements();
  
  // Determine image tag based on configuration
  let version: string;
  
  if (service.config?.tag) {
    // Explicit tag provided via CLI
    version = service.config.tag;
  } else {
    // Check environment configuration for deployment strategy
    const envConfig = loadEnvironmentConfig(service.environment);
    const deploymentStrategy = envConfig.deployment?.imageTagStrategy || 'mutable';
    
    if (deploymentStrategy === 'immutable' || deploymentStrategy === 'git-hash') {
      // Use git commit hash for immutable deployments
      try {
        const gitHash = execSync('git rev-parse --short HEAD', { 
          encoding: 'utf-8',
          cwd: service.config?.semiontRepo || service.projectRoot 
        }).trim();
        version = gitHash;
      } catch {
        // Fall back to timestamp if git not available
        version = new Date().toISOString().replace(/[:.]/g, '-');
      }
    } else {
      // Use 'latest' for mutable deployments (default)
      version = 'latest';
    }
  }
  
  if (!service.quiet) {
    printInfo(`Publishing ${service.name} to AWS ECS...`);
  }
  
  const artifacts: PublishHandlerResult['artifacts'] = {};
  const rollback: PublishHandlerResult['rollback'] = { supported: true };
  
  // Build and push container to ECR
  const ecrRepo = `${resourceName}`;
  const imageUri = `${accountId}.dkr.ecr.${region}.amazonaws.com/${ecrRepo}:${version}`;
  
  // Create ECR repository if needed
  try {
    execSync(`aws ecr create-repository --repository-name ${ecrRepo} --region ${region}`);
  } catch {
    // Repository might already exist
  }
  
  // Build and push image
  if (service.verbose) {
    console.log(`[DEBUG] Build requirements:`, JSON.stringify(requirements.build, null, 2));
  }
  
  if (!requirements.build?.dockerfile) {
    return {
      success: false,
      error: `No Dockerfile specified for ${service.name}`,
      metadata: {
        serviceType: 'ecs'
      }
    };
  }
  
  const buildContext = requirements.build.buildContext || service.projectRoot;
  
  // Build TypeScript/Next.js locally first
  if (!service.quiet) {
    printInfo(`Building ${service.name} locally...`);
  }
  
  // Prepare environment variables for the build
  const buildEnv: NodeJS.ProcessEnv = { ...process.env };
  
  // For frontend, set build-time environment variables
  if (service.name === 'frontend') {
    const domain = service.config?.domain || 
                  (service.environment === 'production' ? 'semiont.com' : `${service.environment}.semiont.com`);
    const apiUrl = `https://${domain}`;
    
    buildEnv.NEXT_PUBLIC_API_URL = apiUrl;
    buildEnv.NEXT_PUBLIC_APP_NAME = 'Semiont';
    buildEnv.NEXT_PUBLIC_APP_VERSION = '1.0.0';
    buildEnv.NODE_ENV = 'production';
    buildEnv.NEXT_TELEMETRY_DISABLED = '1';
    
    if (!service.quiet) {
      printInfo(`Using API URL for frontend: ${apiUrl}`);
    }
  }
  
  // Build the application locally
  try {
    // Build api-types first if it exists
    const apiTypesPath = path.join(buildContext, 'packages', 'api-types');
    if (fs.existsSync(apiTypesPath)) {
      execSync('npm run build', {
        cwd: apiTypesPath,
        env: buildEnv,
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
    }
    
    // Build the app
    const appPath = path.join(buildContext, 'apps', service.name);
    if (fs.existsSync(appPath)) {
      execSync('npm run build', {
        cwd: appPath,
        env: buildEnv,
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to build ${service.name} locally: ${error}`,
      metadata: {
        serviceType: 'ecs'
      }
    };
  }
  
  try {
    // Login to ECR
    execSync(
      `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.${region}.amazonaws.com`,
      { stdio: service.verbose ? 'inherit' : 'pipe' }
    );
    
    // Build Docker image with pre-built artifacts
    const noCacheFlag = service.config?.noCache ? '--no-cache ' : '';
    const platformFlag = '--platform linux/amd64'; // ECS runs on x86_64
    
    const buildCommand = `docker build ${noCacheFlag}${platformFlag} -t ${imageUri} -f ${requirements.build.dockerfile} ${buildContext}`;
    
    if (service.verbose) {
      console.log(`[DEBUG] Docker build command: ${buildCommand}`);
    }
    
    execSync(buildCommand, { stdio: service.verbose ? 'inherit' : 'pipe' });
    
    // Push to ECR
    execSync(`docker push ${imageUri}`, { stdio: service.verbose ? 'inherit' : 'pipe' });
    
    artifacts.imageTag = version;
    artifacts.imageUrl = imageUri;
    
    // Update task definition with new image
    await updateTaskDefinition(service, imageUri, region, accountId, cfnDiscoveredResources, resourceName);
    
    rollback.command = `aws ecs update-service --cluster semiont-${service.environment} --service ${resourceName} --task-definition ${resourceName}-task:PREVIOUS`;
    
    if (!service.quiet) {
      printSuccess(`✅ ${service.name} published successfully`);
      console.log(`   🏷️  Image tag: ${version}`);
      console.log(`   🔗 Image URI: ${imageUri}`);
    }
    
    return {
      success: true,
      artifacts,
      rollback,
      registry: {
        type: 'ecr',
        uri: `${accountId}.dkr.ecr.${region}.amazonaws.com/${ecrRepo}`,
        tags: [version]
      },
      metadata: {
        serviceType: 'ecs',
        serviceName: service.name,
        version,
        imageUri,
        region
      }
    };
    
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      metadata: {
        serviceType: 'ecs',
        serviceName: service.name
      }
    };
  }
};

/**
 * Update ECS task definition with new image
 */
async function updateTaskDefinition(
  service: any,
  imageUri: string,
  region: string,
  _accountId: string,
  cfnDiscoveredResources: any,
  resourceName: string
): Promise<void> {
  if (!service || !imageUri) return;
  
  try {
    // Get the actual ECS service name from CloudFormation discovery
    const clusterName = cfnDiscoveredResources?.clusterName || `semiont-${service.environment}`;
    const serviceName = cfnDiscoveredResources?.serviceName || resourceName;
    
    if (!serviceName) {
      console.warn(`   ⚠️  Could not find ECS service name for ${service.name}`);
      return;
    }
    
    // Get the current service to find its task definition
    const serviceJson = execSync(
      `aws ecs describe-services --cluster ${clusterName} --services ${serviceName} --region ${region} --output json`,
      { encoding: 'utf-8' }
    );
    const serviceData = JSON.parse(serviceJson);
    const currentTaskDefArn = serviceData.services?.[0]?.taskDefinition;
    
    if (!currentTaskDefArn) {
      console.warn(`   ⚠️  Could not find task definition for ${serviceName}`);
      return;
    }
    
    // Get the current task definition
    const taskDefJson = execSync(
      `aws ecs describe-task-definition --task-definition ${currentTaskDefArn} --region ${region} --output json`,
      { encoding: 'utf-8' }
    );
    const taskDef = JSON.parse(taskDefJson).taskDefinition;
    
    // Update the container image
    const containerDefs = taskDef.containerDefinitions;
    const mainContainer = containerDefs.find((c: any) => 
      c.name === service.name || c.name === 'app' || containerDefs.length === 1
    );
    
    if (mainContainer) {
      mainContainer.image = imageUri;
    }
    
    // Create a new task definition revision
    const newTaskDef = {
      family: taskDef.family,
      taskRoleArn: taskDef.taskRoleArn,
      executionRoleArn: taskDef.executionRoleArn,
      networkMode: taskDef.networkMode,
      containerDefinitions: containerDefs,
      volumes: taskDef.volumes || [],
      placementConstraints: taskDef.placementConstraints || [],
      requiresCompatibilities: taskDef.requiresCompatibilities,
      cpu: taskDef.cpu,
      memory: taskDef.memory,
      runtimePlatform: taskDef.runtimePlatform
    };
    
    // Register the new task definition
    const registerOutput = execSync(
      `aws ecs register-task-definition --cli-input-json '${JSON.stringify(newTaskDef)}' --region ${region} --output json`,
      { encoding: 'utf-8' }
    );
    const newTaskDefData = JSON.parse(registerOutput);
    const newTaskDefArn = newTaskDefData.taskDefinition.taskDefinitionArn;
    
    if (!service.quiet) {
      printInfo(`   📝 Registered new task definition: ${newTaskDefArn.split('/').pop()}`);
    }
    
    // Update the service to use the new task definition
    execSync(
      `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --task-definition ${newTaskDefArn} --region ${region}`,
      { stdio: 'pipe' }
    );
    
    if (!service.quiet) {
      printSuccess(`   🚀 Service ${serviceName} updated with new image`);
    }
  } catch (error) {
    console.error(`   ❌ Failed to update task definition: ${error}`);
    throw error;
  }
}

/**
 * Descriptor for ECS publish handler
 */
export const ecsPublishDescriptor: HandlerDescriptor<AWSPublishHandlerContext, PublishHandlerResult> = {
  command: 'publish',
  platform: 'aws',
  serviceType: 'ecs',
  handler: publishECSService,
  requiresDiscovery: true
};

// Also export for ecs-fargate (alias)
export const ecsFargatePublishDescriptor: HandlerDescriptor<AWSPublishHandlerContext, PublishHandlerResult> = {
  command: 'publish',
  platform: 'aws',
  serviceType: 'ecs-fargate',
  handler: publishECSService,
  requiresDiscovery: true
};