/**
 * Update Command - Deployment-type aware service updates
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
import { printDebug, printWarning, printInfo } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo, loadEnvironmentConfig } from '../lib/deployment-resolver.js';
import { stopContainer, runContainer } from '../lib/container-runtime.js';
import type { BaseCommandOptions } from '../lib/base-command-options.js';
// import { getProjectRoot } from '../lib/cli-paths.js';
import { 
  UpdateResult, 
  CommandResults, 
  createBaseResult, 
  createErrorResult,
  ResourceIdentifier 
} from '../lib/command-results.js';

// AWS SDK imports for ECS operations
import { 
  ECSClient, 
  UpdateServiceCommand, 
  ListServicesCommand, 
  DescribeServicesCommand,
  RegisterTaskDefinitionCommand,
  DescribeTaskDefinitionCommand
} from '@aws-sdk/client-ecs';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { ECRClient, DescribeImagesCommand } from '@aws-sdk/client-ecr';

// const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const UpdateOptionsSchema = z.object({
  environment: z.string().optional(),
  service: z.string().optional(),
  skipTests: z.boolean().default(false),
  skipBuild: z.boolean().default(false),
  force: z.boolean().default(false),
  gracePeriod: z.number().int().positive().default(3), // seconds to wait between stop and start
  wait: z.boolean().default(false), // wait for deployment to complete
  timeout: z.number().int().positive().default(600), // timeout in seconds for --wait
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
});

interface UpdateOptions extends BaseCommandOptions {
  skipTests?: boolean;
  skipBuild?: boolean;
  force?: boolean;
  gracePeriod?: number;
  wait?: boolean;
  timeout?: number;
}

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

/**
 * Wait for ECS deployment to complete
 */
