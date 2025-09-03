import { execSync } from 'child_process';
import { AWSUpdateHandlerContext, UpdateHandlerResult, HandlerDescriptor } from './types.js';
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
const updateECSService = async (context: AWSUpdateHandlerContext): Promise<UpdateHandlerResult> => {
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
    // Get current task definition revision being used by the service
    const currentRevision = await getCurrentTaskDefinition(clusterName, serviceName, region);
    
    // Check if there's a newer task definition available
    const latestRevision = await getLatestTaskDefinitionRevision(clusterName, serviceName, region);
    
    if (service.verbose) {
      console.log(`[DEBUG] Current revision: ${currentRevision}`);
      console.log(`[DEBUG] Latest revision: ${latestRevision}`);
    }
    
    let updateCommand: string;
    let updateMode: string;
    
    if (latestRevision && latestRevision !== currentRevision) {
      // There's a newer task definition - update to it
      const taskFamily = await getTaskDefinitionFamily(clusterName, serviceName, region);
      updateCommand = `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --task-definition ${taskFamily}:${latestRevision} --region ${region} --output json`;
      updateMode = `new task definition (revision ${currentRevision} → ${latestRevision})`;
      
      if (!service.quiet) {
        printInfo(`Updating service to use newer task definition revision ${latestRevision} (current: ${currentRevision})`);
      }
    } else {
      // No newer task definition - force redeployment of current one
      // This is useful for mutable tags like 'latest' where the image may have changed
      updateCommand = `aws ecs update-service --cluster ${clusterName} --service ${serviceName} --force-new-deployment --region ${region} --output json`;
      updateMode = `forced redeployment of revision ${currentRevision}`;
      
      if (!service.quiet) {
        printInfo(`No newer task definition found. Forcing redeployment of current revision ${currentRevision}`);
      }
    }
    
    const updateResult = execSync(updateCommand, { encoding: 'utf-8' });
    
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
    
    // No need to check again - we know what we deployed
    
    return {
      success: true,
      previousVersion: currentRevision,
      newVersion: latestRevision || currentRevision,
      strategy: 'rolling',
      metadata: {
        serviceType: 'ecs-fargate',
        clusterName,
        serviceName,
        deploymentId,
        region,
        updateMode
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
 * Get the task definition family name
 */
async function getTaskDefinitionFamily(cluster: string, service: string, region: string): Promise<string> {
  try {
    const taskDefArn = execSync(
      `aws ecs describe-services --cluster ${cluster} --services ${service} --query 'services[0].taskDefinition' --output text --region ${region}`,
      { encoding: 'utf-8' }
    ).trim();
    // Extract family from ARN: arn:aws:ecs:region:account:task-definition/family:revision
    const parts = taskDefArn.split('/');
    if (parts.length > 1) {
      return parts[1].split(':')[0];
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Get the latest task definition revision for the service's task family
 */
async function getLatestTaskDefinitionRevision(cluster: string, service: string, region: string): Promise<string> {
  try {
    const family = await getTaskDefinitionFamily(cluster, service, region);
    if (!family) return '';
    
    // List task definitions for this family and get the latest
    // Use query to get just the first ARN instead of --max-items to avoid pagination token
    const taskDefArn = execSync(
      `aws ecs list-task-definitions --family-prefix ${family} --sort DESC --region ${region} --query 'taskDefinitionArns[0]' --output text`,
      { encoding: 'utf-8' }
    ).trim();
    
    if (taskDefArn && taskDefArn !== 'None' && taskDefArn.includes(':')) {
      // Extract just the revision number from the ARN
      const revision = taskDefArn.split(':').pop();
      return revision || '';
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Fetch recent logs for a failed ECS task
 */
async function fetchTaskLogs(
  clusterName: string,
  taskArn: string,
  region: string,
  verbose: boolean = false
): Promise<string[]> {
  try {
    // Get the task definition to find log configuration
    const taskId = taskArn.split('/').pop();
    
    // Get task details to find the log stream
    const taskDetails = execSync(
      `aws ecs describe-tasks --cluster ${clusterName} --tasks ${taskArn} --region ${region} --output json`,
      { encoding: 'utf-8' }
    );
    const task = JSON.parse(taskDetails).tasks?.[0];
    
    if (!task) {
      return [];
    }
    
    // Get log configuration from task definition
    const taskDefDetails = execSync(
      `aws ecs describe-task-definition --task-definition ${task.taskDefinitionArn} --region ${region} --output json`,
      { encoding: 'utf-8' }
    );
    const taskDef = JSON.parse(taskDefDetails).taskDefinition;
    
    // Find the main container's log configuration
    const mainContainer = taskDef.containerDefinitions?.[0];
    const logConfig = mainContainer?.logConfiguration;
    
    if (!logConfig || logConfig.logDriver !== 'awslogs') {
      return [];
    }
    
    const logGroup = logConfig.options?.['awslogs-group'];
    const streamPrefix = logConfig.options?.['awslogs-stream-prefix'];
    
    if (!logGroup || !streamPrefix) {
      return [];
    }
    
    // Construct the log stream name (format: prefix/container-name/task-id)
    const containerName = mainContainer.name;
    const logStream = `${streamPrefix}/${containerName}/${taskId}`;
    
    // Fetch recent log events
    const logsJson = execSync(
      `aws logs filter-log-events --log-group-name ${logGroup} --log-stream-names ${logStream} --limit 20 --region ${region} --output json`,
      { encoding: 'utf-8' }
    );
    
    const logEvents = JSON.parse(logsJson).events || [];
    
    // Extract just the messages
    return logEvents.map((event: any) => event.message?.trim()).filter(Boolean);
    
  } catch (error) {
    if (verbose) {
      console.log(`Failed to fetch logs: ${error}`);
    }
    return [];
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
  let recentStoppedTasks = new Set<string>();
  let consecutiveFailures = 0;
  
  // Initialize task tracking variables outside loop
  let taskDetails = { new: { total: 0, running: 0, healthy: 0, pending: 0 }, old: { total: 0, running: 0, healthy: 0, pending: 0 } };
  let failedTaskInfo: any[] = [];
  
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
      
      // Check for image pull events and other significant events
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
        
        // Display other significant events in verbose mode
        if (verbose) {
          for (const event of newEvents.slice(0, 5)) { // Show last 5 events
            const eventTime = new Date(event.createdAt).toLocaleTimeString();
            console.log(`[${eventTime}] ${event.message}`);
          }
        }
        
        lastEventCount = events.length;
      }
      
      // Get detailed task counts by deployment version
      taskDetails = { new: { total: 0, running: 0, healthy: 0, pending: 0 }, old: { total: 0, running: 0, healthy: 0, pending: 0 } };
      let taskHealthStatus = 'UNKNOWN'; // Track overall health status
      failedTaskInfo = [];
      
      // Extract revision numbers from task definitions
      const ourRevision = ourDeployment.taskDefinition?.split(':').pop() || 'unknown';
      const oldRevisions = new Set<string>();
      
      // Check for recently stopped tasks (failures)
      try {
        const stoppedTasksData = execSync(
          `aws ecs list-tasks --cluster ${clusterName} --service-name ${serviceName} --desired-status STOPPED --region ${region} --output json`,
          { encoding: 'utf-8' }
        );
        const stoppedTaskArns = JSON.parse(stoppedTasksData).taskArns || [];
        
        // Get details for stopped tasks from the new deployment
        if (stoppedTaskArns.length > 0) {
          const stoppedTasksJson = execSync(
            `aws ecs describe-tasks --cluster ${clusterName} --tasks ${stoppedTaskArns.slice(0, 10).join(' ')} --region ${region} --output json`,
            { encoding: 'utf-8' }
          );
          const stoppedTasks = JSON.parse(stoppedTasksJson).tasks || [];
          
          for (const task of stoppedTasks) {
            // Only check tasks from our deployment that we haven't seen before
            if (task.taskDefinitionArn === ourDeployment.taskDefinition && !recentStoppedTasks.has(task.taskArn)) {
              recentStoppedTasks.add(task.taskArn);
              
              // Collect failure information
              const stopInfo: any = {
                taskArn: task.taskArn.split('/').pop(),
                stopCode: task.stopCode,
                stoppedReason: task.stoppedReason,
                stoppedAt: task.stoppedAt
              };
              
              // Get container stop reasons
              if (task.containers && task.containers.length > 0) {
                stopInfo.containers = task.containers.map((c: any) => ({
                  name: c.name,
                  exitCode: c.exitCode,
                  reason: c.reason
                }));
              }
              
              failedTaskInfo.push(stopInfo);
              consecutiveFailures++;
              
              // Display failure reason immediately
              if (stopInfo.stoppedReason) {
                if (!verbose) {
                  process.stdout.write('\n');
                }
                console.log(`\n⚠️  Task ${stopInfo.taskArn} failed:`);
                console.log(`   Stop reason: ${stopInfo.stoppedReason}`);
                if (stopInfo.stopCode) {
                  console.log(`   Stop code: ${stopInfo.stopCode}`);
                }
                if (stopInfo.containers) {
                  for (const container of stopInfo.containers) {
                    if (container.exitCode !== undefined && container.exitCode !== 0) {
                      console.log(`   Container ${container.name}: exit code ${container.exitCode}${container.reason ? ` - ${container.reason}` : ''}`);
                    }
                  }
                }
                
                // Proactively fetch and display recent logs for the failed task
                try {
                  const logs = await fetchTaskLogs(
                    clusterName, 
                    task.taskArn, // Use full taskArn, not the shortened one
                    region,
                    verbose // Use the verbose variable directly
                  );
                  if (logs && logs.length > 0) {
                    console.log('\n   📋 Recent logs from failed task:');
                    for (const log of logs.slice(-10)) { // Show last 10 log lines
                      console.log(`      ${log}`);
                    }
                  }
                } catch (logError) {
                  // Ignore log fetch errors
                  if (verbose) {
                    console.log(`   (Could not fetch task logs: ${logError})`);
                  }
                }
                
                // Suggest debugging steps based on failure reason
                if (stopInfo.stoppedReason?.includes('Essential container')) {
                  console.log('\n   💡 Suggestion: Check full container logs with:');
                  console.log(`      aws logs tail /ecs/${clusterName}/${serviceName} --follow`);
                } else if (stopInfo.stoppedReason?.includes('OutOfMemory')) {
                  console.log('\n   💡 Suggestion: Increase task memory in your task definition');
                } else if (stopInfo.stoppedReason?.includes('CannotPullContainer')) {
                  console.log('\n   💡 Suggestion: Check ECR permissions and image availability');
                }
                
                if (!verbose) {
                  // Resume progress bar on next line
                  process.stdout.write('\n');
                }
              }
            }
          }
        }
      } catch (error) {
        // Ignore errors fetching stopped tasks
        if (verbose) {
          console.log(`Could not fetch stopped tasks: ${error}`);
        }
      }
      
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
            
            // Track old revision numbers
            if (!isNewDeployment && task.taskDefinitionArn) {
              const oldRev = task.taskDefinitionArn.split(':').pop();
              if (oldRev) oldRevisions.add(oldRev);
            }
            
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
          
          // Special case: If all deployments are using the same task definition revision,
          // this is a force-redeploy of the same version. ECS will cycle tasks but there's
          // no "old" version to drain.
          const allSameRevision = otherActiveDeployments.every((d: any) => 
            d.taskDefinition === ourDeployment.taskDefinition
          );
          
          if (allSameRevision && otherActiveDeployments.length > 0) {
            // Check if service events indicate completion
            const recentEvents = events.slice(0, 2);
            const hasCompletedEvent = recentEvents.some((e: any) => 
              e.message?.includes('has reached a steady state') ||
              e.message?.includes('deployment completed')
            );
            
            if (hasCompletedEvent || (running === desired && taskHealthStatus === 'HEALTHY')) {
              if (!verbose) {
                process.stdout.write('\n');
              }
              printSuccess(`Deployment ${deploymentId} completed - tasks restarted with same revision ${ourRevision} (${running}/${desired} tasks running)`);
              return;
            }
          } else if (otherActiveDeployments.length === 0 && taskHealthStatus !== 'STARTING') {
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
                const oldDeploymentRevs = otherActiveDeployments.map((d: any) => {
                  const rev = d.taskDefinition?.split(':').pop();
                  return rev || 'unknown';
                }).join(', ');
                
                if (allSameRevision) {
                  console.log(`Restarting tasks with same revision (${oldDeploymentRevs})...`);
                } else {
                  console.log(`Waiting for ${otherActiveDeployments.length} old deployment(s) to drain (rev: ${oldDeploymentRevs})...`);
                }
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
          
          // Build detailed status text with revision numbers
          const newStatus = `rev:${ourRevision} ${taskDetails.new.healthy}h/${taskDetails.new.running}r/${taskDetails.new.total}t`;
          const oldRevStr = oldRevisions.size > 0 ? `rev:${Array.from(oldRevisions).join(',')} ` : '';
          const oldStatus = taskDetails.old.total > 0 ? ` | ${oldRevStr}${taskDetails.old.healthy}h/${taskDetails.old.running}r/${taskDetails.old.total}t` : '';
          
          process.stdout.write(`\r  Deployment: [${bar}] ${progress}% (${running}/${desired}) [${newStatus}${oldStatus}]  `);
        } else {
          // Verbose mode - show raw counts with revision numbers
          const newStatus = `rev:${ourRevision} ${taskDetails.new.healthy}h/${taskDetails.new.running}r/${taskDetails.new.total}t`;
          const oldRevStr = oldRevisions.size > 0 ? `rev:${Array.from(oldRevisions).join(',')} ` : '';
          const oldStatus = `${oldRevStr}${taskDetails.old.healthy}h/${taskDetails.old.running}r/${taskDetails.old.total}t`;
          console.log(`Deployment progress: ${running}/${desired} tasks [${ourDeployment.status}] [${newStatus} | ${oldStatus}]`);
        }
      } else if (ourDeployment.status === 'INACTIVE') {
        // Deployment was replaced or rolled back
        throw new Error(`Deployment ${deploymentId} failed - status is INACTIVE`);
      }
      
      // Check if we have too many consecutive failures
      if (consecutiveFailures >= 3) {
        if (!verbose) {
          process.stdout.write('\n');
        }
        const errorMessage = `Deployment ${deploymentId} failed - tasks repeatedly failing to start. Check CloudWatch logs for details.\n` +
          (!verbose ? `   Run with --verbose flag for detailed failure information.\n` : '') +
          `   Check logs: aws logs tail /ecs/${clusterName}/${serviceName} --follow`;
        throw new Error(errorMessage);
      }
      
      // Reset failure counter if we have running tasks
      if (taskDetails.new.running > 0) {
        consecutiveFailures = 0;
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
  
  throw new Error(`Deployment ${deploymentId} timed out after ${effectiveTimeout} seconds\n` +
    `   Last status: ${taskDetails.new.running}/${taskDetails.new.total} new tasks running\n` +
    `   Failed tasks: ${failedTaskInfo.length}\n` +
    `   Run with --verbose flag for detailed progress information\n` +
    `   Check logs: aws logs tail /ecs/${clusterName}/${serviceName} --follow`);
}

/**
 * Descriptor for ECS update handler
 */
export const ecsUpdateDescriptor: HandlerDescriptor<AWSUpdateHandlerContext, UpdateHandlerResult> = {
  command: 'update',
  platform: 'aws',
  serviceType: 'ecs',
  handler: updateECSService,
  requiresDiscovery: true
};

// Also export for ecs-fargate (alias)
export const ecsFargateUpdateDescriptor: HandlerDescriptor<AWSUpdateHandlerContext, UpdateHandlerResult> = {
  command: 'update',
  platform: 'aws',
  serviceType: 'ecs-fargate',
  handler: updateECSService,
  requiresDiscovery: true
};