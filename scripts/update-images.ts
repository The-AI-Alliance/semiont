#!/usr/bin/env -S npx tsx

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { config } from '../config';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { ECSClient, ListTasksCommand, DescribeTasksCommand, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { ECRClient, DescribeRepositoriesCommand, CreateRepositoryCommand, DescribeImagesCommand, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { requireValidAWSCredentials } from './utils/aws-validation';
import { CdkDeployer } from './lib/cdk-deployer';

interface UpdateImagesOptions {
  requireApproval?: boolean;
  verbose?: boolean;
}

// AWS SDK Clients
const region = config.aws.region;
const cloudFormationClient = new CloudFormationClient({ region });
const ecsClient = new ECSClient({ region });
const logsClient = new CloudWatchLogsClient({ region });
const ecrClient = new ECRClient({ region });

function timestamp(): string {
  return new Date().toISOString();
}

function log(message: string): void {
  console.log(`[${timestamp()}] ${message}`);
}

async function runCommand(command: string[], cwd: string, description: string): Promise<boolean> {
  return new Promise((resolve) => {
    log(`🔨 ${description}...`);
    log(`💻 Working directory: ${path.resolve(cwd)}`);
    log(`💻 Command: ${command.join(' ')}`);
    
    const startTime = Date.now();
    const process: ChildProcess = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: 'inherit',
      shell: true
    });

    process.on('close', (code: number | null) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        log(`✅ ${description} completed in ${duration}ms`);
      } else {
        log(`❌ ${description} failed (exit code ${code}) after ${duration}ms`);
      }
      resolve(code === 0);
    });

    process.on('error', (error: Error) => {
      const duration = Date.now() - startTime;
      log(`❌ ${description} failed: ${error.message} after ${duration}ms`);
      resolve(false);
    });
  });
}


async function getECRLoginToken(): Promise<string | null> {
  try {
    const command = new GetAuthorizationTokenCommand({});
    const response = await ecrClient.send(command);
    
    const authData = response.authorizationData?.[0];
    if (!authData?.authorizationToken) {
      log(`❌ Failed to get ECR login token: No authorization data`);
      return null;
    }
    
    // Decode base64 token to get username:password
    const token = Buffer.from(authData.authorizationToken, 'base64').toString('utf-8');
    const password = token.split(':')[1];
    
    return password || null;
  } catch (error) {
    log(`❌ Failed to get ECR login token: ${error}`);
    return null;
  }
}

async function ensureECRRepository(repositoryName: string): Promise<boolean> {
  log(`🔍 Checking if ECR repository '${repositoryName}' exists...`);
  
  try {
    // Check if repository exists
    const checkCommand = new DescribeRepositoriesCommand({
      repositoryNames: [repositoryName]
    });
    
    await ecrClient.send(checkCommand);
    log(`✅ ECR repository '${repositoryName}' already exists`);
    return true;
  } catch (error: any) {
    if (error.name === 'RepositoryNotFoundException') {
      // Repository doesn't exist, create it
      log(`🔨 Creating ECR repository '${repositoryName}'...`);
      
      try {
        const createCommand = new CreateRepositoryCommand({
          repositoryName: repositoryName
        });
        
        await ecrClient.send(createCommand);
        log(`✅ Successfully created ECR repository '${repositoryName}'`);
        return true;
      } catch (createError) {
        log(`❌ CRITICAL: Failed to create ECR repository '${repositoryName}': ${createError}`);
        return false;
      }
    } else {
      log(`❌ CRITICAL: Error checking ECR repository '${repositoryName}': ${error}`);
      return false;
    }
  }
}

async function verifyECRPush(repositoryName: string, imageTag: string): Promise<boolean> {
  log(`🔍 Verifying ECR push for ${repositoryName}:${imageTag}...`);
  
  try {
    const command = new DescribeImagesCommand({
      repositoryName: repositoryName,
      imageIds: [{ imageTag: imageTag }]
    });
    
    const response = await ecrClient.send(command);
    
    if (!response.imageDetails || response.imageDetails.length === 0) {
      log(`❌ CRITICAL: ECR verification failed - image ${repositoryName}:${imageTag} not found in ECR`);
      return false;
    }
    
    log(`✅ ECR verification successful - image ${repositoryName}:${imageTag} confirmed in ECR`);
    return true;
  } catch (error) {
    log(`❌ CRITICAL: ECR verification failed - ${error}`);
    return false;
  }
}

