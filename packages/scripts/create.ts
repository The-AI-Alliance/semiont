
import { config } from '@semiont/config-loader';
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

const region = config.aws.region;



async function deployInfraStack(options: DeployOptions): Promise<boolean> {
  // Validate AWS credentials early
  await requireValidAWSCredentials(region);
  
  const deployer = new CdkDeployer(config);
  try {
    const success = await deployer.deployInfraStack(options);
    return success;
  } finally {
    deployer.cleanup();
  }
}

async function deployAppStack(options: DeployOptions): Promise<boolean> {
  // Validate AWS credentials early
  await requireValidAWSCredentials(region);
  
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

async function create(options: DeployOptions) {
  console.log(`🚀 Starting ${config.site.siteName} stack creation...`);
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
        success = await deployInfraStack(options);
        break;
        
      case 'app':
        success = await deployAppStack(options);
        break;
        
      case 'all':
        console.log('📚 Deploying both stacks (infra first, then app)...');
        
        const infraSuccess = await deployInfraStack(options);
        if (!infraSuccess) {
          console.error('❌ Infrastructure deployment failed');
          success = false;
          break;
        }
        
        console.log('✅ Infrastructure deployment completed');
        console.log('');
        
        const appSuccess = await deployAppStack(options);
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
      console.log(`🌐 Your site should be available at: https://${config.site.domain}`);
      
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
  console.log(`🚀 ${config.site.siteName} Stack Creation Tool`);
  console.log('');
  console.log('Usage: npx tsx create.ts [target] [options]');
  console.log('   or: ./semiont create [target] [options]');
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
  console.log('   ./semiont create                 # Create both stacks');
  console.log('   ./semiont create infra           # Create infrastructure only');
  console.log('   ./semiont create app             # Create application stack only');
  console.log('   ./semiont create app --force     # Force CDK deployment');
  console.log('   ./semiont create all --approval  # Create with manual approval');
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
  
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }
  
  // Find the target (first non-flag argument)
  const nonFlagArgs = args.filter(arg => !arg.startsWith('--'));
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
  
  await create({
    target,
    requireApproval,
    verbose,
    force
  });
}

main().catch(console.error);