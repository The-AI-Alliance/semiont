#!/usr/bin/env -S npx tsx

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { config } from '../config';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
// ECR functionality moved to update-images.ts
import { requireValidAWSCredentials } from './utils/aws-validation';

interface DeployOptions {
  target: 'infra' | 'app' | 'all';
  requireApproval?: boolean;
  verbose?: boolean;
  force?: boolean;
  destroy?: boolean;
}

// AWS SDK Clients
const region = config.aws.region;
const cloudFormationClient = new CloudFormationClient({ region });

function timestamp(): string {
  return new Date().toISOString();
}

function log(message: string): void {
  console.log(`[${timestamp()}] ${message}`);
}

async function runCommand(command: string[], cwd: string, description: string): Promise<boolean> {
  return new Promise((resolve) => {
    log(`🔨 ${description}...`);
    log(`💻 Working directory: ${path.resolve(cwd)}`);
    log(`💻 Command: ${command.join(' ')}`);
    
    const startTime = Date.now();
    const process: ChildProcess = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: 'inherit',
      shell: true
    });

    process.on('close', (code: number | null) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        log(`✅ ${description} completed in ${duration}ms`);
      } else {
        log(`❌ ${description} failed (exit code ${code}) after ${duration}ms`);
      }
      resolve(code === 0);
    });

    process.on('error', (error: Error) => {
      const duration = Date.now() - startTime;
      log(`❌ ${description} failed: ${error.message} after ${duration}ms`);
      resolve(false);
    });
  });
}

async function runCdkCommand(command: string[], cwd: string): Promise<boolean> {
  return runCommand(command, cwd, `CDK: ${command.join(' ')}`);
}

async function verifyStackExists(stackName: string): Promise<boolean> {
  log(`🔍 Verifying stack ${stackName} exists...`);
  
  try {
    const command = new DescribeStacksCommand({
      StackName: stackName
    });
    
    const response = await cloudFormationClient.send(command);
    const stack = response.Stacks?.[0];
    
    if (!stack) {
      log(`❌ CRITICAL: Stack ${stackName} was not created`);
      return false;
    }
    
    log(`✅ Stack ${stackName} verified - status: ${stack.StackStatus}`);
    return true;
  } catch (error) {
    log(`❌ CRITICAL: Stack ${stackName} was not created - ${error}`);
    return false;
  }
}


async function deployInfraStack(options: DeployOptions): Promise<boolean> {
  console.log(`📦 Deploying ${config.site.siteName} Infrastructure Stack...`);
  console.log('   Contains: VPC, RDS, EFS, Secrets Manager');
  
  // Validate AWS credentials early
  await requireValidAWSCredentials(region);
  
  const cdkPath = '../cdk';
  const approvalFlag = options.requireApproval ? '--require-approval' : '--require-approval=never';
  
  const command = ['cdk', 'deploy', 'SemiontInfraStack', approvalFlag];
  
  const deploySuccess = await runCdkCommand(command, cdkPath);
  if (!deploySuccess) {
    log(`❌ CDK deploy command failed for SemiontInfraStack`);
    return false;
  }
  
  // Verify the stack was actually created/updated
  const verifySuccess = await verifyStackExists('SemiontInfraStack');
  if (!verifySuccess) {
    log(`❌ CRITICAL: SemiontInfraStack deployment verification failed`);
    log(`💡 The CDK command reported success, but the stack doesn't exist in CloudFormation`);
    return false;
  }
  
  return true;
}

async function deployAppStack(options: DeployOptions): Promise<boolean> {
  log(`🏗️  Creating ${config.site.siteName} Application Stack...`);
  log('   Contains: ECS, ALB, WAF, CloudWatch');
  log('   Note: This creates infrastructure only. Use "./semiont update-images" to deploy application code.');
  
  // Validate AWS credentials early
  await requireValidAWSCredentials(region);
  
  const cdkPath = '../cdk';
  const approvalFlag = options.requireApproval ? '--require-approval' : '--require-approval=never';
  
  const command = ['cdk', 'deploy', 'SemiontAppStack', approvalFlag];
  
  // Add force flag if specified
  if (options.force) {
    command.push('--force');
  }
  
  const deploySuccess = await runCdkCommand(command, cdkPath);
  if (!deploySuccess) {
    log(`❌ CDK deploy command failed for SemiontAppStack`);
    return false;
  }
  
  // Verify the stack was actually created/updated
  const verifySuccess = await verifyStackExists('SemiontAppStack');
  if (!verifySuccess) {
    log(`❌ CRITICAL: SemiontAppStack deployment verification failed`);
    log(`💡 The CDK command reported success, but the stack doesn't exist in CloudFormation`);
    log(`💡 This often indicates a CDK configuration issue or silent failure`);
    return false;
  }
  
  return true;
}

async function checkPrerequisites(): Promise<boolean> {
  console.log('🔍 Checking deployment prerequisites...');
  
  // Check if CDK directory exists
  const fs = await import('fs');
  const path = await import('path');
  
  const cdkPath = path.resolve('../cdk');
  if (!fs.existsSync(cdkPath)) {
    console.error('❌ CDK directory not found at ../cdk');
    return false;
  }
  
  // Check if package.json exists
  const packageJsonPath = path.join(cdkPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    console.error('❌ CDK package.json not found');
    return false;
  }
  
  // Check if node_modules exists (dependencies installed)
  const nodeModulesPath = path.join(cdkPath, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    console.log('📦 Installing CDK dependencies...');
    const installSuccess = await runCdkCommand(['npm', 'install'], cdkPath);
    if (!installSuccess) {
      console.error('❌ Failed to install CDK dependencies');
      return false;
    }
  }
  
  // Build CDK TypeScript to ensure JavaScript is up-to-date
  console.log('🔨 Building CDK TypeScript...');
  const buildSuccess = await runCdkCommand(['npm', 'run', 'build'], cdkPath);
  if (!buildSuccess) {
    console.error('❌ Failed to build CDK TypeScript');
    console.error('💡 This may happen if there are TypeScript errors in the CDK code');
    return false;
  }
  
  console.log('✅ Prerequisites check passed');
  return true;
}

async function showDeploymentStatus() {
  console.log('\n📊 Post-deployment status:');
  console.log('💡 Check deployment status with: ./semiont status');
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
  console.log('   • Use "./semiont update-images" after this to deploy application code');
  console.log('   • Stack creation typically takes 5-15 minutes');
  console.log('   • Use "./semiont status" to monitor progress');
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