async function waitForDeploymentCompletion(
  ecsClient: ECSClient,
  clusterName: string,
  serviceName: string,
  deploymentId: string,
  timeout: number,
  verbose: boolean = false
): Promise<{ success: boolean; message: string; deploymentId?: string }> {
  const startTime = Date.now();
  const timeoutMs = timeout * 1000;
  
  while (Date.now() - startTime < timeoutMs) {
    const describeResponse = await ecsClient.send(new DescribeServicesCommand({
      cluster: clusterName,
      services: [serviceName]
    }));
    
    const service = describeResponse.services?.[0];
    if (!service) {
      return { success: false, message: 'Service not found' };
    }
    
    const deployments = service.deployments || [];
    const primaryDeployment = deployments.find(d => d.status === 'PRIMARY');
    const activeDeployment = deployments.find(d => d.status === 'ACTIVE');
    
    if (verbose) {
      printDebug(`Deployments: ${deployments.length} total`, { verbose } as any);
      deployments.forEach(d => {
        printDebug(`  - ${d.status}: ${d.runningCount}/${d.desiredCount} tasks (${d.taskDefinition?.split('/').pop()})`, { verbose } as any);
      });
    }
    
    // Find our specific deployment by ID
    const ourDeployment = deployments.find(d => d.id === deploymentId);
    
    if (!ourDeployment) {
      // Deployment no longer exists - likely rolled back or failed
      return {
        success: false,
        message: `Deployment ${deploymentId} no longer exists - likely failed or was rolled back`,
        deploymentId
      };
    }
    
    // Check deployment status
    if (ourDeployment.status === 'PRIMARY') {
      const running = ourDeployment.runningCount || 0;
      const desired = ourDeployment.desiredCount || 0;
      
      // Deployment is only REALLY complete when:
      // 1. Our deployment has all tasks running
      // 2. There are NO other active deployments (old tasks drained)
      if (running === desired && desired > 0) {
        // Check if there are any other non-INACTIVE deployments
        const otherActiveDeployments = deployments.filter(d => 
          d.id !== deploymentId && d.status !== 'INACTIVE'
        );
        
        if (otherActiveDeployments.length === 0) {
          // Only our deployment is active - we're truly done
          return {
            success: true,
            message: `Deployment ${deploymentId} fully completed - all traffic switched (${running}/${desired} tasks running)`,
            deploymentId
          };
        } else {
          // Still draining old tasks
          if (verbose) {
            printDebug(`Waiting for ${otherActiveDeployments.length} old deployment(s) to drain...`, { verbose } as any);
          }
        }
      }
    } else if (ourDeployment.status === 'INACTIVE') {
      // Deployment was replaced or rolled back
      return {
        success: false,
        message: `Deployment ${deploymentId} failed - status is INACTIVE`,
        deploymentId
      };
    }
    
    // Show progress for our specific deployment
    if (ourDeployment) {
      const running = ourDeployment.runningCount || 0;
      const desired = ourDeployment.desiredCount || 0;
      const progress = desired > 0 ? Math.round((running / desired) * 100) : 0;
      
      // Check for other active deployments
      const otherActive = deployments.filter(d => 
        d.id !== deploymentId && d.status !== 'INACTIVE'
      ).length;
      
      // Create progress bar
      const barLength = 20;
      const filledLength = Math.round((progress / 100) * barLength);
      const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
      
      const statusText = otherActive > 0 
        ? `[${ourDeployment.status}] Draining ${otherActive} old deployment(s)...`
        : `[${ourDeployment.status}]`;
      
      process.stdout.write(`\r  Deployment progress: [${bar}] ${progress}% (${running}/${desired} tasks) ${statusText}  `);
    }
    
    // Wait before checking again
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  process.stdout.write('\n');
  return {
    success: false,
    message: `Deployment ${deploymentId} timed out after ${timeout} seconds`,
    deploymentId
  };
}

export async function getClusterNameFromStack(region: string, stackName: string): Promise<string | undefined> {
  try {
    const cfnClient = new CloudFormationClient({ region });
    const result = await cfnClient.send(new DescribeStacksCommand({
      StackName: stackName
    }));
    
    const stack = result.Stacks?.[0];
    if (!stack?.Outputs) {
      return undefined;
    }
    
    // Look for ECS Cluster in outputs
    const clusterOutput = stack.Outputs.find(
      output => output.OutputKey?.includes('Cluster') || 
                output.OutputKey?.includes('ECSCluster')
    );
    
    if (clusterOutput?.OutputValue) {
      // The output value might be an ARN, extract the cluster name
      const value = clusterOutput.OutputValue;
      // If it's an ARN like arn:aws:ecs:region:account:cluster/name, extract the name
      if (value.includes('arn:aws:ecs:')) {
        return value.split('/').pop();
      }
      return value;
    }
    
    return undefined;
  } catch (error) {
    console.debug(`Failed to get cluster name from stack: ${error}`);
    return undefined;
  }
}

/**
 * Determine the image tag to use for deployment
 * For update command, this should always use 'latest' or a specified tag
 * Not dependent on local git state
 */
export async function determineImageTag(region: string, accountId: string, serviceName: string): Promise<string> {
  // For update/deployment, always use 'latest' tag
  // In the future, this could accept a tag parameter or query ECR for available tags
  return 'latest';
}

export async function findEcsService(ecsClient: ECSClient, clusterName: string, serviceName: string): Promise<string | undefined> {
  try {
    // List all services in the cluster
    const services = await ecsClient.send(new ListServicesCommand({
      cluster: clusterName
    }));
    
    if (!services.serviceArns || services.serviceArns.length === 0) {
      return undefined;
    }
    
    // Find a service that contains the service name
    for (const arn of services.serviceArns) {
      // Extract service name from ARN
      const arnServiceName = arn.split('/').pop();
      if (arnServiceName && arnServiceName.toLowerCase().includes(serviceName.toLowerCase())) {
        return arnServiceName;
      }
    }
    
    return undefined;
  } catch (error) {
    console.debug(`Failed to find ECS service: ${error}`);
    return undefined;
  }
}

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

// Helper wrapper for printDebug that passes verbose option
function debugLog(_message: string, _options: any): void {
  // Debug logging disabled for now
}



// =====================================================================
// DEPLOYMENT-TYPE-AWARE UPDATE FUNCTIONS
// =====================================================================

async function updateService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions, isStructuredOutput: boolean = false): Promise<UpdateResult> {
  const startTime = Date.now();
  const environment = options.environment!; // Environment is guaranteed by command loader
  
  if (options.dryRun) {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`[DRY RUN] Would update ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    }
    
    return {
      ...createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime),
      updateTime: new Date(),
      previousVersion: 'unknown',
      newVersion: 'unknown',
      rollbackAvailable: true,
      changesApplied: [],
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'dry-run',
      metadata: { dryRun: true },
    };
  }
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Updating ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  }
  
  try {
    switch (serviceInfo.deploymentType) {
      case 'aws':
        return await updateAWSService(serviceInfo, options, startTime, isStructuredOutput);
      case 'container':
        return await updateContainerService(serviceInfo, options, startTime, isStructuredOutput);
      case 'process':
        return await updateProcessService(serviceInfo, options, startTime, isStructuredOutput);
      case 'external':
        return await updateExternalService(serviceInfo, options, startTime, isStructuredOutput);
      default:
        throw new Error(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
    }
  } catch (error) {
    const baseResult = createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
    const errorResult = createErrorResult(baseResult, error as Error);
    
    return {
      ...errorResult,
      updateTime: new Date(),
      previousVersion: 'unknown',
      newVersion: 'unknown',
      rollbackAvailable: false,
      changesApplied: [],
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'failed',
      metadata: { error: (error as Error).message },
    };
  }
}

async function updateAWSService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions, startTime: number, isStructuredOutput: boolean = false): Promise<UpdateResult> {
  const environment = options.environment!; // Environment is guaranteed by command loader
  const baseResult = createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
  
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`Triggering ECS deployment for ${serviceInfo.name}`);
      }
      
      try {
        // Load the full environment configuration
        const envConfig = loadEnvironmentConfig(environment);
        const awsRegion = envConfig.aws?.region || 'us-east-1';
        const stackName = envConfig.aws?.stacks?.app || 'SemiontAppStack';
        
        const ecsClient = new ECSClient({ region: awsRegion });
        
        // Dynamically get cluster name from CloudFormation
        const clusterName = await getClusterNameFromStack(awsRegion, stackName);
        if (!clusterName) {
          throw new Error(`Could not find ECS cluster in stack ${stackName}`);
        }
        
        // Find the actual service name in the cluster
        const actualServiceName = await findEcsService(ecsClient, clusterName, serviceInfo.name);
        if (!actualServiceName) {
          throw new Error(`Could not find ECS service for ${serviceInfo.name} in cluster ${clusterName}`);
        }
        
        const updateTime = new Date();
        let newRevision: number | undefined;
        let previousRevision: number | undefined;
        
        // Get current revision before update
        const beforeUpdate = await ecsClient.send(new DescribeServicesCommand({
          cluster: clusterName,
          services: [actualServiceName]
        }));
        
        const serviceBefore = beforeUpdate.services?.[0];
        if (serviceBefore?.taskDefinition) {
          const revMatch = serviceBefore.taskDefinition.match(/:(\d+)$/);
          if (revMatch) {
            previousRevision = parseInt(revMatch[1]);
          }
        }
        
        if (!options.dryRun) {
          // Get the current task definition
          const taskDefArn = serviceBefore?.taskDefinition;
          if (!taskDefArn) {
            throw new Error(`No task definition found for service ${actualServiceName}`);
          }
          
          // Get the full task definition
          const taskDefResponse = await ecsClient.send(new DescribeTaskDefinitionCommand({
            taskDefinition: taskDefArn
          }));
          
          const taskDef = taskDefResponse.taskDefinition;
          if (!taskDef) {
            throw new Error(`Could not retrieve task definition ${taskDefArn}`);
          }
          
          // Get AWS account ID from the task definition ARN
          const accountId = taskDefArn.match(/arn:aws:ecs:[^:]+:(\d+):/)?.[1];
          if (!accountId) {
            throw new Error(`Could not extract account ID from task definition ARN`);
          }
          
          // Use 'latest' tag for deployment
          const imageTag = await determineImageTag(awsRegion, accountId, serviceInfo.name);
          
          // Update the container definition with the new image tag and environment variables
          const updatedContainerDefs = taskDef.containerDefinitions?.map(containerDef => {
            let updatedDef = { ...containerDef };
            
            // Update image tag
            if (containerDef.image) {
              // Parse the current image to get the repository
              const imageParts = containerDef.image.split(':');
              const repository = imageParts[0];
              const newImage = `${repository}:${imageTag}`;
              
              if (!isStructuredOutput && options.output === 'summary') {
                printDebug(`Updating image from ${containerDef.image} to ${newImage}`);
              }
              
              updatedDef.image = newImage;
            }
            
            // Update environment variables from semiont.json for frontend service
            if (serviceInfo.name === 'frontend' && envConfig.site) {
              const envVars = updatedDef.environment || [];
              
              // Update or add NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS
              if (envConfig.site.oauthAllowedDomains) {
                const allowedDomainsValue = envConfig.site.oauthAllowedDomains.join(',');
                const existingIndex = envVars.findIndex(e => e.name === 'NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS');
                
                if (existingIndex >= 0) {
                  envVars[existingIndex].value = allowedDomainsValue;
                  if (!isStructuredOutput && options.output === 'summary') {
                    printDebug(`Updated NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS to: ${allowedDomainsValue}`);
                  }
                } else {
                  envVars.push({
                    name: 'NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS',
                    value: allowedDomainsValue
                  });
                  if (!isStructuredOutput && options.output === 'summary') {
                    printDebug(`Added NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS: ${allowedDomainsValue}`);
                  }
                }
              }
              
              // Update other site config environment variables
              if (envConfig.site.siteName) {
                const siteNameIndex = envVars.findIndex(e => e.name === 'NEXT_PUBLIC_SITE_NAME');
                if (siteNameIndex >= 0) {
                  envVars[siteNameIndex].value = envConfig.site.siteName;
                } else {
                  envVars.push({ name: 'NEXT_PUBLIC_SITE_NAME', value: envConfig.site.siteName });
                }
              }
              
              if (envConfig.site.domain) {
                const domainIndex = envVars.findIndex(e => e.name === 'NEXT_PUBLIC_DOMAIN');
                if (domainIndex >= 0) {
                  envVars[domainIndex].value = envConfig.site.domain;
                } else {
                  envVars.push({ name: 'NEXT_PUBLIC_DOMAIN', value: envConfig.site.domain });
                }
              }
              
              updatedDef.environment = envVars;
            }
            
            // Update environment variables for backend service
            if (serviceInfo.name === 'backend' && envConfig.site) {
              const envVars = updatedDef.environment || [];
              
              // Update OAUTH_ALLOWED_DOMAINS for backend
              if (envConfig.site.oauthAllowedDomains) {
                const allowedDomainsValue = envConfig.site.oauthAllowedDomains.join(',');
                const existingIndex = envVars.findIndex(e => e.name === 'OAUTH_ALLOWED_DOMAINS');
                
                if (existingIndex >= 0) {
                  envVars[existingIndex].value = allowedDomainsValue;
                  if (!isStructuredOutput && options.output === 'summary') {
                    printDebug(`Updated OAUTH_ALLOWED_DOMAINS to: ${allowedDomainsValue}`);
                  }
                } else {
                  envVars.push({
                    name: 'OAUTH_ALLOWED_DOMAINS',
                    value: allowedDomainsValue
                  });
                  if (!isStructuredOutput && options.output === 'summary') {
                    printDebug(`Added OAUTH_ALLOWED_DOMAINS: ${allowedDomainsValue}`);
                  }
                }
              }
              
              // Update SITE_DOMAIN for backend
              if (envConfig.site.domain) {
                const domainIndex = envVars.findIndex(e => e.name === 'SITE_DOMAIN');
                if (domainIndex >= 0) {
                  envVars[domainIndex].value = envConfig.site.domain;
                  if (!isStructuredOutput && options.output === 'summary') {
                    printDebug(`Updated SITE_DOMAIN to: ${envConfig.site.domain}`);
                  }
                } else {
                  envVars.push({
                    name: 'SITE_DOMAIN',
                    value: envConfig.site.domain
                  });
                  if (!isStructuredOutput && options.output === 'summary') {
                    printDebug(`Added SITE_DOMAIN: ${envConfig.site.domain}`);
                  }
                }
              }
              
              // Update SITE_NAME for backend  
              if (envConfig.site.siteName) {
                const siteNameIndex = envVars.findIndex(e => e.name === 'SITE_NAME');
                if (siteNameIndex >= 0) {
                  envVars[siteNameIndex].value = envConfig.site.siteName;
                } else {
                  envVars.push({ name: 'SITE_NAME', value: envConfig.site.siteName });
                }
              }
              
              updatedDef.environment = envVars;
            }
            
            return updatedDef;
          });
          
          // Register a new task definition revision with the updated image
          const registerResponse = await ecsClient.send(new RegisterTaskDefinitionCommand({
            family: taskDef.family,
            taskRoleArn: taskDef.taskRoleArn,
            executionRoleArn: taskDef.executionRoleArn,
            networkMode: taskDef.networkMode,
            containerDefinitions: updatedContainerDefs,
            volumes: taskDef.volumes,
            placementConstraints: taskDef.placementConstraints,
            requiresCompatibilities: taskDef.requiresCompatibilities,
            cpu: taskDef.cpu,
            memory: taskDef.memory,
            runtimePlatform: taskDef.runtimePlatform,
            ephemeralStorage: taskDef.ephemeralStorage,
            inferenceAccelerators: taskDef.inferenceAccelerators,
            proxyConfiguration: taskDef.proxyConfiguration,
          }));
          
          const newTaskDefArn = registerResponse.taskDefinition?.taskDefinitionArn;
          if (!newTaskDefArn) {
            throw new Error('Failed to register new task definition');
          }
          
          // Extract the new revision number
          const newRevMatch = newTaskDefArn.match(/:(\d+)$/);
          if (newRevMatch) {
            newRevision = parseInt(newRevMatch[1]);
          }
          
          // Show what's changing
          if (!isStructuredOutput && options.verbose) {
            printInfo(`📋 Task Definition Changes:`);
            printInfo(`  Previous: revision ${previousRevision}`);
            printInfo(`  New: revision ${newRevision}`);
            printInfo(`  Image tag: ${imageTag}`);
            
            // Get task def to show environment changes
            const newTaskDef = await ecsClient.send(new DescribeTaskDefinitionCommand({
              taskDefinition: newTaskDefArn
            }));
            
            const envVars = newTaskDef.taskDefinition?.containerDefinitions?.[0]?.environment || [];
            const deploymentVersion = envVars.find(e => e.name === 'DEPLOYMENT_VERSION')?.value;
            if (deploymentVersion) {
              printInfo(`  Deployment Version: ${deploymentVersion}`);
            }
          }
          
          // Update the service to use the new task definition
          const updateResponse = await ecsClient.send(new UpdateServiceCommand({
            cluster: clusterName,
            service: actualServiceName,
            taskDefinition: newTaskDefArn,
            forceNewDeployment: true
          }));
          
          // Get the new deployment ID from the update response
          // The newest deployment should be the one we just created
          const newDeployments = updateResponse.service?.deployments || [];
          const newDeployment = newDeployments.find(d => d.status === 'PRIMARY' || d.status === 'ACTIVE');
          const deploymentId = newDeployment?.id;
          
          if (!deploymentId) {
            throw new Error('Failed to get deployment ID from update response');
          }
          
          // Get the updated service to find deployment info
          const afterUpdate = await ecsClient.send(new DescribeServicesCommand({
            cluster: clusterName,
            services: [actualServiceName]
          }));
          
          const serviceAfter = afterUpdate.services?.[0];
          const deploymentCount = serviceAfter?.deployments?.length || 0;
          
          if (!isStructuredOutput && options.output === 'summary') {
            if (newRevision && previousRevision && newRevision !== previousRevision) {
              // New task definition revision with updated image
              printSuccess(`ECS deployment initiated for ${serviceInfo.name} - new task definition with image tag '${imageTag}' (rev:${previousRevision} → rev:${newRevision})`);
              if (deploymentCount > 1) {
                printInfo(`Rolling update in progress (${deploymentCount} deployments active)`);
                printInfo(`⏱️  Typical deployment time: 2-3 minutes`);
                printInfo(`📋 Check status: semiont check --service ${serviceInfo.name}`);
                printInfo(`📝 Watch logs: semiont watch logs --service ${serviceInfo.name}`);
                printInfo(`🔍 If deployment fails, check:`);
                printInfo(`   - Task startup errors: aws ecs describe-services --cluster ${clusterName} --services ${actualServiceName} --region ${awsRegion}`);
                printInfo(`   - Container logs: semiont check --service ${serviceInfo.name} --verbose`);
              }
            } else {
              printSuccess(`ECS deployment initiated for ${serviceInfo.name} with image tag '${imageTag}'`);
            }
          }
          
          // Wait for deployment to complete if requested
          let waitFailed = false;
          if (options.wait) {
            if (!isStructuredOutput && options.output === 'summary') {
              printInfo(`Waiting for deployment ${deploymentId} to complete (timeout: ${options.timeout}s)...`);
            }
            
            const waitResult = await waitForDeploymentCompletion(
              ecsClient,
              clusterName,
              actualServiceName,
              deploymentId,
              options.timeout || 600,
              options.verbose || false
            );
            
            if (!isStructuredOutput && options.output === 'summary') {
              if (waitResult.success) {
                printSuccess(waitResult.message);
              } else {
                printError(waitResult.message);
              }
            }
            
            if (!waitResult.success) {
              waitFailed = true;
              // If wait failed, throw an error to ensure non-zero exit
              throw new Error(waitResult.message);
            }
          }
        }
        
        // For the result, indicate if this was a forced deployment with same revision
        const isForceDeployment = newRevision === previousRevision;
        
        const imageTag = options.dryRun ? 'unknown' : await determineImageTag(awsRegion, envConfig.aws?.accountId || '', serviceInfo.name);
        
        return {
          ...baseResult,
          updateTime,
          previousVersion: previousRevision ? `rev:${previousRevision}` : 'unknown',
          newVersion: newRevision ? `rev:${newRevision} (${imageTag})` : imageTag,
          rollbackAvailable: true,
          changesApplied: [{ 
            type: 'infrastructure', 
            description: newRevision 
              ? `Updated ECS task definition to use image tag '${imageTag}' (rev:${previousRevision} → rev:${newRevision})`
              : `ECS deployment initiated for ${actualServiceName}`
          }],
          resourceId: {
            aws: {
              arn: `arn:aws:ecs:${awsRegion}:${envConfig.aws?.accountId || '123456789012'}:service/${clusterName}/${actualServiceName}`,
              id: actualServiceName,
              name: actualServiceName
            }
          },
          status: options.dryRun ? 'dry-run' : 'updated',
          metadata: {
            serviceName: actualServiceName,
            cluster: clusterName,
            region: awsRegion,
            imageTag,
            previousRevision,
            newRevision
          },
        };
      } catch (error) {
        if (!isStructuredOutput && options.output === 'summary') {
          printError(`Failed to update ECS service ${serviceInfo.name}: ${error}`);
        }
        throw error;
      }
      
    case 'database':
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`RDS instances cannot be updated via this command`);
        printWarning('Use AWS Console or RDS CLI to update database instances');
      }
      
      return {
        ...baseResult,
        updateTime: new Date(),
        previousVersion: 'postgres-15',
        newVersion: 'postgres-15',
        rollbackAvailable: true,
        changesApplied: [],
        resourceId: {
          aws: {
            arn: `arn:aws:rds:us-east-1:123456789012:db:semiont-${environment}-db`,
            id: `semiont-${environment}-db`,
            name: `semiont-${environment}-database`
          }
        },
        status: 'not-applicable',
        metadata: {
          instanceIdentifier: `semiont-${environment}-db`,
          reason: 'RDS instances require manual updates'
        },
      };
      
    case 'filesystem':
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`EFS filesystems do not require updates`);
        printSuccess(`EFS ${serviceInfo.name} requires no action`);
      }
      
      return {
        ...baseResult,
        updateTime: new Date(),
        previousVersion: 'efs-standard',
        newVersion: 'efs-standard',
        rollbackAvailable: true,
        changesApplied: [],
        resourceId: {
          aws: {
            arn: `arn:aws:efs:us-east-1:123456789012:file-system/fs-semiont${environment}`,
            id: `fs-semiont${environment}`,
            name: `semiont-${environment}-efs`
          }
        },
        status: 'no-action-needed',
        metadata: {
          fileSystemId: `fs-semiont${environment}`,
          reason: 'EFS filesystems do not require updates'
        },
      };
      
    default:
      throw new Error(`Unsupported AWS service: ${serviceInfo.name}`);
  }
}

async function updateContainerService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions, startTime: number, isStructuredOutput: boolean = false): Promise<UpdateResult> {
  const environment = options.environment!; // Environment is guaranteed by command loader
  const baseResult = createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${environment}`;
  
  try {
    const updateTime = new Date();
    
    // Stop the current container
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Stopping container: ${containerName}`);
    }
    const stopSuccess = await stopContainer(containerName, {
      force: options.force ?? false,
      verbose: options.verbose ?? false,
      timeout: 10
    });
    
    if (!stopSuccess && !options.force) {
      throw new Error(`Failed to stop container: ${containerName}`);
    }
    
    // Wait for grace period
    const gracePeriod = options.gracePeriod || 3;
    if (gracePeriod > 0) {
      printDebug(`Waiting ${gracePeriod} seconds before starting...`, options.verbose || false);
      await new Promise(resolve => setTimeout(resolve, gracePeriod * 1000));
    }
    
    // Start the container again with updated image
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Starting updated container: ${containerName}`);
    }
    let startSuccess = false;
    let imageName = '';
    
    switch (serviceInfo.name) {
      case 'database':
        imageName = serviceInfo.config.image || 'postgres:15-alpine';
        startSuccess = await runContainer(imageName, containerName, {
          ports: { '5432': '5432' },
          environment: {
            POSTGRES_PASSWORD: serviceInfo.config.password || 'localpassword',
            POSTGRES_DB: serviceInfo.config.name || 'semiont',
            POSTGRES_USER: serviceInfo.config.user || 'postgres'
          },
          detached: true,
          verbose: options.verbose ?? false
        });
        break;
        
      case 'frontend':
      case 'backend':
        imageName = serviceInfo.config.image || `semiont-${serviceInfo.name}:latest`;
        startSuccess = await runContainer(imageName, containerName, {
          ports: serviceInfo.config.port ? { [serviceInfo.config.port.toString()]: serviceInfo.config.port.toString() } : {},
          detached: true,
          verbose: options.verbose ?? false
        });
        break;
        
      case 'filesystem':
        // Volumes don't need updating
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`Container volumes don't require updates`);
        }
        startSuccess = true;
        imageName = 'volume';
        break;
    }
    
    if (startSuccess) {
      if (!isStructuredOutput && options.output === 'summary') {
        printSuccess(`Container updated: ${containerName}`);
      }
      
      return {
        ...baseResult,
        updateTime,
        previousVersion: imageName,
        newVersion: imageName,
        rollbackAvailable: !options.force,
        changesApplied: [{ type: 'infrastructure', description: `Container ${containerName} updated with image ${imageName}` }],
        resourceId: {
          container: {
            id: containerName,
            name: containerName
          }
        },
        status: 'updated',
        metadata: {
          containerName,
          image: imageName,
          gracePeriod: options.gracePeriod || 3,
          forced: options.force || false
        },
      };
    } else {
      throw new Error(`Failed to start updated container: ${containerName}`);
    }
  } catch (error) {
    if (options.force) {
      if (!isStructuredOutput && options.output === 'summary') {
        printWarning(`Failed to update ${serviceInfo.name} container: ${error}`);
      }
      
      return {
        ...baseResult,
        success: false,  // Even with force, this is still a failure
        updateTime: new Date(),
        previousVersion: 'unknown',
        newVersion: 'unknown',
        rollbackAvailable: false,
        changesApplied: [],
        resourceId: {
          container: {
            id: containerName,
            name: containerName
          }
        },
        status: 'force-continued',
        metadata: {
          containerName,
          error: (error as Error).message,
          forced: true
        },
      };
    } else {
      throw error;
    }
  }
}

