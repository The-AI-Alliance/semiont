import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import type { FrontendServiceConfig } from '@semiont/core';
import { PlatformResources } from '../../platform-resources.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { getFrontendPaths } from './frontend-paths.js';

/**
 * Start handler for frontend services on POSIX systems
 *
 * Starts the frontend Node.js process using the configuration from
 * the frontend source directory's .env.local and logs
 */
const startFrontendService = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const config = service.config as FrontendServiceConfig;

  // Get frontend paths
  const paths = getFrontendPaths(context);
  const { sourceDir: frontendSourceDir, envLocalFile: envFile, pidFile, logsDir, tmpDir } = paths;

  if (!fs.existsSync(frontendSourceDir)) {
    return {
      success: false,
      error: `Frontend source not found at ${frontendSourceDir}`,
      metadata: { serviceType: 'frontend' }
    };
  }
  
  // Check if frontend is provisioned (by checking for .env.local)
  if (!fs.existsSync(envFile)) {
    return {
      success: false,
      error: `Frontend not provisioned. Run: semiont provision --service frontend --environment ${service.environment}`,
      metadata: { serviceType: 'frontend', frontendSourceDir }
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
  
  const port = service.config.port;
  if (!port) {
    throw new Error('Frontend port not configured');
  }

  if (await isPortInUse(port)) {
    return {
      success: false,
      error: `Port ${port} is already in use`,
      metadata: { serviceType: 'frontend', port }
    };
  }

  const envContent = fs.readFileSync(envFile, 'utf-8');
  const envVars: Record<string, string> = {};
  envContent.split('\n').forEach(line => {
    if (!line.startsWith('#') && line.includes('=')) {
      const [key, ...valueParts] = line.split('=');
      envVars[key.trim()] = valueParts.join('=').trim();
    }
  });

  if (!envVars.NODE_ENV) {
    throw new Error('NODE_ENV not found in .env.local');
  }

  const env = {
    ...process.env,
    ...envVars,
    PORT: port.toString(),
    LOG_DIR: logsDir,
    TMP_DIR: tmpDir
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
    printInfo(`Port: ${port}`);
    printInfo(`Mode: ${config.devMode ? 'development' : 'production'}`);
  }

  // Determine command based on devMode
  const command = config.devMode ? 'npm' : 'npm';
  const args = config.devMode ? ['run', 'dev'] : ['start'];

  try {
    // Open log files for writing (process will write directly)
    const appLogFd = fs.openSync(appLogPath, 'a');
    const errorLogFd = fs.openSync(errorLogPath, 'a');

    // Spawn the frontend process with stdio redirected to files
    const proc = spawn(command, args, {
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
    const commandStr = config.devMode ? 'npm run dev' : 'npm start';
    const resources: PlatformResources = {
      platform: 'posix',
      data: {
        pid: proc.pid,
        port,
        command: commandStr,
        workingDirectory: frontendSourceDir,
        path: frontendSourceDir,
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
        frontendSourceDir,
        logsDir,
        command: commandStr
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