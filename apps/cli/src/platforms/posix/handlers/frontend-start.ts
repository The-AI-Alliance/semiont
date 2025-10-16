import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { PlatformResources } from '../../platform-resources.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';

/**
 * Start handler for frontend services on POSIX systems
 * 
 * Starts the frontend Node.js process using the configuration from
 * SEMIONT_ROOT/frontend/.env.local and logs to SEMIONT_ROOT/frontend/logs/
 */
const startFrontendService = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service, options } = context;
  
  // Get semiont repo path
  const semiontRepo = options.semiontRepo || process.env.SEMIONT_REPO;
  if (!semiontRepo) {
    return {
      success: false,
      error: 'Semiont repository path is required. Use --semiont-repo or set SEMIONT_REPO environment variable',
      metadata: { serviceType: 'frontend' }
    };
  }
  
  const frontendSourceDir = path.join(semiontRepo, 'apps', 'frontend');
  if (!fs.existsSync(frontendSourceDir)) {
    return {
      success: false,
      error: `Frontend source not found at ${frontendSourceDir}`,
      metadata: { serviceType: 'frontend', semiontRepo }
    };
  }
  
  // Setup frontend runtime directory
  const frontendDir = path.join(service.projectRoot, 'frontend');
  const envFile = path.join(frontendDir, '.env.local');
  const pidFile = path.join(frontendDir, '.pid');
  const logsDir = path.join(frontendDir, 'logs');
  
  // Check if frontend directory exists
  if (!fs.existsSync(frontendDir)) {
    return {
      success: false,
      error: `Frontend not provisioned. Run: semiont provision --service frontend --environment ${service.environment} --semiont-repo ${semiontRepo}`,
      metadata: { serviceType: 'frontend', frontendDir }
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
        error: `Frontend is already running with PID ${pid}`,
        metadata: { serviceType: 'frontend', pid }
      };
    } catch {
      // Process not running, remove stale pid file
      fs.unlinkSync(pidFile);
    }
  }
  
  // Check port availability
  const port = service.config.port || 3000;
  if (await isPortInUse(port)) {
    return {
      success: false,
      error: `Port ${port} is already in use`,
      metadata: { serviceType: 'frontend', port }
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
    
    // Copy .env.local to source directory so Next.js can find it
    // Next.js's dotenv loader doesn't follow symlinks, so we must copy
    const sourceEnvFile = path.join(frontendSourceDir, '.env.local');
    if (fs.existsSync(sourceEnvFile)) {
      // Remove existing file/symlink
      fs.unlinkSync(sourceEnvFile);
    }
    // Copy from runtime to source .env.local
    fs.copyFileSync(envFile, sourceEnvFile);
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
    TMP_DIR: path.join(frontendDir, 'tmp')
  };

  // Debug: log NEXT_PUBLIC_* env vars
  const nextPublicVars = Object.keys(env).filter(k => k.startsWith('NEXT_PUBLIC_'));
  if (!service.quiet) {
    printInfo(`Environment variables: ${nextPublicVars.length} NEXT_PUBLIC_* vars found`);
    nextPublicVars.forEach(k => printInfo(`  ${k}=${(env as Record<string, string>)[k]}`));
  }
  
  // Ensure logs directory exists
  fs.mkdirSync(logsDir, { recursive: true });
  
  // Setup log files
  const appLogPath = path.join(logsDir, 'app.log');
  const errorLogPath = path.join(logsDir, 'error.log');
  
  // Create/open log streams
  const appLogStream = fs.createWriteStream(appLogPath, { flags: 'a' });
  const errorLogStream = fs.createWriteStream(errorLogPath, { flags: 'a' });
  
  // Write startup marker to logs
  const startupMessage = `\n=== Frontend Starting at ${new Date().toISOString()} ===\n`;
  appLogStream.write(startupMessage);
  errorLogStream.write(startupMessage);
  
  if (!service.quiet) {
    printInfo(`Starting frontend service ${service.name}...`);
    printInfo(`Source: ${frontendSourceDir}`);
    printInfo(`Runtime: ${frontendDir}`);
    printInfo(`Port: ${port}`);
  }
  
  // Determine the command to run
  const command = service.config.command || 'npm run dev';
  const [cmd, ...args] = command.split(' ');
  
  try {
    // Open log files for writing (process will write directly)
    const appLogFd = fs.openSync(appLogPath, 'a');
    const errorLogFd = fs.openSync(errorLogPath, 'a');
    
    // Spawn the frontend process with stdio redirected to files
    const proc = spawn(cmd, args, {
      cwd: frontendSourceDir,  // Run from source directory
      env,
      detached: true,
      stdio: ['ignore', appLogFd, errorLogFd]  // Redirect stdout/stderr directly to files
    });
    
    if (!proc.pid) {
      fs.closeSync(appLogFd);
      fs.closeSync(errorLogFd);
      throw new Error('Failed to start frontend process');
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
        error: 'Frontend process failed to start. Check logs for details.',
        metadata: {
          serviceType: 'frontend',
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
        workingDirectory: frontendSourceDir,
        path: frontendDir,
        logFile: appLogPath
      }
    };
    
    const endpoint = `http://localhost:${port}`;
    
    if (!service.quiet) {
      printSuccess(`✅ Frontend service ${service.name} started successfully`);
      printInfo('');
      printInfo('Frontend details:');
      printInfo(`  PID: ${proc.pid}`);
      printInfo(`  Port: ${port}`);
      printInfo(`  Endpoint: ${endpoint}`);
      printInfo(`  App log: ${appLogPath}`);
      printInfo(`  Error log: ${errorLogPath}`);
      printInfo('');
      printInfo('Commands:');
      printInfo(`  Check status: semiont check --service frontend --environment ${service.environment}`);
      printInfo(`  View logs: tail -f ${appLogPath}`);
      printInfo(`  Stop: semiont stop --service frontend --environment ${service.environment}`);
    }
    
    return {
      success: true,
      endpoint,
      resources,
      metadata: {
        serviceType: 'frontend',
        pid: proc.pid,
        port,
        frontendDir,
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
      error: `Failed to start frontend: ${error}`,
      metadata: {
        serviceType: 'frontend',
        error: (error as Error).toString()
      }
    };
  }
};

/**
 * Descriptor for frontend POSIX start handler
 */
export const frontendStartDescriptor: HandlerDescriptor<PosixStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'frontend',
  handler: startFrontendService
};