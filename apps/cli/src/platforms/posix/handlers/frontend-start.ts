import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import type { FrontendServiceConfig } from '@semiont/core';
import { PlatformResources } from '../../platform-resources.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { resolveFrontendNpmPackage, resolveFrontendServerScript, frontendXdgPaths } from './frontend-paths.js';
import { checkPortFree, checkCommandAvailable, checkConfigPort, checkFileExists, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Start handler for frontend services on POSIX systems
 *
 * Starts the frontend Node.js process using @semiont/frontend bundled with the CLI.
 */
const startFrontendService = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const config = service.config as FrontendServiceConfig;

  const npmDir = resolveFrontendNpmPackage();
  if (!npmDir) {
    return {
      success: false,
      error: 'Frontend package not found. Reinstall @semiont/cli to restore it.',
      metadata: { serviceType: 'frontend' }
    };
  }
  const serverScript = resolveFrontendServerScript() ?? path.join(npmDir, 'server.js');
  const { pidFile, logsDir, appLogFile, errorLogFile } = frontendXdgPaths();

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

  // Check if already running
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'));
    try {
      process.kill(pid, 0);
      if (!service.quiet) {
        printInfo(`Frontend is already running with PID ${pid}`);
      }
      return {
        success: true,
        metadata: { serviceType: 'frontend', pid, alreadyRunning: true }
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

  const envConfig = service.environmentConfig;
  const frontendService = envConfig.services['frontend']! as import('@semiont/core').FrontendServiceConfig;
  const frontendUrl = frontendService.publicURL!;
  const oauthAllowedDomains = envConfig.site?.oauthAllowedDomains || [];

  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    NODE_ENV: envConfig.env?.NODE_ENV ?? 'development',
    PORT: port.toString(),
    SEMIONT_SITE_NAME: config.siteName,
    SEMIONT_BASE_URL: frontendUrl,
    SEMIONT_OAUTH_ALLOWED_DOMAINS: oauthAllowedDomains.join(','),
    LOG_DIR: logsDir,
  };

  // Ensure logs and pid directories exist
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });

  // Setup log files
  const appLogStream = fs.createWriteStream(appLogFile, { flags: 'a' });
  const errorLogStream = fs.createWriteStream(errorLogFile, { flags: 'a' });

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
    const appLogFd = fs.openSync(appLogFile, 'a');
    const errorLogFd = fs.openSync(errorLogFile, 'a');

    const proc = spawn(command, args, {
      cwd: path.dirname(serverScript),
      env,
      detached: true,
      stdio: ['ignore', appLogFd, errorLogFd]
    });

    if (!proc.pid) {
      fs.closeSync(appLogFd);
      fs.closeSync(errorLogFd);
      throw new Error('Failed to start frontend process');
    }

    fs.writeFileSync(pidFile, proc.pid.toString());

    fs.closeSync(appLogFd);
    fs.closeSync(errorLogFd);

    appLogStream.end();
    errorLogStream.end();

    proc.unref();

    // Wait a moment to check if process started successfully
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      process.kill(proc.pid, 0);
    } catch {
      // Read last few lines from error log for diagnostics
      let logTail = '';
      try {
        const logContent = fs.readFileSync(errorLogFile, 'utf-8');
        const lines = logContent.split('\n').filter(l => l.trim());
        const tail = lines.slice(-10).join('\n');
        if (tail) logTail = `\n\nLast lines from error log:\n${tail}`;
      } catch { /* log may not exist */ }

      const portCheck = await checkPortFree(port);
      const portNote = !portCheck.pass ? `\n\n${portCheck.message}` : '';

      return {
        success: false,
        error: `Frontend process failed to start.\n\nError log: ${errorLogFile}${portNote}${logTail}`,
        metadata: {
          serviceType: 'frontend',
          logFile: appLogFile,
          errorLogFile
        }
      };
    }

    const commandStr = `node ${serverScript}`;
    const resources: PlatformResources = {
      platform: 'posix',
      data: {
        pid: proc.pid,
        port,
        command: commandStr,
        workingDirectory: path.dirname(serverScript),
        path: serverScript,
        logFile: appLogFile
      }
    };

    const endpoint = `http://localhost:${port}`;

    if (!service.quiet) {
      printSuccess(`Frontend service ${service.name} started successfully`);
      printInfo('');
      printInfo('Frontend details:');
      printInfo(`  PID: ${proc.pid}`);
      printInfo(`  Port: ${port}`);
      printInfo(`  Endpoint: ${endpoint}`);
      printInfo(`  App log: ${appLogFile}`);
      printInfo(`  Error log: ${errorLogFile}`);
      printInfo('');
      printInfo('Commands:');
      const envFlag = service.projectRoot ? ` --environment ${service.environment}` : '';
      printInfo(`  Check status: semiont check --service frontend${envFlag}`);
      printInfo(`  View logs: tail -f ${appLogFile}`);
      printInfo(`  Stop: semiont stop --service frontend${envFlag}`);
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
  const npmDir = resolveFrontendNpmPackage();
  const checks = [checkCommandAvailable('node')];
  checks.push(checkConfigPort(config.port, 'frontend.port'));
  if (config.port) {
    checks.push(await checkPortFree(config.port));
  }
  if (npmDir) {
    const serverScript = resolveFrontendServerScript() ?? path.join(npmDir, 'server.js');
    checks.push(checkFileExists(serverScript, 'frontend server.js'));
  } else {
    checks.push({ name: 'frontend-npm-package', pass: false, message: '@semiont/frontend not found — reinstall @semiont/cli' });
  }
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