async function pushToECR(localImageName: string, serviceName: string): Promise<string | null> {
  log(`🐳 Pushing ${localImageName} to ECR...`);
  
  const accountId = config.aws.accountId || '571600854494';
  const region = config.aws.region;
  
  const ecrRepo = `${accountId}.dkr.ecr.${region}.amazonaws.com/semiont-${serviceName}`;
  const repositoryName = `semiont-${serviceName}`;
  
  const imageExists = await runCommand(['docker', 'image', 'inspect', localImageName], '.', `Check ${localImageName} exists`);
  if (!imageExists) {
    log(`❌ CRITICAL: Local image ${localImageName} does not exist`);
    return null;
  }
  
  const repoExists = await ensureECRRepository(repositoryName);
  if (!repoExists) {
    log(`❌ CRITICAL: Could not ensure ECR repository ${repositoryName} exists`);
    return null;
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const imageTag = `deploy-${timestamp}`;
  const taggedImage = `${ecrRepo}:${imageTag}`;
  
  log(`📋 ECR repository: ${ecrRepo}`);
  log(`🏷️  Image tag: ${imageTag}`);
  
  const loginToken = await getECRLoginToken();
  if (!loginToken) {
    log(`❌ CRITICAL: Failed to get ECR login token`);
    return null;
  }
  
  const loginSuccess = await runCommand([
    'docker', 'login', '--username', 'AWS', '--password', loginToken, `${accountId}.dkr.ecr.${region}.amazonaws.com`
  ], '.', 'ECR login');
  
  if (!loginSuccess) {
    log(`❌ CRITICAL: ECR login failed`);
    return null;
  }
  
  const tagSuccess = await runCommand(['docker', 'tag', localImageName, taggedImage], '.', `Tag image as ${taggedImage}`);
  if (!tagSuccess) {
    log(`❌ CRITICAL: Failed to tag image`);
    return null;
  }
  
  const pushSuccess = await runCommand(['docker', 'push', taggedImage], '.', `Push ${taggedImage}`);
  if (!pushSuccess) {
    log(`❌ CRITICAL: Failed to push image to ECR`);
    return null;
  }
  
  const verifySuccess = await verifyECRPush(repositoryName, imageTag);
  if (!verifySuccess) {
    log(`❌ CRITICAL: ECR push verification failed`);
    return null;
  }
  
  const latestImage = `${ecrRepo}:latest`;
  const tagLatestSuccess = await runCommand(['docker', 'tag', localImageName, latestImage], '.', `Tag image as ${latestImage}`);
  if (!tagLatestSuccess) {
    log(`❌ CRITICAL: Failed to tag image as latest`);
    return null;
  }
  
  const pushLatestSuccess = await runCommand(['docker', 'push', latestImage], '.', `Push ${latestImage}`);
  if (!pushLatestSuccess) {
    log(`❌ CRITICAL: Failed to push latest image to ECR`);
    return null;
  }
  
  const verifyLatestSuccess = await verifyECRPush(repositoryName, 'latest');
  if (!verifyLatestSuccess) {
    log(`❌ CRITICAL: ECR latest push verification failed`);
    return null;
  }
  
  log(`✅ Successfully pushed and verified in ECR: ${taggedImage}`);
  log(`✅ Successfully pushed and verified in ECR: ${latestImage}`);
  return taggedImage;
}

async function pushImagesToECR(): Promise<{ frontend: string | null; backend: string | null }> {
  log(`🚀 Pushing Docker images to ECR...`);
  
  const frontendExists = await runCommand(['docker', 'image', 'inspect', 'semiont-frontend:latest'], '.', 'Check frontend image exists');
  const backendExists = await runCommand(['docker', 'image', 'inspect', 'semiont-backend:latest'], '.', 'Check backend image exists');
  
  if (!frontendExists && !backendExists) {
    log(`❌ CRITICAL: No local Docker images found. Run './semiont build' first.`);
    return { frontend: null, backend: null };
  }
  
  const results = { frontend: null as string | null, backend: null as string | null };
  let pushAttempts = 0;
  let pushSuccesses = 0;
  
  if (backendExists) {
    pushAttempts++;
    log(`📤 Pushing backend image to ECR...`);
    results.backend = await pushToECR('semiont-backend:latest', 'backend');
    if (results.backend) {
      pushSuccesses++;
      log(`✅ Backend ECR push successful: ${results.backend}`);
    } else {
      log(`❌ Backend ECR push failed`);
    }
  } else {
    log(`⚠️  Backend image not found locally, skipping ECR push`);
  }
  
  if (frontendExists) {
    pushAttempts++;
    log(`📤 Pushing frontend image to ECR...`);
    results.frontend = await pushToECR('semiont-frontend:latest', 'frontend');
    if (results.frontend) {
      pushSuccesses++;
      log(`✅ Frontend ECR push successful: ${results.frontend}`);
    } else {
      log(`❌ Frontend ECR push failed`);
    }
  } else {
    log(`⚠️  Frontend image not found locally, skipping ECR push`);
  }
  
  log(`📊 ECR Push Summary: ${pushSuccesses}/${pushAttempts} successful`);
  if (pushSuccesses === 0) {
    log(`❌ CRITICAL: All ECR pushes failed! Cannot proceed with deployment.`);
  } else if (pushSuccesses < pushAttempts) {
    log(`⚠️  Some ECR pushes failed, but continuing with partial deployment`);
  } else {
    log(`✅ All ECR pushes successful!`);
  }
  
  return results;
}

async function getECSClusterName(): Promise<string | null> {
  try {
    const command = new DescribeStacksCommand({
      StackName: 'SemiontAppStack'
    });
    
    const response = await cloudFormationClient.send(command);
    const stack = response.Stacks?.[0];
    
    if (!stack?.Outputs) {
      return null;
    }
    
    const clusterOutput = stack.Outputs.find(output => output.OutputKey === 'ClusterName');
    return clusterOutput?.OutputValue || null;
  } catch (error) {
    log(`❌ Error getting cluster name: ${error}`);
    return null;
  }
}

async function getFailedECSTasks(clusterName: string): Promise<string[]> {
  try {
    const command = new ListTasksCommand({
      cluster: clusterName,
      desiredStatus: 'STOPPED',
      maxResults: 10
    });
    
    const response = await ecsClient.send(command);
    return response.taskArns || [];
  } catch (error) {
    log(`❌ Error listing failed tasks: ${error}`);
    return [];
  }
}

async function getTaskLogs(clusterName: string, taskArn: string): Promise<void> {
  const taskId = taskArn.split('/').pop();
  log(`🔍 Analyzing failed task: ${taskId}`);
  
  try {
    // Get task details
    const taskCommand = new DescribeTasksCommand({
      cluster: clusterName,
      tasks: [taskArn]
    });
    
    const taskResponse = await ecsClient.send(taskCommand);
    const task = taskResponse.tasks?.[0];
    
    if (task) {
      log(`❌ Task Stop Reason: ${task.stoppedReason || 'Unknown'}`);
      const container = task.containers?.[0];
      if (container) {
        log(`❌ Container Status: ${container.lastStatus || 'Unknown'}`);
        log(`❌ Container Reason: ${container.reason || 'None'}`);
        log(`❌ Exit Code: ${container.exitCode || 'None'}`);
      }
      
      // Get log group from task definition
      if (task.taskDefinitionArn) {
        try {
          const taskDefCommand = new DescribeTaskDefinitionCommand({
            taskDefinition: task.taskDefinitionArn
          });
          
          const taskDefResponse = await ecsClient.send(taskDefCommand);
          const containerDef = taskDefResponse.taskDefinition?.containerDefinitions?.[0];
          const logGroup = containerDef?.logConfiguration?.options?.['awslogs-group'];
          
          if (logGroup) {
            log(`📋 Checking logs in: ${logGroup}`);
            
            // Get recent log entries
            const logsCommand = new FilterLogEventsCommand({
              logGroupName: logGroup,
              startTime: Date.now() - 30 * 60 * 1000, // Last 30 minutes
              limit: 20
            });
            
            try {
              const logsResponse = await logsClient.send(logsCommand);
              if (logsResponse.events && logsResponse.events.length > 0) {
                log(`📜 Recent Container Logs:`);
                logsResponse.events.forEach(event => {
                  const timestamp = new Date(event.timestamp || 0).toISOString();
                  console.log(`[${timestamp}] ${event.message || ''}`);
                });
              } else {
                log(`❌ No recent log entries found`);
              }
            } catch (logsError) {
              log(`❌ Could not retrieve logs: ${logsError}`);
            }
          } else {
            log(`❌ Could not determine log group for task`);
          }
        } catch (taskDefError) {
          log(`❌ Could not get task definition: ${taskDefError}`);
        }
      }
    }
  } catch (error) {
    log(`❌ Error analyzing task: ${error}`);
  }
}

async function diagnoseECSFailures(): Promise<void> {
  log(`🔍 Diagnosing ECS deployment failures...`);
  
  const clusterName = await getECSClusterName();
  if (!clusterName) {
    log(`❌ Could not find ECS cluster name`);
    return;
  }
  
  log(`📋 ECS Cluster: ${clusterName}`);
  
  const failedTasks = await getFailedECSTasks(clusterName);
  if (failedTasks.length === 0) {
    log(`💡 No recent failed tasks found`);
    return;
  }
  
  log(`🔍 Found ${failedTasks.length} recent failed tasks, analyzing most recent...`);
  
  // Analyze the most recent failed task
  if (failedTasks[0]) {
    await getTaskLogs(clusterName, failedTasks[0]);
  }
}

async function updateECSServices(ecrImages: { frontend: string | null; backend: string | null }): Promise<boolean> {
  log(`🔄 Updating ECS services with new images...`);
  
  // Prepare context variables for CDK
  const context: Record<string, string> = {};
  if (ecrImages.frontend) {
    context.frontendImageUri = ecrImages.frontend;
  }
  if (ecrImages.backend) {
    context.backendImageUri = ecrImages.backend;
  }
  
  const deployer = new CdkDeployer();
  let deploySuccess: boolean;
  
  try {
    deploySuccess = await deployer.deployAppStack({ 
      requireApproval: false, 
      context 
    });
  } finally {
    deployer.cleanup();
  }
  
  if (!deploySuccess) {
    log(`❌ ECS service update failed - running diagnostics...`);
    await diagnoseECSFailures();
  }
  
  return deploySuccess;
}

async function updateImages(_options: UpdateImagesOptions) {
  console.log(`🚀 Starting ${config.site.siteName} image update...`);
  
  // Validate AWS credentials early to avoid wasting time
  await requireValidAWSCredentials(region);
  
  const startTime = Date.now();
  
  try {
    // Push fresh images to ECR
    const ecrImages = await pushImagesToECR();
    
    if (!ecrImages.frontend && !ecrImages.backend) {
      log(`❌ CRITICAL: No images were pushed to ECR successfully`);
      return false;
    }
    
    log(`📋 ECR Push Results:`);
    if (ecrImages.frontend) {
      log(`  📱 Frontend: ${ecrImages.frontend}`);
    }
    if (ecrImages.backend) {
      log(`  🚀 Backend: ${ecrImages.backend}`);
    }
    
    // Update ECS services with new images
    const updateSuccess = await updateECSServices(ecrImages);
    
    const duration = Math.round((Date.now() - startTime) / 1000);
    
    if (updateSuccess) {
      console.log('');
      console.log('✅ Image update completed successfully!');
      console.log(`⏱️  Total time: ${Math.floor(duration / 60)}m ${duration % 60}s`);
      console.log(`🌐 Your site should be available at: https://${config.site.domain}`);
      console.log('💡 Check deployment status with: ./semiont status');
      return true;
    } else {
      console.log('');
      console.error('❌ Image update failed');
      console.log('💡 Check the error messages above for details');
      return false;
    }
    
  } catch (error: any) {
    console.error('❌ Image update error:', error.message);
    return false;
  }
}

function showHelp() {
  console.log(`🖼️  ${config.site.siteName} Image Update Tool`);
  console.log('');
  console.log('Usage: npx tsx update-images.ts [options]');
  console.log('   or: ./semiont update-images [options]');
  console.log('');
  console.log('Options:');
  console.log('   --approval      Require manual approval for changes');
  console.log('   --verbose       Show detailed output');
  console.log('   --help, -h      Show this help');
  console.log('');
  console.log('Examples:');
  console.log('   ./semiont update-images              # Update with latest built images');
  console.log('   ./semiont update-images --approval   # Update with manual approval');
  console.log('');
  console.log('Process:');
  console.log('   1. 🐳 Push local Docker images to ECR with timestamped tags');
  console.log('   2. 🔄 Update ECS task definitions to use new ECR images');
  console.log('   3. 🚀 Deploy new ECS tasks with updated images');
  console.log('');
  console.log('Prerequisites:');
  console.log('   • Run "./semiont build" first to create local Docker images');
  console.log('   • App stack must already exist (run "./semiont deploy app" first)');
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }
  
  const requireApproval = args.includes('--approval');
  const verbose = args.includes('--verbose');
  
  const success = await updateImages({
    requireApproval,
    verbose
  });
  
  process.exit(success ? 0 : 1);
}

main().catch(console.error);