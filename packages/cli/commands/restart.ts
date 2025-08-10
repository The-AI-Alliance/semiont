/**
 * Restart Command V2 - Restart services by stopping then starting
 * 
 * This version orchestrates stop and start commands with proper error handling
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const RestartOptionsSchema = z.object({
  environment: z.string(),
  service: z.enum(['all', 'frontend', 'backend', 'database']).default('all'),
  force: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  gracePeriod: z.number().int().positive().default(3), // seconds to wait between stop and start
});

type RestartOptions = z.infer<typeof RestartOptionsSchema>;

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

function printDebug(message: string, options: RestartOptions): void {
  if (options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

async function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// =====================================================================
// PARSE ARGUMENTS
// =====================================================================

function parseArguments(): RestartOptions {
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
      case '--grace-period':
        rawOptions.gracePeriod = parseInt(args[++i]);
        break;
    }
  }
  
  try {
    return RestartOptionsSchema.parse(rawOptions);
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
// MAIN EXECUTION
// =====================================================================

async function spawnCommand(command: string, args: string[], options: RestartOptions): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const commandPath = path.join(__dirname, `${command}-v2.mjs`);
  
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [commandPath, ...args], {
      stdio: options.verbose ? 'inherit' : 'pipe',
      env: {
        ...process.env,
        SEMIONT_ENV: options.environment,
        SEMIONT_VERBOSE: options.verbose ? '1' : '0',
        SEMIONT_DRY_RUN: options.dryRun ? '1' : '0',
      }
    });
    
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
    
    proc.on('error', (error) => {
      reject(error);
    });
  });
}

async function main(): Promise<void> {
  const options = parseArguments();
  
  printInfo(`Restarting services in ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  try {
    // Step 1: Stop services
    printInfo('🛑 Stopping services...');
    
    const stopArgs = [
      options.environment,
      '--service', options.service,
      ...(options.force ? ['--force'] : []),
      ...(options.verbose ? ['--verbose'] : []),
      ...(options.dryRun ? ['--dry-run'] : []),
    ];
    
    await spawnCommand('stop', stopArgs, options);
    
    if (!options.dryRun) {
      // Step 2: Grace period
      printInfo(`⏳ Waiting ${options.gracePeriod} seconds before restart...`);
      await sleep(options.gracePeriod);
    }
    
    // Step 3: Start services
    printInfo('🚀 Starting services...');
    
    const startArgs = [
      options.environment,
      '--service', options.service,
      ...(options.verbose ? ['--verbose'] : []),
      ...(options.dryRun ? ['--dry-run'] : []),
    ];
    
    await spawnCommand('start', startArgs, options);
    
    printSuccess('Services restarted successfully');
    
  } catch (error) {
    printError(`Failed to restart services: ${error}`);
    
    // If stop succeeded but start failed, warn about state
    printWarning('Services may be in an inconsistent state');
    printInfo('Try running stop and start commands individually');
    
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

export { main, RestartOptions, RestartOptionsSchema };