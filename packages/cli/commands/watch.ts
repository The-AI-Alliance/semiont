/**
 * Watch Command V2 - Monitor logs and system metrics
 * 
 * This version provides local and cloud monitoring without config-loader dependency
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as readline from 'readline';

// Get directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const WatchOptionsSchema = z.object({
  environment: z.string(),
  target: z.enum(['all', 'logs', 'metrics', 'services']).default('all'),
  service: z.enum(['all', 'frontend', 'backend', 'database']).default('all'),
  follow: z.boolean().default(true),
  interval: z.number().int().positive().default(5), // seconds
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

type WatchOptions = z.infer<typeof WatchOptionsSchema>;

// Color utilities
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

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

function clearScreen(): void {
  console.clear();
  console.log('\x1Bc'); // Reset terminal
}

function formatTimestamp(date: Date): string {
  return date.toLocaleTimeString('en-US', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });
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
// MONITORING FUNCTIONS
// =====================================================================

interface ServiceStatus {
  name: string;
  status: 'running' | 'stopped' | 'unknown';
  uptime?: string;
  cpu?: string;
  memory?: string;
  port?: number;
}

async function getDockerStats(containerName: string): Promise<{ cpu: string; memory: string } | null> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemUsage}}', containerName], {
      stdio: 'pipe'
    });
    
    let output = '';
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('exit', (code) => {
      if (code === 0 && output.trim()) {
        const parts = output.trim().split(' ');
        resolve({
          cpu: parts[0] || 'N/A',
          memory: parts.slice(1).join(' ') || 'N/A'
        });
      } else {
        resolve(null);
      }
    });
    
    proc.on('error', () => resolve(null));
  });
}

async function getProcessStatus(port: number, name: string): Promise<ServiceStatus> {
  return new Promise((resolve) => {
    const proc = spawn('lsof', ['-ti', `:${port}`], { stdio: 'pipe' });
    
    let output = '';
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('exit', (code) => {
      const pid = output.trim().split('\n')[0];
      if (code === 0 && pid) {
        resolve({
          name,
          status: 'running',
          port,
          uptime: 'N/A', // Could get from ps if needed
        });
      } else {
        resolve({
          name,
          status: 'stopped',
          port
        });
      }
    });
    
    proc.on('error', () => {
      resolve({
        name,
        status: 'unknown',
        port
      });
    });
  });
}

async function getLocalServices(options: WatchOptions): Promise<ServiceStatus[]> {
  const services: ServiceStatus[] = [];
  
  // Check database
  if (options.service === 'all' || options.service === 'database') {
    const dbStats = await getDockerStats('semiont-postgres');
    services.push({
      name: 'Database (PostgreSQL)',
      status: dbStats ? 'running' : 'stopped',
      cpu: dbStats?.cpu,
      memory: dbStats?.memory,
      port: 5432
    });
  }
  
  // Check backend
  if (options.service === 'all' || options.service === 'backend') {
    const backend = await getProcessStatus(3001, 'Backend API');
    services.push(backend);
  }
  
  // Check frontend
  if (options.service === 'all' || options.service === 'frontend') {
    const frontend = await getProcessStatus(3000, 'Frontend');
    services.push(frontend);
  }
  
  return services;
}

async function tailDockerLogs(containerName: string, follow: boolean): Promise<void> {
  const args = ['logs', containerName];
  if (follow) args.push('-f');
  args.push('--tail', '20');
  
  const proc = spawn('docker', args, { stdio: 'inherit' });
  
  return new Promise((resolve) => {
    proc.on('exit', () => resolve());
    proc.on('error', () => {
      printWarning(`Could not get logs for ${containerName}`);
      resolve();
    });
  });
}

async function showLogs(options: WatchOptions): Promise<void> {
  printInfo(`📋 Logs for ${colors.bright}${options.service}${colors.reset} services`);
  
  if (options.environment === 'local') {
    if (options.service === 'all' || options.service === 'database') {
      printInfo('\n🗃️  Database logs:');
      await tailDockerLogs('semiont-postgres', options.follow);
    }
    
    if (options.service === 'all' || options.service === 'backend') {
      printInfo('\n🚀 Backend logs:');
      printInfo('Check the terminal where backend is running');
    }
    
    if (options.service === 'all' || options.service === 'frontend') {
      printInfo('\n📱 Frontend logs:');
      printInfo('Check the terminal where frontend is running');
    }
  } else {
    printWarning('Cloud log streaming not yet implemented - use AWS Console');
  }
}

async function showMetrics(services: ServiceStatus[]): Promise<void> {
  console.log(`\n${colors.cyan}📊 Service Metrics${colors.reset}`);
  console.log('─'.repeat(60));
  
  for (const service of services) {
    const statusColor = service.status === 'running' ? colors.green : colors.red;
    const statusIcon = service.status === 'running' ? '●' : '○';
    
    console.log(`\n${statusColor}${statusIcon}${colors.reset} ${colors.bright}${service.name}${colors.reset}`);
    console.log(`  Status: ${statusColor}${service.status}${colors.reset}`);
    if (service.port) console.log(`  Port:   ${service.port}`);
    if (service.cpu) console.log(`  CPU:    ${service.cpu}`);
    if (service.memory) console.log(`  Memory: ${service.memory}`);
  }
}

// =====================================================================
// WATCH MODES
// =====================================================================

async function watchAll(options: WatchOptions): Promise<void> {
  const refreshDisplay = async () => {
    clearScreen();
    console.log(`${colors.bright}🔍 Semiont Monitor${colors.reset} - ${options.environment} environment`);
    console.log(`Last update: ${formatTimestamp(new Date())}`);
    console.log('Press Ctrl+C to exit\n');
    
    const services = await getLocalServices(options);
    await showMetrics(services);
    
    if (!options.follow) {
      console.log('\n' + '─'.repeat(60));
      await showLogs({ ...options, follow: false });
    }
  };
  
  // Initial display
  await refreshDisplay();
  
  // Set up refresh interval
  if (options.follow) {
    const interval = setInterval(refreshDisplay, options.interval * 1000);
    
    // Handle cleanup
    process.on('SIGINT', () => {
      clearInterval(interval);
      console.log('\n👋 Monitoring stopped');
      process.exit(0);
    });
    
    // Keep process alive
    await new Promise(() => {});
  }
}

async function watchLogs(options: WatchOptions): Promise<void> {
  clearScreen();
  console.log(`${colors.bright}📋 Log Monitor${colors.reset} - ${options.environment} environment`);
  console.log('Press Ctrl+C to exit\n');
  
  await showLogs(options);
  
  if (!options.follow) {
    process.exit(0);
  }
}

async function watchMetrics(options: WatchOptions): Promise<void> {
  const refresh = async () => {
    clearScreen();
    console.log(`${colors.bright}📊 Metrics Monitor${colors.reset} - ${options.environment} environment`);
    console.log(`Last update: ${formatTimestamp(new Date())}`);
    console.log('Press Ctrl+C to exit');
    
    const services = await getLocalServices(options);
    await showMetrics(services);
  };
  
  await refresh();
  
  if (options.follow) {
    const interval = setInterval(refresh, options.interval * 1000);
    
    process.on('SIGINT', () => {
      clearInterval(interval);
      console.log('\n👋 Monitoring stopped');
      process.exit(0);
    });
    
    await new Promise(() => {});
  }
}

async function watchServices(options: WatchOptions): Promise<void> {
  const refresh = async () => {
    clearScreen();
    console.log(`${colors.bright}🔄 Service Monitor${colors.reset} - ${options.environment} environment`);
    console.log(`Last update: ${formatTimestamp(new Date())}`);
    console.log('Press Ctrl+C to exit\n');
    
    const services = await getLocalServices(options);
    
    console.log(`${colors.cyan}Service Status:${colors.reset}`);
    console.log('─'.repeat(50));
    
    for (const service of services) {
      const statusColor = service.status === 'running' ? colors.green : colors.red;
      const statusIcon = service.status === 'running' ? '✅' : '❌';
      console.log(`${statusIcon} ${service.name.padEnd(25)} ${statusColor}${service.status}${colors.reset}`);
    }
  };
  
  await refresh();
  
  if (options.follow) {
    const interval = setInterval(refresh, options.interval * 1000);
    
    process.on('SIGINT', () => {
      clearInterval(interval);
      console.log('\n👋 Monitoring stopped');
      process.exit(0);
    });
    
    await new Promise(() => {});
  }
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  // Validate environment
  const validEnvironments = ['local', 'development', 'staging', 'production'];
  if (!validEnvironments.includes(options.environment)) {
    printError(`Invalid environment: ${options.environment}`);
    printInfo(`Available environments: ${validEnvironments.join(', ')}`);
    process.exit(1);
  }
  
  if (options.environment !== 'local') {
    printWarning('Cloud monitoring requires AWS SDK integration');
    printInfo('Currently only local environment monitoring is fully supported');
  }
  
  if (options.dryRun) {
    printInfo('[DRY RUN] Would start monitoring with:');
    console.log(`  Target: ${options.target}`);
    console.log(`  Service: ${options.service}`);
    console.log(`  Follow: ${options.follow}`);
    console.log(`  Interval: ${options.interval}s`);
    process.exit(0);
  }
  
  try {
    switch (options.target) {
      case 'all':
        await watchAll(options);
        break;
      
      case 'logs':
        await watchLogs(options);
        break;
      
      case 'metrics':
        await watchMetrics(options);
        break;
      
      case 'services':
        await watchServices(options);
        break;
    }
  } catch (error) {
    printError(`Monitoring failed: ${error}`);
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

export { main, WatchOptions, WatchOptionsSchema };