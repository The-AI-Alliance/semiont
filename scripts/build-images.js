#!/usr/bin/env node

/**
 * Build container images for Semiont services
 * Automatically detects and uses Docker or Podman
 * 
 * Usage:
 *   npm run container:build              # Build all images
 *   npm run container:build backend      # Build backend only
 *   npm run container:build frontend     # Build frontend only
 * 
 * Legacy aliases:
 *   npm run docker:build                 # Same as container:build
 *   npm run podman:build                 # Forces Podman usage
 */

const { spawn } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

const PROJECT_ROOT = join(__dirname, '..');

// ANSI color codes
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m'
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Detect container runtime
async function detectContainerRuntime() {
  // Check if forced via environment variable
  if (process.env.CONTAINER_RUNTIME) {
    const runtime = process.env.CONTAINER_RUNTIME.toLowerCase();
    if (runtime === 'docker' || runtime === 'podman') {
      return runtime;
    }
  }
  
  // Check if forced via script name
  const scriptName = process.env.npm_lifecycle_event || '';
  if (scriptName.includes('podman')) {
    return 'podman';
  }
  if (scriptName.includes('docker')) {
    return 'docker';
  }
  
  // Auto-detect available runtime
  const isDockerAvailable = await checkCommand('docker', ['--version']);
  if (isDockerAvailable) {
    return 'docker';
  }
  
  const isPodmanAvailable = await checkCommand('podman', ['--version']);
  if (isPodmanAvailable) {
    return 'podman';
  }
  
  throw new Error('No container runtime found. Please install Docker or Podman.');
}

function checkCommand(command, args) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: 'pipe' });
    proc.on('exit', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      cwd: PROJECT_ROOT,
      ...options
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function buildImage(service, dockerfile, context, buildArgs = [], runtime) {
  log('yellow', `Building ${service} with ${runtime}...`);
  
  const dockerfilePath = join(PROJECT_ROOT, dockerfile);
  if (!existsSync(dockerfilePath)) {
    log('red', `✗ Dockerfile not found: ${dockerfile}`);
    throw new Error(`Dockerfile not found: ${dockerfile}`);
  }

  const args = [
    'build',
    '-t', `semiont-${service}:latest`,
    '-f', dockerfile,
    ...buildArgs,
    context
  ];

  try {
    await runCommand(runtime, args);
    log('green', `✓ Built semiont-${service}:latest with ${runtime}`);
  } catch (error) {
    log('red', `✗ Failed to build ${service}: ${error.message}`);
    throw error;
  }
}

async function buildBackend(runtime) {
  await buildImage('backend', 'apps/backend/Dockerfile', '.', [], runtime);
}

async function buildFrontend(runtime) {
  log('yellow', 'Building frontend...');

  // Use environment variables or defaults
  // Note: NEXT_PUBLIC_API_URL removed - Envoy handles routing at runtime
  const appName = process.env.NEXT_PUBLIC_APP_NAME || 'Semiont';
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || '1.0.0';

  const buildArgs = [
    '--build-arg', `NEXT_PUBLIC_APP_NAME=${appName}`,
    '--build-arg', `NEXT_PUBLIC_APP_VERSION=${appVersion}`
  ];

  await buildImage('frontend', 'apps/frontend/Dockerfile', '.', buildArgs, runtime);
}

async function showImages(runtime) {
  log('green', `\nBuilt images (${runtime}):`);
  try {
    await runCommand(runtime, ['images', '|', 'grep', 'semiont']);
  } catch {
    console.log('No semiont images found');
  }
}

async function main() {
  const service = process.argv[2] || 'all';
  
  // Detect container runtime
  let runtime;
  try {
    runtime = await detectContainerRuntime();
    log('green', `Using container runtime: ${runtime}`);
  } catch (error) {
    log('red', error.message);
    process.exit(1);
  }
  
  log('green', `Building Semiont container images...`);
  
  try {
    switch (service) {
      case 'all':
        console.log('Building all services...');
        await buildBackend(runtime);
        await buildFrontend(runtime);
        break;
      case 'backend':
        await buildBackend(runtime);
        break;
      case 'frontend':
        await buildFrontend(runtime);
        break;
      default:
        log('red', `Unknown service: ${service}`);
        console.log('Usage: npm run container:build [all|backend|frontend]');
        process.exit(1);
    }
    
    log('green', 'Build complete!');
    await showImages(runtime);
  } catch (error) {
    log('red', `Build failed: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}