async function updateProcessService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions, startTime: number, isStructuredOutput: boolean = false): Promise<UpdateResult> {
  const environment = options.environment!; // Environment is guaranteed by command loader
  const baseResult = createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
  
  switch (serviceInfo.name) {
    case 'database':
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`Running database migrations for ${serviceInfo.name}`);
      }
      
      // Run Prisma migrations
      try {
        const migrationResult = await new Promise<boolean>((resolve) => {
          const proc = spawn('npm', ['run', 'prisma:migrate'], {
            cwd: `${process.env.SEMIONT_ROOT || process.cwd()}/apps/backend`,
            stdio: options.verbose ? 'inherit' : 'pipe',
            env: {
              ...process.env,
              DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:localpassword@localhost:5432/semiont'
            }
          });
          
          let output = '';
          let errorOutput = '';
          
          if (!options.verbose) {
            proc.stdout?.on('data', (data) => {
              output += data.toString();
            });
            
            proc.stderr?.on('data', (data) => {
              errorOutput += data.toString();
            });
          }
          
          proc.on('exit', (code) => {
            if (code === 0) {
              if (!isStructuredOutput && options.output === 'summary') {
                printDebug('Database migrations completed successfully', options as any);
              }
              resolve(true);
            } else {
              if (!options.verbose && errorOutput) {
                console.error(errorOutput);
              }
              printWarning('Database migrations failed or not needed');
              resolve(false);
            }
          });
          
          proc.on('error', (error) => {
            printWarning(`Migration error: ${error.message}`);
            resolve(false);
          });
        });
        
        const status = migrationResult ? 'updated' : 'migration-failed';
        const changesApplied = migrationResult ? ['Database schema updated'] : [];
        
        return {
          ...baseResult,
          updateTime: new Date(),
          previousVersion: 'current-schema',
          newVersion: migrationResult ? 'updated-schema' : 'current-schema',
          rollbackAvailable: true,
          changesApplied,
          resourceId: {
            process: {
              path: '/usr/local/var/postgres',
              port: 5432
            }
          },
          status,
          metadata: {
            migrationsRun: migrationResult,
            service: 'postgresql'
          },
        };
      } catch (error) {
        printWarning(`Failed to run migrations: ${(error as Error).message}`);
        
        return {
          ...baseResult,
          updateTime: new Date(),
          previousVersion: 'current-schema',
          newVersion: 'current-schema',
          rollbackAvailable: false,
          changesApplied: [],
          resourceId: {
            process: {
              path: '/usr/local/var/postgres',
              port: 5432
            }
          },
          status: 'failed',
          metadata: {
            error: (error as Error).message,
            service: 'postgresql'
          },
        };
      }
      
    case 'frontend':
    case 'backend':
      // Kill and restart process with updated code
      const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
      
      // Find and kill existing process
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`Stopping process on port ${port}`);
      }
      await findAndKillProcess(`:${port}`, serviceInfo.name, options);
      
      // Wait for grace period
      const processGracePeriod = options.gracePeriod || 3;
      if (processGracePeriod > 0) {
        printDebug(`Waiting ${processGracePeriod} seconds before starting...`, options.verbose || false);
        await new Promise(resolve => setTimeout(resolve, processGracePeriod * 1000));
      }
      
      // Start new process with updated code
      const updateTime = new Date();
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`Starting updated process for ${serviceInfo.name}`);
      }
      const command = serviceInfo.config.command?.split(' ') || ['npm', 'run', 'dev'];
      const proc = spawn(command[0]!, command.slice(1), {
        cwd: `apps/${serviceInfo.name}`,
        stdio: 'pipe',
        detached: true,
        env: {
          ...process.env,
          PORT: port.toString(),
        }
      });
      
      proc.unref();
      if (!isStructuredOutput && options.output === 'summary') {
        printSuccess(`Process updated on port ${port}`);
      }
      
      return {
        ...baseResult,
        updateTime,
        previousVersion: 'development',
        newVersion: 'development-updated',
        rollbackAvailable: !options.force,
        changesApplied: [{ type: 'code', description: `Process updated on port ${port}` }],
        resourceId: {
          process: {
            pid: proc.pid || 0,
            port: port,
            path: `apps/${serviceInfo.name}`
          }
        },
        status: 'updated',
        metadata: {
          command: command.join(' '),
          port,
          workingDirectory: `apps/${serviceInfo.name}`,
          gracePeriod: options.gracePeriod
        },
      };
      
    case 'filesystem':
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`No updates required for filesystem service`);
        printSuccess(`Filesystem service ${serviceInfo.name} unchanged`);
      }
      
      return {
        ...baseResult,
        updateTime: new Date(),
        previousVersion: 'filesystem',
        newVersion: 'filesystem',
        rollbackAvailable: true,
        changesApplied: [],
        resourceId: {
          process: {
            path: serviceInfo.config.path || '/tmp/filesystem'
          }
        },
        status: 'no-action-needed',
        metadata: {
          reason: 'No updates required for filesystem service'
        },
      };
      
    default:
      throw new Error(`Unsupported process service: ${serviceInfo.name}`);
  }
}

