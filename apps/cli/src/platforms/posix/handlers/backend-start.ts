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
 * SEMIONT_ROOT/backend/.env.local and logs to SEMIONT_ROOT/backend/logs/
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
  
  // Setup backend runtime directory
  const backendDir = path.join(service.projectRoot, 'backend');
  const envFile = path.join(backendDir, '.env.local');
  const pidFile = path.join(backendDir, '.pid');
  const logsDir = path.join(backendDir, 'logs');
  
  // Check if backend directory exists
  if (!fs.existsSync(backendDir)) {
    return {
      success: false,
      error: `Backend not provisioned. Run: semiont provision --service backend --environment ${service.environment} --semiont-repo ${semiontRepo}`,
      metadata: { serviceType: 'backend', backendDir }
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
  
  // Load environment variables from .env.local
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
    printWarning(`.env.local not found, using defaults`);
  }
  
  // Merge environment variables
  const env = {
    ...process.env,
    ...envVars,
    NODE_ENV: envVars.NODE_ENV || 'development',
    PORT: port.toString(),
    LOG_DIR: logsDir,
    TMP_DIR: path.join(backendDir, 'tmp')
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
    printInfo(`Runtime: ${backendDir}`);
    printInfo(`Port: ${port}`);
  }
  
  // Determine the command to run
  const command = service.config.command || 'npm run dev';
  const [cmd, ...args] = command.split(' ');
  
  try {
    // Spawn the backend process
    const proc = spawn(cmd, args, {
      cwd: backendSourceDir,  // Run from source directory
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    if (!proc.pid) {
      throw new Error('Failed to start backend process');
    }
    
    // Save PID
    fs.writeFileSync(pidFile, proc.pid.toString());
    
    // Pipe stdout to app log
    proc.stdout?.on('data', (data) => {
      appLogStream.write(data);
      if (service.verbose) {
        process.stdout.write(`[backend] ${data}`);
      }
    });
    
    // Pipe stderr to error log
    proc.stderr?.on('data', (data) => {
      errorLogStream.write(data);
      appLogStream.write(data); // Also write errors to app log
      if (service.verbose || data.toString().includes('ERROR')) {
        process.stderr.write(`[backend] ${data}`);
      }
    });
    
    // Handle process exit
    proc.on('exit', (code, signal) => {
      const exitMessage = `\n=== Backend Exited at ${new Date().toISOString()} (code: ${code}, signal: ${signal}) ===\n`;
      appLogStream.write(exitMessage);
      errorLogStream.write(exitMessage);
      
      // Clean up PID file
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
      
      // Close log streams
      appLogStream.end();
      errorLogStream.end();
    });
    
    // Detach the process so it continues after parent exits
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
        command,
        workingDirectory: backendSourceDir,
        path: backendDir,
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
        backendDir,
        logsDir,
        command
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