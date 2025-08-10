import { z } from 'zod';
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { SemiontStackConfig } from '../lib/lib/stack-config.js';
import { spawn } from 'child_process';
import React from 'react';
import { render, Text, Box } from 'ink';
import { SimpleTable } from '../lib/lib/ink-utils.js';
import { loadEnvironmentConfig } from '@semiont/config-loader';
import { getAvailableEnvironments, isValidEnvironment } from '../lib/lib/environment-discovery.js';
import { resolveServiceSelector, validateServiceSelector } from '../lib/services.js';
import { colors } from '../lib/cli-colors.js';

// =====================================================================
// ARGUMENT PARSING WITH ZOD
// =====================================================================

const ExecOptionsSchema = z.object({
  environment: z.enum(['development', 'staging', 'production']),
  service: z.string().default('backend'), // Will be validated at runtime against executable services
  command: z.string().default('/bin/sh'),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

type ExecOptions = z.infer<typeof ExecOptionsSchema>;

// =====================================================================
// ARGUMENT PARSING
// =====================================================================

function parseArgs(): ExecOptions {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // First positional argument is environment
  const environment = args[0];
  if (!environment) {
    console.error('❌ Environment is required');
    console.log(`💡 Available environments: ${getAvailableEnvironments().filter(env => env !== 'local').join(', ')}`);
    process.exit(1);
  }

  if (environment === 'local') {
    console.error('❌ Exec command is not available for local environment');
    console.log('💡 For local development, use:');
    console.log('   docker exec -it semiont-postgres bash   # Database');
    console.log('   # Frontend and backend run directly in your terminal');
    process.exit(1);
  }

  if (!isValidEnvironment(environment)) {
    console.error(`❌ Invalid environment: ${environment}`);
    console.log(`💡 Available cloud environments: ${getAvailableEnvironments().filter(env => env !== 'local').join(', ')}`);
    process.exit(1);
  }

  // Parse service and command from remaining arguments
  let service: 'frontend' | 'backend' = 'backend';
  let command = '/bin/sh';

  if (args.length > 1) {
    if (args[1] === 'frontend' || args[1] === 'backend') {
      service = args[1];
      command = args[2] || '/bin/sh';
    } else {
      // Second argument is command, use default backend service
      command = args[1];
    }
  }

  // Parse flags
  const verbose = args.includes('--verbose') || args.includes('-v');
  const dryRun = args.includes('--dry-run');

  try {
    return ExecOptionsSchema.parse({
      environment: environment as 'development' | 'staging' | 'production',
      service,
      command,
      verbose,
      dryRun,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Invalid arguments:');
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

function printHelp(): void {
  console.log(`
🐳 Semiont Container Exec Tool

Usage:
  semiont exec <environment> [service] [command] [options]

Arguments:
  <environment>    Cloud environment (${getAvailableEnvironments().filter(env => env !== 'local').join(', ')})
  [service]        Service to connect to (frontend, backend) - default: backend  
  [command]        Command to execute - default: /bin/sh

Options:
  -v, --verbose    Show detailed output
  --dry-run        Show what would be executed without connecting
  -h, --help       Show this help message

Examples:
  semiont exec production                      # Connect to backend with shell
  semiont exec staging frontend               # Connect to frontend with shell  
  semiont exec production backend "ls -la"   # Run specific command on backend
  semiont exec staging "cat /app/package.json" # Run command on default backend

Requirements:
  • AWS CLI installed and configured
  • Session Manager plugin installed
  • ECS Exec enabled on target services
  • Valid AWS credentials for the target environment

Installation:
  Session Manager plugin: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html
`);
}

// =====================================================================
// CORE FUNCTIONALITY 
// =====================================================================

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

async function showExecutionInfo(
  service: string,
  taskId: string,
  command: string,
  clusterName: string,
  containerName: string,
  config: any
): Promise<void> {
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

async function executeCommand(
  options: ExecOptions,
  config: any,
  stackConfig: SemiontStackConfig,
  ecsClient: ECSClient
): Promise<void> {
  const { service, command } = options;
  
  console.log(`🐳 Connecting to Semiont ${service} container...`);

  try {
    const clusterName = await stackConfig.getClusterName();
    const taskId = await getLatestTaskId(service, stackConfig, ecsClient);
    const containerName = `semiont-${service}`;

    await showExecutionInfo(service, taskId, command, clusterName, containerName, config);

    if (options.dryRun) {
      console.log('🔍 DRY RUN - Would execute:');
      console.log(`   aws ecs execute-command \\`);
      console.log(`     --cluster "${clusterName}" \\`);
      console.log(`     --task "${taskId}" \\`);
      console.log(`     --container "${containerName}" \\`);
      console.log(`     --command "${command}" \\`);
      console.log(`     --interactive \\`);
      console.log(`     --region "${config.aws.region}"`);
      return;
    }

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

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  try {
    const options = parseArgs();
    
    if (options.verbose) {
      console.log('🔧 Parsed options:', options);
    }
    
    // Load environment configuration
    const config = loadEnvironmentConfig(options.environment);
    
    if (!config.aws) {
      throw new Error(`Environment ${options.environment} does not have AWS configuration`);
    }
    
    // Initialize AWS clients
    const stackConfig = new SemiontStackConfig(options.environment);
    const ecsClient = new ECSClient({ region: config.aws.region });
    
    console.log(`🚀 Executing on ${options.service} service: ${options.command}`);
    await executeCommand(options, config, stackConfig, ecsClient);
    
  } catch (error) {
    console.error('❌ Exec failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}