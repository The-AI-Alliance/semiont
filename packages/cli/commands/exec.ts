/**
 * Exec Command V2 - Deployment-type aware command execution
 * 
 * This command executes commands in services based on deployment type:
 * - AWS: Execute commands in ECS tasks using AWS ECS Exec
 * - Container: Execute commands in local containers using container runtime
 * - Process: Execute commands in local processes or spawn new processes
 * - External: Cannot execute (managed separately)
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { colors } from '../lib/cli-colors.js';
import { resolveServiceSelector, validateServiceSelector } from '../lib/services.js';
import { resolveServiceDeployments, type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { execInContainer } from '../lib/container-runtime.js';

// AWS SDK imports for ECS operations
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const ExecOptionsSchema = z.object({
  environment: z.string(),
  service: z.string().default('backend'),
  command: z.string().default('/bin/sh'),
  interactive: z.boolean().default(true),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

type ExecOptions = z.infer<typeof ExecOptionsSchema>;

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

function printWarning(message: string): void {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

function printDebug(message: string, options: ExecOptions): void {
  if (options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

// =====================================================================
// PARSE ARGUMENTS
// =====================================================================

function parseArguments(): ExecOptions {
  const rawOptions: any = {
    environment: process.env.SEMIONT_ENV || process.argv[2],
    verbose: process.env.SEMIONT_VERBOSE === '1',
    dryRun: process.env.SEMIONT_DRY_RUN === '1',
  };
  
  // Parse command-line arguments
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--service':
      case '-s':
        rawOptions.service = args[++i];
        break;
      case '--command':
      case '-c':
        rawOptions.command = args[++i];
        break;
      case '--no-interactive':
        rawOptions.interactive = false;
        break;
      case '--verbose':
      case '-v':
        rawOptions.verbose = true;
        break;
      case '--dry-run':
        rawOptions.dryRun = true;
        break;
    }
  }
  
  // Validate with Zod
  try {
    return ExecOptionsSchema.parse(rawOptions);
  } catch (error) {
    if (error instanceof z.ZodError) {
      printError('Invalid arguments:');
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}


// =====================================================================
// DEPLOYMENT-TYPE-AWARE EXEC FUNCTIONS
// =====================================================================

async function execInService(serviceInfo: ServiceDeploymentInfo, options: ExecOptions): Promise<void> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would execute "${options.command}" in ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    return;
  }
  
  printInfo(`Executing "${options.command}" in ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  
  switch (serviceInfo.deploymentType) {
    case 'aws':
      await execInAWSService(serviceInfo, options);
      break;
    case 'container':
      await execInContainerService(serviceInfo, options);
      break;
    case 'process':
      await execInProcessService(serviceInfo, options);
      break;
    case 'external':
      await execInExternalService(serviceInfo, options);
      break;
    default:
      printWarning(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
  }
}

async function execInAWSService(serviceInfo: ServiceDeploymentInfo, options: ExecOptions): Promise<void> {
  // AWS ECS exec
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      if (!serviceInfo.config.aws || !serviceInfo.config.aws.region) {
        printError('AWS configuration not found in service config');
        throw new Error('Missing AWS configuration');
      }
      
      const ecsClient = new ECSClient({ region: serviceInfo.config.aws.region });
      const clusterName = `semiont-${options.environment}`;
      const serviceName = `semiont-${options.environment}-${serviceInfo.name}`;
      
      try {
        // Get running tasks
        const response = await ecsClient.send(
          new ListTasksCommand({
            cluster: clusterName,
            serviceName: serviceName,
            desiredStatus: 'RUNNING',
          })
        );
        
        if (!response.taskArns || response.taskArns.length === 0) {
          throw new Error(`No running ${serviceInfo.name} tasks found`);
        }
        
        const taskArn = response.taskArns[0]!;
        const taskId = taskArn.split('/').pop()!;
        const containerName = `semiont-${serviceInfo.name}`;
        
        printInfo(`Connecting to task: ${taskId}`);
        printDebug(`Cluster: ${clusterName}, Container: ${containerName}`, options);
        
        // Use AWS CLI for interactive commands
        const awsCommand = [
          'aws', 'ecs', 'execute-command',
          '--cluster', clusterName,
          '--task', taskId,
          '--container', containerName,
          '--command', options.command,
          '--region', serviceInfo.config.aws.region
        ];
        
        if (options.interactive) {
          awsCommand.push('--interactive');
        }
        
        printDebug(`Executing: ${awsCommand.join(' ')}`, options);
        
        const proc = spawn(awsCommand[0], awsCommand.slice(1), {
          stdio: 'inherit'
        });
        
        await new Promise<void>((resolve, reject) => {
          proc.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              printError('ECS exec failed. Possible causes:');
              printInfo('  • ECS Exec not enabled on service');
              printInfo('  • Session Manager plugin not installed');
              printInfo('  • Insufficient IAM permissions');
              reject(new Error(`ECS exec failed with code ${code}`));
            }
          });
          
          proc.on('error', (error) => {
            reject(error);
          });
        });
        
      } catch (error) {
        printError(`Failed to execute in ECS ${serviceInfo.name}: ${error}`);
        throw error;
      }
      break;
      
    case 'database':
      printError('Cannot execute commands directly in RDS instances');
      printInfo('Use database client tools to connect to RDS');
      throw new Error('RDS exec not supported');
      
    case 'filesystem':
      printError('Cannot execute commands in EFS filesystems');
      throw new Error('EFS exec not supported');
      
    default:
      printError(`Exec not supported for AWS service: ${serviceInfo.name}`);
      throw new Error(`Unsupported AWS service: ${serviceInfo.name}`);
  }
}

async function execInContainerService(serviceInfo: ServiceDeploymentInfo, options: ExecOptions): Promise<void> {
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}`;
  
  try {
    printInfo(`Executing in container: ${containerName}`);
    
    const success = await execInContainer(containerName, options.command, {
      interactive: options.interactive,
      verbose: options.verbose
    });
    
    if (success) {
      printSuccess(`Command executed successfully in ${containerName}`);
    } else {
      printError(`Command execution failed in ${containerName}`);
      throw new Error('Container exec failed');
    }
  } catch (error) {
    printError(`Failed to execute in container ${containerName}: ${error}`);
    throw error;
  }
}

async function execInProcessService(serviceInfo: ServiceDeploymentInfo, options: ExecOptions): Promise<void> {
  // For process deployments, we can either:
  // 1. Execute in the context of the running process (limited)
  // 2. Spawn a new process with the same environment
  
  switch (serviceInfo.name) {
    case 'database':
      // Connect to PostgreSQL
      printInfo('Connecting to local PostgreSQL database');
      const psqlCommand = ['psql', '-h', 'localhost', '-U', 'postgres', '-d', 'semiont'];
      
      const proc = spawn(psqlCommand[0], psqlCommand.slice(1), {
        stdio: 'inherit',
        env: {
          ...process.env,
          PGPASSWORD: serviceInfo.config.password || 'localpassword'
        }
      });
      
      await new Promise<void>((resolve, reject) => {
        proc.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`psql failed with code ${code}`));
          }
        });
        proc.on('error', reject);
      });
      break;
      
    case 'frontend':
    case 'backend':
      printInfo(`Executing command in ${serviceInfo.name} process context`);
      
      const command = options.command === '/bin/sh' 
        ? (process.platform === 'win32' ? 'cmd' : 'bash')
        : options.command;
        
      const appProc = spawn(command, {
        stdio: 'inherit',
        shell: true,
        cwd: `apps/${serviceInfo.name}`,
        env: {
          ...process.env,
          PORT: serviceInfo.config.port?.toString() || (serviceInfo.name === 'frontend' ? '3000' : '3001')
        }
      });
      
      await new Promise<void>((resolve, reject) => {
        appProc.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Command failed with code ${code}`));
          }
        });
        appProc.on('error', reject);
      });
      break;
      
    case 'filesystem':
      printInfo('Opening filesystem location');
      const dataPath = serviceInfo.config.path || './data';
      
      const explorerCommand = process.platform === 'darwin' 
        ? ['open', dataPath]
        : process.platform === 'win32' 
          ? ['explorer', dataPath]
          : ['ls', '-la', dataPath];
          
      const fsProc = spawn(explorerCommand[0], explorerCommand.slice(1), {
        stdio: 'inherit'
      });
      
      await new Promise<void>((resolve, reject) => {
        fsProc.on('close', () => resolve());
        fsProc.on('error', reject);
      });
      break;
  }
}

async function execInExternalService(serviceInfo: ServiceDeploymentInfo, options: ExecOptions): Promise<void> {
  printError(`Cannot execute commands in external ${serviceInfo.name} service`);
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        printInfo('To connect to external database, use:');
        printInfo(`  psql -h ${serviceInfo.config.host} -p ${serviceInfo.config.port || 5432} -U ${serviceInfo.config.user || 'postgres'} -d ${serviceInfo.config.name || 'semiont'}`);
      }
      break;
      
    case 'filesystem':
      if (serviceInfo.config.path) {
        printInfo(`External storage path: ${serviceInfo.config.path}`);
        printInfo('Access this path through your system\'s file manager or appropriate tools');
      }
      break;
      
    default:
      printInfo(`External ${serviceInfo.name} must be accessed through its own interface`);
  }
  
  throw new Error(`Cannot exec into external ${serviceInfo.name}`);
}


// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  printInfo(`Executing "${options.command}" in ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  try {
    // Validate service selector and resolve to actual services
    await validateServiceSelector(options.service, 'start', options.environment);
    const resolvedServices = await resolveServiceSelector(options.service, 'start', options.environment);
    
    if (resolvedServices.length > 1) {
      printError('Can only execute commands in one service at a time');
      printInfo(`Resolved to multiple services: ${resolvedServices.join(', ')}`);
      printInfo('Please specify a single service with --service');
      process.exit(1);
    }
    
    // Get deployment information for the service
    const serviceDeployments = await resolveServiceDeployments(resolvedServices, options.environment);
    const serviceInfo = serviceDeployments[0]!;
    
    printDebug(`Target service: ${serviceInfo.name}(${serviceInfo.deploymentType})`, options);
    
    // Execute command in the service
    await execInService(serviceInfo, options);
    
    printSuccess('Command execution completed');
    
  } catch (error) {
    printError(`Execution failed: ${error}`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    printError(`Unexpected error: ${error}`);
    process.exit(1);
  });
}

export { main, ExecOptions, ExecOptionsSchema };