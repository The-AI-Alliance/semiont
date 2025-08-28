/**
 * Container Runtime - Unified interface for Docker and Podman
 * 
 * This utility provides container-runtime-agnostic commands that work with
 * both Docker and Podman, detecting which runtime is available and using
 * the appropriate commands.
 */

import { spawn } from 'child_process';
import { colors } from '../lib/cli-colors.js';

export type ContainerRuntime = 'docker' | 'podman';

// Cache the detected runtime to avoid repeated detection
let detectedRuntime: ContainerRuntime | null = null;

/**
 * Detect which container runtime is available
 */
export async function detectContainerRuntime(): Promise<ContainerRuntime> {
  if (detectedRuntime) {
    return detectedRuntime;
  }

  // Check for docker first (most common)
  if (await isRuntimeAvailable('docker')) {
    detectedRuntime = 'docker';
    return 'docker';
  }

  // Check for podman
  if (await isRuntimeAvailable('podman')) {
    detectedRuntime = 'podman';
    return 'podman';
  }

  throw new Error('No container runtime found. Please install Docker or Podman.');
}

/**
 * Check if a specific runtime is available
 */
async function isRuntimeAvailable(runtime: ContainerRuntime): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(runtime, ['--version'], { stdio: 'pipe' });
    
    proc.on('exit', (code) => {
      resolve(code === 0);
    });
    
    proc.on('error', () => {
      resolve(false);
    });
    
    // Timeout after 2 seconds
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 2000);
  });
}

/**
 * Run a container command with the detected runtime
 */
export async function runContainerCommand(
  args: string[],
  options: {
    cwd?: string;
    stdio?: 'inherit' | 'pipe';
    verbose?: boolean;
    description?: string;
  } = {}
): Promise<boolean> {
  const runtime = await detectContainerRuntime();
  const { cwd, stdio = 'pipe', verbose = false, description } = options;

  if (description && verbose) {
    console.log(`${colors.cyan}[${runtime.toUpperCase()}] ${description}${colors.reset}`);
  }

  if (verbose) {
    console.log(`${colors.dim}Running: ${runtime} ${args.join(' ')}${colors.reset}`);
  }

  return new Promise((resolve) => {
    const proc = spawn(runtime, args, {
      cwd,
      stdio: stdio === 'inherit' ? 'inherit' : 'pipe'
    });

    proc.on('exit', (code) => {
      resolve(code === 0);
    });

    proc.on('error', (error) => {
      if (verbose) {
        console.error(`${colors.red}Container command error: ${error.message}${colors.reset}`);
      }
      resolve(false);
    });
  });
}

/**
 * Build a container image
 */
export async function buildImage(
  imageName: string,
  tag: string,
  dockerfile: string,
  context: string,
  options: {
    verbose?: boolean;
    buildArgs?: Record<string, string>;
    noCache?: boolean;
    platform?: string;
  } = {}
): Promise<boolean> {
  const { verbose = false, buildArgs = {}, noCache = false, platform } = options;
  const imageTag = `${imageName}:${tag}`;

  const args = [
    'build',
    '-t', imageTag,
    '-f', dockerfile,
  ];
  
  // Add platform flag for cross-platform builds (important for AWS deployments)
  // Default to linux/amd64 for production builds to ensure compatibility with ECS
  if (platform) {
    args.push('--platform', platform);
  }

  // Add no-cache flag if requested
  if (noCache) {
    args.push('--no-cache');
  }

  // Add build arguments
  for (const [key, value] of Object.entries(buildArgs)) {
    args.push('--build-arg', `${key}=${value}`);
  }

  args.push(context);

  return runContainerCommand(args, {
    stdio: verbose ? 'inherit' : 'pipe',
    verbose,
    description: `Building image ${imageTag}`
  });
}

/**
 * Tag a container image
 */
export async function tagImage(
  sourceImage: string,
  targetImage: string,
  options: { verbose?: boolean } = {}
): Promise<boolean> {
  const { verbose = false } = options;

  return runContainerCommand(['tag', sourceImage, targetImage], {
    stdio: verbose ? 'inherit' : 'pipe',
    verbose,
    description: `Tagging ${sourceImage} as ${targetImage}`
  });
}

/**
 * Push a container image to registry
 */
export async function pushImage(
  imageName: string,
  options: { verbose?: boolean } = {}
): Promise<boolean> {
  const { verbose = false } = options;

  return runContainerCommand(['push', imageName], {
    stdio: verbose ? 'inherit' : 'pipe',
    verbose,
    description: `Pushing ${imageName}`
  });
}

/**
 * Start a container
 */
