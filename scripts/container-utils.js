#!/usr/bin/env node

/**
 * Container utility commands for Semiont
 * Automatically detects and uses Docker or Podman
 */

const { spawn } = require('child_process');

const command = process.argv[2];

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

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: 'inherit',
      shell: true
    });

    proc.on('close', (code) => {
      resolve(code);
    });

    proc.on('error', () => {
      resolve(1);
    });
  });
}

async function listImages(runtime) {
  console.log(`Semiont container images (${runtime}):`);
  const code = await runCommand(runtime, ['images', '--filter', 'reference=semiont-*']);
  if (code !== 0) {
    console.log(`No semiont images found or ${runtime} not available`);
  }
}

async function cleanImages(runtime) {
  console.log(`Removing Semiont container images (${runtime})...`);
  
  const images = ['semiont-backend:latest', 'semiont-frontend:latest'];
  
  for (const image of images) {
    console.log(`Removing ${image}...`);
    const code = await runCommand(runtime, ['rmi', image]);
    if (code === 0) {
      console.log(`✓ Removed ${image}`);
    } else {
      console.log(`✗ Could not remove ${image} (may not exist)`);
    }
  }
}

async function main() {
  // Detect container runtime
  let runtime;
  try {
    runtime = await detectContainerRuntime();
    console.log(`Using container runtime: ${runtime}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  
  switch (command) {
    case 'list':
      await listImages(runtime);
      break;
    case 'clean':
      await cleanImages(runtime);
      break;
    default:
      console.log('Usage: node scripts/container-utils.js [list|clean]');
      process.exit(1);
  }
}

main().catch(console.error);