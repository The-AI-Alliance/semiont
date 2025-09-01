import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { StartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { PlatformResources } from '../../platform-resources.js';
import { isPortInUse } from '../../../core/io/network-utils.js';

/**
 * Start handler for database services on POSIX systems
 */
const startDatabaseService = async (context: StartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const requirements = service.getRequirements();
  const command = service.getCommand();
  
  // Check network port availability
  const primaryPort = requirements.network?.ports?.[0];
  if (primaryPort && await isPortInUse(primaryPort)) {
    return {
      success: false,
      error: `Port ${primaryPort} is already in use`,
      metadata: {
        serviceType: 'database',
        port: primaryPort
      }
    };
  }
  
  // Ensure data directory exists for database
  const dataDir = requirements.storage?.[0]?.mountPath || 
                  path.join(process.cwd(), 'data', service.name);
  fs.mkdirSync(dataDir, { recursive: true });
  
  // Build environment from requirements
  const env = {
    ...process.env,
    ...service.getEnvironmentVariables(),
    ...(requirements.environment || {}),
    NODE_ENV: service.environment,
    DATA_DIR: dataDir
  };
  
  // Add port if specified
  if (primaryPort) {
    (env as any).PORT = primaryPort.toString();
    (env as any).DATABASE_PORT = primaryPort.toString();
  }
  
  // Add database-specific environment variables
  if (requirements.database) {
    if (requirements.database.name) {
      (env as any).DATABASE_NAME = requirements.database.name;
    }
    if (requirements.database.user) {
      (env as any).DATABASE_USER = requirements.database.user;
    }
    if (requirements.database.password) {
      (env as any).DATABASE_PASSWORD = requirements.database.password;
    }
  }
  
  // Parse command
  const [cmd, ...args] = command.split(' ');
  
  // For process platform, run commands in the current directory
  const workingDir = process.cwd();
  
  // Database services should typically log errors
  let stdio: any;
  if (service.quiet) {
    stdio = ['ignore', 'ignore', 'pipe']; // Still capture stderr for databases
  } else if (service.verbose) {
    stdio = 'inherit';
  } else {
    stdio = ['ignore', 'pipe', 'pipe'];
  }
  
  try {
    const proc = spawn(cmd, args, {
      cwd: workingDir,
      env,
      detached: true,
      stdio
    });
    
    if (!proc.pid) {
      throw new Error('Failed to start database process');
    }
    
    // Always log database errors
    if (Array.isArray(stdio) && stdio[2] === 'pipe' && proc.stderr) {
      proc.stderr.on('data', (data) => {
        console.error(`[${service.name}] ${data.toString()}`);
      });
    }
    
    // Log startup info if verbose
    if (Array.isArray(stdio) && stdio[1] === 'pipe' && proc.stdout && !service.quiet) {
      proc.stdout.on('data', (data) => {
        if (service.verbose) {
          console.log(`[${service.name}] ${data.toString()}`);
        }
      });
    }
    
    proc.unref();
    
    // Build connection string for database
    let endpoint: string | undefined;
    if (primaryPort) {
      const dbType = requirements.database?.type || 'generic';
      const host = 'localhost';
      
      switch (dbType) {
        case 'postgres':
        case 'postgresql':
          endpoint = `postgresql://${host}:${primaryPort}/${requirements.database?.name || 'postgres'}`;
          break;
        case 'mysql':
        case 'mariadb':
          endpoint = `mysql://${host}:${primaryPort}/${requirements.database?.name || 'mysql'}`;
          break;
        case 'mongodb':
        case 'mongo':
          endpoint = `mongodb://${host}:${primaryPort}/${requirements.database?.name || 'admin'}`;
          break;
        case 'redis':
          endpoint = `redis://${host}:${primaryPort}`;
          break;
        default:
          endpoint = `${dbType}://${host}:${primaryPort}`;
      }
    }
    
    const resources: PlatformResources = {
      platform: 'posix',
      data: {
        pid: proc.pid,
        port: primaryPort,
        command,
        workingDirectory: workingDir,
        path: dataDir  // Use path for data directory
      }
    };
    
    // Wait a moment for database to initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return {
      success: true,
      endpoint,
      resources,
      metadata: {
        serviceType: 'database',
        databaseType: requirements.database?.type,
        command,
        pid: proc.pid,
        port: primaryPort,
        dataDir,
        stdio: service.quiet ? 'minimal' : (service.verbose ? 'inherit' : 'pipe')
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to start database service: ${error}`,
      metadata: {
        serviceType: 'database',
        command
      }
    };
  }
};

/**
 * Descriptor for database service start handler
 */
export const databaseStartDescriptor: HandlerDescriptor<StartHandlerContext, StartHandlerResult> = {
  command: 'start',
  serviceType: 'database',
  handler: startDatabaseService
};