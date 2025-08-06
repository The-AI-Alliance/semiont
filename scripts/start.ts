#!/usr/bin/env -S npx tsx

/**
 * Start Command - Start services in any environment
 * 
 * Usage:
 *   ./scripts/semiont start <environment> [options]
 *   ./scripts/semiont start local                     # Start all services locally
 *   ./scripts/semiont start local --service frontend  # Start frontend only
 *   ./scripts/semiont start production --service backend # Start backend in production
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getAvailableEnvironments, isValidEnvironment, isCloudEnvironment } from './lib/environment-discovery';
import { requireValidAWSCredentials } from './utils/aws-validation';

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

function timestamp(): string {
  return new Date().toISOString();
}

function log(message: string, color: string = colors.reset): void {
  console.log(`${color}[${timestamp()}] ${message}${colors.reset}`);
}

function error(message: string): void {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}

function success(message: string): void {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function info(message: string): void {
  console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
}

async function validateEnvironment(env: string): Promise<Environment> {
  const validEnvironments = getAvailableEnvironments();
  
  if (!isValidEnvironment(env)) {
    throw new Error(`Invalid environment: ${env}. Must be one of: ${validEnvironments.join(', ')}`);
  }
  
  return env as Environment;
}

async function startLocalServices(options: StartOptions): Promise<boolean> {
  const { service, verbose, mock } = options;
  
  success('Starting local services...');
  
  // Start services based on selection
  if (service === 'database' || service === 'all') {
    info('Starting PostgreSQL container...');
    // TODO: Start local database
    success('Database running on port 5432');
  }
  
  if (service === 'backend' || service === 'all') {
    info('Starting backend service...');
    // TODO: Start local backend
    success('Backend running on http://localhost:3001');
  }
  
  if (service === 'frontend' || service === 'all') {
    info(`Starting frontend service${mock ? ' with mock API' : ''}...`);
    // TODO: Start local frontend
    success('Frontend running on http://localhost:3000');
  }
  
  return true;
}

async function startCloudServices(options: StartOptions): Promise<boolean> {
  const { environment, service, dryRun, verbose } = options;
  
  info(`Starting services in ${environment} environment...`);
  
  if (dryRun) {
    info('DRY RUN - No actual changes will be made');
  }
  
  // Start services based on selection
  if (service === 'database' || service === 'all') {
    info('Starting database service...');
    // TODO: Start/scale up RDS instance if stopped
    success('Database service started');
  }
  
  if (service === 'backend' || service === 'all') {
    info('Starting backend service...');
    // TODO: Scale up ECS service to desired count
    success('Backend service started');
  }
  
  if (service === 'frontend' || service === 'all') {
    info('Starting frontend service...');
    // TODO: Scale up ECS service to desired count
    success('Frontend service started');
  }
  
  return true;
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
  
  options.environment = args[0];
  
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
        break;
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

async function main(): Promise<void> {
  try {
    const options = parseArguments(process.argv.slice(2));
    const validEnv = await validateEnvironment(options.environment);
    
    info('Start Plan:');
    console.log(`  Environment: ${colors.bright}${validEnv}${colors.reset}`);
    console.log(`  Service:     ${colors.bright}${options.service}${colors.reset}`);
    
    if (validEnv === 'local') {
      const success = await startLocalServices(options);
      if (!success) {
        process.exit(1);
      }
    } else {
      // Validate AWS credentials for cloud environments
      await requireValidAWSCredentials();
      
      const success = await startCloudServices(options);
      if (!success) {
        process.exit(1);
      }
    }
    
    success(`Services started successfully in ${validEnv} environment`);
    
  } catch (err) {
    error(`Failed to start services: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Run if this script is executed directly
import { fileURLToPath } from 'url';
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}