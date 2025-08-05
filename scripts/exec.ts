#!/usr/bin/env -S npx tsx

import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { SemiontStackConfig } from './lib/stack-config';
import { config } from '../config';
import { spawn } from 'child_process';

const stackConfig = new SemiontStackConfig();
const ecsClient = new ECSClient({ region: config.aws.region });

async function getLatestTaskId(service: 'frontend' | 'backend'): Promise<string> {
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

async function executeCommand(service: 'frontend' | 'backend', command: string) {
  console.log(`🐳 Connecting to Semiont ${service} container...`);

  try {
    const clusterName = await stackConfig.getClusterName();
    const taskId = await getLatestTaskId(service);
    const containerName = `semiont-${service}`;

    console.log(`📊 Service: ${service}`);
    console.log(`📊 Task: ${taskId}`);
    console.log(`💻 Command: ${command}`);
    console.log('');

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

// Parse command line arguments
const args = process.argv.slice(2);
let service: 'frontend' | 'backend' = 'backend'; // default
let command = '/bin/sh'; // default

if (args.length === 0) {
  // No arguments: default to backend bash
  command = '/bin/sh';
} else if (args[0] === 'frontend' || args[0] === 'backend') {
  // First argument is service
  service = args[0];
  command = args[1] || '/bin/sh';
} else {
  // First argument is command, use default backend service
  command = args[0] || '/bin/sh';
}

console.log(`🚀 Executing on ${service} service: ${command}`);
executeCommand(service, command).catch(console.error);