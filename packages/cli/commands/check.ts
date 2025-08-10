/**
 * Check Command V2 - System health and status monitoring
 * 
 * This version provides simplified health checking with type-safe argument parsing
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Get directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const CheckOptionsSchema = z.object({
  environment: z.string(),
  section: z.enum(['all', 'services', 'health', 'logs']).default('all'),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

type CheckOptions = z.infer<typeof CheckOptionsSchema>;

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
    environment: process.env.SEMIONT_ENV || process.argv[2],
    verbose: process.env.SEMIONT_VERBOSE === '1',
    dryRun: process.env.SEMIONT_DRY_RUN === '1',
  };
  
  // Parse command-line arguments
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
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
    }
  }
  
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
// ENVIRONMENT VALIDATION
// =====================================================================

async function validateEnvironment(options: CheckOptions): Promise<void> {
  const validEnvironments = ['local', 'development', 'staging', 'production'];
  
  if (!validEnvironments.includes(options.environment)) {
    printError(`Invalid environment: ${options.environment}`);
    printInfo(`Available environments: ${validEnvironments.join(', ')}`);
    process.exit(1);
  }
  
  printDebug(`Validated environment: ${options.environment}`, options);
}

// =====================================================================
// HEALTH CHECK FUNCTIONS
// =====================================================================

async function checkProcessHealth(port: number, name: string, options: CheckOptions): Promise<boolean> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would check ${name} on port ${port}`);
    return true;
  }
  
  return new Promise((resolve) => {
    const proc = spawn('lsof', ['-ti', `:${port}`], { stdio: 'pipe' });
    
    let output = '';
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('exit', (code) => {
      const isRunning = code === 0 && output.trim().length > 0;
      if (isRunning) {
        printSuccess(`${name} is running on port ${port}`);
      } else {
        printWarning(`${name} is not running on port ${port}`);
      }
      resolve(isRunning);
    });
    
    proc.on('error', () => {
      printWarning(`Could not check ${name} status`);
      resolve(false);
    });
  });
}

async function checkWebsiteHealth(url: string, options: CheckOptions): Promise<boolean> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would check website health at ${url}`);
    return true;
  }
  
  try {
    const response = await fetch(url, { 
      method: 'HEAD',
      signal: AbortSignal.timeout(5000)
    });
    
    const isHealthy = response.status >= 200 && response.status < 400;
    if (isHealthy) {
      printSuccess(`Website is healthy - HTTP ${response.status}`);
    } else {
      printWarning(`Website returned HTTP ${response.status}`);
    }
    return isHealthy;
  } catch (error) {
    printError(`Website is unreachable: ${error}`);
    return false;
  }
}

async function checkDockerContainer(containerName: string, options: CheckOptions): Promise<boolean> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would check Docker container ${containerName}`);
    return true;
  }
  
  return new Promise((resolve) => {
    const proc = spawn('docker', ['ps', '--filter', `name=${containerName}`, '--format', 'table {{.Names}}\\t{{.Status}}'], { stdio: 'pipe' });
    
    let output = '';
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('exit', (code) => {
      if (code === 0 && output.includes(containerName)) {
        const lines = output.split('\n');
        const containerLine = lines.find(line => line.includes(containerName));
        if (containerLine) {
          const status = containerLine.split('\t')[1] || 'unknown';
          if (status.includes('Up')) {
            printSuccess(`${containerName} container is running - ${status}`);
            resolve(true);
          } else {
            printWarning(`${containerName} container status: ${status}`);
            resolve(false);
          }
        } else {
          printWarning(`${containerName} container not found`);
          resolve(false);
        }
      } else {
        printWarning(`${containerName} container not running`);
        resolve(false);
      }
    });
    
    proc.on('error', () => {
      printWarning(`Could not check ${containerName} container (Docker not available?)`);
      resolve(false);
    });
  });
}

// =====================================================================
// CHECK SECTIONS
// =====================================================================

async function checkServices(options: CheckOptions): Promise<void> {
  printInfo(`\n🔍 Checking services in ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.environment === 'local') {
    // Check local services
    await checkDockerContainer('semiont-postgres', options);
    await checkProcessHealth(3001, 'Backend API', options);
    await checkProcessHealth(3000, 'Frontend', options);
  } else {
    // For cloud environments - provide useful info
    printInfo('Cloud service checks:');
    printInfo('  • ECS Services: Check via AWS Console → ECS → Clusters');
    printInfo('  • RDS Database: Check via AWS Console → RDS → Databases');
    printInfo('  • Load Balancer: Check via AWS Console → EC2 → Load Balancers');
    printInfo('  • CloudWatch: Check via AWS Console → CloudWatch → Dashboards');
    
    // Try to check if services are reachable via public endpoints
    if (options.environment === 'production') {
      await checkWebsiteHealth('https://your-production-url.com', options);
    } else if (options.environment === 'staging') {
      await checkWebsiteHealth('https://your-staging-url.com', options);
    }
    
    printInfo('\nFor detailed monitoring, use: semiont watch -e ' + options.environment);
  }
}

async function checkHealth(options: CheckOptions): Promise<void> {
  printInfo(`\n🏥 Health checks for ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.environment === 'local') {
    // Check local endpoints
    await checkWebsiteHealth('http://localhost:3000', options);
    await checkWebsiteHealth('http://localhost:3001/health', options);
  } else {
    // Provide guidance for cloud health checks
    printInfo('Cloud health check endpoints:');
    printInfo('  • Frontend: Check load balancer DNS or CloudFront distribution');
    printInfo('  • Backend API: Check /health endpoint via load balancer');
    printInfo('  • Database: Connection test via backend health check');
    
    // Common patterns for cloud URLs
    const baseUrls: Record<string, string> = {
      development: 'https://dev.your-domain.com',
      staging: 'https://staging.your-domain.com',
      production: 'https://your-domain.com'
    };
    
    const baseUrl = baseUrls[options.environment];
    if (baseUrl) {
      printInfo(`\nChecking ${baseUrl} (update URL in check-v2.ts if different)`);
      await checkWebsiteHealth(baseUrl, options);
      await checkWebsiteHealth(`${baseUrl}/api/health`, options);
    }
  }
}

async function checkLogs(options: CheckOptions): Promise<void> {
  printInfo(`\n📋 Recent logs for ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.environment === 'local') {
    // Show local log info
    printInfo('Local log locations:');
    printInfo('  Docker logs: docker logs semiont-postgres');
    printInfo('  Backend logs: Check terminal where backend is running');
    printInfo('  Frontend logs: Check terminal where frontend is running');
    printInfo('\nView live logs: semiont watch -e local --target logs');
  } else {
    printInfo('Cloud log locations:');
    printInfo('  • CloudWatch Logs: AWS Console → CloudWatch → Log groups');
    printInfo('  • ECS Task Logs: AWS Console → ECS → Tasks → View logs');
    printInfo('  • Application Logs: Check CloudWatch log groups:');
    printInfo('    - /ecs/semiont-frontend');
    printInfo('    - /ecs/semiont-backend');
    printInfo('    - /aws/rds/instance/semiont-db');
    printInfo('\nFor live monitoring: semiont watch -e ' + options.environment);
  }
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  printInfo(`📊 System Status Check`);
  printInfo('====================');
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  // Validate environment
  await validateEnvironment(options);
  
  try {
    switch (options.section) {
      case 'services':
        await checkServices(options);
        break;
      
      case 'health':
        await checkHealth(options);
        break;
      
      case 'logs':
        await checkLogs(options);
        break;
      
      case 'all':
        await checkServices(options);
        await checkHealth(options);
        await checkLogs(options);
        break;
    }
    
    printInfo('\n💡 Quick Commands:');
    printInfo('   Start services: semiont start -e local');
    printInfo('   Stop services:  semiont stop -e local');
    printInfo('   View logs:      docker logs semiont-postgres');
    
    printSuccess('Health check completed');
    
  } catch (error) {
    printError(`Health check failed: ${error}`);
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

export { main, CheckOptions, CheckOptionsSchema };