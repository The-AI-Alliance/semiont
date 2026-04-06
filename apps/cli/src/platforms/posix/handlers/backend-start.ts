import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import type { BackendServiceConfig } from '@semiont/core';
import { PlatformResources } from '../../platform-resources.js';
import { isPortInUse, isHostReachable } from '../../../core/io/network-utils.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { resolveBackendNpmPackage, resolveBackendEntryPoint } from './backend-paths.js';
import { SemiontProject } from '@semiont/core/node';
import { checkPortFree, checkCommandAvailable, checkConfigPort, checkConfigField, checkFileExists, checkJwtSecretExists, readSecret, getSecretsFilePath, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Start handler for backend services on POSIX systems
 *
 * Starts the backend Node.js process using the configuration from
 * the backend source directory's .env and logs
 */
const startBackendService = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const config = service.config as BackendServiceConfig;

  const projectRoot = service.projectRoot!;
  const project = new SemiontProject(projectRoot);
  const installPrefix = project.dataHome;
  const npmDir = resolveBackendNpmPackage(installPrefix);
  if (!npmDir) {
    return {
      success: false,
      error: 'Backend not provisioned. Run: semiont provision --service backend',
      metadata: { serviceType: 'backend' }
    };
  }
  const entryPoint = resolveBackendEntryPoint(installPrefix) ?? path.join(npmDir, 'dist', 'index.js');
  const pidFile = project.backendPidFile;
  const logsDir = project.backendLogsDir;

  if (service.verbose) {
    printInfo(`Entry point: ${entryPoint}`);
  }

  if (!fs.existsSync(entryPoint)) {
    return {
      success: false,
      error: `Backend entry point not found at ${entryPoint}`,
      metadata: { serviceType: 'backend' }
    };
  }

  // Check if backend is provisioned (logsDir created by provision)
  if (!fs.existsSync(logsDir)) {
    return {
      success: false,
      error: `Backend not provisioned. Run: semiont provision --service backend --environment ${service.environment}`,
      metadata: { serviceType: 'backend', entryPoint }
    };
  }
  
  // Check if already running
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'));
    try {
      // Check if process is actually running
      process.kill(pid, 0);
      if (!service.quiet) {
        printInfo(`Backend is already running with PID ${pid}`);
      }
      return {
        success: true,
        metadata: { serviceType: 'backend', pid, alreadyRunning: true }
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
      metadata: { serviceType: 'backend', port }
    };
  }

  const processEnvStrings: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      processEnvStrings[key] = value;
    }
  }

  const jwtSecret = readSecret('JWT_SECRET');
  if (!jwtSecret) throw new Error(`JWT_SECRET not found in ${getSecretsFilePath()} — run: semiont provision`);

  const envConfig = service.environmentConfig;
  const dbConfig = envConfig.services!.database!;
  const dbUser = dbConfig.user!;
  const dbPassword = dbConfig.password!;
  const dbName = dbConfig.name!;
  const dbPort = dbConfig.port!;
  const dbHost = dbConfig.host || 'localhost';
  const databaseUrl = `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;
  const nodeEnv = envConfig.env?.NODE_ENV ?? 'development';
  const enableLocalAuth = envConfig.app?.security?.enableLocalAuth ?? (nodeEnv === 'development');
  const backendUrl = config.publicURL!;
  const siteDomain = envConfig.site!.domain!;
  const allowedDomains = envConfig.site!.oauthAllowedDomains!.join(',');

  const env: Record<string, string> = {
    ...processEnvStrings,
    NODE_ENV: nodeEnv,
    PORT: port.toString(),
    HOST: '0.0.0.0',
    DATABASE_URL: databaseUrl,
    LOG_DIR: logsDir,
    BACKEND_URL: backendUrl,
    ENABLE_LOCAL_AUTH: enableLocalAuth.toString(),
    SITE_DOMAIN: siteDomain,
    OAUTH_ALLOWED_DOMAINS: allowedDomains,
    JWT_SECRET: jwtSecret,
    SEMIONT_ROOT: service.projectRoot!,
    SEMIONT_ENV: service.environment,
  };
  
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
  const startupMessage = `\n=== Backend Starting at ${new Date().toISOString()} ===\n`;
  appLogStream.write(startupMessage);
  errorLogStream.write(startupMessage);
  
  // Wait for database to accept connections before running migrations
  const packageDir = path.dirname(path.dirname(entryPoint));
  const prismaSchemaPath = path.join(packageDir, 'prisma', 'schema.prisma');
  if (fs.existsSync(prismaSchemaPath)) {
    if (!service.quiet) {
      printInfo('Waiting for database to be ready...');
    }
    const maxWaitMs = 30_000;
    const pollMs = 500;
    const deadline = Date.now() + maxWaitMs;
    let dbReady = false;
    while (Date.now() < deadline) {
      if (await isHostReachable(dbHost, dbPort, 1000)) {
        dbReady = true;
        break;
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    if (!dbReady) {
      return {
        success: false,
        error: `Database did not become ready within ${maxWaitMs / 1000}s at ${dbHost}:${dbPort}`,
        metadata: { serviceType: 'backend' }
      };
    }

    if (!service.quiet) {
      printInfo('Running database migrations...');
    }
    try {
      execFileSync('npx', ['prisma', 'migrate', 'deploy', `--schema=${prismaSchemaPath}`], {
        cwd: packageDir,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
      if (!service.quiet) {
        printInfo('Database migrations completed');
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to run database migrations: ${error}`,
        metadata: { serviceType: 'backend' }
      };
    }
  }

  if (!service.quiet) {
    printInfo(`Starting backend service ${service.name}...`);
    printInfo(`Entry point: ${entryPoint}`);
    printInfo(`Port: ${port}`);
  }

  const command = 'node';
  const args = [entryPoint];

  try {
    // Open log files for writing (process will write directly)
    const appLogFd = fs.openSync(appLogPath, 'a');
    const errorLogFd = fs.openSync(errorLogPath, 'a');

    // Spawn the backend process
    const proc = spawn(command, args, {
      cwd: projectRoot,
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
    const commandStr = `node ${entryPoint}`;
    const resources: PlatformResources = {
      platform: 'posix',
      data: {
        pid: proc.pid,
        port,
        command: commandStr,
        workingDirectory: path.dirname(entryPoint),
        path: entryPoint,
        logFile: appLogPath
      }
    };
    
    const endpoint = `http://localhost:${port}`;
    
    if (!service.quiet) {
      printSuccess(`Backend service ${service.name} started successfully`);
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
        entryPoint,
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
      error: `Failed to start backend: ${error}`,
      metadata: {
        serviceType: 'backend',
        error: (error as Error).toString()
      }
    };
  }
};

const preflightBackendStart = async (context: PosixStartHandlerContext): Promise<PreflightResult> => {
  const config = context.service.config as BackendServiceConfig;
  const projectRoot = context.service.projectRoot!;
  const project = new SemiontProject(projectRoot);
  const installPrefix = project.dataHome;
  const npmDir = resolveBackendNpmPackage(installPrefix);
  const checks = [checkCommandAvailable('node')];
  checks.push(checkConfigPort(config.port, 'backend.port'));
  if (config.port) {
    checks.push(await checkPortFree(config.port));
  }
  if (npmDir) {
    checks.push(checkFileExists(resolveBackendEntryPoint(installPrefix) ?? path.join(npmDir, 'dist', 'index.js'), 'backend dist/index.js'));
  } else {
    checks.push({ name: 'backend-npm-package', pass: false, message: '@semiont/backend not installed — run: semiont provision' });
  }
  checks.push(
    checkFileExists(project.backendLogsDir, 'backend logs dir (run: semiont provision)'),
    checkJwtSecretExists(),
    checkConfigField(projectRoot, 'projectRoot'),
  );
  return preflightFromChecks(checks);
};

/**
 * Descriptor for backend POSIX start handler
 */
export const backendStartDescriptor: HandlerDescriptor<PosixStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'backend',
  handler: startBackendService,
  preflight: preflightBackendStart
};