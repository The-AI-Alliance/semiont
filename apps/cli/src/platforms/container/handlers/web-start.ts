import { execSync } from 'child_process';
import { ContainerStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';
import { printInfo } from '../../../core/io/cli-logger.js';
import type { FrontendServiceConfig, BackendServiceConfig } from '@semiont/core';

/**
 * Start handler for web services in containers
 */
const startWebContainer = async (context: ContainerStartHandlerContext): Promise<StartHandlerResult> => {
  const { service, runtime, containerName } = context;
  const config = service.config as FrontendServiceConfig | BackendServiceConfig;
  const image = service.getImage();
  
  // Remove existing container if it exists
  try {
    execSync(`${runtime} rm -f ${containerName}`, { stdio: 'ignore' });
  } catch {
    // Container might not exist
  }
  
  // Create network if it doesn't exist
  const networkName = `semiont-${service.environment}`;
  try {
    execSync(`${runtime} network create ${networkName}`, { stdio: 'ignore' });
  } catch {
    // Network might already exist
  }
  
  // Build run command
  const runArgs: string[] = [
    'run',
    '-d',
    '--name', containerName,
    '--network', networkName
  ];
  
  // Add port mappings for web service
  const port = config.port;
  runArgs.push('-p', `${port}:${port}`);
  
  // Add environment variables
  const envVars = service.getEnvironmentVariables();
  
  for (const [key, value] of Object.entries(envVars)) {
    runArgs.push('-e', `${key}=${value}`);
  }

  // Add resource limits if specified in config
  if (config.resources?.memory) {
    runArgs.push('--memory', config.resources.memory);
  }
  if (config.resources?.cpu) {
    runArgs.push('--cpus', config.resources.cpu);
  }

  // Add restart policy
  runArgs.push('--restart', 'unless-stopped');
  
  // Add the image
  runArgs.push(image);
  
  // Add command if specified
  const command = service.getCommand();
  if (command && command !== 'npm start') {
    runArgs.push(...command.split(' '));
  }
  
  // Run container
  const runCommand = `${runtime} ${runArgs.join(' ')}`;
  
  if (!service.quiet) {
    printInfo(`Starting web container: ${containerName}`);
  }
  
  try {
    const containerId = execSync(runCommand, { encoding: 'utf-8' }).trim();

    // Wait for container to be ready
    await waitForContainer(runtime, containerName);

    // Build endpoint for web service
    const endpoint = `http://localhost:${port}`;

    return {
      success: true,
      endpoint,
      resources: createPlatformResources('container', {
        containerId: containerId.substring(0, 12),
        containerName,
        image
      }),
      metadata: {
        serviceType: 'web',
        containerName,
        image,
        runtime,
        port
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to start web container: ${error}`,
      metadata: {
        serviceType: 'web',
        containerName,
        runtime
      }
    };
  }
};

/**
 * Wait for container to be ready
 */
async function waitForContainer(runtime: string, containerName: string): Promise<void> {
  const maxAttempts = 30;
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const status = execSync(
        `${runtime} inspect ${containerName} --format '{{.State.Status}}'`,
        { encoding: 'utf-8' }
      ).trim();

      if (status === 'running') {
        // Container is running
        return;
      }
    } catch {
      // Container might not exist yet
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
  }
  
  throw new Error(`Container ${containerName} failed to start within ${maxAttempts} seconds`);
}

/**
 * Descriptor for web container start handler
 */
export const webStartDescriptor: HandlerDescriptor<ContainerStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'container',
  serviceType: 'web',
  handler: startWebContainer
};