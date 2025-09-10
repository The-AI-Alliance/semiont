import { execSync } from 'child_process';
import { ContainerStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';
import { printInfo, printWarning } from '../../../core/io/cli-logger.js';

/**
 * Start handler for database services in containers
 */
const startDatabaseContainer = async (context: ContainerStartHandlerContext): Promise<StartHandlerResult> => {
  const { service, runtime, containerName } = context;
  const requirements = service.getRequirements();
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
  
  // Build run command for database
  const runArgs: string[] = [
    'run',
    '-d',
    '--name', containerName,
    '--network', networkName
  ];
  
  // Add port mappings for database
  if (requirements.network?.ports) {
    for (const port of requirements.network.ports) {
      runArgs.push('-p', `${port}:${port}`);
    }
  } else {
    // Default database ports
    const defaultPort = image.includes('postgres') ? 5432 : 
                       image.includes('mysql') ? 3306 : 
                       image.includes('mongo') ? 27017 : null;
    if (defaultPort) {
      runArgs.push('-p', `${defaultPort}:${defaultPort}`);
    }
  }
  
  // Add environment variables (including database credentials)
  // These MUST be configured in the environment JSON - no defaults!
  const envVars = {
    ...service.getEnvironmentVariables(),
    ...(requirements.environment || {})
  };
  
  if (context.options.verbose) {
    printInfo(`Database environment variables configured: ${Object.keys(envVars).join(', ')}`);
  }
  
  for (const [key, value] of Object.entries(envVars)) {
    runArgs.push('-e', `${key}=${value}`);
  }
  
  // Add persistent volume for database data
  const volumeName = `${containerName}-data`;
  try {
    execSync(`${runtime} volume create ${volumeName}`, { stdio: 'ignore' });
  } catch {
    // Volume might already exist
  }
  
  // Mount volume at appropriate path based on database type
  const mountPath = image.includes('postgres') ? '/var/lib/postgresql/data' :
                   image.includes('mysql') ? '/var/lib/mysql' :
                   image.includes('mongo') ? '/data/db' :
                   '/data';
  runArgs.push('-v', `${volumeName}:${mountPath}`);
  
  // Add resource limits (databases need more resources)
  if (requirements.resources) {
    if (requirements.resources.memory) {
      runArgs.push('--memory', requirements.resources.memory);
    } else {
      runArgs.push('--memory', '1g'); // Default 1GB for databases
    }
    if (requirements.resources.cpu) {
      runArgs.push('--cpus', requirements.resources.cpu);
    }
  } else {
    runArgs.push('--memory', '1g');
  }
  
  // Add security settings
  if (requirements.security) {
    if (requirements.security.runAsUser) {
      runArgs.push('--user', requirements.security.runAsUser.toString());
    }
    if (!requirements.security.allowPrivilegeEscalation) {
      runArgs.push('--security-opt', 'no-new-privileges');
    }
  }
  
  // Add restart policy (databases should always restart)
  runArgs.push('--restart', 'unless-stopped');
  
  // Add the image
  runArgs.push(image);
  
  // Run container
  const runCommand = `${runtime} ${runArgs.join(' ')}`;
  
  if (!service.quiet) {
    printInfo(`Starting database container: ${containerName}`);
  }
  
  if (context.options.verbose) {
    printInfo(`Run command: ${runCommand}`);
  }
  
  try {
    const containerId = execSync(runCommand, { encoding: 'utf-8' }).trim();
    
    // Wait for database to be ready (databases take longer)
    const dbUser = envVars.POSTGRES_USER || envVars.MYSQL_USER || envVars.MONGO_INITDB_ROOT_USERNAME;
    await waitForDatabase(runtime, containerName, image, service.quiet || false, dbUser, context.options.verbose);
    
    // Build endpoint for database
    let endpoint: string | undefined;
    const port = requirements.network?.ports?.[0] || 
                (image.includes('postgres') ? 5432 : 
                 image.includes('mysql') ? 3306 : 
                 image.includes('mongo') ? 27017 : null);
    
    if (port) {
      endpoint = `localhost:${port}`;
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
        serviceType: 'database',
        containerName,
        image,
        runtime,
        volume: volumeName,
        port,
        databaseType: image.includes('postgres') ? 'postgresql' :
                     image.includes('mysql') ? 'mysql' :
                     image.includes('mongo') ? 'mongodb' : 'unknown'
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to start database container: ${error}`,
      metadata: {
        serviceType: 'database',
        containerName,
        runtime
      }
    };
  }
};

/**
 * Wait for database to be ready
 */
async function waitForDatabase(runtime: string, containerName: string, image: string, quiet: boolean, dbUser?: string, verbose?: boolean): Promise<void> {
  const maxAttempts = 15; // 15 seconds should be enough
  let attempts = 0;
  
  // Give container a moment to initialize
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // For development, we can be less strict about health checks
  const skipHealthCheck = process.env.SKIP_DB_HEALTH_CHECK === 'true';
  
  // Skip health check if requested or just check if container is running
  if (skipHealthCheck) {
    try {
      const status = execSync(
        `${runtime} inspect ${containerName} --format '{{.State.Status}}'`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      
      if (status === 'running') {
        // Just give it a few seconds to initialize
        await new Promise(resolve => setTimeout(resolve, 3000));
        return;
      }
    } catch {
      // Container not ready
    }
    throw new Error(`Database container ${containerName} failed to start`);
  }
  
  while (attempts < maxAttempts) {
    try {
      const status = execSync(
        `${runtime} inspect ${containerName} --format '{{.State.Status}}'`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      
      if (verbose && attempts === 0) {
        printInfo(`Container status: ${status}`);
      }
      
      if (status === 'running') {
        // Check if database is accepting connections
        if (image.includes('postgres')) {
          if (!dbUser) {
            // If no user is configured, skip the health check
            if (!quiet) {
              printWarning(`No POSTGRES_USER configured, skipping health check`);
            }
            return;
          }
          try {
            // Use pg_isready with the configured user
            if (verbose) {
              printInfo(`Checking PostgreSQL readiness with user '${dbUser}'...`);
            }
            execSync(`${runtime} exec ${containerName} pg_isready -U ${dbUser} -t 1`, { 
              stdio: verbose ? 'inherit' : 'ignore',
              timeout: 5000 
            });
            // Give it another second to fully initialize
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (verbose) {
              printInfo(`PostgreSQL is ready`);
            }
            return;
          } catch (e) {
            // Not ready yet, continue waiting
            if (verbose || (!quiet && attempts === maxAttempts - 1)) {
              printInfo(`PostgreSQL not responding to pg_isready with user '${dbUser}' (attempt ${attempts + 1}/${maxAttempts})`);
            }
          }
        } else if (image.includes('mysql')) {
          try {
            execSync(`${runtime} exec ${containerName} mysqladmin ping -h localhost`, { 
              stdio: 'ignore',
              timeout: 5000 
            });
            return;
          } catch {
            // Not ready yet
          }
        } else if (image.includes('mongo')) {
          try {
            execSync(`${runtime} exec ${containerName} mongosh --eval "db.adminCommand('ping')"`, { 
              stdio: 'ignore',
              timeout: 5000 
            });
            return;
          } catch {
            // Not ready yet
          }
        } else {
          // Generic database, just wait a bit
          await new Promise(resolve => setTimeout(resolve, 3000));
          return;
        }
      }
    } catch (error) {
      // Container might not be ready yet
      if (!quiet && attempts % 5 === 0) {
        printInfo(`Waiting for database to be ready... (${attempts + 1}/${maxAttempts})`);
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
  }
  
  // If we've exhausted attempts, just continue - database might still work
  printWarning(`Database container ${containerName} is taking longer than expected to start`);
}

/**
 * Descriptor for database container start handler
 */
export const databaseStartDescriptor: HandlerDescriptor<ContainerStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'container',
  serviceType: 'database',
  handler: startDatabaseContainer
};