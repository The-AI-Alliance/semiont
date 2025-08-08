
/**
 * Restart Command - Restart services in any environment
 * 
 * Usage:
 *   ./scripts/semiont restart <environment> [options]
 *   ./scripts/semiont restart local                     # Restart all local services
 *   ./scripts/semiont restart production --service backend  # Restart backend in production
 *   ./scripts/semiont restart staging --service frontend    # Restart frontend in staging
 */

import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { SemiontStackConfig } from './lib/stack-config';
import { execSync } from 'child_process';
import { loadConfig } from '../config/dist/index.js';

// Types
type Environment = 'local' | 'development' | 'staging' | 'production';
type Service = 'database' | 'backend' | 'frontend' | 'all';

interface RestartOptions {
  environment: Environment;
  service: Service;
  verbose?: boolean;
}

// Color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

function log(message: string, color: string = colors.reset): void {
  console.log(`${color}${message}${colors.reset}`);
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

async function loadEnvironmentConfig(environment: Environment): Promise<any> {
  // Load configuration using the new JSON-based config loader
  return loadConfig(environment);
}

async function restartLocalService(service: Service): Promise<boolean> {
  log(`🔄 Restarting ${service} locally`, colors.bright);
  
  try {
    switch (service) {
      case 'database':
        info('Restarting PostgreSQL container...');
        execSync('docker restart semiont-postgres', { stdio: 'pipe' });
        success('Database service restarted');
        break;
        
      case 'backend':
        info('Backend restart requires manual intervention in local development');
        info('Stop the backend process (Ctrl+C) and run: npm run dev');
        break;
        
      case 'frontend':
        info('Frontend restart requires manual intervention in local development');
        info('Stop the frontend process (Ctrl+C) and run: npm run dev or npm run dev:mock');
        break;
        
      case 'all':
        const dbRestarted = await restartLocalService('database');
        await restartLocalService('backend');
        await restartLocalService('frontend');
        return dbRestarted;
    }
    return true;
  } catch (err) {
    error(`Failed to restart ${service}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function restartCloudService(service: Service, config: any, environment: Environment): Promise<boolean> {
  log(`🔄 Restarting ${service} in ${environment} environment`, colors.bright);
  
  try {
    const stackConfig = new SemiontStackConfig();
    const ecsClient = new ECSClient({ region: config.aws.region });
    
    if (service === 'database' || service === 'all') {
      info('Database service runs on RDS - no restart needed');
      info('RDS automatically manages database availability');
    }
    
    if (service === 'backend' || service === 'all') {
      info('🚀 Restarting backend service...');
      const clusterName = await stackConfig.getClusterName();
      const serviceName = await stackConfig.getBackendServiceName();
      
      await ecsClient.send(
        new UpdateServiceCommand({
          cluster: clusterName,
          service: serviceName,
          forceNewDeployment: true,
        })
      );
      success('Backend restart initiated');
    }
    
    if (service === 'frontend' || service === 'all') {
      info('📱 Restarting frontend service...');
      const clusterName = await stackConfig.getClusterName();
      const serviceName = await stackConfig.getFrontendServiceName();
      
      await ecsClient.send(
        new UpdateServiceCommand({
          cluster: clusterName,
          service: serviceName,
          forceNewDeployment: true,
        })
      );
      success('Frontend restart initiated');
    }
    
    return true;
  } catch (err) {
    error(`Failed to restart ${service}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  // Check for help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  
  // Parse arguments
  const environment = args[0];
  if (!environment) {
    error('Environment is required');
    printHelp();
    process.exit(1);
  }
  
  // Validate environment
  const validEnvironments: Environment[] = ['local', 'development', 'staging', 'production'];
  if (!validEnvironments.includes(environment as Environment)) {
    error(`Invalid environment: ${environment}. Must be one of: ${validEnvironments.join(', ')}`);
    process.exit(1);
  }
  
  const validEnv = environment as Environment;
  
  // Parse options
  const options: RestartOptions = {
    environment: validEnv,
    service: 'all',
    verbose: false
  };
  
  // Process command line arguments
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
      case '--verbose':
        options.verbose = true;
        break;
      default:
        if (!arg || !arg.startsWith('-')) break;
        error(`Unknown option: ${arg}`);
    }
  }
  
  try {
    // Load configuration for the environment
    const config = await loadEnvironmentConfig(validEnv);
    
    // Show restart plan
    console.log('');
    info('Restart Plan:');
    console.log(`  Environment: ${colors.bright}${validEnv}${colors.reset}`);
    console.log(`  Service:     ${colors.bright}${options.service}${colors.reset}`);
    console.log('');
    
    // Execute restart
    let restartSuccess: boolean;
    if (validEnv === 'local') {
      restartSuccess = await restartLocalService(options.service);
    } else {
      restartSuccess = await restartCloudService(options.service, config, validEnv);
    }
    
    if (restartSuccess) {
      console.log('');
      if (validEnv === 'local') {
        console.log(`${colors.green}✅ Local service restart completed${colors.reset}`);
      } else {
        console.log(`${colors.green}✅ Service restart initiated in ${validEnv}${colors.reset}`);
        info('⏱️  Restart will take 2-3 minutes to complete');
        info(`Monitor progress: ./scripts/semiont watch logs`);
      }
    } else {
      error('Service restart failed');
      process.exit(1);
    }
    
  } catch (err) {
    error(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
    if (options.verbose) {
      console.error(err);
    }
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
${colors.bright}🔄 Semiont Restart Command${colors.reset}

${colors.cyan}Usage:${colors.reset}
  ./scripts/semiont restart <environment> [options]

${colors.cyan}Environments:${colors.reset}
  local          Local development services
  development    Development cloud services
  staging        Staging cloud services  
  production     Production cloud services

${colors.cyan}Options:${colors.reset}
  --service <name>     Service to restart: database, backend, frontend, all (default: all)
  --verbose            Show detailed output
  --help               Show this help message

${colors.cyan}Examples:${colors.reset}
  ${colors.reset}# Restart all services locally${colors.reset}
  ./scripts/semiont restart local

  ${colors.reset}# Restart backend in production${colors.reset}
  ./scripts/semiont restart production --service backend

  ${colors.reset}# Restart frontend in staging${colors.reset}
  ./scripts/semiont restart staging --service frontend

${colors.cyan}Notes:${colors.reset}
  • Local: Database containers restart immediately, dev servers need manual restart
  • Cloud: ECS services restart automatically, takes 2-3 minutes
  • Database service in cloud runs on RDS (managed, no restart needed)
`);
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export { restartLocalService, restartCloudService, type RestartOptions, type Environment, type Service };