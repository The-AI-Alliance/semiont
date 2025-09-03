import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ContainerStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';
import { printInfo } from '../../../core/io/cli-logger.js';

/**
 * Start handler for web services in containers
 */
const startWebContainer = async (context: ContainerStartHandlerContext): Promise<StartHandlerResult> => {
  const { service, runtime, containerName } = context;
  const requirements = service.getRequirements();
  const image = service.getImage();
  
  // Remove existing container if it exists
  try {
    execSync(`${runtime} rm -f ${containerName}`, { stdio: 'ignore' });
  } catch {
    // Container might not exist
  }
  
  // Build run command from requirements
  const runArgs: string[] = [
    'run',
    '-d',
    '--name', containerName,
    '--network', `semiont-${service.environment}`
  ];
  
  // Add port mappings for web service
  if (requirements.network?.ports) {
    for (const port of requirements.network.ports) {
      runArgs.push('-p', `${port}:${port}`);
    }
  }
  
  // Add environment variables
  const envVars = {
    ...service.getEnvironmentVariables(),
    ...(requirements.environment || {})
  };
  
  for (const [key, value] of Object.entries(envVars)) {
    runArgs.push('-e', `${key}=${value}`);
  }
  
  // Add volumes
  if (requirements.storage) {
    for (const storage of requirements.storage) {
      if (storage.persistent) {
        const volumeName = storage.volumeName || `${containerName}-data`;
        runArgs.push('-v', `${volumeName}:${storage.mountPath}`);
        
        // Create volume if it doesn't exist
        try {
          execSync(`${runtime} volume create ${volumeName}`, { stdio: 'ignore' });
        } catch {
          // Volume might already exist
        }
      } else if (storage.type === 'bind') {
        // Bind mount from host
        const hostPath = path.join(service.projectRoot, 'data', service.name);
        fs.mkdirSync(hostPath, { recursive: true });
        runArgs.push('-v', `${hostPath}:${storage.mountPath}`);
      }
    }
  }
  
  // Add resource limits
  if (requirements.resources) {
    if (requirements.resources.memory) {
      runArgs.push('--memory', requirements.resources.memory);
    }
    if (requirements.resources.cpu) {
      runArgs.push('--cpus', requirements.resources.cpu);
    }
  }
  
  // Add health check for web service
  if (requirements.network?.healthCheckPath) {
    const port = requirements.network.healthCheckPort || requirements.network.ports?.[0];
    if (port) {
      const interval = requirements.network.healthCheckInterval || 30;
      runArgs.push(
        '--health-cmd', `curl -f http://localhost:${port}${requirements.network.healthCheckPath} || exit 1`,
        '--health-interval', `${interval}s`,
        '--health-timeout', '10s',
        '--health-retries', '3',
        '--health-start-period', '40s'
      );
    }
  }
  
  // Add restart policy
  const restartPolicy = requirements.annotations?.['container/restart'] || 'unless-stopped';
  runArgs.push('--restart', restartPolicy);
  
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
    await waitForContainer(runtime, containerName, requirements);
    
    // Build endpoint for web service
    let endpoint: string | undefined;
    if (requirements.network?.ports && requirements.network.ports.length > 0) {
      const primaryPort = requirements.network.ports[0];
      endpoint = `http://localhost:${primaryPort}`;
    }
    
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
        volumes: requirements.storage?.filter(s => s.persistent).map(s => s.volumeName || `${containerName}-data`),
        ports: requirements.network?.ports
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
async function waitForContainer(runtime: string, containerName: string, requirements: any): Promise<void> {
  const maxAttempts = 30;
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    try {
      const status = execSync(
        `${runtime} inspect ${containerName} --format '{{.State.Status}}'`,
        { encoding: 'utf-8' }
      ).trim();
      
      if (status === 'running') {
        // If health check is configured, wait for it
        if (requirements?.network?.healthCheckPath) {
          try {
            const health = execSync(
              `${runtime} inspect ${containerName} --format '{{.State.Health.Status}}'`,
              { encoding: 'utf-8' }
            ).trim();
            
            if (health === 'healthy') {
              return;
            }
          } catch {
            // No health status yet
          }
        } else {
          return; // Container is running, no health check configured
        }
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