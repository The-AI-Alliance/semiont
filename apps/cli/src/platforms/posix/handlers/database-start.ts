import { spawn } from 'child_process';
import * as fs from 'fs';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { PlatformResources } from '../../platform-resources.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import type { DatabaseServiceConfig } from '@semiont/core';
import { checkCommandAvailable, checkPortFree, checkConfigPort, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';
import { getDatabasePaths } from './database-paths.js';

/**
 * Start handler for database services on POSIX systems
 */
const startDatabaseService = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const config = service.config as DatabaseServiceConfig;
  const command = service.getCommand();

  // Check network port availability
  const primaryPort = config.port;
  if (await isPortInUse(primaryPort)) {
    return {
      success: false,
      error: `Port ${primaryPort} is already in use`,
      metadata: {
        serviceType: 'database',
        port: primaryPort
      }
    };
  }

  // Get database paths
  const paths = getDatabasePaths(context);
  const { dataDir, pidFile } = paths;
  fs.mkdirSync(dataDir, { recursive: true });

  // Build environment from config
  const env = {
    ...process.env,
    ...service.getEnvironmentVariables(),
    DATA_DIR: dataDir
  };
  
  // Add port
  (env as any).PORT = primaryPort.toString();
  (env as any).DATABASE_PORT = primaryPort.toString();

  // Add database-specific environment variables from config
  if (config.database) {
    (env as any).DATABASE_NAME = config.database;
  }
  if (config.username) {
    (env as any).DATABASE_USER = config.username;
  }
  if (config.password) {
    (env as any).DATABASE_PASSWORD = config.password;
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

    // Write PID file
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(pidFile, proc.pid.toString());

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
    const dbType = config.type;
    const host = 'localhost';
    const dbName = config.database;

    switch (dbType) {
      case 'postgres':
      case 'postgresql':
        endpoint = `postgresql://${host}:${primaryPort}/${dbName}`;
        break;
      case 'mysql':
      case 'mariadb':
        endpoint = `mysql://${host}:${primaryPort}/${dbName}`;
        break;
      case 'mongodb':
      case 'mongo':
        endpoint = `mongodb://${host}:${primaryPort}/${dbName}`;
        break;
      case 'redis':
        endpoint = `redis://${host}:${primaryPort}`;
        break;
      default:
        endpoint = `${dbType}://${host}:${primaryPort}`;
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
        databaseType: config.type,
        command,
        pid: proc.pid,
        port: primaryPort,
        dataDir,
        stdio: service.quiet ? 'minimal' : (service.verbose ? 'inherit' : 'pipe')
      }
    };
  } catch (error) {
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
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

const preflightDatabaseStart = async (context: PosixStartHandlerContext): Promise<PreflightResult> => {
  const config = context.service.config as DatabaseServiceConfig;
  const command = context.service.getCommand();
  const runtime = command.split(' ')[0];
  return preflightFromChecks([
    checkCommandAvailable(runtime),
    checkConfigPort(config.port, 'database.port'),
    await checkPortFree(config.port),
  ]);
};

/**
 * Descriptor for database service start handler
 */
export const databaseStartDescriptor: HandlerDescriptor<PosixStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'database',
  handler: startDatabaseService,
  preflight: preflightDatabaseStart
};