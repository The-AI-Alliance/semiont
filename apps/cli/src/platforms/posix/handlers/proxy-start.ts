import { spawn } from 'child_process';
import * as fs from 'fs';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import type { ProxyServiceConfig } from '@semiont/core';
import { PlatformResources } from '../../platform-resources.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { getProxyPaths } from './proxy-paths.js';

/**
 * Start handler for proxy services on POSIX systems
 *
 * Starts Envoy (or other proxy) as a detached background process.
 * Requires the proxy to be provisioned first (config file must exist).
 */
const startProxyService = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const config = service.config as ProxyServiceConfig;
  const paths = getProxyPaths(context);

  // Check if config file exists (must be provisioned first)
  if (!fs.existsSync(paths.configFile)) {
    return {
      success: false,
      error: `Proxy not provisioned. Run: semiont provision --service proxy --environment ${service.environment}`,
      metadata: { serviceType: 'proxy' }
    };
  }

  // Check if already running
  if (fs.existsSync(paths.pidFile)) {
    const pid = parseInt(fs.readFileSync(paths.pidFile, 'utf-8'));
    try {
      process.kill(pid, 0);
      return {
        success: false,
        error: `Proxy is already running with PID ${pid}`,
        metadata: { serviceType: 'proxy', pid }
      };
    } catch {
      // Process not running, remove stale pid file
      fs.unlinkSync(paths.pidFile);
    }
  }

  const proxyPort = config.port || 8080;
  const adminPort = config.adminPort || 9901;

  if (await isPortInUse(proxyPort)) {
    return {
      success: false,
      error: `Port ${proxyPort} is already in use`,
      metadata: { serviceType: 'proxy', port: proxyPort }
    };
  }

  // Ensure logs directory exists
  fs.mkdirSync(paths.logsDir, { recursive: true });

  if (!service.quiet) {
    printInfo(`Starting proxy service ${service.name} (${config.type})...`);
    printInfo(`Config: ${paths.configFile}`);
    printInfo(`Port: ${proxyPort}`);
  }

  try {
    // Open log file for proxy output
    const logFd = fs.openSync(paths.appLogFile, 'a');

    // Spawn envoy as a detached process
    const proc = spawn('envoy', ['-c', paths.configFile], {
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });

    if (!proc.pid) {
      fs.closeSync(logFd);
      throw new Error('Failed to start proxy process');
    }

    // Save PID
    fs.writeFileSync(paths.pidFile, proc.pid.toString());

    // Close file descriptor — child has its own reference
    fs.closeSync(logFd);

    // Detach from child process
    proc.unref();

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify process is still running
    try {
      process.kill(proc.pid, 0);
    } catch {
      return {
        success: false,
        error: `Proxy process failed to start. Check logs: ${paths.appLogFile}`,
        metadata: { serviceType: 'proxy', logFile: paths.appLogFile }
      };
    }

    const resources: PlatformResources = {
      platform: 'posix',
      data: {
        pid: proc.pid,
        port: proxyPort,
        command: `envoy -c ${paths.configFile}`,
        logFile: paths.appLogFile
      }
    };

    const endpoint = `http://localhost:${proxyPort}`;

    if (!service.quiet) {
      printSuccess(`Proxy service ${service.name} started successfully`);
      printInfo('');
      printInfo('Proxy details:');
      printInfo(`  PID: ${proc.pid}`);
      printInfo(`  Proxy: ${endpoint}`);
      printInfo(`  Admin: http://localhost:${adminPort}`);
      printInfo(`  Logs: ${paths.appLogFile}`);
    }

    return {
      success: true,
      endpoint,
      resources,
      metadata: {
        serviceType: 'proxy',
        pid: proc.pid,
        port: proxyPort,
        adminPort
      }
    };
  } catch (error) {
    if (fs.existsSync(paths.pidFile)) {
      fs.unlinkSync(paths.pidFile);
    }
    return {
      success: false,
      error: `Failed to start proxy: ${error}`,
      metadata: { serviceType: 'proxy' }
    };
  }
};

export const proxyStartDescriptor: HandlerDescriptor<PosixStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'proxy',
  handler: startProxyService
};
