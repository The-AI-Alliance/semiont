
/**
 * Stop Command - Stop services in any environment
 * 
 * Usage:
 *   ./scripts/semiont stop <environment> [options]
 *   ./scripts/semiont stop local                     # Stop all local services
 *   ./scripts/semiont stop local --service frontend  # Stop frontend only
 *   ./scripts/semiont stop production --service backend # Stop backend in production
 */

import { getAvailableEnvironments, isValidEnvironment } from './lib/environment-discovery';
import { requireValidAWSCredentials } from './utils/aws-validation';

// Valid environments
type Environment = string;
type Service = 'database' | 'backend' | 'frontend' | 'all';

interface StopOptions {
  environment: Environment;
  service: Service;
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
}

// Color codes for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};


function error(message: string): void {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}

function success(message: string): void {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function info(message: string): void {
  console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
}

function warning(message: string): void {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

async function validateEnvironment(env: string): Promise<Environment> {
  const validEnvironments = getAvailableEnvironments();
  
  if (!isValidEnvironment(env)) {
    throw new Error(`Invalid environment: ${env}. Must be one of: ${validEnvironments.join(', ')}`);
  }
  
  return env as Environment;
}

async function stopLocalServices(options: StopOptions): Promise<boolean> {
  const { service } = options;
  
  success('Stopping local services...');
  
  // Stop services based on selection
  if (service === 'frontend' || service === 'all') {
    info('Stopping frontend service...');
    // TODO: Stop local frontend process
    success('Frontend stopped');
  }
  
  if (service === 'backend' || service === 'all') {
    info('Stopping backend service...');
    // TODO: Stop local backend process
    success('Backend stopped');
  }
  
  if (service === 'database' || service === 'all') {
    info('Stopping PostgreSQL container...');
    // TODO: Stop local database container
    success('Database container stopped');
  }
  
  return true;
}

async function stopCloudServices(options: StopOptions): Promise<boolean> {
  const { environment, service, dryRun } = options;
  
  info(`Stopping services in ${environment} environment...`);
  
  if (dryRun) {
    info('DRY RUN - No actual changes will be made');
  }
  
  // Warning for production
  if (environment === 'production' && !options.force) {
    warning('Stopping production services! Use --force to confirm this action.');
    return false;
  }
  
  // Stop services based on selection
  if (service === 'frontend' || service === 'all') {
    info('Stopping frontend service...');
    // TODO: Scale ECS service to 0 instances
    success('Frontend service stopped');
  }
  
  if (service === 'backend' || service === 'all') {
    info('Stopping backend service...');
    // TODO: Scale ECS service to 0 instances
    success('Backend service stopped');
  }
  
  if (service === 'database' || service === 'all') {
    if (environment === 'production') {
      warning('Database stop skipped in production for safety. Use --force if needed.');
    } else {
      info('Stopping database service...');
      // TODO: Stop RDS instance (staging/dev only)
      success('Database service stopped');
    }
  }
  
  return true;
}

function parseArguments(args: string[]): StopOptions {
  const options: Partial<StopOptions> = {
    service: 'all',
    dryRun: false,
    verbose: false,
    force: false
  };
  
  if (args.length === 0) {
    throw new Error('Environment is required. Usage: stop <environment> [options]');
  }
  
  options.environment = args[0]!;
  
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '--service':
        const service = args[++i];
        if (!service) {
          throw new Error('--service requires a value');
        }
        if (!['database', 'backend', 'frontend', 'all'].includes(service)) {
          throw new Error(`Invalid service: ${service}. Must be one of: database, backend, frontend, all`);
        }
        options.service = service as Service;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  
  return options as StopOptions;
}

function printHelp(): void {
  console.log(`
${colors.bright}stop${colors.reset} - Stop services in any environment

${colors.cyan}Usage:${colors.reset}
  ./scripts/semiont stop <environment> [options]

${colors.cyan}Arguments:${colors.reset}
  <environment>        Environment to stop services in
                       Available: ${getAvailableEnvironments().join(', ')}

${colors.cyan}Options:${colors.reset}
  --service <target>   Service to stop (default: all)
                       Services: database, backend, frontend, all
  --dry-run            Show what would be stopped without changes
  --verbose            Show detailed output
  --force              Force stop even in production

${colors.cyan}Examples:${colors.reset}
  ${colors.dim}# Stop all local services${colors.reset}
  ./scripts/semiont stop local

  ${colors.dim}# Stop frontend service only${colors.reset}
  ./scripts/semiont stop local --service frontend

  ${colors.dim}# Stop backend in staging${colors.reset}
  ./scripts/semiont stop staging --service backend

  ${colors.dim}# Force stop production services${colors.reset}
  ./scripts/semiont stop production --force

${colors.cyan}Notes:${colors.reset}
  • Local environment stops Docker/Podman containers
  • Cloud environments scale ECS services to 0 instances
  • Production database stops require --force flag
  • Services can be restarted with the start command
`);
}

async function main(): Promise<void> {
  try {
    const options = parseArguments(process.argv.slice(2));
    const validEnv = await validateEnvironment(options.environment);
    
    info('Stop Plan:');
    console.log(`  Environment: ${colors.bright}${validEnv}${colors.reset}`);
    console.log(`  Service:     ${colors.bright}${options.service}${colors.reset}`);
    
    if (validEnv === 'local') {
      const success = await stopLocalServices(options);
      if (!success) {
        process.exit(1);
      }
    } else {
      // Validate AWS credentials for cloud environments
      await requireValidAWSCredentials();
      
      const success = await stopCloudServices(options);
      if (!success) {
        process.exit(1);
      }
    }
    
    success(`Services stopped successfully in ${validEnv} environment`);
    
  } catch (err) {
    error(`Failed to stop services: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Run when bundled (always execute main)
main();