
/**
 * Local Development Environment Management
 * 
 * Manages local PostgreSQL containers, backend, and frontend services
 * for seamless development experience.
 */

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';

const program = new Command();

// Configuration aligned with config/environments/development.ts
const LOCAL_CONFIG = {
  database: {
    name: 'semiont_dev',
    user: 'dev_user',
    password: 'dev_password',
    containerName: 'semiont-postgres-dev'
  },
  backend: {
    port: 3001,
    url: 'http://localhost:3001'
  },
  frontend: {
    port: 3000,
    url: 'http://localhost:3000'
  }
};

// State tracking
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

const state: LocalState = {};

// Container runtime detection and configuration
interface ContainerRuntime {
  name: 'docker' | 'podman';
  command: string;
  detected: boolean;
  configured: boolean;
}

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

function configureContainerRuntime(): void {
  const runtime = detectContainerRuntime();
  
  if (!runtime.detected) {
    error('No container runtime detected. Please install Docker or Podman.');
    process.exit(1);
  }
  
  if (runtime.name === 'podman' && !runtime.configured) {
    log('🐳 Podman detected but not configured for Testcontainers', '⚠️');
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
        log('🔧 Auto-configuring Podman environment variables...');
        process.env.DOCKER_HOST = `unix://${podmanSocket}`;
        process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
        success('Podman configured automatically');
        return;
      }
    }
    
    log('Please configure Podman and try again, or use Docker instead.');
    process.exit(1);
  }
  
  if (runtime.configured) {
    const emoji = runtime.name === 'podman' ? '🐳' : '🐋';
    log(`Using ${runtime.name.charAt(0).toUpperCase() + runtime.name.slice(1)} container runtime`, emoji);
  }
}

// Utilities
function log(message: string, emoji = '📝') {
  console.log(`${emoji} ${message}`);
}

function error(message: string) {
  console.error(`❌ ${message}`);
}

function success(message: string) {
  console.log(`✅ ${message}`);
}

function getProjectRoot(): string {
  return path.resolve(__dirname, '..');
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

// Database Management
async function startDatabase(options: { reset?: boolean; seed?: boolean } = {}): Promise<void> {
  // Configure container runtime before starting
  configureContainerRuntime();
  
  log('🐳 Starting local PostgreSQL database...');

  // Stop existing container if reset requested
  if (options.reset) {
    log('🗑️  Resetting database (stopping existing container)...');
    stopContainer(LOCAL_CONFIG.database.containerName);
  }

  // Check if container is already running
  if (isContainerRunning(LOCAL_CONFIG.database.containerName)) {
    success('Database container already running');
    return;
  }

  try {
    // Start PostgreSQL container with persistent name
    const container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase(LOCAL_CONFIG.database.name)
      .withUsername(LOCAL_CONFIG.database.user)
      .withPassword(LOCAL_CONFIG.database.password)
      .withName(LOCAL_CONFIG.database.containerName)
      .withReuse() // Allow container reuse across restarts
      .start();

    const connectionString = container.getConnectionUri();
    log(`📡 Database started: ${connectionString}`);

    // Set environment variable for other processes
    process.env.DATABASE_URL = connectionString;

    // Apply database schema
    log('🔧 Applying database schema...');
    const projectRoot = getProjectRoot();
    const schemaPath = path.join(projectRoot, 'apps/backend/prisma/schema.prisma');
    
    execSync(`npx prisma db push --schema="${schemaPath}" --accept-data-loss`, {
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: 'pipe'
    });

    // Seed database if requested
    if (options.seed) {
      log('🌱 Seeding database with sample data...');
      await seedDatabase(connectionString);
    }

    state.database = { container, connectionString };
    success('Database ready for development!');

  } catch (err) {
    error(`Failed to start database: ${err}`);
    throw err;
  }
}

async function stopDatabase(): Promise<void> {
  log('🛑 Stopping database...');
  
  if (state.database?.container) {
    await state.database.container.stop();
    delete state.database;
  }
  
  stopContainer(LOCAL_CONFIG.database.containerName);
  success('Database stopped');
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
      ]
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
      ]
    });

    success('Sample data created');
  } finally {
    await prisma.$disconnect();
  }
}

