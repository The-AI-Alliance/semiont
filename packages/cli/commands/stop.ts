/**
 * Stop Command V2 - Stop services with type-safe argument parsing
 * 
 * This version works with the new CLI structure using Zod validation
 */

import { z } from 'zod';
import { spawn } from 'child_process';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const StopOptionsSchema = z.object({
  environment: z.string(),
  service: z.enum(['all', 'frontend', 'backend', 'database']).default('all'),
  force: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

type StopOptions = z.infer<typeof StopOptionsSchema>;

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

function printDebug(message: string, options: StopOptions): void {
  if (options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

// =====================================================================
// PARSE ARGUMENTS
// =====================================================================

function parseArguments(): StopOptions {
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
      case '--force':
      case '-f':
        rawOptions.force = true;
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
    return StopOptionsSchema.parse(rawOptions);
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

async function validateEnvironment(options: StopOptions): Promise<void> {
  const validEnvironments = ['local', 'development', 'staging', 'production'];
  
  if (!validEnvironments.includes(options.environment)) {
    printError(`Invalid environment: ${options.environment}`);
    printInfo(`Available environments: ${validEnvironments.join(', ')}`);
    process.exit(1);
  }
  
  printDebug(`Validated environment: ${options.environment}`, options);
}

// =====================================================================
// SERVICE STOP FUNCTIONS
// =====================================================================

async function stopDatabase(options: StopOptions): Promise<void> {
  if (options.dryRun) {
    printInfo('[DRY RUN] Would stop database');
    return;
  }
  
  printInfo('Stopping database...');
  
  if (options.environment === 'local') {
    try {
      // Stop and remove PostgreSQL container
      const stopCmd = spawn('docker', ['stop', 'semiont-postgres'], {
        stdio: options.verbose ? 'inherit' : 'pipe'
      });
      
      await new Promise((resolve, reject) => {
        stopCmd.on('exit', (code) => {
          if (code === 0 || code === 1) { // 1 = container not found
            resolve(void 0);
          } else {
            reject(new Error(`Failed to stop database: exit code ${code}`));
          }
        });
      });
      
      // Remove container
      const rmCmd = spawn('docker', ['rm', 'semiont-postgres'], {
        stdio: options.verbose ? 'inherit' : 'pipe'
      });
      
      await new Promise((resolve) => {
        rmCmd.on('exit', () => resolve(void 0)); // Ignore errors
      });
      
      printSuccess('Database stopped');
    } catch (error) {
      if (options.force) {
        printWarning(`Failed to stop database: ${error}`);
      } else {
        throw error;
      }
    }
  } else {
    printInfo('Cloud database (RDS) cannot be stopped via CLI - use AWS Console');
  }
}

async function findAndKillProcess(pattern: string, name: string, options: StopOptions): Promise<void> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would stop ${name}`);
    return;
  }
  
  printInfo(`Stopping ${name}...`);
  
  try {
    // Find process using lsof (for port) or pgrep (for name)
    const isPort = pattern.startsWith(':');
    const findCmd = isPort 
      ? spawn('lsof', ['-ti', pattern])
      : spawn('pgrep', ['-f', pattern]);
    
    let pids = '';
    findCmd.stdout?.on('data', (data) => {
      pids += data.toString();
    });
    
    await new Promise((resolve) => {
      findCmd.on('exit', () => resolve(void 0));
    });
    
    if (pids.trim()) {
      const pidList = pids.trim().split('\n');
      printDebug(`Found ${pidList.length} process(es) to stop`, options);
      
      for (const pid of pidList) {
        if (pid) {
          try {
            process.kill(parseInt(pid), options.force ? 'SIGKILL' : 'SIGTERM');
          } catch (err) {
            printDebug(`Failed to kill PID ${pid}: ${err}`, options);
          }
        }
      }
      
      printSuccess(`${name} stopped`);
    } else {
      printInfo(`${name} not running`);
    }
  } catch (error) {
    if (options.force) {
      printWarning(`Failed to stop ${name}: ${error}`);
    } else {
      throw error;
    }
  }
}

async function stopBackend(options: StopOptions): Promise<void> {
  if (options.environment === 'local') {
    // Kill process on port 3001
    await findAndKillProcess(':3001', 'Backend', options);
  } else {
    // For cloud environments, use ECS
    if (options.dryRun) {
      printInfo('[DRY RUN] Would stop backend ECS service');
      return;
    }
    
    printInfo(`Stopping backend in ${options.environment} via ECS...`);
    printWarning('ECS service stop not yet implemented - use AWS Console');
  }
}

async function stopFrontend(options: StopOptions): Promise<void> {
  if (options.environment === 'local') {
    // Kill process on port 3000
    await findAndKillProcess(':3000', 'Frontend', options);
  } else {
    // For cloud environments, use ECS
    if (options.dryRun) {
      printInfo('[DRY RUN] Would stop frontend ECS service');
      return;
    }
    
    printInfo(`Stopping frontend in ${options.environment} via ECS...`);
    printWarning('ECS service stop not yet implemented - use AWS Console');
  }
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  printInfo(`Stopping services in ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  // Validate environment
  await validateEnvironment(options);
  
  try {
    switch (options.service) {
      case 'database':
        await stopDatabase(options);
        break;
      
      case 'backend':
        await stopBackend(options);
        break;
      
      case 'frontend':
        await stopFrontend(options);
        break;
      
      case 'all':
        // Stop in reverse order from start
        await stopFrontend(options);
        await stopBackend(options);
        if (options.environment === 'local') {
          await stopDatabase(options);
        }
        break;
    }
    
    printSuccess('Services stopped successfully');
  } catch (error) {
    printError(`Failed to stop services: ${error}`);
    if (!options.force) {
      printInfo('Use --force to ignore errors and continue');
    }
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

export { main, StopOptions, StopOptionsSchema };