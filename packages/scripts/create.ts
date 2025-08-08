
import { loadConfig } from '@semiont/config-loader';
import { getAvailableEnvironments, isValidEnvironment } from './lib/environment-discovery';
import { requireValidAWSCredentials } from './utils/aws-validation';
import { CdkDeployer } from './lib/cdk-deployer';
import * as fs from 'fs';
import * as path from 'path';

interface DeployOptions {
  target: 'infra' | 'app' | 'all';
  requireApproval?: boolean;
  verbose?: boolean;
  force?: boolean;
  destroy?: boolean;
}




async function deployInfraStack(environment: string, options: DeployOptions): Promise<boolean> {
  const config = loadConfig(environment);
  // Validate AWS credentials early
  await requireValidAWSCredentials(config.aws.region);
  
  const deployer = new CdkDeployer(config);
  try {
    const success = await deployer.deployInfraStack(options);
    return success;
  } finally {
    deployer.cleanup();
  }
}

async function deployAppStack(environment: string, options: DeployOptions): Promise<boolean> {
  const config = loadConfig(environment);
  // Validate AWS credentials early
  await requireValidAWSCredentials(config.aws.region);
  
  const deployer = new CdkDeployer(config);
  try {
    const success = await deployer.deployAppStack(options);
    return success;
  } finally {
    deployer.cleanup();
  }
}

async function checkPrerequisites(): Promise<boolean> {
  console.log('🔍 Checking deployment prerequisites...');
  
  // Check if CDK library directory exists (for stack classes)
  const cdkPath = path.resolve('../config/cdk');
  if (!fs.existsSync(cdkPath)) {
    console.error('❌ CDK directory not found at ../config/cdk');
    return false;
  }
  
  // Check if stack files exist
  const infraStackPath = path.join(cdkPath, 'lib', 'infra-stack.ts');
  const appStackPath = path.join(cdkPath, 'lib', 'app-stack.ts');
  
  if (!fs.existsSync(infraStackPath)) {
    console.error('❌ Infrastructure stack file not found');
    return false;
  }
  
  if (!fs.existsSync(appStackPath)) {
    console.error('❌ Application stack file not found');
    return false;
  }
  
  console.log('✅ Prerequisites check passed');
  return true;
}

async function showDeploymentStatus() {
  console.log('\n📊 Post-deployment status:');
  console.log('💡 Check deployment status with: ./semiont check');
}

async function create(environment: string, options: DeployOptions) {
  console.log(`🚀 Starting Semiont stack creation...`);
  console.log(`📋 Target: ${options.target}`);
  
  const startTime = Date.now();
  
  // Check prerequisites
  const prereqsOk = await checkPrerequisites();
  if (!prereqsOk) {
    console.error('❌ Prerequisites check failed');
    process.exit(1);
  }
  
  let success = true;
  
  try {
    switch (options.target) {
      case 'infra':
        success = await deployInfraStack(environment, options);
        break;
        
      case 'app':
        success = await deployAppStack(environment, options);
        break;
        
      case 'all':
        console.log('📚 Deploying both stacks (infra first, then app)...');
        
        const infraSuccess = await deployInfraStack(environment, options);
        if (!infraSuccess) {
          console.error('❌ Infrastructure deployment failed');
          success = false;
          break;
        }
        
        console.log('✅ Infrastructure deployment completed');
        console.log('');
        
        const appSuccess = await deployAppStack(environment, options);
        if (!appSuccess) {
          console.error('❌ Application deployment failed');
          success = false;
          break;
        }
        
        success = true;
        break;
        
      default:
        console.error(`❌ Unknown deployment target: ${options.target}`);
        success = false;
    }
    
    const duration = Math.round((Date.now() - startTime) / 1000);
    
    if (success) {
      console.log('');
      console.log('✅ Stack creation completed successfully!');
      console.log(`⏱️  Total time: ${Math.floor(duration / 60)}m ${duration % 60}s`);
      console.log(`🌐 Check your site status with: ./semiont check ${environment}`);
      
      await showDeploymentStatus();
    } else {
      console.log('');
      console.error('❌ Stack creation failed');
      console.log('💡 Check the error messages above for details');
      console.log('🔍 Common issues:');
      console.log('   • AWS credentials not configured');
      console.log('   • Insufficient IAM permissions');
      console.log('   • Resource limits exceeded');
      console.log('   • Stack dependencies not met');
      process.exit(1);
    }
    
  } catch (error: any) {
    console.error('❌ Stack creation error:', error.message);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`🚀 Semiont Stack Creation Tool`);
  console.log('');
  console.log('Usage: ./semiont create <environment> [target] [options]');
  console.log('');
  console.log('Arguments:');
  console.log(`   <environment>    Environment to create stacks for (${getAvailableEnvironments().join(', ')})`);
  console.log('');
  console.log('Targets:');
  console.log('   infra    Create infrastructure stack (VPC, RDS, EFS, Secrets)');
  console.log('   app      Create application stack (ECS, ALB, WAF)');
  console.log('   all      Create both stacks (default)');
  console.log('');
  console.log('Options:');
  console.log('   --approval      Require manual approval for changes');
  console.log('   --verbose       Show detailed output');
  console.log('   --force         Force CDK deployment (use with caution)');
  console.log('   --help, -h      Show this help');
  console.log('');
  console.log('Examples:');
  console.log('   ./semiont create production                 # Create both stacks for production');
  console.log('   ./semiont create staging infra             # Create infrastructure only for staging');
  console.log('   ./semiont create production app            # Create application stack only for production');
  console.log('   ./semiont create staging app --force       # Force CDK deployment for staging');
  console.log('   ./semiont create production all --approval # Create with manual approval for production');
  console.log('');
  console.log('Notes:');
  console.log('   • Infrastructure stack must exist before creating application stack');
  console.log('   • This only creates AWS infrastructure - no application code is deployed');
  console.log('   • Use "./semiont deploy <environment>" after this to deploy application code');
  console.log('   • Stack creation typically takes 5-15 minutes');
  console.log('   • Use "./semiont check" to monitor progress');
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }
  
  const environment = args[0];
  if (!environment) {
    console.error('❌ Environment is required');
    showHelp();
    process.exit(1);
  }
  
  if (!isValidEnvironment(environment)) {
    console.error(`❌ Invalid environment: ${environment}`);
    console.log(`💡 Available environments: ${getAvailableEnvironments().join(', ')}`);
    process.exit(1);
  }
  
  // Find the target (second non-flag argument)
  const nonFlagArgs = args.slice(1).filter(arg => !arg.startsWith('--'));
  const target = (nonFlagArgs[0] as 'infra' | 'app' | 'all') || 'all';
  
  const requireApproval = args.includes('--approval');
  const verbose = args.includes('--verbose');
  const force = args.includes('--force');
  
  if (!['infra', 'app', 'all'].includes(target)) {
    console.error(`❌ Invalid target: ${target}`);
    console.log('💡 Valid targets: infra, app, all');
    console.log('💡 Use --help for more information');
    process.exit(1);
  }
  
  await create(environment, {
    target,
    requireApproval,
    verbose,
    force
  });
}

main().catch(console.error);