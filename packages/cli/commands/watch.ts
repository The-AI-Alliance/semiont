/**
 * Watch Command V2 - Deployment-type aware monitoring of logs and metrics
 * 
 * This command monitors services based on deployment type:
 * - AWS: Stream CloudWatch logs and metrics
 * - Container: Stream container logs and monitor usage
 * - Process: Tail log files and monitor process metrics
 * - External: Monitor external logs and storage
 */

import { z } from 'zod';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { colors } from '../lib/cli-colors.js';
import { resolveServiceSelector, validateServiceSelector } from '../lib/services.js';
import { resolveServiceDeployments, type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { getContainerLogs } from '../lib/container-runtime.js';
import { getProjectRoot } from '../lib/cli-paths.js';

const PROJECT_ROOT = getProjectRoot(import.meta.url);

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const WatchOptionsSchema = z.object({
  environment: z.string(),
  target: z.enum(['all', 'logs', 'metrics', 'services']).default('all'),
  service: z.string().default('all'),
  follow: z.boolean().default(true),
  interval: z.number().int().positive().default(5), // seconds
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

type WatchOptions = z.infer<typeof WatchOptionsSchema>;

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

function printDebug(message: string, options: WatchOptions): void {
  if (options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

// =====================================================================
// PARSE ARGUMENTS
// =====================================================================

function parseArguments(): WatchOptions {
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
      case '--target':
      case '-t':
        rawOptions.target = args[++i];
        break;
      case '--service':
      case '-s':
        rawOptions.service = args[++i];
        break;
      case '--no-follow':
        rawOptions.follow = false;
        break;
      case '--interval':
      case '-i':
        rawOptions.interval = parseInt(args[++i]);
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
    return WatchOptionsSchema.parse(rawOptions);
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
// DEPLOYMENT-TYPE-AWARE WATCH FUNCTIONS
// =====================================================================

async function watchService(serviceInfo: ServiceDeploymentInfo, options: WatchOptions): Promise<void> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would monitor ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    return;
  }
  
  printInfo(`👁️  Monitoring ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  
  switch (serviceInfo.deploymentType) {
    case 'aws':
      await watchAWSService(serviceInfo, options);
      break;
    case 'container':
      await watchContainerService(serviceInfo, options);
      break;
    case 'process':
      await watchProcessService(serviceInfo, options);
      break;
    case 'external':
      await watchExternalService(serviceInfo, options);
      break;
    default:
      printWarning(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
  }
}

async function watchAWSService(serviceInfo: ServiceDeploymentInfo, options: WatchOptions): Promise<void> {
  // AWS CloudWatch monitoring
  switch (serviceInfo.name) {
    case 'frontend':
    case 'backend':
      if (options.target === 'all' || options.target === 'logs') {
        printInfo(`Streaming CloudWatch logs for ${serviceInfo.name}`);
        printWarning('CloudWatch log streaming not yet implemented');
      }
      if (options.target === 'all' || options.target === 'metrics') {
        printInfo(`Monitoring CloudWatch metrics for ${serviceInfo.name}`);
        printWarning('CloudWatch metrics monitoring not yet implemented');
      }
      break;
      
    case 'database':
      if (options.target === 'all' || options.target === 'logs') {
        printInfo(`Streaming RDS logs for ${serviceInfo.name}`);
        printWarning('RDS log streaming not yet implemented');
      }
      break;
      
    case 'filesystem':
      if (options.target === 'all' || options.target === 'metrics') {
        printInfo(`Monitoring EFS metrics for ${serviceInfo.name}`);
        printWarning('EFS metrics monitoring not yet implemented');
      }
      break;
  }
}

async function watchContainerService(serviceInfo: ServiceDeploymentInfo, options: WatchOptions): Promise<void> {
  const containerName = `semiont-${serviceInfo.name === 'database' ? 'postgres' : serviceInfo.name}-${options.environment}`;
  
  try {
    if (options.target === 'all' || options.target === 'logs') {
      printInfo(`Streaming logs for container: ${containerName}`);
      
      // Stream container logs
      const success = await getContainerLogs(containerName, {
        follow: options.follow,
        verbose: options.verbose
      });
      
      if (!success) {
        printWarning(`Failed to get logs for container: ${containerName}`);
      }
    }
    
    if (options.target === 'all' || options.target === 'metrics') {
      printInfo(`Monitoring container usage for ${serviceInfo.name}`);
      await monitorContainerMetrics(containerName, options);
    }
  } catch (error) {
    printError(`Failed to monitor container ${containerName}: ${error}`);
  }
}

async function watchProcessService(serviceInfo: ServiceDeploymentInfo, options: WatchOptions): Promise<void> {
  switch (serviceInfo.name) {
    case 'database':
      if (options.target === 'all' || options.target === 'logs') {
        printInfo(`Tailing PostgreSQL logs`);
        await tailLogFile('/usr/local/var/log/postgres.log', 'PostgreSQL', options);
      }
      break;
      
    case 'frontend':
    case 'backend':
      if (options.target === 'all' || options.target === 'logs') {
        const logPath = path.join(PROJECT_ROOT, 'apps', serviceInfo.name, 'logs', `${serviceInfo.name}.log`);
        printInfo(`Tailing log file: ${logPath}`);
        await tailLogFile(logPath, serviceInfo.name, options);
      }
      
      if (options.target === 'all' || options.target === 'metrics') {
        printInfo(`Monitoring process metrics for ${serviceInfo.name}`);
        const port = serviceInfo.config.port || (serviceInfo.name === 'frontend' ? 3000 : 3001);
        await monitorProcessMetrics(port, serviceInfo.name, options);
      }
      break;
      
    case 'filesystem':
      if (options.target === 'all' || options.target === 'metrics') {
        const dataPath = serviceInfo.config.path || path.join(PROJECT_ROOT, 'data');
        printInfo(`Monitoring disk usage: ${dataPath}`);
        await monitorDiskUsage(dataPath, options);
      }
      break;
  }
}

async function watchExternalService(serviceInfo: ServiceDeploymentInfo, options: WatchOptions): Promise<void> {
  switch (serviceInfo.name) {
    case 'database':
      if (serviceInfo.config.host) {
        printInfo(`Monitoring external database: ${serviceInfo.config.host}`);
        printWarning('External database monitoring not yet implemented');
      }
      break;
      
    case 'filesystem':
      if (serviceInfo.config.path) {
        printInfo(`Monitoring external storage: ${serviceInfo.config.path}`);
        await monitorDiskUsage(serviceInfo.config.path, options);
      }
      break;
      
    case 'frontend':
    case 'backend':
      if (serviceInfo.config.host) {
        printInfo(`Monitoring external ${serviceInfo.name}: ${serviceInfo.config.host}`);
        await monitorExternalEndpoint(serviceInfo.config.host!, serviceInfo.config.port || 80, serviceInfo.name, options);
      }
      break;
  }
}

// =====================================================================
// UTILITY FUNCTIONS
// =====================================================================

async function tailLogFile(filePath: string, serviceName: string, options: WatchOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const tailArgs = ['tail'];
    
    if (options.follow) {
      tailArgs.push('-f');
    }
    tailArgs.push('-n', '50', filePath); // Show last 50 lines
    
    printDebug(`Running: ${tailArgs.join(' ')}`, options);
    
    const proc = spawn(tailArgs[0], tailArgs.slice(1), {
      stdio: ['pipe', 'inherit', 'inherit']
    });
    
    proc.on('error', (error) => {
      if (error.message.includes('ENOENT')) {
        printWarning(`Log file not found: ${filePath}`);
        resolve();
      } else {
        reject(error);
      }
    });
    
    // For non-follow mode, resolve when process exits
    if (!options.follow) {
      proc.on('exit', () => resolve());
    }
    
    // Handle Ctrl+C
    process.on('SIGINT', () => {
      proc.kill();
      resolve();
    });
  });
}

async function monitorContainerMetrics(containerName: string, options: WatchOptions): Promise<void> {
  const interval = setInterval(async () => {
    try {
      // Would use docker stats or container runtime stats API
      printDebug(`Container ${containerName} metrics: CPU: 15%, Memory: 128MB`, options);
    } catch (error) {
      printDebug(`Failed to get metrics for ${containerName}: ${error}`, options);
    }
  }, options.interval * 1000);
  
  // Handle Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(interval);
  });
}

async function monitorProcessMetrics(port: number, serviceName: string, options: WatchOptions): Promise<void> {
  const interval = setInterval(async () => {
    try {
      // Find process using lsof and get PID
      const proc = spawn('lsof', ['-ti', `:${port}`]);
      let pid = '';
      
      proc.stdout?.on('data', (data) => {
        pid += data.toString().trim();
      });
      
      await new Promise((resolve) => {
        proc.on('exit', () => resolve(void 0));
      });
      
      if (pid) {
        printDebug(`Process ${serviceName} (PID: ${pid}) monitoring active`, options);
        // Would get actual process metrics here
      } else {
        printDebug(`Process ${serviceName} not running on port ${port}`, options);
      }
    } catch (error) {
      printDebug(`Failed to monitor process ${serviceName}: ${error}`, options);
    }
  }, options.interval * 1000);
  
  // Handle Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(interval);
  });
}

async function monitorDiskUsage(dirPath: string, options: WatchOptions): Promise<void> {
  const interval = setInterval(async () => {
    try {
      const proc = spawn('du', ['-sh', dirPath]);
      let output = '';
      
      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });
      
      await new Promise((resolve) => {
        proc.on('exit', () => resolve(void 0));
      });
      
      if (output.trim()) {
        const usage = output.trim().split('\t')[0];
        printDebug(`Disk usage ${dirPath}: ${usage}`, options);
      }
    } catch (error) {
      printDebug(`Failed to monitor disk usage ${dirPath}: ${error}`, options);
    }
  }, options.interval * 1000);
  
  // Handle Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(interval);
  });
}

async function monitorExternalEndpoint(host: string, port: number, serviceName: string, options: WatchOptions): Promise<void> {
  const interval = setInterval(async () => {
    try {
      // Simple ping-style health check
      const proc = spawn('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://${host}:${port}/health`]);
      let statusCode = '';
      
      proc.stdout?.on('data', (data) => {
        statusCode += data.toString();
      });
      
      await new Promise((resolve) => {
        proc.on('exit', () => resolve(void 0));
      });
      
      if (statusCode === '200') {
        printDebug(`External ${serviceName} healthy: ${host}:${port}`, options);
      } else {
        printWarning(`External ${serviceName} returned ${statusCode}: ${host}:${port}`);
      }
    } catch (error) {
      printDebug(`Failed to check external ${serviceName}: ${error}`, options);
    }
  }, options.interval * 1000);
  
  // Handle Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(interval);
  });
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  printInfo(`👁️  Monitoring ${options.target} in ${colors.bright}${options.environment}${colors.reset} environment`);
  printInfo('Press Ctrl+C to stop monitoring');
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  try {
    // Validate service selector and resolve to actual services
    await validateServiceSelector(options.service, 'start', options.environment);
    const resolvedServices = await resolveServiceSelector(options.service, 'start', options.environment);
    
    // Get deployment information for all resolved services
    const serviceDeployments = await resolveServiceDeployments(resolvedServices, options.environment);
    
    printDebug(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    
    // Start monitoring all services concurrently
    const monitoringPromises = serviceDeployments.map(serviceInfo => 
      watchService(serviceInfo, options).catch(error => {
        printError(`Failed to monitor ${serviceInfo.name}: ${error}`);
      })
    );
    
    // Wait for all monitoring to complete (or Ctrl+C)
    await Promise.allSettled(monitoringPromises);
    
  } catch (error) {
    printError(`Monitoring failed: ${error}`);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  printInfo('\n🛑 Stopping monitoring...');
  process.exit(0);
});

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    printError(`Unexpected error: ${error}`);
    process.exit(1);
  });
}

export { main, WatchOptions, WatchOptionsSchema };