async function updateExternalService(serviceInfo: ServiceDeploymentInfo, options: UpdateOptions, startTime: number, isStructuredOutput: boolean = false): Promise<UpdateResult> {
  const environment = options.environment!; // Environment is guaranteed by command loader
  const baseResult = createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Cannot update external ${serviceInfo.name} service`);
  }
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`External database: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
          printWarning('External database updates must be managed by the database provider');
        }
        
        return {
          ...baseResult,
          updateTime: new Date(),
          previousVersion: 'external',
          newVersion: 'external',
          rollbackAvailable: true,
          changesApplied: [],
          resourceId: {
            external: {
              endpoint: `${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`
            }
          },
          status: 'external',
          metadata: {
            host: serviceInfo.config.host,
            port: serviceInfo.config.port || 5432,
            reason: 'External database updates must be managed by the database provider'
          },
        };
      }
      break;
      
    case 'filesystem':
      if (serviceInfo.config.path) {
        if (!isStructuredOutput && options.output === 'summary') {
          printInfo(`External storage: ${serviceInfo.config.path}`);
          printWarning('External storage updates must be managed by the storage provider');
        }
        
        return {
          ...baseResult,
          updateTime: new Date(),
          previousVersion: 'external',
          newVersion: 'external',
          rollbackAvailable: true,
          changesApplied: [],
          resourceId: {
            external: {
              path: serviceInfo.config.path
            }
          },
          status: 'external',
          metadata: {
            path: serviceInfo.config.path,
            reason: 'External storage updates must be managed by the storage provider'
          },
        };
      }
      break;
      
    default:
      if (!isStructuredOutput && options.output === 'summary') {
        printInfo(`External ${serviceInfo.name} service`);
        printWarning('External service updates must be managed separately');
      }
  }
  
  if (!isStructuredOutput && options.output === 'summary') {
    printSuccess(`External ${serviceInfo.name} service noted`);
  }
  
  return {
    ...baseResult,
    updateTime: new Date(),
    previousVersion: 'external',
    newVersion: 'external',
    rollbackAvailable: true,
    changesApplied: [],
    resourceId: {
      external: {
        endpoint: 'external-service'
      }
    },
    status: 'external',
    metadata: {
      reason: 'External service updates must be managed separately'
    },
  };
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
          } catch {
            debugLog(`Failed to kill PID ${pid}`, options);
          }
        }
      }
      debugLog(`Stopped ${name} process(es)`, options);
    } else {
      debugLog(`${name} not running`, options);
    }
  } catch (error) {
    if (!options.force) {
      throw error;
    }
  }
}

