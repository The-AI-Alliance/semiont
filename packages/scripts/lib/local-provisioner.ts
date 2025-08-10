/**
 * Local Environment Provisioner
 * 
 * Handles provisioning of container-based and process-based local environments
 * Extracted from local.ts and integrated into the provision command structure
 */

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import React from 'react';
import { render, Text, Box } from 'ink';
import { SimpleTable } from './ink-utils';

// =====================================================================
// TYPES AND INTERFACES
// =====================================================================

export interface LocalProvisionOptions {
  environment: string;
  reset?: boolean;
  seed?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  destroy?: boolean;
}

export interface ContainerConfig {
  database?: {
    name: string;
    user: string;
    password: string;
    containerName: string;
    image?: string;
  };
}

export interface ProcessConfig {
  backend?: {
    port: number;
    url: string;
    command?: string;
    args?: string[];
    cwd?: string;
  };
  frontend?: {
    port: number;
    url: string;
    command?: string;
    args?: string[];
    cwd?: string;
  };
}

export interface LocalEnvironmentConfig {
  infrastructure: {
    type: 'containers' | 'processes' | 'hybrid';
  };
  containers?: ContainerConfig;
  processes?: ProcessConfig;
}

interface LocalState {
  database?: {
    container: StartedPostgreSqlContainer;
    connectionString: string;
  };
  backend?: {
    process: ChildProcess;
  };
  frontend?: {
    process: ChildProcess;
  };
}

interface ContainerRuntime {
  name: 'docker' | 'podman';
  command: string;
  detected: boolean;
  configured: boolean;
}

// =====================================================================
// GLOBAL STATE
// =====================================================================

const localState: LocalState = {};

// =====================================================================
// CONTAINER RUNTIME DETECTION
// =====================================================================

function detectContainerRuntime(): ContainerRuntime {
  // Check for explicit DOCKER_HOST configuration (indicates Podman setup)
  const dockerHost = process.env.DOCKER_HOST;
  const ryukDisabled = process.env.TESTCONTAINERS_RYUK_DISABLED;
  const ryukPrivileged = process.env.TESTCONTAINERS_RYUK_PRIVILEGED;
  
  // Try to detect Podman
  try {
    execSync('podman --version', { stdio: 'pipe' });
    const isPodmanConfigured = dockerHost?.includes('podman') || ryukDisabled || ryukPrivileged;
    
    if (isPodmanConfigured) {
      return { name: 'podman', command: 'podman', detected: true, configured: true };
    } else {
      return { name: 'podman', command: 'podman', detected: true, configured: false };
    }
  } catch {
    // Podman not available, fall back to Docker
  }
  
  // Check for Docker
  try {
    execSync('docker --version', { stdio: 'pipe' });
    return { name: 'docker', command: 'docker', detected: true, configured: true };
  } catch {
    // Neither runtime available
    return { name: 'docker', command: 'docker', detected: false, configured: false };
  }
}

function configureContainerRuntime(): ContainerRuntime {
  const runtime = detectContainerRuntime();
  
  if (!runtime.detected) {
    throw new Error('No container runtime detected. Please install Docker or Podman.');
  }
  
  if (runtime.name === 'podman' && !runtime.configured) {
    console.log('🐳 Podman detected but not configured for Testcontainers');
    console.log('');
    console.log('To configure Podman for local development:');
    console.log('');
    
    if (process.platform === 'linux') {
      console.log('Linux setup:');
      console.log('  systemctl --user enable --now podman.socket');
      console.log('  export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"');
      console.log('  export TESTCONTAINERS_RYUK_DISABLED=true');
    } else if (process.platform === 'darwin') {
      console.log('macOS setup:');
      console.log('  podman machine init && podman machine start');
      console.log('  export DOCKER_HOST="$(podman machine inspect --format \'{{.ConnectionInfo.PodmanSocket.Path}}\')"');
      console.log('  export TESTCONTAINERS_RYUK_DISABLED=true');
    }
    
    console.log('');
    console.log('Or create a .testcontainers.properties file in project root:');
    if (process.platform === 'linux') {
      console.log('  docker.host=unix:///run/user/1000/podman/podman.sock');
    } else {
      console.log('  docker.host=unix:///tmp/podman-run-1000/podman/podman.sock');
    }
    console.log('  ryuk.disabled=true');
    console.log('');
    
    // Auto-configure if possible
    if (process.platform === 'linux') {
      const uid = process.getuid ? process.getuid() : 1000;
      const podmanSocket = `/run/user/${uid}/podman/podman.sock`;
      if (fs.existsSync(podmanSocket)) {
        console.log('🔧 Auto-configuring Podman environment variables...');
        process.env.DOCKER_HOST = `unix://${podmanSocket}`;
        process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
        console.log('✅ Podman configured automatically');
        return runtime;
      }
    }
    
    throw new Error('Please configure Podman and try again, or use Docker instead.');
  }
  
  if (runtime.configured) {
    const emoji = runtime.name === 'podman' ? '🐳' : '🐋';
    console.log(`${emoji} Using ${runtime.name.charAt(0).toUpperCase() + runtime.name.slice(1)} container runtime`);
  }
  
  return runtime;
}

