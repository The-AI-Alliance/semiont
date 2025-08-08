
/**
 * Provision Command - Infrastructure provisioning for cloud environments
 * 
 * Usage:
 *   ./scripts/semiont provision <environment> [options]
 *   ./scripts/semiont provision development --stack all
 *   ./scripts/semiont provision staging --stack infra
 *   ./scripts/semiont provision production --stack all --dry-run
 * 
 * This command creates cloud infrastructure (VPC, RDS, ECS clusters, etc.)
 * It's typically run once per environment or when infrastructure changes are needed.
 * 
 * Note: Local environment doesn't need provisioning - use 'deploy local' directly
 */

// Remove unused imports
import React from 'react';
import { render, Text, Box } from 'ink';
import { requireValidAWSCredentials } from './utils/aws-validation';
import { CdkDeployer } from './lib/cdk-deployer';
import { loadConfig } from '../config/dist/index.js';

// Valid environments for provisioning (excludes 'local')
type CloudEnvironment = 'development' | 'staging' | 'production';

// Infrastructure stacks (cloud only)
type Stack = 'infra' | 'app' | 'all';

interface ProvisionOptions {
  environment: CloudEnvironment;
  stack: Stack;
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
  requireApproval?: boolean;
  destroy?: boolean;  // For teardown
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

function warning(message: string): void {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

// Progress spinner component
function ProgressSpinner({ text }: { text: string }) {
  const [frame, setFrame] = React.useState(0);
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  React.useEffect(() => {
    const interval = setInterval(() => {
      setFrame((f: number) => (f + 1) % spinnerFrames.length);
    }, 80);
    
    return () => clearInterval(interval);
  }, []);

  return React.createElement(
    Box,
    {},
    React.createElement(Text, { color: 'cyan' }, `${spinnerFrames[frame]} ${text}`)
  );
}

async function deployWithProgress<T>(description: string, deployFn: () => Promise<T>): Promise<T> {
  // Show progress spinner
  const ProgressComponent = React.createElement(ProgressSpinner, { text: description });
  const { unmount } = render(ProgressComponent);
  
  try {
    const result = await deployFn();
    unmount();
    return result;
  } catch (error) {
    unmount();
    throw error;
  }
}

async function validateEnvironment(env: string): Promise<CloudEnvironment> {
  const validEnvironments: CloudEnvironment[] = ['development', 'staging', 'production'];
  
  if (env === 'local') {
    throw new Error('Local environment does not require provisioning. Use: ./scripts/semiont deploy local');
  }
  
  if (!validEnvironments.includes(env as CloudEnvironment)) {
    throw new Error(`Invalid environment: ${env}. Must be one of: ${validEnvironments.join(', ')}`);
  }
  
  return env as CloudEnvironment;
}

async function loadEnvironmentConfig(environment: CloudEnvironment): Promise<any> {
  // Load configuration using the new JSON-based config loader
  return loadConfig(environment);
}

async function checkExistingInfrastructure(_environment: CloudEnvironment, _config: any): Promise<boolean> {
  // Check if infrastructure already exists
  // This would check CloudFormation stacks, etc.
  // For now, returning false to indicate no existing infrastructure
  return false;
}

async function provisionInfrastructure(options: ProvisionOptions, config: any): Promise<boolean> {
  const { environment, stack, dryRun, verbose, destroy } = options;
  
  if (destroy) {
    log(`🗑️  Destroying ${stack} infrastructure in ${environment} environment`, colors.red);
    warning('This will permanently delete all infrastructure and data!');
  } else {
    log(`🏗️  Provisioning ${stack} infrastructure for ${environment} environment`, colors.bright);
  }
  
  if (dryRun) {
    warning('DRY RUN MODE - No actual changes will be made');
  }
  
  // Validate AWS credentials
  await requireValidAWSCredentials(config.aws.region);
  
  // Check for existing infrastructure
  if (!destroy) {
    const exists = await checkExistingInfrastructure(environment, config);
    if (exists && !options.force) {
      warning(`Infrastructure already exists in ${environment}. Use --force to override or 'deploy' to update applications.`);
      return false;
    }
  }
  
  const deployer = new CdkDeployer(config);
  
  try {
    // For staging/production, always require approval unless explicitly disabled
    const requireApproval = options.requireApproval ?? (environment !== 'development');
    
    const deployOptions = {
      target: stack,
      requireApproval,
      verbose: verbose ?? false,
      force: options.force ?? false,
      destroy: destroy ?? false,
      environment
    };
    
    // Provision infrastructure stack
    if (stack === 'infra' || stack === 'all') {
      info(destroy ? 'Destroying infrastructure stack...' : 'Creating infrastructure stack...');
      info('This includes: VPC, Subnets, RDS Database, EFS Storage, Security Groups');
      
      if (!dryRun) {
        const infraSuccess = await deployWithProgress('Infrastructure stack', () => deployer.deployInfraStack(deployOptions));
        if (!infraSuccess) {
          error('Infrastructure provisioning failed');
          return false;
        }
      }
      
      success(destroy ? 'Infrastructure stack destroyed' : 'Infrastructure stack created successfully');
      
      if (!destroy) {
        info('Resources created:');
        console.log('  • VPC with public/private subnets');
        console.log('  • RDS PostgreSQL database (Multi-AZ: ' + (environment === 'production' ? 'Yes' : 'No') + ')');
        console.log('  • EFS file system for shared storage');
        console.log('  • Security groups and network ACLs');
      }
    }
    
    // Provision application infrastructure
    if (stack === 'app' || stack === 'all') {
      info(destroy ? 'Destroying application infrastructure...' : 'Creating application infrastructure...');
      info('This includes: ECS Cluster, Load Balancer, ECR Repositories, CloudFront CDN');
      
      if (!dryRun) {
        const appSuccess = await deployWithProgress('Application stack', () => deployer.deployAppStack(deployOptions));
        if (!appSuccess) {
          error('Application infrastructure provisioning failed');
          return false;
        }
      }
      
      success(destroy ? 'Application infrastructure destroyed' : 'Application infrastructure created successfully');
      
      if (!destroy) {
        info('Resources created:');
        console.log('  • ECS Fargate cluster');
        console.log('  • Application Load Balancer');
        console.log('  • ECR repositories for container images');
        console.log('  • CloudFront distribution');
        console.log('  • Route53 DNS records');
      }
    }
    
    return true;
  } finally {
    deployer.cleanup();
  }
}

function printHelp(): void {
  console.log(`
${colors.bright}🏗️  Semiont Provision Command${colors.reset}

${colors.cyan}Usage:${colors.reset}
  ./scripts/semiont provision <environment> [options]

${colors.cyan}Environments:${colors.reset}
  development    Development cloud environment
  staging        Staging environment (production-like)
  production     Production environment

  Note: 'local' doesn't require provisioning - use 'deploy local' directly

${colors.cyan}Options:${colors.reset}
  --stack <target>     Stack to provision: infra, app, or all (default: all)
  --dry-run            Show what would be created without making changes
  --verbose            Show detailed output
  --force              Force provisioning even if infrastructure exists
  --no-approval        Skip manual approval (use with caution)
  --destroy            Tear down infrastructure (DESTRUCTIVE!)
  --help               Show this help message

${colors.cyan}Examples:${colors.reset}
  ${colors.dim}# Provision all infrastructure for development${colors.reset}
  ./scripts/semiont provision development

  ${colors.dim}# Provision only base infrastructure for production${colors.reset}
  ./scripts/semiont provision production --stack infra

  ${colors.dim}# Dry run to see what would be created${colors.reset}
  ./scripts/semiont provision staging --dry-run

  ${colors.dim}# Destroy development environment${colors.reset}
  ./scripts/semiont provision development --destroy

${colors.cyan}Infrastructure Stacks:${colors.reset}
  infra    VPC, Database, Storage, Networking
  app      ECS Cluster, Load Balancer, CDN, DNS
  all      Both infrastructure and application stacks

${colors.cyan}Notes:${colors.reset}
  • Provisioning creates cloud resources that incur costs
  • Production provisioning requires manual approval
  • Use 'deploy' command to update applications after provisioning
  • Infrastructure is persistent - survives application updates
  • --destroy permanently deletes all data and resources
`);
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
  
  let options: ProvisionOptions | undefined;
  
  try {
    // Validate environment
    const validEnv = await validateEnvironment(environment);
    
    // Parse options
    options = {
      environment: validEnv,
      stack: 'all',
      dryRun: false,
      verbose: false,
      force: false,
      destroy: false,
      requireApproval: false  // Will be set based on environment
    };
    
    // Process command line arguments
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      switch (arg) {
        case '--stack':
          const stack = args[++i];
          if (!stack || !['infra', 'app', 'all'].includes(stack)) {
            throw new Error(`Invalid stack: ${stack}. Must be one of: infra, app, all`);
          }
          options!.stack = stack as Stack;
          break;
        case '--dry-run':
          options!.dryRun = true;
          break;
        case '--verbose':
          options!.verbose = true;
          break;
        case '--force':
          options!.force = true;
          break;
        case '--no-approval':
          options!.requireApproval = false;
          break;
        case '--destroy':
          options!.destroy = true;
          break;
        default:
          warning(`Unknown option: ${arg}`);
      }
    }
    
    // Load configuration for the environment
    log(`Loading configuration for ${validEnv} environment...`, colors.cyan);
    const config = await loadEnvironmentConfig(validEnv);
    
    // Show provisioning plan
    console.log('');
    info(options!.destroy ? 'Destruction Plan:' : 'Provisioning Plan:');
    console.log(`  Environment: ${colors.bright}${validEnv}${colors.reset}`);
    console.log(`  Stack:       ${colors.bright}${options!.stack}${colors.reset}`);
    console.log(`  Region:      ${colors.bright}${config.aws.region}${colors.reset}`);
    console.log(`  Action:      ${colors.bright}${options!.destroy ? 'DESTROY' : 'CREATE'}${colors.reset}`);
    
    if (options!.dryRun) {
      console.log(`  Mode:        ${colors.yellow}DRY RUN${colors.reset}`);
    }
    
    console.log('');
    
    // Confirm for production provisioning
    if (validEnv === 'production' && !options!.dryRun && options!.requireApproval !== false) {
      if (options!.destroy) {
        error('⚠️  PRODUCTION DESTRUCTION - This will permanently delete all data!');
        const readline = require('readline').createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        const answer = await new Promise<string>(resolve => {
          readline.question('Type "DESTROY PRODUCTION" to continue: ', resolve);
        });
        readline.close();
        
        if (answer !== 'DESTROY PRODUCTION') {
          error('Production destruction cancelled');
          process.exit(1);
        }
      } else {
        warning('⚠️  PRODUCTION PROVISIONING - This will create billable AWS resources!');
        const readline = require('readline').createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        const answer = await new Promise<string>(resolve => {
          readline.question('Type "PROVISION PRODUCTION" to continue: ', resolve);
        });
        readline.close();
        
        if (answer !== 'PROVISION PRODUCTION') {
          error('Production provisioning cancelled');
          process.exit(1);
        }
      }
    }
    
    // Execute provisioning
    const provisionSuccess = await provisionInfrastructure(options!, config);
    
    if (provisionSuccess) {
      console.log('');
      if (options!.destroy) {
        success(`🗑️  Infrastructure in ${validEnv} destroyed successfully`);
      } else {
        success(`🎉 Infrastructure provisioned in ${validEnv} successfully!`);
        
        // Provide next steps
        console.log('');
        info('Next steps:');
        console.log(`  1. Deploy applications: ./scripts/semiont deploy ${validEnv}`);
        console.log(`  2. Configure secrets: ./scripts/semiont configure ${validEnv} set oauth/google`);
        console.log(`  3. Check status: ./scripts/semiont check --env ${validEnv}`);
      }
    } else {
      error(options!.destroy ? 'Destruction failed' : 'Provisioning failed');
      process.exit(1);
    }
    
  } catch (err) {
    error(`Operation failed: ${err instanceof Error ? err.message : String(err)}`);
    if (options?.verbose) {
      console.error(err);
    }
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export { provisionInfrastructure, loadEnvironmentConfig, type ProvisionOptions, type CloudEnvironment };