// =====================================================================
// STRUCTURED OUTPUT FUNCTION
// =====================================================================

export const update = async (
  serviceDeployments: ServiceDeploymentInfo[],
  options: UpdateOptions
): Promise<CommandResults> => {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  const environment = options.environment!; // Environment is guaranteed by command loader
  
  if (!isStructuredOutput && options.output === 'summary') {
    printInfo(`Updating services in ${colors.bright}${environment}${colors.reset} environment`);
  }
  
  if (options.verbose && !isStructuredOutput && options.output === 'summary') {
    console.log(`Options: ${JSON.stringify(options, null, 2)}`);
  }
  
  try {
    if (options.verbose && !isStructuredOutput && options.output === 'summary') {
      console.log(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`);
    }
    
    if (options.dryRun && !isStructuredOutput && options.output === 'summary') {
      printInfo('[DRY RUN] Would update the following services:');
      for (const serviceInfo of serviceDeployments) {
        printInfo(`  - ${serviceInfo.name} (${serviceInfo.deploymentType})`);
      }
    }
    
    // Update services and collect results
    const serviceResults: UpdateResult[] = [];
    
    for (const serviceInfo of serviceDeployments) {
      try {
        const result = await updateService(serviceInfo, options, isStructuredOutput);
        serviceResults.push(result);
        
        // Stop on first error unless --force is used
        if (!result.success && !options.force) {
          if (!isStructuredOutput && options.output === 'summary') {
            printError(`Stopping due to error. Use --force to continue despite errors.`);
          }
          break;
        }
      } catch (error) {
        // Create error result
        const baseResult = createBaseResult('update', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
        const errorResult = createErrorResult(baseResult, error as Error);
        
        const updateErrorResult: UpdateResult = {
          ...errorResult,
          updateTime: new Date(),
          previousVersion: 'unknown',
          newVersion: 'unknown',
          rollbackAvailable: false,
          changesApplied: [],
          resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
          status: 'failed',
          metadata: { error: (error as Error).message },
        };
        
        serviceResults.push(updateErrorResult);
        
        if (!isStructuredOutput && options.output === 'summary') {
          printError(`Failed to update ${serviceInfo.name}: ${error}`);
        }
        
        if (!options.force) {
          break; // Stop on first error unless --force
        }
      }
    }
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'update',
      environment: environment,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: serviceResults,
      summary: {
        total: serviceResults.length,
        succeeded: serviceResults.filter(r => r.success).length,
        failed: serviceResults.filter(r => !r.success).length,
        warnings: serviceResults.filter(r => r.status.includes('not-implemented') || r.status.includes('not-applicable')).length,
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
      printError(`Failed to update services: ${error}`);
    }
    
    return {
      command: 'update',
      environment: environment,
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

import { CommandBuilder } from '../lib/command-definition.js';

export const updateCommand = new CommandBuilder<UpdateOptions>()
  .name('update')
  .description('Update running services with latest code/images')
  .schema(UpdateOptionsSchema as any)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args({
    args: {
      '--environment': { type: 'string', description: 'Environment name', required: true },
      '--skip-tests': { type: 'boolean', description: 'Skip test suite after update' },
      '--skip-build': { type: 'boolean', description: 'Skip build step' },
      '--force': { type: 'boolean', description: 'Force update even on errors' },
      '--grace-period': { type: 'number', description: 'Seconds to wait between stop and start' },
      '--wait': { type: 'boolean', description: 'Wait for deployment to complete' },
      '--timeout': { type: 'number', description: 'Timeout in seconds for --wait (default: 600)' },
      '--verbose': { type: 'boolean', description: 'Verbose output' },
      '--dry-run': { type: 'boolean', description: 'Simulate actions without executing' },
      '--output': { type: 'string', description: 'Output format (summary, table, json, yaml)' },
      '--service': { type: 'string', description: 'Service name or "all" for all services' },
    },
    aliases: {
      '-e': '--environment',
      '-f': '--force',
      '-w': '--wait',
      '-v': '--verbose',
      '-o': '--output',
    }
  })
  .examples(
    'semiont update --environment staging',
    'semiont update --environment production --wait',
    'semiont update --environment production --force',
    'semiont update --environment local --skip-tests'
  )
  .handler(update)
  .build();

// Export default for compatibility
export default updateCommand;

// Export the schema and options type for use by CLI
export type { UpdateOptions };
export { UpdateOptionsSchema };