// =====================================================================
// UTILITY FUNCTIONS
// =====================================================================

function getProjectRoot(): string {
  // From packages/scripts/lib, go up to project root
  return path.resolve(__dirname, '../../..');
}

function isContainerRunning(containerName: string): boolean {
  try {
    const result = execSync(`docker ps --filter name=${containerName} --format "{{.Names}}"`, { 
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    return result.trim() === containerName;
  } catch {
    return false;
  }
}

function stopContainer(containerName: string): void {
  try {
    execSync(`docker stop ${containerName}`, { stdio: 'pipe' });
    execSync(`docker rm ${containerName}`, { stdio: 'pipe' });
  } catch {
    // Container might not exist, ignore
  }
}

function isProcessRunning(port: number): boolean {
  try {
    execSync(`lsof -ti:${port}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// =====================================================================
// DATABASE PROVISIONING
// =====================================================================

async function provisionDatabase(
  containerConfig: ContainerConfig['database'],
  options: LocalProvisionOptions
): Promise<void> {
  if (!containerConfig) {
    throw new Error('Database container configuration is required');
  }
  
  console.log('🐳 Provisioning local PostgreSQL database...');
  
  // Configure container runtime
  configureContainerRuntime();
  
  // Handle destroy/reset
  if (options.destroy) {
    console.log('🗑️  Destroying database container...');
    stopContainer(containerConfig.containerName);
    if (localState.database) {
      await localState.database.container.stop();
      delete localState.database;
    }
    console.log('✅ Database destroyed');
    return;
  }
  
  if (options.reset) {
    console.log('🔄 Resetting database (stopping existing container)...');
    stopContainer(containerConfig.containerName);
  }
  
  // Check if container is already running
  if (isContainerRunning(containerConfig.containerName)) {
    console.log('✅ Database container already running');
    return;
  }
  
  if (options.dryRun) {
    console.log('🔍 DRY RUN - Would create PostgreSQL container:');
    console.log(`   Image: ${containerConfig.image || 'postgres:15-alpine'}`);
    console.log(`   Database: ${containerConfig.name}`);
    console.log(`   User: ${containerConfig.user}`);
    console.log(`   Container: ${containerConfig.containerName}`);
    return;
  }
  
  try {
    // Start PostgreSQL container with persistent name
    const container = await new PostgreSqlContainer(containerConfig.image || 'postgres:15-alpine')
      .withDatabase(containerConfig.name)
      .withUsername(containerConfig.user)
      .withPassword(containerConfig.password)
      .withName(containerConfig.containerName)
      .withReuse() // Allow container reuse across restarts
      .start();

    const connectionString = container.getConnectionUri();
    console.log(`📡 Database provisioned: ${connectionString}`);

    // Set environment variable for other processes
    process.env.DATABASE_URL = connectionString;

    // Apply database schema
    console.log('🔧 Applying database schema...');
    const projectRoot = getProjectRoot();
    const schemaPath = path.join(projectRoot, 'apps/backend/prisma/schema.prisma');
    
    if (fs.existsSync(schemaPath)) {
      execSync(`npx prisma db push --schema="${schemaPath}" --accept-data-loss`, {
        env: { ...process.env, DATABASE_URL: connectionString },
        stdio: options.verbose ? 'inherit' : 'pipe'
      });
    }

    // Seed database if requested
    if (options.seed) {
      console.log('🌱 Seeding database with sample data...');
      await seedDatabase(connectionString);
    }

    localState.database = { container, connectionString };
    console.log('✅ Database ready for development!');

  } catch (err) {
    throw new Error(`Failed to provision database: ${err}`);
  }
}

async function seedDatabase(connectionString: string): Promise<void> {
  const prisma = new PrismaClient({
    datasources: { db: { url: connectionString } }
  });

  try {
    // Create sample HelloWorld records
    await prisma.helloWorld.createMany({
      data: [
        { message: 'Welcome to Semiont!' },
        { message: 'Local development is ready' },
        { message: 'Happy coding! 🚀' }
      ],
      skipDuplicates: true
    });

    // Create sample users
    await prisma.user.createMany({
      data: [
        {
          email: 'admin@localhost.dev',
          name: 'Local Admin',
          provider: 'google',
          providerId: 'local_admin',
          domain: 'localhost.dev',
          isAdmin: true
        },
        {
          email: 'user@localhost.dev', 
          name: 'Local User',
          provider: 'google',
          providerId: 'local_user',
          domain: 'localhost.dev'
        }
      ],
      skipDuplicates: true
    });

    console.log('✅ Sample data seeded');
  } finally {
    await prisma.$disconnect();
  }
}

// =====================================================================
// PROCESS PROVISIONING
// =====================================================================

async function provisionProcesses(
  processConfig: ProcessConfig,
  options: LocalProvisionOptions
): Promise<void> {
  console.log('🚀 Provisioning local processes...');
  
  if (options.destroy) {
    console.log('🛑 Stopping all processes...');
    if (localState.backend?.process) {
      localState.backend.process.kill();
      delete localState.backend;
    }
    if (localState.frontend?.process) {
      localState.frontend.process.kill();
      delete localState.frontend;
    }
    console.log('✅ All processes stopped');
    return;
  }
  
  const projectRoot = getProjectRoot();
  
  // Provision backend process
  if (processConfig.backend) {
    const backendConfig = processConfig.backend;
    console.log(`🚀 Provisioning backend process on port ${backendConfig.port}...`);
    
    if (options.dryRun) {
      console.log('🔍 DRY RUN - Would start backend:');
      console.log(`   Command: ${backendConfig.command || 'npm'} ${(backendConfig.args || ['run', 'dev']).join(' ')}`);
      console.log(`   Port: ${backendConfig.port}`);
      console.log(`   URL: ${backendConfig.url}`);
    } else {
      // Check if already running
      if (localState.backend?.process && !localState.backend.process.killed) {
        console.log('✅ Backend process already running');
      } else if (isProcessRunning(backendConfig.port)) {
        console.log('⚠️  Backend port already in use by another process');
      } else {
        // Start backend process
        const backendPath = backendConfig.cwd || path.join(projectRoot, 'apps/backend');
        const env = {
          ...process.env,
          NODE_ENV: 'development',
          SEMIONT_ENV: options.environment,
          PORT: backendConfig.port.toString(),
          DATABASE_URL: localState.database?.connectionString || process.env.DATABASE_URL
        };

        const backendProcess = spawn(
          backendConfig.command || 'npm',
          backendConfig.args || ['run', 'dev'],
          {
            cwd: backendPath,
            env,
            stdio: options.verbose ? 'inherit' : 'pipe'
          }
        );

        backendProcess.on('error', (err) => {
          console.error(`❌ Backend failed to start: ${err}`);
        });

        localState.backend = { process: backendProcess };
        console.log(`✅ Backend starting at ${backendConfig.url}`);
      }
    }
  }
  
  // Provision frontend process
  if (processConfig.frontend) {
    const frontendConfig = processConfig.frontend;
    console.log(`🎨 Provisioning frontend process on port ${frontendConfig.port}...`);
    
    if (options.dryRun) {
      console.log('🔍 DRY RUN - Would start frontend:');
      console.log(`   Command: ${frontendConfig.command || 'npm'} ${(frontendConfig.args || ['run', 'dev']).join(' ')}`);
      console.log(`   Port: ${frontendConfig.port}`);
      console.log(`   URL: ${frontendConfig.url}`);
    } else {
      // Check if already running
      if (localState.frontend?.process && !localState.frontend.process.killed) {
        console.log('✅ Frontend process already running');
      } else if (isProcessRunning(frontendConfig.port)) {
        console.log('⚠️  Frontend port already in use by another process');
      } else {
        // Start frontend process
        const frontendPath = frontendConfig.cwd || path.join(projectRoot, 'apps/frontend');
        const env = {
          ...process.env,
          NODE_ENV: 'development',
          SEMIONT_ENV: options.environment,
          PORT: frontendConfig.port.toString()
        };

        const frontendProcess = spawn(
          frontendConfig.command || 'npm',
          frontendConfig.args || ['run', 'dev'],
          {
            cwd: frontendPath,
            env,
            stdio: options.verbose ? 'inherit' : 'pipe'
          }
        );

        frontendProcess.on('error', (err) => {
          console.error(`❌ Frontend failed to start: ${err}`);
        });

        localState.frontend = { process: frontendProcess };
        console.log(`✅ Frontend starting at ${frontendConfig.url}`);
      }
    }
  }
}

// =====================================================================
// MAIN PROVISIONING FUNCTIONS
// =====================================================================

export async function provisionLocalEnvironment(
  config: LocalEnvironmentConfig,
  options: LocalProvisionOptions
): Promise<boolean> {
  try {
    console.log(`🏗️  Provisioning ${config.infrastructure.type} environment: ${options.environment}`);
    
    if (options.dryRun) {
      console.log('⚠️  DRY RUN MODE - No actual changes will be made');
    }
    
    // Provision containers if configured
    if (config.containers && (config.infrastructure.type === 'containers' || config.infrastructure.type === 'hybrid')) {
      if (config.containers.database) {
        await provisionDatabase(config.containers.database, options);
      }
    }
    
    // Provision processes if configured
    if (config.processes && (config.infrastructure.type === 'processes' || config.infrastructure.type === 'hybrid')) {
      await provisionProcesses(config.processes, options);
    }
    
    if (!options.destroy && !options.dryRun) {
      await showProvisioningSummary(config, options);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Local provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function showProvisioningSummary(
  config: LocalEnvironmentConfig,
  options: LocalProvisionOptions
): Promise<void> {
  return new Promise((resolve) => {
    const summaryData: Array<{ Service: string; Status: string; Location: string }> = [];
    
    // Database status
    if (config.containers?.database) {
      const containerName = config.containers.database.containerName;
      const isRunning = isContainerRunning(containerName);
      summaryData.push({
        Service: 'Database',
        Status: isRunning ? '✅ Running' : '❌ Stopped',
        Location: isRunning ? `Container: ${containerName}` : 'Not started'
      });
    }
    
    // Backend status
    if (config.processes?.backend) {
      const backendRunning = localState.backend?.process && !localState.backend.process.killed;
      summaryData.push({
        Service: 'Backend',
        Status: backendRunning ? '✅ Running' : '❌ Stopped',
        Location: backendRunning ? config.processes.backend.url : 'Not started'
      });
    }
    
    // Frontend status
    if (config.processes?.frontend) {
      const frontendRunning = localState.frontend?.process && !localState.frontend.process.killed;
      summaryData.push({
        Service: 'Frontend',
        Status: frontendRunning ? '✅ Running' : '❌ Stopped',
        Location: frontendRunning ? config.processes.frontend.url : 'Not started'
      });
    }

    const SummaryTable = React.createElement(
      Box,
      { flexDirection: 'column' },
      [
        React.createElement(Text, { bold: true, color: 'green', key: 'title' }, '\n🎉 Local Environment Provisioned!'),
        React.createElement(SimpleTable, { 
          data: summaryData, 
          columns: ['Service', 'Status', 'Location'],
          key: 'summary-table' 
        }),
        React.createElement(Text, { color: 'cyan', key: 'next-steps' }, '\nNext steps:'),
        React.createElement(Text, { key: 'deploy-cmd' }, `  semiont deploy -e ${options.environment}     # Deploy application code`),
        React.createElement(Text, { key: 'check-cmd' }, `  semiont check -e ${options.environment}      # Check system health`),
        React.createElement(Text, { key: 'spacing' }, '\n')
      ]
    );

    const { unmount } = render(SummaryTable);
    
    setTimeout(() => {
      unmount();
      resolve();
    }, 100);
  });
}

// =====================================================================
// CLEANUP
// =====================================================================

export async function cleanupLocalEnvironment(): Promise<void> {
  console.log('🧹 Cleaning up local environment...');
  
  if (localState.frontend?.process) {
    localState.frontend.process.kill();
    delete localState.frontend;
  }
  
  if (localState.backend?.process) {
    localState.backend.process.kill();
    delete localState.backend;
  }
  
  if (localState.database?.container) {
    await localState.database.container.stop();
    delete localState.database;
  }
  
  console.log('✅ Cleanup complete');
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  await cleanupLocalEnvironment();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await cleanupLocalEnvironment();
  process.exit(0);
});