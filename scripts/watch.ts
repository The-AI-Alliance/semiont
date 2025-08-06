#!/usr/bin/env -S npx tsx

import { ECSClient, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, GetLogEventsCommand, DescribeLogStreamsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { WAFV2Client, GetSampledRequestsCommand } from '@aws-sdk/client-wafv2';
import { SemiontStackConfig } from './lib/stack-config';
import { ECSTask, LogMode, ServiceType, AWSError, isServiceType, isLogMode } from './lib/types.js';
import { logger } from './lib/logger.js';
// Validators imported for future AWS resource validation needs
import { config } from '../config/dist/index.js';

const stackConfig = new SemiontStackConfig();
const ecsClient = new ECSClient({ region: config.aws.region });
const logsClient = new CloudWatchLogsClient({ region: config.aws.region });
const cloudWatchClient = new CloudWatchClient({ region: config.aws.region });
const wafClient = new WAFV2Client({ region: config.aws.region });

async function getAllTasks(service?: ServiceType): Promise<ECSTask[]> {
  const clusterName = await stackConfig.getClusterName();
  
  const services: ServiceType[] = service && service !== 'both' ? [service] : ['frontend', 'backend'];
  const allTasks: ECSTask[] = [];
  
  for (const svc of services) {
    try {
      const serviceName = svc === 'frontend' 
        ? await stackConfig.getFrontendServiceName()
        : await stackConfig.getBackendServiceName();

      const response = await ecsClient.send(
        new ListTasksCommand({
          cluster: clusterName,
          serviceName: serviceName,
          maxResults: 10,
        })
      );

      if (response.taskArns && response.taskArns.length > 0) {
        // Get detailed task information
        const tasksResponse = await ecsClient.send(
          new DescribeTasksCommand({
            cluster: clusterName,
            tasks: response.taskArns,
          })
        );

        const serviceTasks: ECSTask[] = tasksResponse.tasks?.map(task => ({
          id: task.taskArn?.split('/').pop() || 'unknown',
          service: svc,
          status: task.lastStatus || 'UNKNOWN',
          health: task.healthStatus || 'UNKNOWN',
          createdAt: task.createdAt || new Date(),
          lastStatus: task.lastStatus || 'UNKNOWN'
        })) || [];
        
        allTasks.push(...serviceTasks);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Failed to get ${svc} tasks`, { error: errorMessage, service: svc });
    }
  }

  return allTasks;
}

async function getLatestTaskId(service?: ServiceType): Promise<{taskId: string, service: string}> {
  const tasks = await getAllTasks(service);
  if (tasks.length === 0) {
    throw new AWSError(`No ${service || ''} tasks found`, { service });
  }
  
  // Return the most recently created task
  const latestTask = tasks.sort((a, b) => 
    (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0)
  )[0];
  
  if (!latestTask) {
    throw new AWSError('No tasks available after sorting', { service });
  }
  
  return { taskId: latestTask.id, service: latestTask.service };
}

async function getLogStreamForTask(taskId: string, service: string): Promise<string | null> {
  const logGroupName = await stackConfig.getLogGroupName();
  const streamPrefix = `semiont-${service}/semiont-${service}/${taskId}`;
  
  try {
    const response = await logsClient.send(
      new DescribeLogStreamsCommand({
        logGroupName,
        logStreamNamePrefix: streamPrefix,
        limit: 1,
      })
    );
    
    return response.logStreams?.[0]?.logStreamName || null;
  } catch (error) {
    return null;
  }
}

async function getLogsForTask(taskId: string, service: string, startTime?: Date, nextToken?: string): Promise<{events: any[], nextToken?: string}> {
  const logGroupName = await stackConfig.getLogGroupName();
  const logStreamName = await getLogStreamForTask(taskId, service);
  
  if (!logStreamName) {
    return { events: [] };
  }

  try {
    const response = await logsClient.send(
      new GetLogEventsCommand({
        logGroupName,
        logStreamName,
        startTime: startTime?.getTime(),
        nextToken,
        limit: 100,
      })
    );

    return {
      events: response.events || [],
      ...(response.nextForwardToken && { nextToken: response.nextForwardToken }),
    };
  } catch (error) {
    return { events: [] };
  }
}

async function showTasksStatus(service?: ServiceType) {
  try {
    const siteName = await stackConfig.getSiteName();
    logger.simple(`📋 ${siteName} Container Logs\n`);
    
    const tasks = await getAllTasks(service);
    if (tasks.length === 0) {
      logger.simple(`❌ No ${service || ''} tasks found`);
      return;
    }

    logger.simple('📊 Current Tasks:');
    tasks.forEach((task) => {
      const age = task.createdAt ? 
        Math.round((Date.now() - task.createdAt.getTime()) / 1000 / 60) : 'unknown';
      const statusIcon = task.status === 'RUNNING' ? '✅' : 
                        task.status === 'STOPPED' ? '❌' : '🔄';
      const healthInfo = task.health && task.health !== 'UNKNOWN' ? ` (${task.health})` : '';
      const serviceIcon = task.service === 'frontend' ? '📱' : '🚀';
      logger.simple(`   ${statusIcon} ${serviceIcon} ${task.service}: ${task.id} - ${task.status}${healthInfo} - ${age}m ago`);
    });
    logger.simple('');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to show task status', { error: errorMessage, service });
    throw new AWSError(`Failed to get task status: ${errorMessage}`);
  }
}

async function getWAFLogs(minutes: number = 30) {
  try {
    const wafArn = await stackConfig.getWAFWebACLArn();
    
    // Extract ID and Name from ARN
    const arnParts = wafArn.split('/');
    // WAF name and ID extracted for future use
    const _wafName = arnParts[arnParts.length - 2];
    const _wafId = arnParts[arnParts.length - 1];
    void _wafName; void _wafId; // Mark as intentionally unused
    
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - minutes * 60 * 1000);
    
    // Get sampled requests from WAF
    const response = await wafClient.send(
      new GetSampledRequestsCommand({
        WebAclArn: wafArn,
        RuleMetricName: 'ALL',
        Scope: 'REGIONAL',
        TimeWindow: {
          StartTime: startTime,
          EndTime: endTime,
        },
        MaxItems: 100,
      })
    );
    
    return response.SampledRequests || [];
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to get WAF logs', { error: errorMessage });
    return [];
  }
}

async function getALBMetrics(minutes: number = 30) {
  try {
    const albDns = await stackConfig.getLoadBalancerDNS();
    const albName = albDns.split('-')[0] + '-' + albDns.split('-')[1] + '-' + albDns.split('-')[2];
    
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - minutes * 60 * 1000);
    
    // Get ALB request count
    const requestCount = await cloudWatchClient.send(
      new GetMetricStatisticsCommand({
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'RequestCount',
        Dimensions: [
          {
            Name: 'LoadBalancer',
            Value: `app/${albName}/${albDns.split('-')[3]?.split('.')[0] || 'unknown'}`,
          },
        ],
        StartTime: startTime,
        EndTime: endTime,
        Period: 300, // 5 minutes
        Statistics: ['Sum'],
      })
    );
    
    // Get ALB 4xx/5xx errors
    const errors4xx = await cloudWatchClient.send(
      new GetMetricStatisticsCommand({
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'HTTPCode_Target_4XX_Count',
        Dimensions: [
          {
            Name: 'LoadBalancer',
            Value: `app/${albName}/${albDns.split('-')[3]?.split('.')[0] || 'unknown'}`,
          },
        ],
        StartTime: startTime,
        EndTime: endTime,
        Period: 300,
        Statistics: ['Sum'],
      })
    );
    
    const errors5xx = await cloudWatchClient.send(
      new GetMetricStatisticsCommand({
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'HTTPCode_Target_5XX_Count',
        Dimensions: [
          {
            Name: 'LoadBalancer',
            Value: `app/${albName}/${albDns.split('-')[3]?.split('.')[0] || 'unknown'}`,
          },
        ],
        StartTime: startTime,
        EndTime: endTime,
        Period: 300,
        Statistics: ['Sum'],
      })
    );
    
    return {
      requestCount: requestCount.Datapoints || [],
      errors4xx: errors4xx.Datapoints || [],
      errors5xx: errors5xx.Datapoints || [],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to get ALB metrics', { error: errorMessage });
    return {
      requestCount: [],
      errors4xx: [],
      errors5xx: [],
    };
  }
}

async function showWAFandALBLogs(minutes: number = 30) {
  logger.simple('\n🛡️  WAF Activity:');
  const wafRequests = await getWAFLogs(minutes);
  
  if (wafRequests.length === 0) {
    logger.simple('   No sampled requests in the last ' + minutes + ' minutes');
    logger.simple('   Note: WAF only samples a subset of requests for logging');
  } else {
    logger.simple(`   Sampled requests (last ${minutes} minutes):`);
    wafRequests.slice(0, 10).forEach(request => {
      const timestampNum = typeof request.Timestamp === 'number' ? request.Timestamp : 0;
      const timestamp = new Date(timestampNum * 1000).toISOString();
      const action = request.Action || 'UNKNOWN';
      const uri = request.Request?.URI || 'N/A';
      const country = request.Request?.Country || 'N/A';
      const ip = request.Request?.ClientIP || 'N/A';
      const method = (request.Request as any)?.Method || 'N/A';
      const statusIcon = action === 'ALLOW' ? '✅' : '❌';
      logger.simple(`   ${statusIcon} [${timestamp}] ${method} ${uri} - ${action} (${ip}, ${country})`);
    });
    if (wafRequests.length > 10) {
      logger.simple(`   ... and ${wafRequests.length - 10} more requests`);
    }
  }
  
  logger.simple('\n⚖️  ALB Metrics:');
  const albMetrics = await getALBMetrics(minutes);
  
  logger.simple(`   Request metrics (last ${minutes} minutes):`);
  
  // Calculate totals
  let totalRequests = 0;
  let total4xx = 0;
  let total5xx = 0;
  
  albMetrics.requestCount.forEach(dp => totalRequests += dp.Sum || 0);
  albMetrics.errors4xx.forEach(dp => total4xx += dp.Sum || 0);
  albMetrics.errors5xx.forEach(dp => total5xx += dp.Sum || 0);
  
  logger.simple(`   Total Requests: ${totalRequests}`);
  logger.simple(`   4XX Errors: ${total4xx}`);
  logger.simple(`   5XX Errors: ${total5xx}`);
  
  // Show recent data points
  if (albMetrics.requestCount.length > 0) {
    logger.simple('\n   Recent activity:');
    const recentPoints = albMetrics.requestCount
      .sort((a, b) => (b.Timestamp?.getTime() || 0) - (a.Timestamp?.getTime() || 0))
      .slice(0, 5);
    
    recentPoints.forEach(point => {
      const timestamp = point.Timestamp?.toISOString() || 'N/A';
      const requests = point.Sum || 0;
      logger.simple(`   [${timestamp}] ${requests} requests`);
    });
  }
}

async function getLogs(mode: LogMode = 'tail', service?: ServiceType, targetTaskId?: string) {
  if (mode === 'waf') {
    const siteName = await stackConfig.getSiteName();
    logger.simple(`📋 ${siteName} WAF and ALB Logs\n`);
    await showWAFandALBLogs(30);
    return;
  }

  await showTasksStatus(service);

  try {
    let taskId: string;
    let taskService: string;
    
    if (targetTaskId) {
      taskId = targetTaskId;
      // If targeting a specific task, we need to find which service it belongs to
      const allTasks = await getAllTasks();
      const task = allTasks.find(t => t.id === targetTaskId);
      taskService = task?.service || 'backend'; // fallback to backend
      logger.simple(`📊 Showing logs for specific task: ${taskId} (${taskService})`);
    } else {
      const latest = await getLatestTaskId(service);
      taskId = latest.taskId;
      taskService = latest.service;
      logger.simple(`📊 Showing logs for latest ${taskService} task: ${taskId}`);
    }

    if (mode === 'all') {
      logger.simple(`📜 All available logs for ${service ? service + ' ' : ''}tasks:\n`);
      const tasks = await getAllTasks(service);
      
      for (const task of tasks) {
        const serviceIcon = task.service === 'frontend' ? '📱' : '🚀';
        logger.simple(`\n=== ${serviceIcon} ${task.service}: ${task.id} (${task.status}) ===`);
        const { events } = await getLogsForTask(task.id, task.service);
        
        if (events.length === 0) {
          logger.simple('   No logs available yet');
        } else {
          events.forEach(event => {
            const timestamp = new Date(event.timestamp || 0).toISOString();
            logger.simple(`[${timestamp}] ${event.message || ''}`);
          });
        }
      }
      return;
    }

    if (mode === 'follow') {
      logger.simple('👀 Following logs in real-time (Ctrl+C to stop)...\n');
      
      let lastTimestamp = new Date();
      let isFirstRun = true;
      
      // Set up graceful shutdown
      process.on('SIGINT', () => {
        logger.simple('\n👋 Stopping log follow...');
        process.exit(0);
      });

      while (true) {
        const startTime = isFirstRun ? new Date(Date.now() - 5 * 60 * 1000) : lastTimestamp;
        const { events } = await getLogsForTask(taskId, taskService, startTime);
        
        if (events.length > 0) {
          events.forEach(event => {
            const timestamp = new Date(event.timestamp || 0);
            if (timestamp > lastTimestamp) {
              logger.simple(`[${timestamp.toISOString()}] ${event.message || ''}`);
              lastTimestamp = timestamp;
            }
          });
        }
        
        isFirstRun = false;
        
        // Check if task changed (new deployment)
        try {
          const current = await getLatestTaskId(service);
          if (current.taskId !== taskId) {
            logger.simple(`\n🔄 New task detected: ${current.taskId} (${current.service})`);
            logger.simple('👀 Switching to new task logs...\n');
            taskId = current.taskId;
            taskService = current.service;
            lastTimestamp = new Date();
          }
        } catch (error) {
          // Task might have stopped, continue with current one
        }
        
        // Wait 2 seconds before next poll
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Tail mode - show recent logs
    logger.simple('📜 Recent logs (last 30 minutes):\n');
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const { events } = await getLogsForTask(taskId, taskService, thirtyMinutesAgo);

    if (events.length === 0) {
      logger.simple('   No recent logs available');
    } else {
      events.forEach(event => {
        const timestamp = new Date(event.timestamp || 0).toISOString();
        logger.simple(`[${timestamp}] ${event.message || ''}`);
      });
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to get logs', { error: errorMessage });
    process.exit(1);
  }
}

// Parse command line arguments with type safety
function parseArgs(): { mode: LogMode; service?: ServiceType; targetTaskId?: string } {
  const args = process.argv.slice(2);
  let mode: LogMode = 'follow'; // Default to follow for continuous monitoring
  let service: ServiceType | undefined;
  let targetTaskId: string | undefined;

  // Parse arguments - handle new watch command structure
  if (args.length === 0) {
    // Default: follow mode, all services
    mode = 'follow';
  } else if (args[0] === 'logs') {
    // Watch logs continuously
    mode = 'follow';
    if (args[1] && isServiceType(args[1])) {
      service = args[1];
      targetTaskId = args[2];
    }
  } else if (args[0] === 'metrics' || args[0] === 'waf') {
    // Watch metrics or WAF
    mode = args[0] as LogMode;
    if (args[1] && isServiceType(args[1])) {
      service = args[1];
      targetTaskId = args[2];
    }
  } else if (args[0] && isServiceType(args[0])) {
    // First argument is service
    service = args[0];
    if (args[1] === 'logs') {
      mode = 'follow';
    } else if (args[1] === 'metrics' || args[1] === 'waf') {
      mode = args[1] as LogMode;
    } else if (args[1] && isLogMode(args[1])) {
      mode = args[1];
    }
    targetTaskId = args[2];
  } else if (args[0] && isLogMode(args[0])) {
    // Legacy mode support
    mode = args[0];
    if (args[1] && isServiceType(args[1])) {
      service = args[1];
      targetTaskId = args[2];
    } else {
      targetTaskId = args[1];
    }
  } else {
    logger.simple('Usage: semiont watch [logs|metrics|waf] [frontend|backend] [task-id]');
    logger.simple('   or: semiont watch [frontend|backend] [logs|metrics|waf] [task-id]');
    logger.simple('');
    logger.simple('Services:');
    logger.simple('  frontend - Show only frontend container logs');
    logger.simple('  backend  - Show only backend container logs');
    logger.simple('  (none)   - Show logs from both services');
    logger.simple('');
    logger.simple('Monitoring Modes:');
    logger.simple('  logs     - Follow container logs continuously (default)');
    logger.simple('  metrics  - Monitor performance metrics');
    logger.simple('  waf      - Monitor WAF and security events');
    logger.simple('');
    logger.simple('Examples:');
    logger.simple('  semiont watch                # Monitor all logs');
    logger.simple('  semiont watch logs           # Follow logs continuously');
    logger.simple('  semiont watch metrics        # Monitor performance metrics');
    logger.simple('  semiont watch waf            # Monitor WAF/security events');
    logger.simple('  semiont watch frontend logs  # Follow frontend logs');
    process.exit(1);
  }

  return { mode, ...(service && { service }), ...(targetTaskId && { targetTaskId }) };
}

// Main execution
async function main() {
  try {
    const { mode, service, targetTaskId } = parseArgs();
    logger.debug('Starting watch monitoring', { mode, service, targetTaskId });
    await getLogs(mode, service, targetTaskId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Script execution failed', { error: errorMessage });
    process.exit(1);
  }
}

// Only run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}