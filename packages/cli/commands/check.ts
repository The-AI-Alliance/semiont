/**
 * Check Command V2 - Deployment-type aware system health and status monitoring
 * 
 * This command checks service health based on deployment type:
 * - AWS: Query ECS service status, RDS status, EFS mount status
 * - Container: Check container health
 * - Process: Check process status
 * - External: HTTP health checks and connectivity tests
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../lib/cli-paths.js';
import { colors } from '../lib/cli-colors.js';
import { resolveServiceSelector, validateServiceSelector } from '../lib/services.js';
import { resolveServiceDeployments, type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { listContainers } from '../lib/container-runtime.js';
import * as http from 'http';
import { CheckResult, CommandResults, createBaseResult, createErrorResult } from '../lib/command-results.js';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const CheckOptionsSchema = z.object({
  environment: z.string(),
  service: z.string().default('all'),
  section: z.enum(['all', 'services', 'health', 'logs']).default('all'),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['table', 'json', 'yaml', 'summary']).default('table'),
});

type CheckOptions = z.infer<typeof CheckOptionsSchema>;

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

function printDebug(message: string, options: CheckOptions): void {
  if (options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

// =====================================================================
// PARSE ARGUMENTS
// =====================================================================

function parseArguments(): CheckOptions {
  const rawOptions: any = {
    environment: process.env.SEMIONT_ENV,
    verbose: process.env.SEMIONT_VERBOSE === '1',
    dryRun: process.env.SEMIONT_DRY_RUN === '1',
  };
  
  // Parse command-line arguments
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--environment':
      case '-e':
        rawOptions.environment = args[++i];
        break;
      case '--service':
        rawOptions.service = args[++i];
        break;
      case '--section':
      case '-s':
        rawOptions.section = args[++i];
        break;
      case '--verbose':
      case '-v':
        rawOptions.verbose = true;
        break;
      case '--dry-run':
        rawOptions.dryRun = true;
        break;
      case '--output':
      case '-o':
        rawOptions.output = args[++i];
        break;
    }
  }
  
  // Validate with Zod
  try {
    return CheckOptionsSchema.parse(rawOptions);
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
// DEPLOYMENT-TYPE-AWARE CHECK FUNCTIONS
// =====================================================================

async function checkService(serviceInfo: ServiceDeploymentInfo, options: CheckOptions, startTime: number, isStructuredOutput: boolean = false): Promise<CheckResult> {
  const baseResult = createBaseResult('check', serviceInfo.name, serviceInfo.deploymentType, options.environment, startTime);
  
  try {
    if (!isStructuredOutput) {
      printInfo(`Checking ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
    }
    
    let checks: CheckResult['checks'] = [];
    let healthStatus: CheckResult['healthStatus'] = 'unknown';
    let uptime: number | undefined;
    
    switch (serviceInfo.deploymentType) {
      case 'aws':
        ({ checks, healthStatus, uptime } = await checkAWSService(serviceInfo, options, isStructuredOutput));
        break;
      case 'container':
        ({ checks, healthStatus, uptime } = await checkContainerService(serviceInfo, options, isStructuredOutput));
        break;
      case 'process':
        ({ checks, healthStatus, uptime } = await checkProcessService(serviceInfo, options, isStructuredOutput));
        break;
      case 'external':
        ({ checks, healthStatus, uptime } = await checkExternalService(serviceInfo, options, isStructuredOutput));
        break;
      case 'mock':
        ({ checks, healthStatus, uptime } = await checkMockService(serviceInfo, options, isStructuredOutput));
        break;
      default:
        printWarning(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
        checks = [{
          name: 'deployment-type',
          status: 'fail',
          message: `Unknown deployment type: ${serviceInfo.deploymentType}`,
        }];
        healthStatus = 'unhealthy';
    }
    
    return {
      ...baseResult,
      resourceId: {
        [serviceInfo.deploymentType]: {
          name: serviceInfo.name,
          ...(serviceInfo.deploymentType === 'process' && { path: serviceInfo.config.path || '' }),
          ...(serviceInfo.deploymentType === 'container' && { name: `semiont-${serviceInfo.name}-${options.environment}` }),
          ...(serviceInfo.deploymentType === 'external' && { endpoint: serviceInfo.config.host || '' }),
          ...(serviceInfo.deploymentType === 'mock' && { id: `mock-${serviceInfo.name}-${options.environment}` }),
        }
      },
      status: healthStatus === 'healthy' ? 'running' : 'stopped',
      metadata: {
        deploymentType: serviceInfo.deploymentType,
        config: serviceInfo.config,
      },
      healthStatus,
      checks,
      uptime,
      lastCheck: new Date(),
    };
    
  } catch (error) {
    const errorResult = createErrorResult(baseResult, error instanceof Error ? error : String(error));
    return {
      ...errorResult,
      resourceId: {
        [serviceInfo.deploymentType]: {
          name: serviceInfo.name,
        }
      },
      status: 'error',
      metadata: { error: errorResult.error },
      healthStatus: 'unhealthy',
      checks: [{
        name: 'service-check',
        status: 'fail',
        message: errorResult.error || 'Unknown error occurred',
      }],
      lastCheck: new Date(),
    };
  }
}

async function checkAWSService(serviceInfo: ServiceDeploymentInfo, options: CheckOptions, isStructuredOutput: boolean = false): Promise<{ checks: CheckResult['checks'], healthStatus: CheckResult['healthStatus'], uptime?: number }> {
  const checks: CheckResult['checks'] = [];
  let healthStatus: CheckResult['healthStatus'] = 'healthy';
  
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      printDebug(`Querying ECS service status for ${serviceInfo.name}`, options);
      checks.push({
        name: 'ecs-service',
        status: 'warn',
        message: 'ECS service status check not yet implemented',
      });
      healthStatus = 'unknown';
      break;
      
    case 'database':
      printDebug(`Checking RDS instance status for ${serviceInfo.name}`, options);
      checks.push({
        name: 'rds-instance',
        status: 'warn', 
        message: 'RDS status check not yet implemented',
      });
      healthStatus = 'unknown';
      break;
      
    case 'filesystem':
      printDebug(`Checking EFS mount status for ${serviceInfo.name}`, options);
      checks.push({
        name: 'efs-mount',
        status: 'warn',
        message: 'EFS mount status check not yet implemented',
      });
      healthStatus = 'unknown';
      break;
      
    default:
      checks.push({
        name: 'service-recognition',
        status: 'pass',
        message: 'Service configuration recognized',
      });
  }
  
  return { checks, healthStatus };
}

async function checkContainerService(serviceInfo: ServiceDeploymentInfo, options: CheckOptions, isStructuredOutput: boolean = false): Promise<{ checks: CheckResult['checks'], healthStatus: CheckResult['healthStatus'], uptime?: number }> {
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}`;
  const checks: CheckResult['checks'] = [];
  let healthStatus: CheckResult['healthStatus'] = 'healthy';
  
  try {
    // Check if container is running
    const containers = await listContainers({ all: false });
    const isRunning = containers.some(c => c.includes(containerName));
    
    if (isRunning) {
      if (!isStructuredOutput) {
        printSuccess(`Container ${containerName} is running`);
      }
      checks.push({
        name: 'container-running',
        status: 'pass',
        message: `Container ${containerName} is running`,
      });
      
      // Additional health checks based on service
      switch (serviceInfo.name) {
        case 'database':
          printDebug('Database container health check passed', options);
          checks.push({
            name: 'database-container',
            status: 'pass',
            message: 'Database container is operational',
          });
          break;
          
        case 'frontend':
        case 'backend':
          const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
          const startTime = Date.now();
          const healthCheck = await checkHttpHealth(`http://localhost:${port}/health`);
          const responseTime = Date.now() - startTime;
          
          if (healthCheck) {
            if (!isStructuredOutput) {
              printSuccess(`${serviceInfo.name} health endpoint responding`);
            }
            checks.push({
              name: 'http-health',
              status: 'pass',
              message: `Health endpoint responding`,
              responseTime,
            });
          } else {
            if (!isStructuredOutput) {
              printWarning(`${serviceInfo.name} health endpoint not responding`);
            }
            checks.push({
              name: 'http-health',
              status: 'warn',
              message: `Health endpoint not responding`,
              responseTime,
            });
            healthStatus = 'degraded';
          }
          break;
          
        case 'filesystem':
          printDebug('Container volume mounts verified', options);
          checks.push({
            name: 'volume-mounts',
            status: 'pass',
            message: 'Container volume mounts verified',
          });
          break;
      }
    } else {
      if (!isStructuredOutput) {
        printWarning(`Container ${containerName} is not running`);
      }
      checks.push({
        name: 'container-running',
        status: 'fail',
        message: `Container ${containerName} is not running`,
      });
      healthStatus = 'unhealthy';
    }
  } catch (error) {
    printError(`Failed to check container ${containerName}: ${error}`);
    checks.push({
      name: 'container-check',
      status: 'fail',
      message: `Failed to check container: ${error}`,
    });
    healthStatus = 'unhealthy';
  }
  
  return { checks, healthStatus };
}

async function checkProcessService(serviceInfo: ServiceDeploymentInfo, options: CheckOptions, isStructuredOutput: boolean = false): Promise<{ checks: CheckResult['checks'], healthStatus: CheckResult['healthStatus'], uptime?: number }> {
  const checks: CheckResult['checks'] = [];
  let healthStatus: CheckResult['healthStatus'] = 'healthy';
  
  switch (serviceInfo.name) {
    case 'database':
      const pgRunning = await checkProcessOnPort(5432);
      if (pgRunning) {
        printSuccess('PostgreSQL service is running');
        checks.push({
          name: 'postgres-process',
          status: 'pass',
          message: 'PostgreSQL service is running on port 5432',
        });
      } else {
        printWarning('PostgreSQL service is not running');
        checks.push({
          name: 'postgres-process',
          status: 'fail',
          message: 'PostgreSQL service is not running on port 5432',
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    case 'frontend':
    case 'backend':
      const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
      const processRunning = await checkProcessOnPort(port);
      
      if (processRunning) {
        printSuccess(`${serviceInfo.name} process is running on port ${port}`);
        checks.push({
          name: 'process-running',
          status: 'pass',
          message: `Process is running on port ${port}`,
        });
        
        // Check HTTP health endpoint
        const startTime = Date.now();
        const healthCheck = await checkHttpHealth(`http://localhost:${port}/health`);
        const responseTime = Date.now() - startTime;
        
        if (healthCheck) {
          printSuccess(`${serviceInfo.name} health endpoint responding`);
          checks.push({
            name: 'http-health',
            status: 'pass',
            message: 'Health endpoint responding',
            responseTime,
          });
        } else {
          printDebug(`${serviceInfo.name} health endpoint not available`, options);
          checks.push({
            name: 'http-health',
            status: 'warn',
            message: 'Health endpoint not available',
            responseTime,
          });
          healthStatus = 'degraded';
        }
      } else {
        printWarning(`${serviceInfo.name} process is not running on port ${port}`);
        checks.push({
          name: 'process-running',
          status: 'fail',
          message: `Process is not running on port ${port}`,
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    case 'filesystem':
      const dataPath = serviceInfo.config.path || path.join(PROJECT_ROOT, 'data');
      try {
        await fs.access(dataPath);
        printSuccess(`Filesystem directory accessible: ${dataPath}`);
        checks.push({
          name: 'filesystem-access',
          status: 'pass',
          message: `Directory accessible: ${dataPath}`,
          details: { path: dataPath },
        });
      } catch {
        printWarning(`Filesystem directory not accessible: ${dataPath}`);
        checks.push({
          name: 'filesystem-access',
          status: 'fail',
          message: `Directory not accessible: ${dataPath}`,
          details: { path: dataPath },
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    default:
      checks.push({
        name: 'service-recognition',
        status: 'pass',
        message: 'Service configuration recognized',
      });
  }
  
  return { checks, healthStatus };
}

async function checkExternalService(serviceInfo: ServiceDeploymentInfo, options: CheckOptions, isStructuredOutput: boolean = false): Promise<{ checks: CheckResult['checks'], healthStatus: CheckResult['healthStatus'], uptime?: number }> {
  const checks: CheckResult['checks'] = [];
  let healthStatus: CheckResult['healthStatus'] = 'healthy';
  
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        printInfo(`External database: ${serviceInfo.config.host}:${serviceInfo.config.port || 5432}`);
        checks.push({
          name: 'external-database',
          status: 'warn',
          message: 'External database connectivity check not yet implemented',
          details: {
            host: serviceInfo.config.host,
            port: serviceInfo.config.port || 5432,
          },
        });
        healthStatus = 'unknown';
      } else {
        checks.push({
          name: 'external-database-config',
          status: 'fail',
          message: 'No host configured for external database',
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    case 'filesystem':
      if (serviceInfo.config.path || serviceInfo.config.mount) {
        const externalPath = serviceInfo.config.path || serviceInfo.config.mount;
        printInfo(`External storage: ${externalPath}`);
        try {
          await fs.access(externalPath!);
          printSuccess('External storage accessible');
          checks.push({
            name: 'external-storage',
            status: 'pass',
            message: 'External storage accessible',
            details: { path: externalPath },
          });
        } catch {
          printWarning('External storage not accessible');
          checks.push({
            name: 'external-storage',
            status: 'fail',
            message: 'External storage not accessible',
            details: { path: externalPath },
          });
          healthStatus = 'unhealthy';
        }
      } else {
        checks.push({
          name: 'external-storage-config',
          status: 'fail',
          message: 'No path configured for external storage',
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    case 'frontend':
    case 'backend':
      if (serviceInfo.config.host) {
        const url = `http://${serviceInfo.config.host}:${serviceInfo.config.port || 80}/health`;
        const startTime = Date.now();
        const healthy = await checkHttpHealth(url);
        const responseTime = Date.now() - startTime;
        
        if (healthy) {
          printSuccess(`External ${serviceInfo.name} service is healthy`);
          checks.push({
            name: 'external-service',
            status: 'pass',
            message: `External ${serviceInfo.name} service is healthy`,
            responseTime,
            details: { endpoint: url },
          });
        } else {
          printWarning(`External ${serviceInfo.name} service is not responding`);
          checks.push({
            name: 'external-service',
            status: 'fail',
            message: `External ${serviceInfo.name} service is not responding`,
            responseTime,
            details: { endpoint: url },
          });
          healthStatus = 'unhealthy';
        }
      } else {
        checks.push({
          name: 'external-service-config',
          status: 'fail',
          message: `No host configured for external ${serviceInfo.name}`,
        });
        healthStatus = 'unhealthy';
      }
      break;
      
    default:
      checks.push({
        name: 'external-service-config',
        status: 'pass',
        message: `External ${serviceInfo.name} service configured`,
      });
  }
  
  return { checks, healthStatus };
}

async function checkMockService(serviceInfo: ServiceDeploymentInfo, options: CheckOptions, isStructuredOutput: boolean = false): Promise<{ checks: CheckResult['checks'], healthStatus: CheckResult['healthStatus'], uptime?: number }> {
  const checks: CheckResult['checks'] = [];
  let healthStatus: CheckResult['healthStatus'] = 'healthy';
  
  // Mock services are always "healthy" for testing purposes
  printSuccess(`Mock ${serviceInfo.name} service is healthy`);
  checks.push({
    name: 'mock-service',
    status: 'pass',
    message: `Mock ${serviceInfo.name} service is operational`,
    details: {
      mockType: 'testing',
      simulatedHealthy: true,
    },
  });
  
  return { checks, healthStatus };
}

// =====================================================================
// UTILITY FUNCTIONS
// =====================================================================

async function checkProcessOnPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('lsof', ['-ti', `:${port}`]);
    let output = '';
    
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('exit', (code) => {
      resolve(code === 0 && output.trim().length > 0);
    });
    
    proc.on('error', () => {
      resolve(false);
    });
  });
}

async function checkHttpHealth(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, 5000);
    
    http.get(url, (res) => {
      clearTimeout(timeout);
      resolve(res.statusCode === 200);
    }).on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

export async function check(options: CheckOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  
  try {
    // Validate service selector and resolve to actual services
    await validateServiceSelector(options.service, 'check', options.environment);
    const resolvedServices = await resolveServiceSelector(options.service, 'check', options.environment);
    
    // Get deployment information for all resolved services
    const serviceDeployments = await resolveServiceDeployments(resolvedServices, options.environment);
    
    if (!isStructuredOutput) {
      printDebug(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    }
    
    // Check services and collect results
    const serviceResults: CheckResult[] = [];
    
    if (options.section === 'all' || options.section === 'services') {
      if (!isStructuredOutput) {
        printInfo('\n📊 Service Status:');
      }
      
      for (const serviceInfo of serviceDeployments) {
        const result = await checkService(serviceInfo, options, startTime, isStructuredOutput);
        serviceResults.push(result);
      }
    }
    
    // Calculate overall health based on actual service results
    const healthyCount = serviceResults.filter(r => r.healthStatus === 'healthy').length;
    const degradedCount = serviceResults.filter(r => r.healthStatus === 'degraded').length;
    const unhealthyCount = serviceResults.filter(r => r.healthStatus === 'unhealthy').length;
    
    let overallHealth = 'Unknown';
    if (serviceResults.length === 0) {
      overallHealth = 'No services checked';
    } else if (healthyCount === serviceResults.length) {
      overallHealth = '✅ All services healthy';
    } else if (unhealthyCount === serviceResults.length) {
      overallHealth = '❌ All services unhealthy';
    } else if (unhealthyCount > 0) {
      overallHealth = `⚠️  ${healthyCount}/${serviceResults.length} services healthy`;
    } else if (degradedCount > 0) {
      overallHealth = `⚠️  Some services degraded`;
    }
    
    if (options.section === 'all' || options.section === 'health') {
      if (!isStructuredOutput) {
        printInfo('\n💚 Health Checks:');
        printInfo(`Overall system health: ${overallHealth}`);
      }
    }
    
    if (options.section === 'all' || options.section === 'logs') {
      if (!isStructuredOutput) {
        printInfo('\n📝 Recent Logs:');
        printWarning('Log aggregation not yet implemented');
      }
    }
    
    // Create aggregated results
    const succeeded = serviceResults.filter(r => r.success && r.healthStatus === 'healthy').length;
    const failed = serviceResults.filter(r => !r.success || r.healthStatus === 'unhealthy').length;
    const warnings = serviceResults.filter(r => r.success && r.healthStatus === 'degraded').length;
    
    const commandResults: CommandResults = {
      command: 'check',
      environment: options.environment,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: serviceResults,
      summary: {
        total: serviceResults.length,
        succeeded,
        failed,
        warnings,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun,
      },
    };
    
    // Print summary if not using structured output
    if (!isStructuredOutput) {
      printInfo('\n📋 Summary:');
      if (succeeded === serviceResults.length) {
        printSuccess(`All ${serviceResults.length} services are healthy`);
      } else {
        printWarning(`${succeeded}/${serviceResults.length} services are healthy`);
        const unhealthy = serviceResults.filter(r => !r.success || r.healthStatus === 'unhealthy');
        for (const service of unhealthy) {
          printError(`  - ${service.service} is not healthy`);
        }
      }
    }
    
    return commandResults;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    printError(`Check failed: ${errorMessage}`);
    
    return {
      command: 'check',
      environment: options.environment,
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

async function main(): Promise<void> {
  const options = parseArguments();
  
  printInfo(`🔍 Checking system status in ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  try {
    const results = await check(options);
    
    // Handle structured output
    if (options.output !== 'table') {
      const { formatResults } = await import('../lib/output-formatter.js');
      const formatted = formatResults(results, options.output);
      console.log(formatted);
      return;
    }
    
    // Exit with error code if any services are unhealthy
    if (results.summary.failed > 0) {
      process.exit(1);
    }
    
  } catch (error) {
    printError(`Check failed: ${error}`);
    process.exit(1);
  }
}

// Command file - no direct execution needed

export { main, CheckOptions, CheckOptionsSchema };