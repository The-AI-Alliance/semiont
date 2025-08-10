/**
 * Start Command V2 - Refactored to work with new CLI structure
 * 
 * This version expects arguments to be passed via environment variables
 * and command-line flags from the main CLI entry point.
 */

import { z } from 'zod';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
// Removed problematic imports for simpler CLI

// Get directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const StartOptionsSchema = z.object({
  environment: z.string(),
  service: z.enum(['all', 'frontend', 'backend', 'database']).default('all'),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

type StartOptions = z.infer<typeof StartOptionsSchema>;

// Track spawned processes for cleanup
const spawnedProcesses: ChildProcess[] = [];

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

function printDebug(message: string, options: StartOptions): void {
  if (options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

// =====================================================================
// PARSE ARGUMENTS FROM CLI
// =====================================================================

function parseArguments(): StartOptions {
  // Build arguments object from both environment variables and CLI args
  const rawOptions: any = {
    // Environment variable takes precedence (set by main CLI)
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
    return StartOptionsSchema.parse(rawOptions);
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

async function validateEnvironment(options: StartOptions): Promise<void> {
  const validEnvironments = ['local', 'development', 'staging', 'production'];
  
  if (!validEnvironments.includes(options.environment)) {
    printError(`Invalid environment: ${options.environment}`);
    printInfo(`Available environments: ${validEnvironments.join(', ')}`);
    process.exit(1);
  }
  
  printDebug(`Validated environment: ${options.environment}`, options);
}

// =====================================================================
// SERVICE START FUNCTIONS
// =====================================================================

async function startDatabase(options: StartOptions): Promise<void> {
  if (options.dryRun) {
    printInfo('[DRY RUN] Would start database');
    return;
  }
  
  printInfo('Starting database...');
  
  if (options.environment === 'local') {
    // Start local PostgreSQL container in detached mode
    const proc = spawn('docker', [
      'run',
      '--name', 'semiont-postgres',
      '-e', 'POSTGRES_PASSWORD=localpassword',
      '-e', 'POSTGRES_DB=semiont',
      '-p', '5432:5432',
      '-d',
      'postgres:15-alpine'
    ], { stdio: options.verbose ? 'inherit' : 'pipe' });
    
    printSuccess('Database started');
  } else {
    printInfo('Cloud database is managed by AWS RDS');
  }
}

async function startBackend(options: StartOptions): Promise<void> {
  if (options.dryRun) {
    printInfo('[DRY RUN] Would start backend');
    return;
  }
  
  printInfo('Starting backend...');
  
  if (options.environment === 'local') {
    // Start local backend in detached mode
    const proc = spawn('npm', ['run', 'dev'], {
      cwd: path.join(PROJECT_ROOT, 'apps/backend'),
      stdio: 'pipe',
      detached: true,
      env: {
        ...process.env,
        SEMIONT_ENV: 'development',
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:localpassword@localhost:5432/semiont',
        JWT_SECRET: process.env.JWT_SECRET || 'local-dev-secret',
        PORT: '3001',
      }
    });
    
    proc.unref(); // Allow parent to exit
    printSuccess('Backend started on port 3001');
  } else {
    // For cloud environments, use ECS
    printInfo(`Starting backend in ${options.environment} via ECS...`);
    printWarning('ECS service start not yet implemented - use AWS Console');
  }
}

async function startFrontend(options: StartOptions): Promise<void> {
  if (options.dryRun) {
    printInfo('[DRY RUN] Would start frontend');
    return;
  }
  
  printInfo('Starting frontend...');
  
  if (options.environment === 'local') {
    const proc = spawn('npm', ['run', 'dev'], {
      cwd: path.join(PROJECT_ROOT, 'apps/frontend'),
      stdio: 'pipe',
      detached: true,
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: 'http://localhost:3001',
        NEXT_PUBLIC_SITE_NAME: 'Semiont Dev',
      }
    });
    
    proc.unref(); // Allow parent to exit
    printSuccess('Frontend started on port 3000');
  } else {
    printInfo(`Starting frontend in ${options.environment} via ECS...`);
    printWarning('ECS service start not yet implemented - use AWS Console');
  }
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  printInfo(`Starting services in ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  // Validate environment
  await validateEnvironment(options);
  
  // Start services based on selection (all in detached mode)
  try {
    switch (options.service) {
      case 'database':
        await startDatabase(options);
        break;
      
      case 'backend':
        if (options.environment === 'local') {
          await startDatabase(options); // Backend needs database
        }
        await startBackend(options);
        break;
      
      case 'frontend':
        await startFrontend(options);
        break;
      
      case 'all':
        if (options.environment === 'local') {
          await startDatabase(options);
          await startBackend(options);
        }
        await startFrontend(options);
        break;
    }
    
    printSuccess('All services started successfully');
  } catch (error) {
    printError(`Failed to start services: ${error}`);
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

export { main, StartOptions, StartOptionsSchema };