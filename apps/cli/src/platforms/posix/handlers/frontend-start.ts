import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import type { FrontendServiceConfig } from '@semiont/core';
import { PlatformResources } from '../../platform-resources.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { resolveFrontendNpmPackage } from './frontend-paths.js';
import { SemiontProject } from '@semiont/core/node';
import { checkPortFree, checkCommandAvailable, checkConfigPort, checkFileExists, checkJwtSecretExists, readSecret, getSecretsFilePath, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Start handler for frontend services on POSIX systems
 *
 * Starts the frontend Node.js process using the configuration from
 * the frontend source directory's .env.local and logs
 */
const startFrontendService = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const config = service.config as FrontendServiceConfig;

  const projectRoot = service.projectRoot;
  const npmDir = resolveFrontendNpmPackage(projectRoot);
  if (!npmDir) {
    return {
      success: false,
      error: 'Frontend not provisioned. Run: semiont provision --service frontend',
      metadata: { serviceType: 'frontend' }
    };
  }
  const serverScript = path.join(npmDir, '.next', 'standalone', 'apps', 'frontend', 'server.js');
  const project = new SemiontProject(projectRoot);
  const pidFile = project.frontendPidFile;
  const logsDir = project.frontendLogsDir;

  if (service.verbose) {
    printInfo(`Server script: ${serverScript}`);
  }

  if (!fs.existsSync(serverScript)) {
    return {
      success: false,
      error: `Frontend server script not found at ${serverScript}`,
      metadata: { serviceType: 'frontend' }
    };
  }

  // Check if frontend is provisioned (logsDir created by provision)
  if (!fs.existsSync(logsDir)) {
    return {
      success: false,
      error: `Frontend not provisioned. Run: semiont provision --service frontend --environment ${service.environment}`,
      metadata: { serviceType: 'frontend', serverScript }
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
  
  const port = config.port!;

  if (await isPortInUse(port)) {
    return {
      success: false,
      error: `Port ${port} is already in use`,
      metadata: { serviceType: 'frontend', port }
    };
  }

  const jwtSecret = readSecret('JWT_SECRET');
  if (!jwtSecret) throw new Error(`JWT_SECRET not found in ${getSecretsFilePath()} — run: semiont provision`);

  const envConfig = service.environmentConfig;
  const backendService = envConfig.services['backend']!;
  const backendUrl = `http://127.0.0.1:${backendService.port!}`;
  const frontendService = envConfig.services['frontend']!;
  const frontendUrl = frontendService.publicURL!;
  const oauthAllowedDomains = envConfig.site?.oauthAllowedDomains || [];
  const allowedOrigins: string[] = [...(frontendService.allowedOrigins || [])];
  allowedOrigins.push(new URL(frontendUrl).host);

  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    NODE_ENV: envConfig.env?.NODE_ENV ?? 'development',
    PORT: port.toString(),
    NEXTAUTH_URL: frontendUrl,
    SERVER_API_URL: backendUrl,
    NEXT_PUBLIC_SITE_NAME: config.siteName,
    NEXT_PUBLIC_BASE_URL: frontendUrl,
    NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS: oauthAllowedDomains.join(','),
    NEXT_PUBLIC_ALLOWED_ORIGINS: allowedOrigins.join(','),
    LOG_DIR: logsDir,
    NEXTAUTH_SECRET: jwtSecret
  };

  // Debug: log NEXT_PUBLIC_* env vars
  const nextPublicVars = Object.keys(env).filter(k => k.startsWith('NEXT_PUBLIC_'));
  if (!service.quiet) {
    printInfo(`Environment variables: ${nextPublicVars.length} NEXT_PUBLIC_* vars found`);
    nextPublicVars.forEach(k => printInfo(`  ${k}=${(env as Record<string, string>)[k]}`));
  }
  
  // Ensure logs and pid directories exist
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  
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
    printInfo(`Server script: ${serverScript}`);
    printInfo(`Port: ${port}`);
    printInfo(`Mode: ${config.devMode ? 'development' : 'production'}`);
  }

  const command = 'node';
  const args = [serverScript];

  try {
    // Open log files for writing (process will write directly)
    const appLogFd = fs.openSync(appLogPath, 'a');
    const errorLogFd = fs.openSync(errorLogPath, 'a');

    // Spawn the frontend process with stdio redirected to files
    const proc = spawn(command, args, {
      cwd: path.dirname(serverScript),
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
    const commandStr = `node ${serverScript}`;
    const resources: PlatformResources = {
      platform: 'posix',
      data: {
        pid: proc.pid,
        port,
        command: commandStr,
        workingDirectory: path.dirname(serverScript),
        path: serverScript,
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
        serverScript,
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

const preflightFrontendStart = async (context: PosixStartHandlerContext): Promise<PreflightResult> => {
  const config = context.service.config as FrontendServiceConfig;
  const projectRoot = context.service.projectRoot;
  const npmDir = resolveFrontendNpmPackage(projectRoot);
  const project = new SemiontProject(projectRoot);
  const checks = [checkCommandAvailable('node')];
  checks.push(checkConfigPort(config.port, 'frontend.port'));
  if (config.port) {
    checks.push(await checkPortFree(config.port));
  }
  if (npmDir) {
    checks.push(checkFileExists(
      path.join(npmDir, '.next', 'standalone', 'apps', 'frontend', 'server.js'),
      'frontend server.js'
    ));
  } else {
    checks.push({ name: 'frontend-npm-package', pass: false, message: '@semiont/frontend not installed — run: semiont provision' });
  }
  checks.push(
    checkFileExists(project.frontendLogsDir, 'frontend logs dir (run: semiont provision)'),
    checkJwtSecretExists(),
  );
  return preflightFromChecks(checks);
};

/**
 * Descriptor for frontend POSIX start handler
 */
export const frontendStartDescriptor: HandlerDescriptor<PosixStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'frontend',
  handler: startFrontendService,
  preflight: preflightFrontendStart
};