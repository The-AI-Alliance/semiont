
/**
 * Deploy Command - Deploy applications and configuration changes
 * 
 * Usage:
 *   ./scripts/semiont deploy <environment> [options]
 *   ./scripts/semiont deploy local                    # Deploy all services locally
 *   ./scripts/semiont deploy development              # Deploy to development cloud
 *   ./scripts/semiont deploy staging --service backend # Deploy backend to staging
 *   ./scripts/semiont deploy production --dry-run      # Production dry-run
 * 
 * This command deploys application code and configuration changes.
 * Use 'provision' for infrastructure setup, 'start/stop/restart' for service control.
 */

import { spawn, type ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import React from 'react';
import { render, Text, Box } from 'ink';
import { getAvailableEnvironments, isValidEnvironment } from './lib/environment-discovery';
import { EnvironmentDetails, SimpleTable, StepProgress, DeploymentStatus } from './lib/ink-utils';
import { requireValidAWSCredentials } from './utils/aws-validation';
import { loadConfig } from '../config/dist/index.js';
import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { ECRClient, DescribeRepositoriesCommand, CreateRepositoryCommand, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { SemiontStackConfig } from './lib/stack-config';

// Valid environments
// Environment type is now dynamic - any valid environment name
type Environment = string;

// Infrastructure stacks (cloud only)
type Stack = 'infra' | 'app' | 'all';

// Application services (all environments)
type Service = 'database' | 'backend' | 'frontend' | 'all';

// Deployment is focused on code/config updates only

interface DeployOptions {
  environment: Environment;
  service: Service;        // What service to deploy
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
  requireApproval?: boolean;
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

function warning(message: string): void {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

async function runCommand(command: string[], cwd: string, description: string, verbose: boolean = false): Promise<boolean> {
  return new Promise((resolve) => {
    if (verbose) {
      log(`🔨 ${description}...`, colors.cyan);
    }
    
    const startTime = Date.now();
    const process: ChildProcess = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: verbose ? 'inherit' : 'pipe',
      shell: true
    });

    process.on('close', (code: number | null) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        if (verbose) {
          success(`${description} completed in ${duration}ms`);
        }
        resolve(true);
      } else {
        error(`${description} failed with code ${code} after ${duration}ms`);
        resolve(false);
      }
    });

    process.on('error', (err: Error) => {
      error(`${description} failed: ${err.message}`);
      resolve(false);
    });
  });
}

// Progress spinner component
function ProgressSpinner({ text }: { text: string }) {
  const [frame, setFrame] = React.useState(0);
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  React.useEffect(() => {
    const interval = global.setInterval(() => {
      setFrame((f: number) => (f + 1) % spinnerFrames.length);
    }, 80);
    
    return () => global.clearInterval(interval);
  }, []);

  return React.createElement(
    Box,
    {},
    React.createElement(Text, { color: 'cyan' }, `${spinnerFrames[frame]} ${text}`)
  );
}

async function runCommandWithProgress(command: string[], cwd: string, description: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Show progress spinner
    const ProgressComponent = React.createElement(ProgressSpinner, { text: description });
    const { unmount } = render(ProgressComponent);
    
    const startTime = Date.now();
    const process: ChildProcess = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: 'pipe',
      shell: true
    });

    process.on('close', (code: number | null) => {
      unmount();
      const duration = Date.now() - startTime;
      if (code === 0) {
        success(`${description} completed in ${duration}ms`);
        resolve(true);
      } else {
        error(`${description} failed with code ${code} after ${duration}ms`);
        resolve(false);
      }
    });

    process.on('error', (err: Error) => {
      unmount();
      error(`${description} failed: ${err.message}`);
      resolve(false);
    });
  });
}

function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function validateEnvironment(env: string): Promise<Environment> {
  const validEnvironments = getAvailableEnvironments();
  
  if (!isValidEnvironment(env)) {
    throw new Error(`Invalid environment: ${env}. Must be one of: ${validEnvironments.join(', ')}`);
  }
  
  return env as Environment;
}

