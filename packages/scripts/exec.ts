
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { SemiontStackConfig } from './lib/stack-config';
import { spawn } from 'child_process';
import React from 'react';
import { render, Text, Box } from 'ink';
import { SimpleTable } from './lib/ink-utils';
import { loadEnvironmentConfig } from '@semiont/config-loader';
import { getAvailableEnvironments, isValidEnvironment } from './lib/environment-discovery';

async function getLatestTaskId(service: 'frontend' | 'backend', stackConfig: SemiontStackConfig, ecsClient: ECSClient): Promise<string> {
  const clusterName = await stackConfig.getClusterName();
  const serviceName = service === 'frontend' 
    ? await stackConfig.getFrontendServiceName()
    : await stackConfig.getBackendServiceName();

  const response = await ecsClient.send(
    new ListTasksCommand({
      cluster: clusterName,
      serviceName: serviceName,
      desiredStatus: 'RUNNING',
    })
  );

  if (!response.taskArns || response.taskArns.length === 0) {
    throw new Error(`No running ${service} tasks found`);
  }

  const taskArn = response.taskArns[0];
  if (!taskArn) {
    throw new Error(`Invalid task ARN received for ${service}`);
  }
  const taskId = taskArn.split('/').pop();
  if (!taskId) {
    throw new Error(`Could not extract task ID from ARN: ${taskArn}`);
  }
  return taskId;
}

async function executeCommand(service: 'frontend' | 'backend', command: string, config: any, stackConfig: SemiontStackConfig, ecsClient: ECSClient) {
  console.log(`🐳 Connecting to Semiont ${service} container...`);

  try {
    const clusterName = await stackConfig.getClusterName();
    const taskId = await getLatestTaskId(service, stackConfig, ecsClient);
    const containerName = `semiont-${service}`;

    await showExecutionInfo(service, taskId, command, clusterName, containerName, config);

    // Use AWS CLI for interactive commands since the SDK doesn't support interactive mode well
    const awsCommand = `aws ecs execute-command --cluster "${clusterName}" --task "${taskId}" --container "${containerName}" --command "${command}" --interactive --region "${config.aws.region}"`;

    const awsProcess = spawn('bash', ['-c', awsCommand], {
      stdio: 'inherit'
    });

    awsProcess.on('close', (code) => {
      if (code !== 0) {
        console.log('');
        console.log('❌ Command execution failed. Possible causes:');
        console.log('   • ECS Exec not enabled on service');
        console.log('   • Session Manager plugin not installed');
        console.log('   • Insufficient IAM permissions');
        console.log('');
        console.log('💡 To install Session Manager plugin:');
        console.log('   https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html');
        process.exit(code || 1);
      }
    });

    awsProcess.on('error', (error) => {
      console.error('❌ Failed to execute command:', error);
      process.exit(1);
    });

  } catch (error) {
    console.error('❌ Failed to connect to container:', error);
    process.exit(1);
  }
}

// Table display function for execution info
async function showExecutionInfo(service: string, taskId: string, command: string, clusterName: string, containerName: string, config: any): Promise<void> {
  return new Promise((resolve) => {
    const execData = [
      { Property: 'Service', Value: `🚀 ${service}` },
      { Property: 'Task ID', Value: taskId },
      { Property: 'Container', Value: containerName },
      { Property: 'Cluster', Value: clusterName },
      { Property: 'Command', Value: command },
      { Property: 'Region', Value: config.aws.region }
    ];

    const ExecutionTable = React.createElement(
      Box,
      { flexDirection: 'column' },
      [
        React.createElement(Text, { bold: true, color: 'cyan', key: 'title' }, '\n🐳 Container Execution Details'),
        React.createElement(SimpleTable, { 
          data: execData, 
          columns: ['Property', 'Value'],
          key: 'execution-table' 
        }),
        React.createElement(Text, { color: 'yellow', key: 'connecting' }, '\n🔗 Connecting to container...\n')
      ]
    );

    const { unmount } = render(ExecutionTable);
    
    setTimeout(() => {
      unmount();
      resolve();
    }, 1000); // Show for 1 second before connecting
  });
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('🐳 Semiont Container Exec Tool');
    console.log('');
    console.log('Usage: ./semiont exec <environment> [service] [command]');
    console.log('');
    console.log('Arguments:');
    console.log(`   <environment>    Environment to connect to (${getAvailableEnvironments().join(', ')})`);
    console.log('   [service]        Service to connect to (frontend, backend) - default: backend');
    console.log('   [command]        Command to execute - default: /bin/sh');
    console.log('');
    console.log('Examples:');
    console.log('   ./semiont exec production                    # Connect to backend with shell');
    console.log('   ./semiont exec staging frontend             # Connect to frontend with shell');
    console.log('   ./semiont exec production backend "ls -la"   # Run specific command on backend');
    console.log('');
    console.log('Requirements:');
    console.log('   • AWS CLI installed and configured');
    console.log('   • Session Manager plugin installed');
    console.log('   • ECS Exec enabled on target services');
    return;
  }
  
  const environment = args[0];
  if (!environment) {
    console.error('❌ Environment is required');
    process.exit(1);
  }
  
  if (!isValidEnvironment(environment)) {
    console.error(`❌ Invalid environment: ${environment}`);
    console.log(`💡 Available environments: ${getAvailableEnvironments().join(', ')}`);
    process.exit(1);
  }
  
  const config = loadEnvironmentConfig(environment);
  
  if (!config.aws) {
    throw new Error(`Environment ${environment} does not have AWS configuration`);
  }
  const stackConfig = new SemiontStackConfig(environment);
  const ecsClient = new ECSClient({ region: config.aws.region });
  
  // Parse service and command arguments
  let service: 'frontend' | 'backend' = 'backend'; // default
  let command = '/bin/sh'; // default
  
  if (args.length === 1) {
    // Only environment provided: default to backend bash
    service = 'backend';
    command = '/bin/sh';
  } else if (args[1] === 'frontend' || args[1] === 'backend') {
    // Second argument is service
    service = args[1];
    command = args[2] || '/bin/sh';
  } else {
    // Second argument is command, use default backend service
    service = 'backend';
    command = args[1] || '/bin/sh';
  }
  
  console.log(`🚀 Executing on ${service} service: ${command}`);
  await executeCommand(service, command, config, stackConfig, ecsClient);
}

main().catch(console.error);