// Backend Management
async function startBackend(options: { fresh?: boolean } = {}): Promise<void> {
  log('🚀 Starting backend...');

  // Ensure database is running first
  if (!isContainerRunning(LOCAL_CONFIG.database.containerName)) {
    log('Database not running, starting it first...');
    await startDatabase({ reset: options.fresh ?? false });
  }

  // Check if backend is already running
  if (state.backend?.process && !state.backend.process.killed) {
    success('Backend already running');
    return;
  }

  const projectRoot = getProjectRoot();
  const backendPath = path.join(projectRoot, 'apps/backend');

  // Set environment variables
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    SEMIONT_ENV: 'development',
    PORT: LOCAL_CONFIG.backend.port.toString(),
    DATABASE_URL: state.database?.connectionString || process.env.DATABASE_URL
  };

  // Start backend in development mode
  const backendProcess = spawn('npm', ['run', 'dev'], {
    cwd: backendPath,
    env,
    stdio: 'inherit'
  });

  backendProcess.on('error', (err) => {
    error(`Backend failed to start: ${err}`);
  });

  state.backend = { process: backendProcess };
  success(`Backend starting at ${LOCAL_CONFIG.backend.url}`);
}

async function stopBackend(): Promise<void> {
  if (state.backend?.process) {
    log('🛑 Stopping backend...');
    state.backend.process.kill();
    delete state.backend;
    success('Backend stopped');
  }
}

// Frontend Management  
async function startFrontend(options: { mock?: boolean } = {}): Promise<void> {
  log('🎨 Starting frontend...');

  // Check if frontend is already running
  if (state.frontend?.process && !state.frontend.process.killed) {
    success('Frontend already running');
    return;
  }

  const projectRoot = getProjectRoot();
  const frontendPath = path.join(projectRoot, 'apps/frontend');

  let env = {
    ...process.env,
    NODE_ENV: 'development',
    SEMIONT_ENV: 'development',
    PORT: LOCAL_CONFIG.frontend.port.toString()
  };

  let command: string;
  let args: string[];

  if (options.mock) {
    log('🎭 Using mock API (no backend required)');
    command = 'npm';
    args = ['run', 'dev:mock'];
  } else {
    // Ensure backend is running first
    if (!state.backend?.process || state.backend.process.killed) {
      log('Backend not running, starting it first...');
      await startBackend();
    }
    
    command = 'npm';
    args = ['run', 'dev'];
  }

  // Start frontend
  const frontendProcess = spawn(command, args, {
    cwd: frontendPath,
    env,
    stdio: 'inherit'
  });

  frontendProcess.on('error', (err) => {
    error(`Frontend failed to start: ${err}`);
  });

  state.frontend = { process: frontendProcess };
  success(`Frontend starting at ${LOCAL_CONFIG.frontend.url}`);
}

async function stopFrontend(): Promise<void> {
  if (state.frontend?.process) {
    log('🛑 Stopping frontend...');
    state.frontend.process.kill();
    delete state.frontend;
    success('Frontend stopped');
  }
}

// Full Stack Management
async function startFullStack(options: { reset?: boolean } = {}): Promise<void> {
  log('🚀 Starting full Semiont development environment...');
  
  await startDatabase({ reset: options.reset ?? false, seed: true });
  await startBackend();
  await startFrontend();
  
  success('🎉 Full development environment ready!');
  console.log('');
  console.log('📍 Services running at:');
  console.log(`   Frontend: ${LOCAL_CONFIG.frontend.url}`);
  console.log(`   Backend:  ${LOCAL_CONFIG.backend.url}`);
  console.log(`   Database: Running in Docker container '${LOCAL_CONFIG.database.containerName}'`);
  console.log('');
  console.log('💡 Use Ctrl+C to stop all services');
}

