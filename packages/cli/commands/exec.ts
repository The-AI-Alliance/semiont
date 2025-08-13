/**
 * Exec Command - Deployment-type aware command execution
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
import { type ServiceDeploymentInfo, loadEnvironmentConfig } from '../lib/deployment-resolver.js';
import { execInContainer } from '../lib/container-runtime.js';
import { 
  ExecResult, 
  CommandResults, 
  createBaseResult, 
  createErrorResult,
  ResourceIdentifier 
} from '../lib/command-results.js';

// AWS SDK imports for ECS operations
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const ExecOptionsSchema = z.object({
  environment: z.string(),
  command: z.string().default('/bin/sh'),
  interactive: z.boolean().default(true),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
});

type ExecOptions = z.infer<typeof ExecOptionsSchema>;

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

// Global flag to control output suppression
let suppressOutput = false;

function printError(message: string): void {
  if (!suppressOutput) {
    console.error(`${colors.red}❌ ${message}${colors.reset}`);
  }
}

function printSuccess(message: string): void {
  if (!suppressOutput) {
    console.log(`${colors.green}✅ ${message}${colors.reset}`);
  }
}

function printInfo(message: string): void {
  if (!suppressOutput) {
    console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
  }
}

function printWarning(message: string): void {
  if (!suppressOutput) {
    console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
  }
}

function printDebug(message: string, options: ExecOptions): void {
  if (!suppressOutput && options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}



// =====================================================================
// DEPLOYMENT-TYPE-AWARE EXEC FUNCTIONS
// =====================================================================

async function execInServiceImpl(serviceInfo: ServiceDeploymentInfo, options: ExecOptions): Promise<ExecResult> {
  const startTime = Date.now();
  
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would execute "${options.command}" in ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    return {
      ...createBaseResult('exec', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime),
      command: options.command,
      exitCode: 0,
      output: '[DRY RUN] Command not executed',
      interactive: options.interactive,
      executionTime: 0,
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'dry-run',
      metadata: { dryRun: true },
    };
  }
  
  printInfo(`Executing command in ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  
  try {
    switch (serviceInfo.deploymentType) {
      case 'aws':
        return await execInAWSService(serviceInfo, options, startTime);
      case 'container':
        return await execInContainerService(serviceInfo, options, startTime);
      case 'process':
        return await execInProcessService(serviceInfo, options, startTime);
      case 'external':
        return await execInExternalService(serviceInfo, options, startTime);
      default:
        throw new Error(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
    }
  } catch (error) {
    const baseResult = createBaseResult('exec', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
    const errorResult = createErrorResult(baseResult, error as Error);
    
    return {
      ...errorResult,
      command: options.command,
      exitCode: 1,
      output: '',
      interactive: options.interactive,
      executionTime: Date.now() - startTime,
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'failed',
      metadata: { error: (error as Error).message },
    };
  }
}

async function execInAWSService(serviceInfo: ServiceDeploymentInfo, options: ExecOptions, startTime: number): Promise<ExecResult> {
  const baseResult = createBaseResult('exec', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  
  // Load AWS config from environment
  const envConfig = loadEnvironmentConfig(options.environment);
  if (!envConfig.aws || !envConfig.aws.region) {
    printError('AWS configuration not found in environment config');
    throw new Error('Missing AWS configuration');
  }
  
  // AWS ECS exec
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      const ecsClient = new ECSClient({ region: envConfig.aws.region });
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
          '--region', envConfig.aws.region
        ];
        
        if (options.interactive) {
          awsCommand.push('--interactive');
        }
        
        printDebug(`Executing: ${awsCommand.join(' ')}`, options);
        
        const proc = spawn(awsCommand[0], awsCommand.slice(1), {
          stdio: 'inherit'
        });
        
        const exitCode = await new Promise<number>((resolve, reject) => {
          proc.on('close', (code) => {
            if (code === 0) {
              resolve(code);
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
        
        // Return successful result
        return {
          ...baseResult,
          command: options.command,
          exitCode,
          output: '',
          interactive: options.interactive,
          executionTime: Date.now() - startTime,
          resourceId: {
            aws: {
              taskId,
              containerName,
              cluster: clusterName
            }
          } as ResourceIdentifier,
          status: 'success',
          metadata: {
            taskArn,
            cluster: clusterName,
            service: serviceName
          }
        };
        
      } catch (error) {
        printError(`Failed to execute in ECS ${serviceInfo.name}: ${error}`);
        throw error;
      }
      
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

async function execInContainerService(serviceInfo: ServiceDeploymentInfo, options: ExecOptions, startTime: number): Promise<ExecResult> {
  const baseResult = createBaseResult('exec', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}`;
  
  try {
    printInfo(`Executing in container: ${containerName}`);
    
    const success = await execInContainer(containerName, [options.command], {
      interactive: options.interactive,
      verbose: options.verbose
    });
    
    if (success) {
      printSuccess(`Command executed successfully in ${containerName}`);
      
      // Return successful result
      return {
        ...baseResult,
        command: options.command,
        exitCode: 0,
        output: '',
        interactive: options.interactive,
        executionTime: Date.now() - startTime,
        resourceId: {
          container: {
            name: containerName
          }
        } as ResourceIdentifier,
        status: 'success',
        metadata: {
          containerName
        }
      };
    } else {
      printError(`Command execution failed in ${containerName}`);
      throw new Error('Container exec failed');
    }
  } catch (error) {
    printError(`Failed to execute in container ${containerName}: ${error}`);
    throw error;
  }
}

async function execInProcessService(serviceInfo: ServiceDeploymentInfo, options: ExecOptions, startTime: number): Promise<ExecResult> {
  const baseResult = createBaseResult('exec', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  
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
      
      const dbExitCode = await new Promise<number>((resolve, reject) => {
        proc.on('close', (code) => {
          if (code === 0) {
            resolve(code);
          } else {
            reject(new Error(`psql failed with code ${code}`));
          }
        });
        proc.on('error', reject);
      });
      
      // Return successful result for database
      return {
        ...baseResult,
        command: 'psql',
        exitCode: dbExitCode,
        output: '',
        interactive: true,
        executionTime: Date.now() - startTime,
        resourceId: {
          process: {
            path: 'localhost:5432'
          }
        } as ResourceIdentifier,
        status: 'success',
        metadata: {
          method: 'psql'
        }
      };
      
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
      
      const appExitCode = await new Promise<number>((resolve, reject) => {
        appProc.on('close', (code) => {
          if (code === 0) {
            resolve(code);
          } else {
            reject(new Error(`Command failed with code ${code}`));
          }
        });
        appProc.on('error', reject);
      });
      
      // Return successful result for app
      return {
        ...baseResult,
        command: command,
        exitCode: appExitCode,
        output: '',
        interactive: options.interactive,
        executionTime: Date.now() - startTime,
        resourceId: {
          process: {
            path: `apps/${serviceInfo.name}`
          }
        } as ResourceIdentifier,
        status: 'success',
        metadata: {
          method: 'spawn',
          cwd: `apps/${serviceInfo.name}`
        }
      };
      
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
      
      // Return result for filesystem
      return {
        ...baseResult,
        command: explorerCommand.join(' '),
        exitCode: 0,
        output: '',
        interactive: false,
        executionTime: Date.now() - startTime,
        resourceId: {
          process: {
            path: dataPath
          }
        } as ResourceIdentifier,
        status: 'success',
        metadata: {
          method: 'file-explorer',
          path: dataPath
        }
      };
      
    default:
      throw new Error(`Unsupported process service: ${serviceInfo.name}`);
  }
}

async function execInExternalService(serviceInfo: ServiceDeploymentInfo, options: ExecOptions, startTime: number): Promise<ExecResult> {
  printError(`Cannot execute commands in external ${serviceInfo.name} service`);
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        printInfo(`External database: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
        printInfo('Use database client tools to connect to the external database');
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
// STRUCTURED OUTPUT FUNCTION
// =====================================================================

export async function exec(
  serviceDeployment: ServiceDeploymentInfo,
  options: ExecOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  
  // Suppress output for structured formats
  const previousSuppressOutput = suppressOutput;
  suppressOutput = isStructuredOutput;
  
  try {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Executing command in ${colors.bright}${options.environment}${colors.reset} environment`);
    }
    
    if (!isStructuredOutput && options.output === 'summary' && options.verbose) {
      printDebug(`Target service: ${serviceDeployment.name}(${serviceDeployment.deploymentType})`, options);
    }
    
    // Execute command in the service
    const result = await execInServiceImpl(serviceDeployment, options);
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'exec',
      environment: options.environment,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: [result],
      summary: {
        total: 1,
        succeeded: result.status === 'success' ? 1 : 0,
        failed: result.status === 'failed' ? 1 : 0,
        warnings: 0,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun,
      }
    };
    
    return commandResults;
    
  } finally {
    // Restore output suppression state
    suppressOutput = previousSuppressOutput;
  }
}

// Export the schema for use by CLI
export { ExecOptions, ExecOptionsSchema };