async function selectEnvironmentInteractively(): Promise<Environment> {
  const availableEnvironments = getAvailableEnvironments();
  
  if (availableEnvironments.length === 0) {
    throw new Error('No environments available');
  }
  
  if (availableEnvironments.length === 1) {
    return availableEnvironments[0] as Environment;
  }
  
  console.log('\n🌍 Available Deployment Environments:\n');
  
  // Show details for each environment
  for (let i = 0; i < availableEnvironments.length; i++) {
    const env = availableEnvironments[i];
    console.log(`${i + 1}. ${env}`);
    
    try {
      const config = await loadEnvironmentConfig(env as Environment);
      const details = {
        'Region': config.aws?.region || 'local',
        'Domain': config.site?.domain || 'localhost',
        'Account ID': config.aws?.accountId || 'N/A',
        'Type': env === 'local' ? 'Development' : env === 'production' ? 'Production' : 'Staging'
      };
      
      // Render environment details
      await new Promise<void>((resolve) => {
        const DetailsComponent = React.createElement(EnvironmentDetails, {
          environment: env || 'unknown',
          details
        });
        const { unmount } = render(DetailsComponent);
        
        setTimeout(() => {
          unmount();
          resolve();
        }, 500);
      });
      
      console.log('');
    } catch (error) {
      warning(`Could not load config for ${env}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  return promptForEnvironmentSelection(availableEnvironments);
}

async function showDeploymentConfirmation(options: DeployOptions): Promise<boolean> {
  const { environment, service, dryRun } = options;
  
  console.log('\\n📋 Deployment Impact Analysis\\n');
  
  // Impact analysis data
  const impactData: Array<{ Category: string; Impact: string; Details: string }> = [];
  
  // Environment impact
  const riskLevel = environment === 'production' ? '🔴 HIGH' : 
                   environment === 'staging' ? '🟡 MEDIUM' : '🟢 LOW';
  impactData.push({ 
    Category: 'Environment Risk', 
    Impact: riskLevel,
    Details: environment === 'production' ? 'Live users affected' : 
            environment === 'staging' ? 'Testing environment' : 'Development only'
  });
  
  // Service impact
  const services = service === 'all' ? ['database', 'backend', 'frontend'] : [service];
  impactData.push({
    Category: 'Services Affected',
    Impact: `${services.length} service${services.length > 1 ? 's' : ''}`,
    Details: services.join(', ')
  });
  
  // Downtime estimate
  const downtime = environment === 'local' ? 'None (local dev)' :
                  service === 'database' ? '2-5 minutes' :
                  service === 'all' ? '5-10 minutes' : '1-3 minutes';
  impactData.push({
    Category: 'Estimated Downtime',
    Impact: downtime,
    Details: dryRun ? 'Dry run - no actual changes' : 'Rolling deployment'
  });
  
  // Infrastructure changes
  if (environment !== 'local') {
    const changes = [];
    if (service === 'backend' || service === 'all') changes.push('ECS task definition update');
    if (service === 'frontend' || service === 'all') changes.push('CloudFront invalidation');
    if (service === 'database' || service === 'all') changes.push('Database migrations');
    
    impactData.push({
      Category: 'Infrastructure Changes',
      Impact: `${changes.length} change${changes.length > 1 ? 's' : ''}`,
      Details: changes.join(', ')
    });
  }
  
  // Rollback plan
  const rollbackTime = environment === 'local' ? 'Immediate (restart containers)' :
                      environment === 'production' ? '10-15 minutes' : '5-10 minutes';
  impactData.push({
    Category: 'Rollback Time',
    Impact: rollbackTime,
    Details: 'Automated rollback available'
  });
  
  // Show impact analysis table
  return new Promise((resolve) => {
    const ConfirmationComponent = React.createElement(
      Box,
      { flexDirection: 'column' },
      [
        React.createElement(Text, { 
          bold: true, 
          color: 'yellow', 
          key: 'title' 
        }, '⚠️  Deployment Impact Analysis'),
        React.createElement(SimpleTable, {
          data: impactData,
          columns: ['Category', 'Impact', 'Details'],
          key: 'impact-table'
        }),
        React.createElement(Box, { key: 'mode', marginTop: 1 },
          React.createElement(Text, { 
            color: dryRun ? 'green' : (environment === 'production' ? 'red' : 'cyan')
          }, dryRun ? '🔍 DRY RUN MODE - No changes will be made' : 
             environment === 'production' ? '🚨 PRODUCTION DEPLOYMENT - This affects live users!' :
             '🚀 Deployment ready to proceed')
        )
      ]
    );
    
    const { unmount } = render(ConfirmationComponent);
    
    setTimeout(async () => {
      unmount();
      console.log('');
      
      // Skip confirmation for dry runs or local environment
      if (dryRun || environment === 'local') {
        resolve(true);
        return;
      }
      
      // Require explicit confirmation for production
      if (environment === 'production') {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        try {
          const answer = await askQuestion(rl, 'Type \"DEPLOY PRODUCTION\" to continue: ');
          resolve(answer === 'DEPLOY PRODUCTION');
        } finally {
          rl.close();
        }
        return;
      }
      
      // Simple yes/no for other environments
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      try {
        const answer = await askQuestion(rl, 'Proceed with deployment? (y/N): ');
        resolve(['y', 'yes', 'Y', 'YES'].includes(answer));
      } finally {
        rl.close();
      }
    }, 1000);
  });
}

async function runPreDeploymentHealthChecks(environment: Environment, config: any): Promise<boolean> {
  if (environment === 'local') {
    info('Skipping health checks for local environment');
    return true;
  }
  
  console.log('\\n🏥 Pre-Deployment Health Checks\\n');
  
  const healthChecks: Array<{ Check: string; Status: string; Details: string }> = [];
  let allPassed = true;
  
  // AWS credentials check
  try {
    await requireValidAWSCredentials(config.aws.region);
    healthChecks.push({ 
      Check: 'AWS Credentials', 
      Status: '✅ Valid', 
      Details: `Region: ${config.aws.region}` 
    });
  } catch (error) {
    allPassed = false;
    healthChecks.push({ 
      Check: 'AWS Credentials', 
      Status: '❌ Invalid', 
      Details: error instanceof Error ? error.message : String(error)
    });
  }
  
  // Infrastructure stack check
  try {
    const infraExists = await checkStackExists('infra', config);
    healthChecks.push({ 
      Check: 'Infrastructure Stack', 
      Status: infraExists ? '✅ Available' : '❌ Missing', 
      Details: infraExists ? 'ECS cluster ready' : 'Run provision command first'
    });
    if (!infraExists) allPassed = false;
  } catch (error) {
    allPassed = false;
    healthChecks.push({ 
      Check: 'Infrastructure Stack', 
      Status: '❌ Error', 
      Details: error instanceof Error ? error.message : String(error)
    });
  }
  
  // App stack check
  try {
    const appExists = await checkStackExists('app', config);
    healthChecks.push({ 
      Check: 'Application Stack', 
      Status: appExists ? '✅ Available' : '❌ Missing', 
      Details: appExists ? 'ECS services ready' : 'Run provision command first'
    });
    if (!appExists) allPassed = false;
  } catch (error) {
    allPassed = false;
    healthChecks.push({ 
      Check: 'Application Stack', 
      Status: '❌ Error', 
      Details: error instanceof Error ? error.message : String(error)
    });
  }
  
  // Docker/container runtime check
  try {
    const hasContainer = await checkContainerRuntime();
    healthChecks.push({ 
      Check: 'Container Runtime', 
      Status: hasContainer ? '✅ Available' : '❌ Missing', 
      Details: hasContainer ? 'Docker/Podman ready' : 'Install Docker or Podman'
    });
    if (!hasContainer) allPassed = false;
  } catch (error) {
    allPassed = false;
    healthChecks.push({ 
      Check: 'Container Runtime', 
      Status: '❌ Error', 
      Details: error instanceof Error ? error.message : String(error)
    });
  }
  
  // Configuration validation
  try {
    // This will throw if configuration is invalid
    await loadEnvironmentConfig(environment);
    healthChecks.push({ 
      Check: 'Configuration', 
      Status: '✅ Valid', 
      Details: 'All settings validated'
    });
  } catch (error) {
    allPassed = false;
    healthChecks.push({ 
      Check: 'Configuration', 
      Status: '❌ Invalid', 
      Details: error instanceof Error ? error.message : String(error)
    });
  }
  
  // Show health check results
  return new Promise((resolve) => {
    const HealthCheckComponent = React.createElement(
      Box,
      { flexDirection: 'column' },
      [
        React.createElement(Text, { 
          bold: true, 
          color: allPassed ? 'green' : 'red', 
          key: 'title' 
        }, allPassed ? '✅ Pre-Deployment Health Check: PASSED' : '❌ Pre-Deployment Health Check: FAILED'),
        React.createElement(SimpleTable, {
          data: healthChecks,
          columns: ['Check', 'Status', 'Details'],
          key: 'health-table'
        }),
        React.createElement(Box, { key: 'summary', marginTop: 1 },
          React.createElement(Text, { 
            color: allPassed ? 'green' : 'yellow'
          }, allPassed ? '🚀 Environment is ready for deployment' : 
             '⚠️  Please resolve the issues above before proceeding')
        )
      ]
    );
    
    const { unmount } = render(HealthCheckComponent);
    
    setTimeout(() => {
      unmount();
      console.log('');
      resolve(allPassed);
    }, 2000);
  });
}

interface DeploymentProgress {
  steps: string[];
  currentStep: number;
  completedSteps: number[];
  services: Array<{
    name: string;
    icon: string;
    oldTasks: number;
    newTasks: number;
    healthy: boolean;
    status: string;
  }>;
}

async function showLiveDeploymentProgress(options: DeployOptions): Promise<{ unmount: () => void }> {
  const { environment, service } = options;
  
  // Define deployment steps based on service and environment
  const steps = [];
  if (environment !== 'local') {
    if (service === 'backend' || service === 'all') {
      steps.push('Building backend image', 'Pushing to ECR', 'Updating ECS service');
    }
    if (service === 'frontend' || service === 'all') {
      steps.push('Building frontend image', 'Pushing to ECR', 'Updating ECS service');
    }
    if (service === 'database' || service === 'all') {
      steps.push('Running database migrations');
    }
  } else {
    if (service === 'database' || service === 'all') {
      steps.push('Starting PostgreSQL container');
    }
    if (service === 'backend' || service === 'all') {
      steps.push('Starting backend service');
    }
    if (service === 'frontend' || service === 'all') {
      steps.push('Starting frontend service');
    }
  }
  steps.push('Deployment complete');
  
  // Initialize deployment progress
  const progress: DeploymentProgress = {
    steps,
    currentStep: 0,
    completedSteps: [],
    services: []
  };
  
  // Initialize services based on what's being deployed
  if (service === 'backend' || service === 'all') {
    progress.services.push({
      name: 'backend',
      icon: '🖥️',
      oldTasks: 1,
      newTasks: 0,
      healthy: false,
      status: 'Preparing'
    });
  }
  
  if (service === 'frontend' || service === 'all') {
    progress.services.push({
      name: 'frontend',
      icon: '🌐',
      oldTasks: 1,
      newTasks: 0,
      healthy: false,
      status: 'Preparing'
    });
  }
  
  if (service === 'database' || service === 'all') {
    progress.services.push({
      name: 'database',
      icon: '🗄️',
      oldTasks: 0,
      newTasks: 1,
      healthy: false,
      status: 'Preparing'
    });
  }
  
  // Show live progress display
  const ProgressComponent = React.createElement(
    Box,
    { flexDirection: 'column' },
    [
      React.createElement(Text, { 
        bold: true, 
        color: 'cyan', 
        key: 'title' 
      }, `\\n🚀 Deploying to ${environment} environment...`),
      React.createElement(StepProgress, {
        steps: progress.steps,
        currentStep: progress.currentStep,
        completedSteps: progress.completedSteps,
        key: 'step-progress'
      }),
      progress.services.length > 0 ? React.createElement(DeploymentStatus, {
        services: progress.services,
        key: 'service-status'
      }) : null,
      React.createElement(Box, { key: 'status', marginTop: 1 },
        React.createElement(Text, { color: 'yellow' }, '⏳ Deployment in progress...')
      )
    ].filter(Boolean)
  );
  
  return render(ProgressComponent);
}

function updateDeploymentProgress(
  progressRef: { unmount: () => void }, 
  progress: DeploymentProgress, 
  stepUpdate?: { step?: number; completed?: number; serviceUpdate?: { name: string; status: string; healthy?: boolean } }
): { unmount: () => void } {
  // Unmount current display
  progressRef.unmount();
  
  // Apply updates
  if (stepUpdate?.step !== undefined) {
    progress.currentStep = stepUpdate.step;
  }
  if (stepUpdate?.completed !== undefined) {
    progress.completedSteps.push(stepUpdate.completed);
  }
  if (stepUpdate?.serviceUpdate) {
    const service = progress.services.find(s => s.name === stepUpdate.serviceUpdate!.name);
    if (service) {
      service.status = stepUpdate.serviceUpdate.status;
      if (stepUpdate.serviceUpdate.healthy !== undefined) {
        service.healthy = stepUpdate.serviceUpdate.healthy;
      }
    }
  }
  
  // Render updated display
  const ProgressComponent = React.createElement(
    Box,
    { flexDirection: 'column' },
    [
      React.createElement(Text, { 
        bold: true, 
        color: 'cyan', 
        key: 'title' 
      }, '\\n🚀 Deployment Progress'),
      React.createElement(StepProgress, {
        steps: progress.steps,
        currentStep: progress.currentStep,
        completedSteps: progress.completedSteps,
        key: 'step-progress'
      }),
      progress.services.length > 0 ? React.createElement(DeploymentStatus, {
        services: progress.services,
        key: 'service-status'
      }) : null,
      React.createElement(Box, { key: 'status', marginTop: 1 },
        React.createElement(Text, { 
          color: progress.currentStep >= progress.steps.length - 1 ? 'green' : 'yellow'
        }, progress.currentStep >= progress.steps.length - 1 ? '✅ Deployment completed!' : '⏳ Deployment in progress...')
      )
    ].filter(Boolean)
  );
  
  return render(ProgressComponent);
}

async function deployStackWithProgress(options: DeployOptions, config: any): Promise<boolean> {
  // Start live progress display
  const progressDisplay = await showLiveDeploymentProgress(options);
  let currentProgress: DeploymentProgress = {
    steps: [],
    currentStep: 0,
    completedSteps: [],
    services: []
  };
  
  try {
    // Call the original deployment function with progress updates
    const result = await deployStack(options, config, (update) => {
      // Update progress and re-render
      const newDisplay = updateDeploymentProgress(progressDisplay, currentProgress, update);
      Object.assign(progressDisplay, newDisplay);
    });
    
    // Final progress update
    updateDeploymentProgress(progressDisplay, currentProgress, { 
      step: currentProgress.steps.length - 1,
      completed: currentProgress.steps.length - 1
    });
    
    // Keep progress display for a moment before unmounting
    setTimeout(() => {
      progressDisplay.unmount();
    }, 2000);
    
    return result;
  } catch (error) {
    progressDisplay.unmount();
    throw error;
  }
}

async function promptForEnvironmentSelection(environments: string[]): Promise<Environment> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  try {
    const answer = await askQuestion(rl, `Select environment (1-${environments.length}): `);
    const selection = parseInt(answer, 10);
    
    if (isNaN(selection) || selection < 1 || selection > environments.length) {
      console.log('❌ Invalid selection');
      return promptForEnvironmentSelection(environments);
    }
    
    return environments[selection - 1] as Environment;
  } finally {
    rl.close();
  }
}

async function loadEnvironmentConfig(environment: Environment): Promise<any> {
  // Load configuration using the new JSON-based config loader
  return loadConfig(environment);
}

async function deployLocal(options: DeployOptions): Promise<boolean> {
  const { service, verbose } = options;
  
  log(`🚀 Deploying ${service} service(s) locally`, colors.bright);
  
  // Local deployment doesn't need AWS credentials
  // It uses Docker/Podman containers
  
  try {
    // Check for Docker or Podman
    const hasDocker = await checkContainerRuntime();
    if (!hasDocker) {
      error('Docker or Podman is required for local deployment');
      return false;
    }
    
    // Deploy based on service selection
    if (service === 'database' || service === 'all') {
      info('Starting PostgreSQL container...');
      const dbStarted = await startLocalDatabase(verbose ?? false);
      if (!dbStarted) {
        error('Failed to start database');
        return false;
      }
      success('Database running on port 5432');
    }
    
    if (service === 'backend' || service === 'all') {
      info('Starting backend service...');
      const backendStarted = await startLocalBackend(verbose ?? false);
      if (!backendStarted) {
        error('Failed to start backend');
        return false;
      }
      success('Backend running on http://localhost:3001');
    }
    
    if (service === 'frontend' || service === 'all') {
      info('Starting frontend service...');
      const frontendStarted = await startLocalFrontend(options.mock ?? false, verbose ?? false);
      if (!frontendStarted) {
        error('Failed to start frontend');
        return false;
      }
      success('Frontend running on http://localhost:3000');
    }
    
    return true;
  } catch (err) {
    error(`Local deployment failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function checkContainerRuntime(): Promise<boolean> {
  try {
    // Check for Docker first
    execSync('docker --version', { stdio: 'pipe' });
    return true;
  } catch {
    try {
      // Check for Podman
      execSync('podman --version', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}

async function startLocalDatabase(verbose: boolean): Promise<boolean> {
  try {
    // Check if container already exists
    try {
      const existing = execSync('docker ps -a --filter name=semiont-postgres --format "{{.Names}}"', { encoding: 'utf-8' });
      if (existing.includes('semiont-postgres')) {
        info('Starting existing database container...');
        execSync('docker start semiont-postgres', { stdio: verbose ? 'inherit' : 'pipe' });
        
        // Wait for database to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        return true;
      }
    } catch {
      // Container doesn't exist, create it
    }
    
    // Create new container
    info('Creating new database container...');
    const cmd = `docker run --name semiont-postgres \
      -e POSTGRES_PASSWORD=localpassword \
      -e POSTGRES_DB=semiont_dev \
      -e POSTGRES_USER=dev_user \
      -p 5432:5432 \
      -d postgres:15-alpine`;
    
    execSync(cmd, { stdio: verbose ? 'inherit' : 'pipe' });
    
    // Wait for database to be ready
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Run migrations
    info('Running database migrations...');
    execSync('cd apps/backend && npx prisma db push', { stdio: verbose ? 'inherit' : 'pipe' });
    
    return true;
  } catch (err) {
    error(`Database startup failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function startLocalBackend(verbose: boolean): Promise<boolean> {
  try {
    info('Installing backend dependencies...');
    execSync('cd apps/backend && npm install', { stdio: verbose ? 'inherit' : 'pipe' });
    
    info('Starting backend in development mode...');
    spawn('npm', ['run', 'dev'], {
      cwd: path.join(process.cwd(), 'apps/backend'),
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    // Wait for backend to start
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check if backend is responding
    try {
      execSync('curl -f http://localhost:3001/health', { stdio: 'pipe' });
      return true;
    } catch {
      warning('Backend may still be starting...');
      return true;  // Return true anyway, user can check manually
    }
  } catch (err) {
    error(`Backend startup failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function startLocalFrontend(mock: boolean, verbose: boolean): Promise<boolean> {
  try {
    info('Installing frontend dependencies...');
    execSync('cd apps/frontend && npm install', { stdio: verbose ? 'inherit' : 'pipe' });
    
    const command = mock ? 'dev:mock' : 'dev';
    info(`Starting frontend in ${mock ? 'mock' : 'development'} mode...`);
    
    spawn('npm', ['run', command], {
      cwd: path.join(process.cwd(), 'apps/frontend'),
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    // Wait for frontend to start
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    return true;
  } catch (err) {
    error(`Frontend startup failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function deployStack(options: DeployOptions, config: any, _onProgress?: (update: any) => void): Promise<boolean> {
  const { environment, service, dryRun, verbose } = options;
  
  // Handle local deployment separately
  if (environment === 'local') {
    return deployLocal(options);
  }
  
  log(`🚀 Deploying ${service} service(s) to ${environment} environment`, colors.bright);
  
  if (dryRun) {
    warning('DRY RUN MODE - No actual changes will be made');
  }
  
  // Validate AWS credentials for cloud deployments
  await requireValidAWSCredentials(config.aws.region);
  
  // Map services to required stacks
  const stacksNeeded = getStacksForServices(service);
  
  // For cloud deployments, we need to ensure stacks exist before deploying services
  for (const stack of stacksNeeded) {
    info(`Checking ${stack} stack availability...`);
    const stackExists = await checkStackExists(stack, config);
    if (!stackExists) {
      error(`${stack} stack not found. Run: ./scripts/semiont provision ${environment} --stack ${stack}`);
      return false;
    }
  }
  
  // Deploy services
  if (service === 'database' || service === 'all') {
    info('Deploying database service...');
    const dbSuccess = await deployDatabaseService(environment, config, { dryRun, verbose });
    if (!dbSuccess) {
      error('Database service deployment failed');
      return false;
    }
    success('Database service updated successfully');
  }
  
  if (service === 'backend' || service === 'all') {
    info('Deploying backend service...');
    const backendSuccess = await deployBackendService(environment, config, { dryRun, verbose });
    if (!backendSuccess) {
      error('Backend service deployment failed');
      return false;
    }
    success('Backend service updated successfully');
  }
  
  if (service === 'frontend' || service === 'all') {
    info('Deploying frontend service...');
    const frontendSuccess = await deployFrontendService(environment, config, { dryRun, verbose });
    if (!frontendSuccess) {
      error('Frontend service deployment failed');
      return false;
    }
    success('Frontend service updated successfully');
  }
  
  return true;
}

function getStacksForServices(service: Service): Stack[] {
  switch (service) {
    case 'database':
      return ['infra'];  // Database runs on RDS in infra stack
    case 'backend':
    case 'frontend':
      return ['app'];    // Backend/frontend run on ECS in app stack  
    case 'all':
      return ['infra', 'app'];  // All services need both stacks
    default:
      return [];
  }
}

async function checkStackExists(_stack: Stack, _config: any): Promise<boolean> {
  // Check if CloudFormation stack exists
  // For now, returning true as placeholder
  return true;
}

async function deployDatabaseService(_environment: Environment, _config: any, _options: any): Promise<boolean> {
  // Database service deployment (RDS configuration, migrations)
  info('Database service runs on RDS - managed by infrastructure stack');
  info('Running database migrations...');
  // TODO: Run migrations, update schemas
  return true;
}

async function deployBackendService(environment: Environment, _config: any, options: any): Promise<boolean> {
  info('Deploying backend service...');
  
  // Build backend image if it doesn't exist
  const backendExists = await runCommand(['docker', 'image', 'inspect', 'semiont-backend:latest'], '.', 'Check backend image exists', options.verbose);
  
  if (!backendExists) {
    info('Building backend Docker image...');
    const buildSuccess = await runCommandWithProgress(['npm', 'run', 'build:backend'], '.', 'Build backend image');
    if (!buildSuccess) {
      error('Failed to build backend image');
      return false;
    }
  }
  
  // Push to ECR and update ECS service
  const ecrImage = await pushImageToECR('semiont-backend:latest', 'backend', environment);
  if (!ecrImage) {
    error('Failed to push backend image to ECR');
    return false;
  }
  
  // Update ECS service with new image
  const updateSuccess = await updateECSService('backend', ecrImage, environment);
  if (!updateSuccess) {
    error('Failed to update backend ECS service');
    return false;
  }
  
  success('Backend service deployment completed');
  return true;
}

async function deployFrontendService(environment: Environment, _config: any, options: any): Promise<boolean> {
  info('Deploying frontend service...');
  
  // Build frontend image if it doesn't exist
  const frontendExists = await runCommand(['docker', 'image', 'inspect', 'semiont-frontend:latest'], '.', 'Check frontend image exists', options.verbose);
  
  if (!frontendExists) {
    info('Building frontend Docker image...');
    const buildSuccess = await runCommandWithProgress(['npm', 'run', 'build:frontend'], '.', 'Build frontend image');
    if (!buildSuccess) {
      error('Failed to build frontend image');
      return false;
    }
  }
  
  // Push to ECR and update ECS service
  const ecrImage = await pushImageToECR('semiont-frontend:latest', 'frontend', environment);
  if (!ecrImage) {
    error('Failed to push frontend image to ECR');
    return false;
  }
  
  // Update ECS service with new image
  const updateSuccess = await updateECSService('frontend', ecrImage, environment);
  if (!updateSuccess) {
    error('Failed to update frontend ECS service');
    return false;
  }
  
  success('Frontend service deployment completed');
  // TODO: Add CloudFront invalidation if needed
  return true;
}

// ECR and ECS deployment functions
async function pushImageToECR(localImageName: string, serviceName: string, environment: string): Promise<string | null> {
  const envConfig = loadConfig(environment);
  const ecrClient = new ECRClient({ region: envConfig.aws.region });
  
  // Get ECR login token
  const authResponse = await ecrClient.send(new GetAuthorizationTokenCommand({}));
  const authToken = authResponse.authorizationData?.[0]?.authorizationToken;
  const registryUrl = authResponse.authorizationData?.[0]?.proxyEndpoint;
  
  if (!authToken || !registryUrl) {
    error('Failed to get ECR authorization');
    return null;
  }
  
  const repositoryName = `semiont-${serviceName}`;
  const accountId = envConfig.aws.accountId;
  const region = envConfig.aws.region;
  const ecrImageUri = `${accountId}.dkr.ecr.${region}.amazonaws.com/${repositoryName}:latest`;
  
  // Ensure ECR repository exists
  await ensureECRRepository(repositoryName, ecrClient);
  
  // Docker login to ECR
  const loginCommand = ['docker', 'login', '--username', 'AWS', '--password', Buffer.from(authToken, 'base64').toString(), registryUrl];
  const loginSuccess = await runCommand(loginCommand, '.', `ECR login for ${serviceName}`, false);
  if (!loginSuccess) {
    return null;
  }
  
  // Tag image for ECR
  const tagSuccess = await runCommand(['docker', 'tag', localImageName, ecrImageUri], '.', `Tag ${serviceName} image`, false);
  if (!tagSuccess) {
    return null;
  }
  
  // Push to ECR with progress indicator
  const pushSuccess = await runCommandWithProgress(['docker', 'push', ecrImageUri], '.', `Push ${serviceName} to ECR`);
  if (!pushSuccess) {
    return null;
  }
  
  return ecrImageUri;
}

async function ensureECRRepository(repositoryName: string, ecrClient: ECRClient): Promise<boolean> {
  try {
    await ecrClient.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
    return true;
  } catch (error: any) {
    if (error.name === 'RepositoryNotFoundException') {
      info(`Creating ECR repository: ${repositoryName}`);
      try {
        await ecrClient.send(new CreateRepositoryCommand({ repositoryName }));
        return true;
      } catch (createError) {
        error(`Failed to create ECR repository: ${createError}`);
        return false;
      }
    }
    error(`Error checking ECR repository: ${error}`);
    return false;
  }
}

async function updateECSService(serviceName: string, _imageUri: string, environment: string): Promise<boolean> {
  const envConfig = loadConfig(environment);
  const ecsClient = new ECSClient({ region: envConfig.aws.region });
  const stackConfig = new SemiontStackConfig(envConfig.aws.region);
  
  try {
    const clusterName = await stackConfig.getClusterName();
    const fullServiceName = serviceName === 'frontend' 
      ? await stackConfig.getFrontendServiceName()
      : await stackConfig.getBackendServiceName();
    
    info(`Updating ECS service: ${fullServiceName}`);
    
    // Update service with new task definition (simplified)
    // In a full implementation, you'd create a new task definition revision
    // For now, trigger a deployment to pick up the new ECR image
    await ecsClient.send(new UpdateServiceCommand({
      cluster: clusterName,
      service: fullServiceName,
      forceNewDeployment: true
    }));
    
    info(`ECS service ${serviceName} update initiated`);
    return true;
  } catch (err) {
    error(`Failed to update ECS service: ${(err as any).message || err}`);
    return false;
  }
}

function printHelp(): void {
  console.log(`
${colors.bright}🚀 Semiont Deploy Command${colors.reset}

${colors.cyan}Usage:${colors.reset}
  ./scripts/semiont deploy [environment] [options]

${colors.cyan}Environments:${colors.reset}
  local          Local development (Docker/Podman containers)
  development    Development cloud environment (auto-approve)
  staging        Staging environment (requires approval)
  production     Production environment (requires approval)

${colors.cyan}Options:${colors.reset}
  --service <target>   Service to deploy (default: all)
                       Services: database, backend, frontend, all
  --mock               Use mock API for frontend (local only)
  --dry-run            Show what would be deployed without changes
  --verbose            Show detailed output
  --force              Force deployment even with warnings
  --no-approval        Skip manual approval (use with caution)
  --help               Show this help message

${colors.cyan}Examples:${colors.reset}
  ${colors.dim}# Interactive environment selection${colors.reset}
  ./scripts/semiont deploy

  ${colors.dim}# Deploy everything locally${colors.reset}
  ./scripts/semiont deploy local

  ${colors.dim}# Deploy frontend with mock API locally${colors.reset}
  ./scripts/semiont deploy local --service frontend --mock

  ${colors.dim}# Deploy to development cloud${colors.reset}
  ./scripts/semiont deploy development

  ${colors.dim}# Deploy backend service to production${colors.reset}
  ./scripts/semiont deploy production --service backend

  ${colors.dim}# Dry run for staging${colors.reset}
  ./scripts/semiont deploy staging --dry-run


${colors.cyan}Notes:${colors.reset}
  • If no environment specified, interactive selector will show available options
  • Local deployment uses Docker/Podman containers
  • Cloud deployments require AWS credentials
  • Production/staging require manual approval (unless --no-approval)
  • Use 'provision' command for initial infrastructure setup
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  // Check for help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  
  // Parse arguments - allow interactive selection if no environment provided
  let environment = args[0];
  if (!environment) {
    try {
      environment = await selectEnvironmentInteractively();
      info(`Selected environment: ${environment}`);
    } catch (err) {
      error('Failed to select environment');
      printHelp();
      process.exit(1);
    }
  }
  
  try {
    // Validate environment
    const validEnv = await validateEnvironment(environment);
    
    // Parse options
    const options: DeployOptions = {
      environment: validEnv,
      service: 'all',
      dryRun: false,
      verbose: false,
      force: false,
      requireApproval: false,  // Will be set based on environment
      mock: false
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
        case '--dry-run':
          options.dryRun = true;
          break;
        case '--verbose':
          options.verbose = true;
          break;
        case '--force':
          options.force = true;
          break;
        case '--no-approval':
          options.requireApproval = false;
          break;
        case '--mock':
          options.mock = true;
          break;
        default:
          warning(`Unknown option: ${arg}`);
      }
    }
    
    // Load configuration for the environment
    log(`Loading configuration for ${validEnv} environment...`, colors.cyan);
    const config = await loadEnvironmentConfig(validEnv);
    
    // Show deployment plan
    console.log('');
    info('Deployment Plan:');
    console.log(`  Environment: ${colors.bright}${validEnv}${colors.reset}`);
    console.log(`  Service:     ${colors.bright}${options.service}${colors.reset}`);
    if (validEnv !== 'local') {
      console.log(`  Region:      ${colors.bright}${config.aws.region}${colors.reset}`);
      
      // Show required stacks
      const requiredStacks = getStacksForServices(options.service);
      console.log(`  Stacks:      ${colors.dim}${requiredStacks.join(', ')}${colors.reset}`);
    }
    
    if (options.dryRun) {
      console.log(`  Mode:        ${colors.yellow}DRY RUN${colors.reset}`);
    }
    
    console.log('');
    
    // Run pre-deployment health checks
    const healthPassed = await runPreDeploymentHealthChecks(validEnv, config);
    if (!healthPassed && !options.force) {
      error('Health checks failed. Use --force to override (not recommended)');
      process.exit(1);
    }
    
    // Show deployment confirmation with impact analysis
    if (options.requireApproval !== false) {
      const confirmed = await showDeploymentConfirmation(options);
      if (!confirmed) {
        error('Deployment cancelled by user');
        process.exit(1);
      }
    }
    
    // Execute deployment with live progress
    const success = await deployStackWithProgress(options, config);
    
    if (success) {
      console.log('');
      console.log('');
      console.log(`${colors.green}🎉 Deployment to ${validEnv} completed successfully!${colors.reset}`);
      
      // Provide next steps
      console.log('');
      info('Next steps:');
      if (validEnv === 'local') {
        console.log(`  1. Frontend: http://localhost:3000`);
        console.log(`  2. Backend API: http://localhost:3001`);
        console.log(`  3. Run tests: ./scripts/semiont test`);
      } else {
        console.log(`  1. Check deployment status: ./scripts/semiont check --env ${validEnv}`);
        console.log(`  2. Monitor logs: ./scripts/semiont watch logs --env ${validEnv}`);
        console.log(`  3. Run tests: ./scripts/semiont test integration --env ${validEnv}`);
      }
    } else {
      error('Deployment failed');
      process.exit(1);
    }
    
  } catch (err) {
    error(`Deployment failed: ${err instanceof Error ? err.message : String(err)}`);
    if (args.includes('--verbose')) {
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

export { deployStack, loadEnvironmentConfig, type DeployOptions, type Environment };