async function stopAll(): Promise<void> {
  log('🛑 Stopping all services...');
  await stopFrontend();
  await stopBackend();
  await stopDatabase();
  success('All services stopped');
}

// CLI Command Definitions
program
  .name('semiont-local')
  .description('Local development environment management')
  .version('1.0.0');

// Database commands
const dbCommand = program
  .command('db')
  .description('Manage local PostgreSQL database');

dbCommand
  .command('start')
  .description('Start local database container')
  .option('--seed', 'Add sample data after starting')
  .action(async (options) => {
    try {
      await startDatabase({ seed: options.seed });
    } catch (err) {
      process.exit(1);
    }
  });

dbCommand
  .command('stop')
  .description('Stop local database container')
  .action(async () => {
    try {
      await stopDatabase();
    } catch (err) {
      process.exit(1);
    }
  });

dbCommand
  .command('reset')
  .description('Reset database (drop and recreate)')
  .option('--seed', 'Add sample data after reset')
  .action(async (options) => {
    try {
      await startDatabase({ reset: true, seed: options.seed });
    } catch (err) {
      process.exit(1);
    }
  });

// Backend commands
const backendCommand = program
  .command('backend')
  .description('Manage local backend service');

backendCommand
  .command('start')
  .description('Start backend service')
  .option('--fresh', 'Start with fresh database')
  .action(async (options) => {
    try {
      await startBackend({ fresh: options.fresh });
    } catch (err) {
      process.exit(1);
    }
  });

backendCommand
  .command('stop')
  .description('Stop backend service')
  .action(async () => {
    try {
      await stopBackend();
    } catch (err) {
      process.exit(1);
    }
  });

// Frontend commands
const frontendCommand = program
  .command('frontend')
  .description('Manage local frontend service');

frontendCommand
  .command('start')
  .description('Start frontend service')
  .option('--mock', 'Use mock API (no backend required)')
  .action(async (options) => {
    try {
      await startFrontend({ mock: options.mock });
    } catch (err) {
      process.exit(1);
    }
  });

frontendCommand
  .command('stop')
  .description('Stop frontend service')
  .action(async () => {
    try {
      await stopFrontend();
    } catch (err) {
      process.exit(1);
    }
  });

// Full stack commands
program
  .command('start')
  .description('Start full development environment (db + backend + frontend)')
  .option('--reset', 'Start with fresh database')
  .action(async (options) => {
    try {
      await startFullStack({ reset: options.reset });
      
      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        console.log('\n🛑 Shutting down development environment...');
        await stopAll();
        process.exit(0);
      });
      
      // Keep process alive
      process.stdin.resume();
    } catch (err) {
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop all local services')
  .action(async () => {
    try {
      await stopAll();
    } catch (err) {
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Show status of local services')
  .action(() => {
    console.log('🔍 Local Development Environment Status:');
    console.log('');
    
    const dbRunning = isContainerRunning(LOCAL_CONFIG.database.containerName);
    const backendRunning = state.backend?.process && !state.backend.process.killed;
    const frontendRunning = state.frontend?.process && !state.frontend.process.killed;
    
    console.log(`   Database:  ${dbRunning ? '✅ Running' : '❌ Stopped'}`);
    console.log(`   Backend:   ${backendRunning ? '✅ Running' : '❌ Stopped'}`);
    console.log(`   Frontend:  ${frontendRunning ? '✅ Running' : '❌ Stopped'}`);
    
    if (dbRunning) {
      console.log(`   Database URL: postgres://${LOCAL_CONFIG.database.user}:***@localhost:*****/${LOCAL_CONFIG.database.name}`);
    }
  });

// Parse CLI arguments
if (process.argv.length < 3) {
  program.help();
} else {
  program.parse(process.argv);
}