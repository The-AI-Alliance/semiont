import { execSync } from 'child_process';
import { ContainerStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { createPlatformResources } from '../../platform-resources.js';
import { printInfo } from '../../../core/io/cli-logger.js';

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
  
  // Build run command for database
  const runArgs: string[] = [
    'run',
    '-d',
    '--name', containerName,
    '--network', `semiont-${service.environment}`
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
  const envVars = {
    ...service.getEnvironmentVariables(),
    ...(requirements.environment || {})
  };
  
  // Add common database environment variables if not present
  if (image.includes('postgres') && !envVars.POSTGRES_DB) {
    envVars.POSTGRES_DB = service.name;
    envVars.POSTGRES_USER = envVars.POSTGRES_USER || 'admin';
    envVars.POSTGRES_PASSWORD = envVars.POSTGRES_PASSWORD || 'changeme';
  } else if (image.includes('mysql') && !envVars.MYSQL_DATABASE) {
    envVars.MYSQL_DATABASE = service.name;
    envVars.MYSQL_ROOT_PASSWORD = envVars.MYSQL_ROOT_PASSWORD || 'changeme';
  } else if (image.includes('mongo') && !envVars.MONGO_INITDB_DATABASE) {
    envVars.MONGO_INITDB_DATABASE = service.name;
    envVars.MONGO_INITDB_ROOT_USERNAME = envVars.MONGO_INITDB_ROOT_USERNAME || 'admin';
    envVars.MONGO_INITDB_ROOT_PASSWORD = envVars.MONGO_INITDB_ROOT_PASSWORD || 'changeme';
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
  
  try {
    const containerId = execSync(runCommand, { encoding: 'utf-8' }).trim();
    
    // Wait for database to be ready (databases take longer)
    await waitForDatabase(runtime, containerName, image);
    
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
async function waitForDatabase(runtime: string, containerName: string, image: string): Promise<void> {
  const maxAttempts = 60; // Databases can take longer
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    try {
      const status = execSync(
        `${runtime} inspect ${containerName} --format '{{.State.Status}}'`,
        { encoding: 'utf-8' }
      ).trim();
      
      if (status === 'running') {
        // Check if database is accepting connections
        if (image.includes('postgres')) {
          try {
            execSync(`${runtime} exec ${containerName} pg_isready`, { stdio: 'ignore' });
            return;
          } catch {
            // Not ready yet
          }
        } else if (image.includes('mysql')) {
          try {
            execSync(`${runtime} exec ${containerName} mysqladmin ping`, { stdio: 'ignore' });
            return;
          } catch {
            // Not ready yet
          }
        } else if (image.includes('mongo')) {
          try {
            execSync(`${runtime} exec ${containerName} mongo --eval "db.adminCommand('ping')"`, { stdio: 'ignore' });
            return;
          } catch {
            // Not ready yet
          }
        } else {
          // Generic database, just wait a bit more
          await new Promise(resolve => setTimeout(resolve, 5000));
          return;
        }
      }
    } catch {
      // Container might not exist yet
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
  }
  
  throw new Error(`Database container ${containerName} failed to start within ${maxAttempts} seconds`);
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