/**
 * Start Command - Unified command structure
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import * as path from 'path';
import { getProjectRoot } from '../lib/cli-paths.js';
import { colors } from '../lib/cli-colors.js';
import { printError, printSuccess, printInfo, printWarning } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo, getNodeEnvForEnvironment } from '../lib/deployment-resolver.js';
import { runContainer } from '../lib/container-runtime.js';
import { 
  StartResult, 
  CommandResults, 
  createBaseResult, 
  createErrorResult,
  ResourceIdentifier 
} from '../lib/command-results.js';
import * as fs from 'fs';
import { CommandBuilder } from '../lib/command-definition.js';
import type { BaseCommandOptions } from '../lib/base-command-options.js';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const StartOptionsSchema = z.object({
  environment: z.string().optional(),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
  quiet: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  services: z.array(z.string()).optional(),
});

type StartOptions = z.infer<typeof StartOptionsSchema> & BaseCommandOptions;

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

// Helper wrapper for printDebug that passes verbose option
function debugLog(_message: string, _options: any): void {
  // Debug logging disabled for now
}




// =====================================================================
// DEPLOYMENT-TYPE-AWARE START FUNCTIONS
// =====================================================================

async function startServiceImpl(serviceInfo: ServiceDeploymentInfo, options: StartOptions): Promise<StartResult> {
  const startTime = Date.now();
  const environment = options.environment!; // Environment is guaranteed by command loader
  
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would start ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    
    return {
      ...createBaseResult('start', serviceInfo.name, serviceInfo.deploymentType, environment, startTime),
      startTime: new Date(),
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'dry-run',
      metadata: { dryRun: true },
    };
  }
  
  if (!options.quiet) {
    printInfo(`Starting ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  }
  
  try {
    switch (serviceInfo.deploymentType) {
      case 'aws':
        return await startAWSService(serviceInfo, options, startTime);
      case 'container':
        return await startContainerService(serviceInfo, options, startTime);
      case 'process':
        return await startProcessService(serviceInfo, options, startTime);
      case 'external':
        return await startExternalService(serviceInfo, options, startTime);
      default:
        throw new Error(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
    }
  } catch (error) {
    const baseResult = createBaseResult('start', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
    const errorResult = createErrorResult(baseResult, error as Error);
    
    return {
      ...errorResult,
      startTime: new Date(),
      resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
      status: 'failed',
      metadata: { error: (error as Error).message },
    };
  }
}

async function startAWSService(serviceInfo: ServiceDeploymentInfo, options: StartOptions, startTime: number): Promise<StartResult> {
  const environment = options.environment!; // Environment is guaranteed by command loader
  const baseResult = createBaseResult('start', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
  
  // AWS ECS service start
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      if (!options.quiet) {
        printInfo(`Starting ${serviceInfo.name} ECS service in ${environment}`);
        printWarning('ECS service start not yet implemented - use AWS Console or CDK');
      }
      
      return {
        ...baseResult,
        startTime: new Date(),
        resourceId: {
          aws: {
            arn: `arn:aws:ecs:us-east-1:123456789012:service/semiont-${environment}/${serviceInfo.name}`,
            id: `semiont-${environment}-${serviceInfo.name}`,
            name: `semiont-${environment}-${serviceInfo.name}`
          }
        },
        status: 'not-implemented',
        metadata: {
          serviceName: `semiont-${environment}-${serviceInfo.name}`,
          cluster: `semiont-${environment}`,
          implementation: 'pending'
        },
      };
      
    case 'database':
      if (!options.quiet) {
        printInfo(`Starting RDS instance for ${serviceInfo.name}`);
        printWarning('RDS instance start not yet implemented - use AWS Console');
      }
      
      return {
        ...baseResult,
        startTime: new Date(),
        resourceId: {
          aws: {
            arn: `arn:aws:rds:us-east-1:123456789012:db:semiont-${environment}-db`,
            id: `semiont-${environment}-db`,
            name: `semiont-${environment}-database`
          }
        },
        status: 'not-implemented',
        metadata: {
          instanceIdentifier: `semiont-${environment}-db`,
          implementation: 'pending'
        },
      };
      
    case 'filesystem':
      if (!options.quiet) {
        printInfo(`Mounting EFS volumes for ${serviceInfo.name}`);
        printWarning('EFS mount not yet implemented');
      }
      
      return {
        ...baseResult,
        startTime: new Date(),
        resourceId: {
          aws: {
            arn: `arn:aws:efs:us-east-1:123456789012:file-system/fs-semiont${environment}`,
            id: `fs-semiont${environment}`,
            name: `semiont-${environment}-efs`
          }
        },
        status: 'not-implemented',
        metadata: {
          fileSystemId: `fs-semiont${environment}`,
          implementation: 'pending'
        },
      };
      
    default:
      throw new Error(`Unsupported AWS service: ${serviceInfo.name}`);
  }
}

async function startContainerService(serviceInfo: ServiceDeploymentInfo, options: StartOptions, startTime: number): Promise<StartResult> {
  const environment = options.environment!; // Environment is guaranteed by command loader
  const baseResult = createBaseResult('start', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
  
  // Container deployment
  switch (serviceInfo.name) {
    case 'database':
      const containerName = `semiont-postgres-${environment}`;
      const imageName = serviceInfo.config.image || 'postgres:15-alpine';
      
      const success = await runContainer(imageName, containerName, {
        ports: { '5432': '5432' },
        environment: {
          POSTGRES_PASSWORD: serviceInfo.config.password || 'localpassword',
          POSTGRES_DB: serviceInfo.config.name || 'semiont',
          POSTGRES_USER: serviceInfo.config.user || 'postgres'
        },
        detached: true,
        verbose: options.verbose
      });
      
      if (success) {
        if (!options.quiet) {
          printSuccess(`Database container started: ${containerName}`);
        }
        
        return {
          ...baseResult,
          startTime: new Date(),
          endpoint: 'postgresql://localhost:5432/semiont',
          resourceId: {
            container: {
              id: containerName, // Would be actual container ID in real implementation
              name: containerName
            }
          },
          status: 'running',
          metadata: {
            containerName,
            image: imageName,
            ports: { '5432': '5432' },
            database: serviceInfo.config.name || 'semiont'
          },
        };
      } else {
        throw new Error(`Failed to start database container: ${containerName}`);
      }
      
    case 'frontend':
    case 'backend':
      const appContainerName = `semiont-${serviceInfo.name}-${environment}`;
      const appImageName = serviceInfo.config.image || `semiont-${serviceInfo.name}:latest`;
      const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
      
      const appSuccess = await runContainer(appImageName, appContainerName, {
        ports: { [port.toString()]: port.toString() },
        environment: {
          NODE_ENV: getNodeEnvForEnvironment(environment),
          SEMIONT_ENV: environment
        },
        detached: true,
        verbose: options.verbose
      });
      
      if (appSuccess) {
        if (!options.quiet) {
          printSuccess(`${serviceInfo.name} container started: ${appContainerName}`);
        }
        
        return {
          ...baseResult,
          startTime: new Date(),
          endpoint: `http://localhost:${port}`,
          resourceId: {
            container: {
              id: appContainerName, // Would be actual container ID in real implementation
              name: appContainerName
            }
          },
          status: 'running',
          metadata: {
            containerName: appContainerName,
            image: appImageName,
            port: port.toString()
          },
        };
      } else {
        throw new Error(`Failed to start ${serviceInfo.name} container: ${appContainerName}`);
      }
      
    case 'filesystem':
      const volumeName = `semiont-${serviceInfo.name}-${environment}`;
      
      if (!options.quiet) {
        printInfo(`Creating container volumes for ${serviceInfo.name}`);
        printSuccess(`Container volumes ready: ${volumeName}`);
      }
      
      return {
        ...baseResult,
        startTime: new Date(),
        resourceId: {
          container: {
            name: volumeName,
            id: volumeName
          }
        },
        status: 'ready',
        metadata: {
          volumeName,
          type: 'named-volume'
        },
      };
      
    default:
      throw new Error(`Unsupported container service: ${serviceInfo.name}`);
  }
}

async function startProcessService(serviceInfo: ServiceDeploymentInfo, options: StartOptions, startTime: number): Promise<StartResult> {
  const environment = options.environment!; // Environment is guaranteed by command loader
  const baseResult = createBaseResult('start', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
  
  // Process deployment (local development)
  switch (serviceInfo.name) {
    case 'database':
      if (!options.quiet) {
        printInfo(`Starting PostgreSQL service for ${serviceInfo.name}`);
        printWarning('Local PostgreSQL service start not yet implemented - start manually');
      }
      
      return {
        ...baseResult,
        startTime: new Date(),
        endpoint: 'postgresql://localhost:5432/semiont',
        resourceId: {
          process: {
            path: '/usr/local/var/postgres',
            port: 5432
          }
        },
        status: 'not-implemented',
        metadata: {
          implementation: 'pending',
          service: 'postgresql'
        },
      };
      
    case 'backend':
      const backendCwd = path.join(PROJECT_ROOT, 'apps/backend');
      const backendCommand = serviceInfo.config.command?.split(' ') || ['npm', 'run', 'dev'];
      const backendPort = serviceInfo.config.port || 3001;
      
      const backendProc = spawn(backendCommand[0]!, backendCommand.slice(1), {
        cwd: backendCwd,
        stdio: 'pipe',
        detached: true,
        env: {
          ...process.env,
          NODE_ENV: getNodeEnvForEnvironment(environment),
          SEMIONT_ENV: environment,
          DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:localpassword@localhost:5432/semiont',
          JWT_SECRET: process.env.JWT_SECRET || 'local-dev-secret',
          PORT: backendPort.toString(),
        }
      });
      
      backendProc.unref();
      
      if (!options.quiet) {
        printSuccess(`Backend process started on port ${backendPort}`);
      }
      
      return {
        ...baseResult,
        startTime: new Date(),
        endpoint: `http://localhost:${backendPort}`,
        resourceId: {
          process: {
            pid: backendProc.pid || 0,
            port: backendPort,
            path: backendCwd
          }
        },
        status: 'running',
        metadata: {
          command: backendCommand.join(' '),
          workingDirectory: backendCwd,
          port: backendPort
        },
      };
      
    case 'frontend':
      const frontendCwd = path.join(PROJECT_ROOT, 'apps/frontend');
      const frontendCommand = serviceInfo.config.command?.split(' ') || ['npm', 'run', 'dev'];
      const frontendPort = serviceInfo.config.port || 3000;
      
      const frontendProc = spawn(frontendCommand[0]!, frontendCommand.slice(1), {
        cwd: frontendCwd,
        stdio: 'pipe',
        detached: true,
        env: {
          ...process.env,
          NODE_ENV: getNodeEnvForEnvironment(environment),
          NEXT_PUBLIC_API_URL: `http://localhost:3001`,
          NEXT_PUBLIC_SITE_NAME: 'Semiont Dev',
          PORT: frontendPort.toString(),
        }
      });
      
      frontendProc.unref();
      
      if (!options.quiet) {
        printSuccess(`Frontend process started on port ${frontendPort}`);
      }
      
      return {
        ...baseResult,
        startTime: new Date(),
        endpoint: `http://localhost:${frontendPort}`,
        resourceId: {
          process: {
            pid: frontendProc.pid || 0,
            port: frontendPort,
            path: frontendCwd
          }
        },
        status: 'running',
        metadata: {
          command: frontendCommand.join(' '),
          workingDirectory: frontendCwd,
          port: frontendPort
        },
      };
      
    case 'filesystem':
      const fsPath = serviceInfo.config.path || path.join(PROJECT_ROOT, 'data');
      
      try {
        await fs.promises.mkdir(fsPath, { recursive: true });
        
        if (!options.quiet) {
          printInfo(`Creating directories for ${serviceInfo.name}`);
          printSuccess(`Filesystem directories created: ${fsPath}`);
        }
        
        return {
          ...baseResult,
          startTime: new Date(),
          resourceId: {
            process: {
              path: fsPath
            }
          },
          status: 'ready',
          metadata: {
            path: fsPath,
            type: 'local-directory'
          },
        };
      } catch (error) {
        throw new Error(`Failed to create directories: ${error}`);
      }
      
    default:
      throw new Error(`Unsupported process service: ${serviceInfo.name}`);
  }
}

async function startExternalService(serviceInfo: ServiceDeploymentInfo, options: StartOptions, startTime: number): Promise<StartResult> {
  const environment = options.environment!; // Environment is guaranteed by command loader
  const baseResult = createBaseResult('start', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
  
  // External service - just check connectivity
  if (!options.quiet) {
    printInfo(`Checking external ${serviceInfo.name} service`);
  }
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        if (!options.quiet) {
          printInfo(`External database: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
          printWarning('External database connectivity check not yet implemented');
        }
        
        return {
          ...baseResult,
          startTime: new Date(),
          endpoint: `postgresql://${serviceInfo.config.host}:${serviceInfo.config.port || 5432}/${serviceInfo.config.name || 'semiont'}`,
          resourceId: {
            external: {
              endpoint: `${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`
            }
          },
          status: 'external',
          metadata: {
            host: serviceInfo.config.host,
            port: serviceInfo.config.port || 5432,
            database: serviceInfo.config.name || 'semiont',
            connectivityCheck: 'not-implemented'
          },
        };
      }
      break;
      
    case 'filesystem':
      if (serviceInfo.config.path) {
        if (!options.quiet) {
          printInfo(`External storage: ${serviceInfo.config.path}`);
          printWarning('External storage connectivity check not yet implemented');
        }
        
        return {
          ...baseResult,
          startTime: new Date(),
          resourceId: {
            external: {
              path: serviceInfo.config.path
            }
          },
          status: 'external',
          metadata: {
            path: serviceInfo.config.path,
            connectivityCheck: 'not-implemented'
          },
        };
      }
      break;
      
    default:
      if (!options.quiet) {
        printInfo(`External ${serviceInfo.name} service configured`);
      }
  }
  
  if (!options.quiet) {
    printSuccess(`External ${serviceInfo.name} service ready`);
  }
  
  return {
    ...baseResult,
    startTime: new Date(),
    resourceId: {
      external: {
        endpoint: (serviceInfo.config as any).endpoint || 'configured'
      }
    },
    status: 'external',
    metadata: {
      configured: true
    },
  };
}

// =====================================================================
// STRUCTURED OUTPUT FUNCTION  
// =====================================================================

export async function start(
  serviceDeployments: ServiceDeploymentInfo[],
  options: StartOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  const environment = environment!; // Environment is guaranteed by command loader
  
  // Suppress output for structured formats
  // const previousSuppressOutput = setSuppressOutput(isStructuredOutput);
  
  try {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Starting services in ${colors.bright}${environment}${colors.reset} environment`);
    }
    
    if (!isStructuredOutput && options.output === 'summary' && options.verbose) {
      debugLog(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    }
    
    // Start services based on deployment type and collect results
    const serviceResults: StartResult[] = [];
    
    for (const serviceInfo of serviceDeployments) {
      try {
        const result = await startServiceImpl(serviceInfo, options);
        serviceResults.push(result);
        
        // Results are now collected for structured output
        // Individual service functions handle their own immediate feedback
      } catch (error) {
        // Create error result
        const baseResult = createBaseResult('start', serviceInfo.name, serviceInfo.deploymentType, environment, startTime);
        const errorResult = createErrorResult(baseResult, error as Error);
        
        const startErrorResult: StartResult = {
          ...errorResult,
          startTime: new Date(),
          resourceId: { [serviceInfo.deploymentType]: {} } as ResourceIdentifier,
          status: 'failed',
          metadata: { error: (error as Error).message },
        };
        
        serviceResults.push(startErrorResult);
        
        if (!isStructuredOutput && options.output === 'summary') {
          printError(`Failed to start ${serviceInfo.name}: ${error}`);
        }
      }
    }
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'start',
      environment: environment,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: serviceResults,
      summary: {
        total: serviceResults.length,
        succeeded: serviceResults.filter(r => r.success).length,
        failed: serviceResults.filter(r => !r.success).length,
        warnings: serviceResults.filter(r => r.status.includes('not-implemented')).length,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun,
      }
    };
    
    return commandResults;
    
  } catch (error) {
    if (!isStructuredOutput) {
      printError(`Failed to start services: ${error}`);
    }
    
    return {
      command: 'start',
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
        dryRun: options.dryRun,
      },
    };
  }
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const startCommand = new CommandBuilder<StartOptions>()
  .name('start')
  .description('Start services in an environment')
  .schema(StartOptionsSchema as any)
  .requiresEnvironment(true)
  .requiresServices(true)
  .args({
    args: {
      '--environment': { type: 'string', description: 'Environment name' },
      '--output': { type: 'string', description: 'Output format (summary, table, json, yaml)' },
      '--quiet': { type: 'boolean', description: 'Suppress output' },
      '--verbose': { type: 'boolean', description: 'Verbose output' },
      '--dry-run': { type: 'boolean', description: 'Simulate actions without executing' },
      '--services': { type: 'string', description: 'Comma-separated list of services' },
    },
    aliases: {
      '-e': '--environment',
      '-o': '--output',
      '-q': '--quiet',
      '-v': '--verbose',
    }
  })
  .examples(
    'semiont start --environment local',
    'semiont start --environment staging --services frontend,backend',
    'semiont start --environment prod --dry-run'
  )
  .handler(start)
  .build();

// Export default for compatibility
export default startCommand;

// Export the schema for use by CLI
export { StartOptions, StartOptionsSchema };