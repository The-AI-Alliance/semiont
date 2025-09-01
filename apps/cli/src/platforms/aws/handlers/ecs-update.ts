import { execSync } from 'child_process';
import { UpdateHandlerContext, UpdateHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';

/**
 * Update handler for ECS Fargate services
 * 
 * Forces a new deployment of the ECS service, which will:
 * - Pull the latest image if using mutable tags (like 'latest')
 * - Restart tasks with the current image if using immutable tags
 * - Support rolling updates with zero downtime
 * - Wait for deployment completion if requested
 */
const updateECSService = async (context: UpdateHandlerContext): Promise<UpdateHandlerResult> => {
  const { service, cfnDiscoveredResources, region, resourceName } = context;
  
  // Get cluster and service names from discovered resources
  const clusterName = cfnDiscoveredResources?.clusterName || `semiont-${service.environment}`;
  const serviceName = cfnDiscoveredResources?.serviceName || resourceName;
  
  if (!clusterName || !serviceName) {
    return {
      success: false,
      strategy: 'none',
      error: `Cluster or service not found for ${service.name}. Discovered: ${JSON.stringify(cfnDiscoveredResources)}`,
      metadata: {
        serviceType: 'ecs-fargate'
      }
    };
  }
  
  try {
    // Get current task definition revision
    const previousVersion = await getCurrentTaskDefinition(clusterName, serviceName, region);
    
    // Force a new deployment with the current task definition
    // This will cause ECS to pull the image again, getting any updates if the tag is mutable (like 'latest')
    // For immutable tags (like git hashes), this will just restart the tasks
    const updateResult = execSync(
      `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --force-new-deployment --region ${region} --output json`,
      { encoding: 'utf-8' }
    );
    
    if (service.verbose) {
      // Get current task definition to show what image is being used
      try {
        // First get the service to find its current task definition
        const serviceData = execSync(
          `aws ecs describe-services --cluster ${clusterName} --services ${serviceName} --region ${region} --output json`,
          { encoding: 'utf-8' }
        );
        
        const ecsService = JSON.parse(serviceData).services?.[0];
        if (ecsService?.taskDefinition) {
          const currentTaskDef = execSync(
            `aws ecs describe-task-definition --task-definition ${ecsService.taskDefinition} --region ${region} --output json`,
            { encoding: 'utf-8' }
          );
          
          const taskDef = JSON.parse(currentTaskDef).taskDefinition;
          const images = taskDef.containerDefinitions?.map((c: any) => c.image).filter(Boolean);
          if (images?.length > 0) {
            console.log(`[DEBUG] Forcing new deployment with image(s): ${images.join(', ')}`);
          }
        }
      } catch (error) {
        // Ignore errors in verbose logging
        if (service.verbose) {
          console.log(`[DEBUG] Could not get current task definition: ${error}`);
        }
      }
    }
    
    // Parse the update result to get deployment ID
    const updateData = JSON.parse(updateResult);
    const deployments = updateData.service?.deployments || [];
    const newDeployment = deployments.find((d: any) => d.status === 'PRIMARY');
    const deploymentId = newDeployment?.id;
    
    // Wait for deployment if requested
    if (service.config?.wait && deploymentId) {
      const timeout = service.config.timeout || 300;
      if (!service.quiet) {
        printInfo(`Waiting for deployment to complete (timeout: ${timeout}s)...`);
      }
      
      await waitForECSDeployment(clusterName, serviceName, deploymentId, region, timeout, service.verbose);
    }
    
    // Get new task definition revision
    const newVersion = await getCurrentTaskDefinition(clusterName, serviceName, region);
    
    return {
      success: true,
      previousVersion,
      newVersion,
      strategy: 'rolling',
      metadata: {
        serviceType: 'ecs-fargate',
        clusterName,
        serviceName,
        deploymentId,
        region
      }
    };
    
  } catch (error) {
    return {
      success: false,
      strategy: 'none',
      error: error instanceof Error ? error.message : String(error),
      metadata: {
        serviceType: 'ecs-fargate'
      }
    };
  }
};

/**
 * Get current task definition revision
 */
async function getCurrentTaskDefinition(cluster: string, service: string, region: string): Promise<string> {
  try {
    const taskDef = execSync(
      `aws ecs describe-services --cluster ${cluster} --services ${service} --query 'services[0].taskDefinition' --output text --region ${region}`,
      { encoding: 'utf-8' }
    ).trim();
    return taskDef.split(':').pop() || '';
  } catch {
    return '';
  }
}

/**
 * Wait for ECS deployment to complete with enhanced monitoring
 */
async function waitForECSDeployment(
  clusterName: string,
  serviceName: string,
  deploymentId: string,
  region: string,
  timeout: number,
  verbose: boolean = false
): Promise<void> {
  const startTime = Date.now();
  const checkInterval = 5000; // 5 seconds
  let imagePullDetected = false;
  let lastEventCount = 0;
  
  // Extend timeout if we detect image pulling
  let effectiveTimeout = timeout;
  
  while ((Date.now() - startTime) < (effectiveTimeout * 1000)) {
    try {
      // Get service details with events
      const serviceData = execSync(
        `aws ecs describe-services --cluster ${clusterName} --services ${serviceName} --region ${region} --output json`,
        { encoding: 'utf-8' }
      );
      
      const service = JSON.parse(serviceData).services?.[0];
      if (!service) {
        throw new Error(`Service ${serviceName} not found`);
      }
      
      const deployments = service.deployments || [];
      const events = service.events || [];
      const ourDeployment = deployments.find((d: any) => d.id === deploymentId);
      
      if (!ourDeployment) {
        // Deployment no longer exists - likely rolled back
        throw new Error(`Deployment ${deploymentId} no longer exists - likely failed or was rolled back`);
      }
      
      // Check for image pull events
      if (events.length > lastEventCount) {
        const newEvents = events.slice(0, events.length - lastEventCount);
        const pullEvents = newEvents.filter((e: any) => 
          e.message?.includes('pulling image') || 
          e.message?.includes('pull complete')
        );
        
        if (pullEvents.length > 0 && !imagePullDetected) {
          imagePullDetected = true;
          effectiveTimeout = timeout + 300; // Add 5 minutes for image pull
          if (!verbose) {
            process.stdout.write('\n');
          }
          printInfo('Image pull detected, extending timeout by 5 minutes...');
        }
        
        lastEventCount = events.length;
      }
      
      // Get detailed task counts by deployment version
      let taskDetails = { new: { total: 0, running: 0, healthy: 0, pending: 0 }, old: { total: 0, running: 0, healthy: 0, pending: 0 } };
      let taskHealthStatus = 'UNKNOWN'; // Track overall health status
      try {
        const tasksData = execSync(
          `aws ecs list-tasks --cluster ${clusterName} --service-name ${serviceName} --desired-status RUNNING --region ${region} --output json`,
          { encoding: 'utf-8' }
        );
        const taskArns = JSON.parse(tasksData).taskArns || [];
        
        if (taskArns.length > 0) {
          const taskDetailsJson = execSync(
            `aws ecs describe-tasks --cluster ${clusterName} --tasks ${taskArns.join(' ')} --region ${region} --output json`,
            { encoding: 'utf-8' }
          );
          const allTasks = JSON.parse(taskDetailsJson).tasks || [];
          
          // Group tasks by deployment (new vs old)
          for (const task of allTasks) {
            const isNewDeployment = task.taskDefinitionArn === ourDeployment.taskDefinition;
            const details = isNewDeployment ? taskDetails.new : taskDetails.old;
            
            details.total++;
            
            if (task.lastStatus === 'PENDING' || task.lastStatus === 'PROVISIONING') {
              details.pending++;
              if (isNewDeployment) {
                taskHealthStatus = 'STARTING';
              }
            } else if (task.lastStatus === 'RUNNING') {
              details.running++;
              if (task.healthStatus === 'HEALTHY') {
                details.healthy++;
                if (isNewDeployment && taskHealthStatus !== 'STARTING') {
                  taskHealthStatus = 'HEALTHY';
                }
              } else if (isNewDeployment && task.healthStatus === 'UNKNOWN') {
                taskHealthStatus = 'STARTING';
              }
            }
          }
        }
      } catch {
        // Ignore task detail errors - just show deployment counts
      }
      
      // Check deployment status
      if (ourDeployment.status === 'PRIMARY') {
        const running = ourDeployment.runningCount || 0;
        const desired = ourDeployment.desiredCount || 0;
        
        // Deployment is only REALLY complete when:
        // 1. Our deployment has all tasks running
        // 2. There are NO other active deployments (old tasks drained)
        // 3. Tasks are healthy (if health checks configured)
        if (running === desired && desired > 0) {
          // Check if there are any other non-INACTIVE deployments
          const otherActiveDeployments = deployments.filter((d: any) => 
            d.id !== deploymentId && d.status !== 'INACTIVE'
          );
          
          if (otherActiveDeployments.length === 0 && taskHealthStatus !== 'STARTING') {
            // Only our deployment is active and tasks are ready
            if (!verbose) {
              process.stdout.write('\n');
            }
            printSuccess(`Deployment ${deploymentId} fully completed - all traffic switched (${running}/${desired} tasks running and healthy)`);
            return;
          } else {
            // Still draining old tasks or waiting for health
            if (verbose) {
              if (otherActiveDeployments.length > 0) {
                console.log(`Waiting for ${otherActiveDeployments.length} old deployment(s) to drain...`);
              }
              if (taskHealthStatus === 'STARTING') {
                console.log('Waiting for tasks to pass health checks...');
              }
            }
          }
        }
        
        // Show progress with phase information
        if (!verbose) {
          const progress = desired > 0 ? Math.round((running / desired) * 100) : 0;
          
          const barLength = 20;
          const filledLength = Math.round((progress / 100) * barLength);
          const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
          
          // Build detailed status text
          const newStatus = `new: ${taskDetails.new.healthy}h/${taskDetails.new.running}r/${taskDetails.new.total}t`;
          const oldStatus = taskDetails.old.total > 0 ? ` | old: ${taskDetails.old.healthy}h/${taskDetails.old.running}r/${taskDetails.old.total}t` : '';
          
          process.stdout.write(`\r  Deployment: [${bar}] ${progress}% (${running}/${desired}) [${newStatus}${oldStatus}]  `);
        } else {
          // Verbose mode - show raw counts
          const newStatus = `new: ${taskDetails.new.healthy}h/${taskDetails.new.running}r/${taskDetails.new.total}t`;
          const oldStatus = `old: ${taskDetails.old.healthy}h/${taskDetails.old.running}r/${taskDetails.old.total}t`;
          console.log(`Deployment progress: ${running}/${desired} tasks [${ourDeployment.status}] [${newStatus} | ${oldStatus}]`);
        }
      } else if (ourDeployment.status === 'INACTIVE') {
        // Deployment was replaced or rolled back
        throw new Error(`Deployment ${deploymentId} failed - status is INACTIVE`);
      }
      
      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    } catch (error) {
      if (error instanceof Error && error.message.includes('Deployment')) {
        if (!verbose) {
          process.stdout.write('\n');
        }
        throw error; // Re-throw deployment-specific errors
      }
      // Ignore other errors and keep trying
      if (verbose) {
        console.log(`Error checking deployment: ${error}`);
      }
    }
  }
  
  // Clear progress line
  if (!verbose) {
    process.stdout.write('\n');
  }
  
  throw new Error(`Deployment ${deploymentId} timed out after ${effectiveTimeout} seconds`);
}

/**
 * Descriptor for ECS update handler
 */
export const ecsUpdateDescriptor: HandlerDescriptor<UpdateHandlerContext, UpdateHandlerResult> = {
  command: 'update',
  platform: 'aws',
  serviceType: 'ecs',
  handler: updateECSService,
  requiresDiscovery: true
};

// Also export for ecs-fargate (alias)
export const ecsFargateUpdateDescriptor: HandlerDescriptor<UpdateHandlerContext, UpdateHandlerResult> = {
  command: 'update',
  platform: 'aws',
  serviceType: 'ecs-fargate',
  handler: updateECSService,
  requiresDiscovery: true
};