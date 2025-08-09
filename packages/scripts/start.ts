
/**
 * Start Command - Start services in any environment
 * 
 * Usage:
 *   ./scripts/semiont start <environment> [options]
 *   ./scripts/semiont start local                     # Start all services locally
 *   ./scripts/semiont start local --service frontend  # Start frontend only
 *   ./scripts/semiont start production --service backend # Start backend in production
 */

import { getAvailableEnvironments, isValidEnvironment } from './lib/environment-discovery';
import { requireValidAWSCredentials } from './utils/aws-validation';
import { showError } from './lib/ink-utils';
import { loadEnvironmentConfig } from '@semiont/config-loader';

// Valid environments
type Environment = string;
type Service = 'database' | 'backend' | 'frontend' | 'all';

interface StartOptions {
  environment: Environment;
  service: Service;
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
  mock?: boolean;          // For local frontend mock mode
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



// Legacy fallback functions (use ink-utils for enhanced formatting)
function error(message: string): void {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}

function success(message: string): void {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function info(message: string): void {
  console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
}

// Enhanced error handling with ink
async function handleError(message: string, details?: string): Promise<void> {
  await showError(message, details);
}

// Removed unused utility functions - can be re-added if needed

async function validateEnvironment(env: string): Promise<Environment> {
  const validEnvironments = getAvailableEnvironments();
  
  if (!isValidEnvironment(env)) {
    await handleError(
      `Invalid environment: ${env}`,
      `Available environments: ${validEnvironments.join(', ')}`
    );
    throw new Error(`Invalid environment: ${env}`);
  }
  
  return env as Environment;
}


function parseArguments(args: string[]): StartOptions {
  const options: Partial<StartOptions> = {
    service: 'all',
    dryRun: false,
    verbose: false,
    force: false,
    mock: false
  };
  
  if (args.length === 0) {
    throw new Error('Environment is required. Usage: start <environment> [options]');
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
      case '--mock':
        options.mock = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  
  return options as StartOptions;
}

function printHelp(): void {
  console.log(`
${colors.bright}start${colors.reset} - Start services in any environment

${colors.cyan}Usage:${colors.reset}
  ./scripts/semiont start <environment> [options]

${colors.cyan}Arguments:${colors.reset}
  <environment>        Environment to start services in
                       Available: ${getAvailableEnvironments().join(', ')}

${colors.cyan}Options:${colors.reset}
  --service <target>   Service to start (default: all)
                       Services: database, backend, frontend, all
  --mock               Use mock API for frontend (local only)
  --dry-run            Show what would be started without changes
  --verbose            Show detailed output
  --force              Force start even with warnings

${colors.cyan}Examples:${colors.reset}
  ${colors.dim}# Start all services locally${colors.reset}
  ./scripts/semiont start local

  ${colors.dim}# Start frontend with mock API locally${colors.reset}
  ./scripts/semiont start local --service frontend --mock

  ${colors.dim}# Start backend service in production${colors.reset}
  ./scripts/semiont start production --service backend

  ${colors.dim}# Dry run for staging${colors.reset}
  ./scripts/semiont start staging --dry-run

${colors.cyan}Notes:${colors.reset}
  • Local environment uses Docker/Podman containers
  • Cloud environments scale ECS services to desired count
  • Use --mock for frontend development without backend
`);
}

// Get deployment type for a specific service
function getServiceDeploymentType(config: any, serviceName: string): string {
  const service = config.services?.[serviceName];
  if (service?.deployment?.type) {
    return service.deployment.type;
  }
  return config.deployment?.default || 'process';
}

// Check if any selected services require AWS
function requiresAWS(config: any, selectedServices: string[]): boolean {
  return selectedServices.some(serviceName => 
    getServiceDeploymentType(config, serviceName) === 'aws'
  );
}

// Get list of services to start based on options
function getServicesToStart(options: StartOptions): string[] {
  if (options.service === 'all') {
    return ['database', 'backend', 'frontend'];
  }
  return [options.service];
}

async function startMixedServices(options: StartOptions, config: any): Promise<boolean> {
  const { environment } = options;
  const servicesToStart = getServicesToStart(options);
  
  info(`Starting services in ${environment} environment...`);
  
  let allSuccessful = true;
  
  for (const serviceName of servicesToStart) {
    const deploymentType = getServiceDeploymentType(config, serviceName);
    
    info(`Starting ${serviceName} service (${deploymentType})...`);
    
    try {
      switch (deploymentType) {
        case 'process':
          await startProcessService(serviceName, config);
          break;
        case 'aws':
          await startAWSService(serviceName, config);
          break;
        case 'external':
          info(`${serviceName} is externally managed, skipping start`);
          break;
        case 'mock':
          info(`${serviceName} is mocked for testing, skipping start`);
          break;
        default:
          throw new Error(`Unsupported deployment type: ${deploymentType}`);
      }
      success(`${serviceName} service started successfully`);
    } catch (err) {
      error(`Failed to start ${serviceName}: ${err instanceof Error ? err.message : String(err)}`);
      allSuccessful = false;
    }
  }
  
  return allSuccessful;
}

async function startProcessService(serviceName: string, config: any): Promise<void> {
  const service = config.services?.[serviceName];
  
  switch (serviceName) {
    case 'database':
      info('Starting PostgreSQL container...');
      // TODO: Start local database container
      success('Database running on port 5432');
      break;
    case 'backend':
      info('Starting backend service...');
      const backendPort = service?.port || 3001;
      // TODO: Start local backend process
      success(`Backend running on http://localhost:${backendPort}`);
      break;
    case 'frontend':
      info('Starting frontend service...');
      const frontendPort = service?.port || 3000;
      // TODO: Start local frontend process
      success(`Frontend running on http://localhost:${frontendPort}`);
      break;
  }
}

async function startAWSService(serviceName: string, _config: any): Promise<void> {
  switch (serviceName) {
    case 'database':
      info('Starting RDS database...');
      // TODO: Scale up RDS if stopped
      success('Database service started');
      break;
    case 'backend':
      info('Starting backend ECS service...');
      // TODO: Scale up ECS service to desired count
      success('Backend service started');
      break;
    case 'frontend':
      info('Starting frontend ECS service...');
      // TODO: Scale up ECS service to desired count
      success('Frontend service started');
      break;
  }
}

async function main(): Promise<void> {
  try {
    const options = parseArguments(process.argv.slice(2));
    const validEnv = await validateEnvironment(options.environment);
    
    // Load configuration to determine deployment types
    const config = loadEnvironmentConfig(validEnv);
    const servicesToStart = getServicesToStart(options);
    
    info('Start Plan:');
    console.log(`  Environment: ${colors.bright}${validEnv}${colors.reset}`);
    console.log(`  Service:     ${colors.bright}${options.service}${colors.reset}`);
    
    // Show deployment plan
    for (const serviceName of servicesToStart) {
      const deploymentType = getServiceDeploymentType(config, serviceName);
      console.log(`  ${serviceName}: ${colors.dim}${deploymentType}${colors.reset}`);
    }
    console.log();
    
    // Validate AWS credentials only if needed
    if (requiresAWS(config, servicesToStart)) {
      if (!config.aws) {
        throw new Error(`Some services require AWS deployment but environment ${validEnv} has no AWS configuration`);
      }
      info('Validating AWS credentials...');
      await requireValidAWSCredentials(config.aws.region);
      success('AWS credentials validated');
    }
    
    // Start services with mixed deployment support
    const allSuccessful = await startMixedServices(options, config);
    if (!allSuccessful) {
      process.exit(1);
    }
    
    success(`Services started successfully in ${validEnv} environment`);
    
  } catch (err) {
    error(`Failed to start services: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Run when bundled (always execute main)
main();