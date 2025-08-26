/**
 * Enhanced Container Runtime - Returns container IDs for state tracking
 */

import { execSync } from 'child_process';
import * as fs from 'fs';

export interface ContainerStartResult {
  success: boolean;
  containerId?: string;
  containerName: string;
  runtime: 'docker' | 'podman';
}

/**
 * Start a container and return its ID
 */
export async function startContainer(
  imageName: string,
  containerName: string,
  options: {
    detached?: boolean;
    ports?: Record<string, string>;
    environment?: Record<string, string>;
    volumes?: Record<string, string>;
    command?: string[];
    verbose?: boolean;
  } = {}
): Promise<ContainerStartResult> {
  const runtime = fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
  
  const {
    detached = true,
    ports = {},
    environment = {},
    volumes = {},
    command = [],
    verbose = false
  } = options;
  
  const args = ['run'];
  
  // Container name
  args.push('--name', containerName);
  
  // Detached mode
  if (detached) {
    args.push('-d');
  }
  
  // Remove existing container with same name
  args.push('--rm');
  
  // Port mappings
  for (const [host, container] of Object.entries(ports)) {
    args.push('-p', `${host}:${container}`);
  }
  
  // Environment variables
  for (const [key, value] of Object.entries(environment)) {
    args.push('-e', `${key}=${value}`);
  }
  
  // Volume mounts
  for (const [host, container] of Object.entries(volumes)) {
    args.push('-v', `${host}:${container}`);
  }
  
  // Image name
  args.push(imageName);
  
  // Command
  if (command.length > 0) {
    args.push(...command);
  }
  
  try {
    // Run container and capture the container ID
    const fullCommand = `${runtime} ${args.join(' ')}`;
    
    if (verbose) {
      console.log(`Running: ${fullCommand}`);
    }
    
    // For detached containers, docker/podman returns the container ID
    const output = execSync(fullCommand, { encoding: 'utf-8' }).trim();
    
    // The output should be the container ID for detached containers
    const containerId = detached ? output : undefined;
    
    return {
      success: true,
      containerId,
      containerName,
      runtime: runtime as 'docker' | 'podman'
    };
    
  } catch (error) {
    if (verbose) {
      console.error(`Failed to start container: ${error}`);
    }
    
    return {
      success: false,
      containerName,
      runtime: runtime as 'docker' | 'podman'
    };
  }
}

/**
 * Get the container ID for a running container by name
 */
export function getContainerId(containerName: string): string | undefined {
  const runtime = fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
  
  try {
    const output = execSync(
      `${runtime} ps -q --filter "name=^${containerName}$"`,
      { encoding: 'utf-8' }
    ).trim();
    
    return output || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if a container is running by ID or name
 */
export function isContainerRunning(containerIdOrName: string): boolean {
  const runtime = fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
  
  try {
    const output = execSync(
      `${runtime} ps -q --filter "id=${containerIdOrName}"`,
      { encoding: 'utf-8' }
    ).trim();
    
    if (output) return true;
    
    // Try by name if ID didn't match
    const outputByName = execSync(
      `${runtime} ps -q --filter "name=^${containerIdOrName}$"`,
      { encoding: 'utf-8' }
    ).trim();
    
    return !!outputByName;
  } catch {
    return false;
  }
}