export async function runContainer(
  imageName: string,
  containerName: string,
  containerOptions: {
    detached?: boolean;
    ports?: Record<string, string>;
    environment?: Record<string, string>;
    volumes?: Record<string, string>;
    command?: string[];
    verbose?: boolean;
  } = {}
): Promise<boolean> {
  const {
    detached = true,
    ports = {},
    environment = {},
    volumes = {},
    command = [],
    verbose = false
  } = containerOptions;

  const args = ['run'];

  // Container name
  if (containerName) {
    args.push('--name', containerName);
  }

  // Detached mode
  if (detached) {
    args.push('-d');
  }

  // Port mappings
  for (const [hostPort, containerPort] of Object.entries(ports)) {
    args.push('-p', `${hostPort}:${containerPort}`);
  }

  // Environment variables
  for (const [key, value] of Object.entries(environment)) {
    args.push('-e', `${key}=${value}`);
  }

  // Volume mounts
  for (const [hostPath, containerPath] of Object.entries(volumes)) {
    args.push('-v', `${hostPath}:${containerPath}`);
  }

  // Image name
  args.push(imageName);

  // Command to run in container
  if (command.length > 0) {
    args.push(...command);
  }

  return runContainerCommand(args, {
    stdio: verbose ? 'inherit' : 'pipe',
    verbose,
    description: `Starting container ${containerName || imageName}`
  });
}

/**
 * Stop a container
 */
export async function stopContainer(
  containerName: string,
  options: { 
    force?: boolean; 
    verbose?: boolean;
    timeout?: number;
  } = {}
): Promise<boolean> {
  const { force = false, verbose = false, timeout = 10 } = options;

  const args = ['stop'];
  
  if (timeout !== 10) {
    args.push('--timeout', timeout.toString());
  }
  
  args.push(containerName);

  const stopped = await runContainerCommand(args, {
    stdio: verbose ? 'inherit' : 'pipe',
    verbose,
    description: `Stopping container ${containerName}`
  });

  // If force is requested or stop failed, try force removal
  if (force || !stopped) {
    return runContainerCommand(['rm', '-f', containerName], {
      stdio: verbose ? 'inherit' : 'pipe',
      verbose,
      description: `Force removing container ${containerName}`
    });
  }

  return stopped;
}

/**
 * Execute command in running container
 */
export async function execInContainer(
  containerName: string,
  command: string[],
  options: {
    interactive?: boolean;
    tty?: boolean;
    verbose?: boolean;
  } = {}
): Promise<boolean> {
  const { interactive = true, tty = true, verbose = false } = options;

  const args = ['exec'];

  if (interactive) {
    args.push('-i');
  }

  if (tty) {
    args.push('-t');
  }

  args.push(containerName, ...command);

  return runContainerCommand(args, {
    stdio: 'inherit', // Always inherit for exec to maintain interactivity
    verbose,
    description: `Executing in container ${containerName}: ${command.join(' ')}`
  });
}

/**
 * List containers
 */
export async function listContainers(options: {
  all?: boolean;
  format?: string;
  verbose?: boolean;
} = {}): Promise<string[]> {
  const { all = false, format } = options;

  const args = ['ps'];

  if (all) {
    args.push('-a');
  }

  if (format) {
    args.push('--format', format);
  }

  const runtime = await detectContainerRuntime();
  
  return new Promise((resolve) => {
    const proc = spawn(runtime, args, { stdio: 'pipe' });
    let output = '';

    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        const lines = output.trim().split('\n').filter(line => line.length > 0);
        resolve(lines);
      } else {
        resolve([]);
      }
    });

    proc.on('error', () => {
      resolve([]);
    });
  });
}

/**
 * Get container logs
 */
export async function getContainerLogs(
  containerName: string,
  options: {
    follow?: boolean;
    tail?: number;
    verbose?: boolean;
  } = {}
): Promise<boolean> {
  const { follow = false, tail, verbose = false } = options;

  const args = ['logs'];

  if (follow) {
    args.push('-f');
  }

  if (tail !== undefined) {
    args.push('--tail', tail.toString());
  }

  args.push(containerName);

  return runContainerCommand(args, {
    stdio: 'inherit',
    verbose,
    description: `Getting logs for container ${containerName}`
  });
}

/**
 * Create and mount a volume
 */
export async function createVolume(
  volumeName: string,
  options: { verbose?: boolean } = {}
): Promise<boolean> {
  const { verbose = false } = options;

  return runContainerCommand(['volume', 'create', volumeName], {
    stdio: verbose ? 'inherit' : 'pipe',
    verbose,
    description: `Creating volume ${volumeName}`
  });
}

/**
 * Remove a volume
 */
export async function removeVolume(
  volumeName: string,
  options: { force?: boolean; verbose?: boolean } = {}
): Promise<boolean> {
  const { force = false, verbose = false } = options;

  const args = ['volume', 'rm'];
  
  if (force) {
    args.push('-f');
  }
  
  args.push(volumeName);

  return runContainerCommand(args, {
    stdio: verbose ? 'inherit' : 'pipe',
    verbose,
    description: `Removing volume ${volumeName}`
  });
}