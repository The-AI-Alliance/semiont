import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { PlatformResources } from '../../platform-resources.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';

/**
 * Start handler for backend services on POSIX systems
 *
 * Starts the backend Node.js process using the configuration from
 * the backend source directory's .env and logs
 */
const startBackendService = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service, options } = context;
  
  // Get semiont repo path
  const semiontRepo = options.semiontRepo || process.env.SEMIONT_REPO;
  if (!semiontRepo) {
    return {
      success: false,
      error: 'Semiont repository path is required. Use --semiont-repo or set SEMIONT_REPO environment variable',
      metadata: { serviceType: 'backend' }
    };
  }
  
  const backendSourceDir = path.join(semiontRepo, 'apps', 'backend');
  if (!fs.existsSync(backendSourceDir)) {
    return {
      success: false,
      error: `Backend source not found at ${backendSourceDir}`,
      metadata: { serviceType: 'backend', semiontRepo }
    };
  }
  
  // All runtime files are in the source directory
  const envFile = path.join(backendSourceDir, '.env');
  const pidFile = path.join(backendSourceDir, '.pid');
  const logsDir = path.join(backendSourceDir, 'logs');
  const tmpDir = path.join(backendSourceDir, 'tmp');
  
  // Check if backend is provisioned (by checking for .env)
  if (!fs.existsSync(envFile)) {
    return {
      success: false,
      error: `Backend not provisioned. Run: semiont provision --service backend --environment ${service.environment} --semiont-repo ${semiontRepo}`,
      metadata: { serviceType: 'backend', backendSourceDir }
    };
  }
  
  // Check if already running
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'));
    try {
      // Check if process is actually running
      process.kill(pid, 0);
      return {
        success: false,
        error: `Backend is already running with PID ${pid}`,
        metadata: { serviceType: 'backend', pid }
      };
    } catch {
      // Process not running, remove stale pid file
      fs.unlinkSync(pidFile);
    }
  }
  
  // Check port availability
  const port = service.config.port || 4000;
  if (await isPortInUse(port)) {
    return {
      success: false,
      error: `Port ${port} is already in use`,
      metadata: { serviceType: 'backend', port }
    };
  }
  
  // Load environment variables from .env
  const envVars: Record<string, string> = {};
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    envContent.split('\n').forEach(line => {
      if (!line.startsWith('#') && line.includes('=')) {
        const [key, ...valueParts] = line.split('=');
        envVars[key.trim()] = valueParts.join('=').trim();
      }
    });
  } else {
    printWarning(`.env not found, using defaults`);
  }
  
  // Merge environment variables - ensure all values are strings
  const processEnvStrings: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      processEnvStrings[key] = value;
    }
  }
  
  const env: Record<string, string> = {
    ...processEnvStrings,
    ...envVars,
    NODE_ENV: envVars.NODE_ENV || 'development',
    PORT: port.toString(),
    LOG_DIR: logsDir,
    TMP_DIR: tmpDir
  };
  
  // Ensure logs directory exists
  fs.mkdirSync(logsDir, { recursive: true });
  
  // Setup log files
  const appLogPath = path.join(logsDir, 'app.log');
  const errorLogPath = path.join(logsDir, 'error.log');
  
  // Create/open log streams
  const appLogStream = fs.createWriteStream(appLogPath, { flags: 'a' });
  const errorLogStream = fs.createWriteStream(errorLogPath, { flags: 'a' });
  
  // Write startup marker to logs
  const startupMessage = `\n=== Backend Starting at ${new Date().toISOString()} ===\n`;
  appLogStream.write(startupMessage);
  errorLogStream.write(startupMessage);
  
  if (!service.quiet) {
    printInfo(`Starting backend service ${service.name}...`);
    printInfo(`Source: ${backendSourceDir}`);
    printInfo(`Port: ${port}`);
  }
  
  // Run node directly instead of through npm to ensure environment variables are passed
  const distPath = path.join(backendSourceDir, 'dist', 'index.js');
  
  try {
    // Open log files for writing (process will write directly)
    const appLogFd = fs.openSync(appLogPath, 'a');
    const errorLogFd = fs.openSync(errorLogPath, 'a');
    
    // Spawn the backend process directly with node
    const proc = spawn('node', [distPath], {
      cwd: backendSourceDir,  // Run from source directory
      env,
      detached: true,
      stdio: ['ignore', appLogFd, errorLogFd]  // Redirect stdout/stderr directly to files
    });
    
    if (!proc.pid) {
      fs.closeSync(appLogFd);
      fs.closeSync(errorLogFd);
      throw new Error('Failed to start backend process');
    }
    
    // Save PID
    fs.writeFileSync(pidFile, proc.pid.toString());
    
    // Close file descriptors - the child process has its own references
    fs.closeSync(appLogFd);
    fs.closeSync(errorLogFd);
    
    // Close the log streams we opened for the startup message
    appLogStream.end();
    errorLogStream.end();
    
    // Completely detach from the child process
    proc.unref();
    
    // Wait a moment to check if process started successfully
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Verify process is still running
    try {
      process.kill(proc.pid, 0);
    } catch {
      return {
        success: false,
        error: 'Backend process failed to start. Check logs for details.',
        metadata: {
          serviceType: 'backend',
          logFile: appLogPath,
          errorLogFile: errorLogPath
        }
      };
    }
    
    // Build resources
    const resources: PlatformResources = {
      platform: 'posix',
      data: {
        pid: proc.pid,
        port,
        command: `node ${distPath}`,
        workingDirectory: backendSourceDir,
        path: backendSourceDir,
        logFile: appLogPath
      }
    };
    
    const endpoint = `http://localhost:${port}`;
    
    if (!service.quiet) {
      printSuccess(`✅ Backend service ${service.name} started successfully`);
      printInfo('');
      printInfo('Backend details:');
      printInfo(`  PID: ${proc.pid}`);
      printInfo(`  Port: ${port}`);
      printInfo(`  Endpoint: ${endpoint}`);
      printInfo(`  App log: ${appLogPath}`);
      printInfo(`  Error log: ${errorLogPath}`);
      printInfo('');
      printInfo('Commands:');
      printInfo(`  Check status: semiont check --service backend --environment ${service.environment}`);
      printInfo(`  View logs: tail -f ${appLogPath}`);
      printInfo(`  Stop: semiont stop --service backend --environment ${service.environment}`);
    }
    
    return {
      success: true,
      endpoint,
      resources,
      metadata: {
        serviceType: 'backend',
        pid: proc.pid,
        port,
        backendSourceDir,
        logsDir,
        command: `node dist/index.js`
      }
    };
    
  } catch (error) {
    // Clean up PID file if exists
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    
    return {
      success: false,
      error: `Failed to start backend: ${error}`,
      metadata: {
        serviceType: 'backend',
        error: (error as Error).toString()
      }
    };
  }
};

/**
 * Descriptor for backend POSIX start handler
 */
export const backendStartDescriptor: HandlerDescriptor<PosixStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'backend',
  handler: startBackendService
};