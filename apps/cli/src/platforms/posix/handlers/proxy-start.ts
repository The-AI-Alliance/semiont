import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import type { ProxyServiceConfig } from '@semiont/core';
import { PlatformResources } from '../../platform-resources.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { getProxyPaths } from './proxy-paths.js';
import { checkCommandAvailable, checkPortFree, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Start handler for proxy services on POSIX systems
 *
 * Uses a double-fork to fully daemonize envoy so it survives
 * when the parent CLI process exits.
 */
const startProxyService = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const config = service.config as ProxyServiceConfig;
  const paths = getProxyPaths(context);

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

  fs.mkdirSync(paths.logsDir, { recursive: true });

  if (!service.quiet) {
    printInfo(`Starting proxy service ${service.name} (${config.type})...`);
    printInfo(`Config: ${paths.configFile}`);
    printInfo(`Port: ${proxyPort}`);
  }

  try {
    // Double-fork to daemonize envoy (reparents to PID 1).
    // Without this, envoy gets SIGTERM when the CLI process exits.
    // Paths are passed via environment variables to avoid shell escaping issues
    // (e.g. SEMIONT_ROOT containing spaces).
    const pidFile = paths.pidFile;
    const logFile = paths.appLogFile;
    const configFile = paths.configFile;

    spawnSync('bash', ['-c', `
      (
        exec </dev/null
        exec >>"$_ENVOY_LOG" 2>&1
        (
          exec envoy -c "$_ENVOY_CONFIG" &
          echo $! > "$_ENVOY_PID"
        ) &
      ) &
    `], {
      env: {
        ...process.env,
        _ENVOY_LOG: logFile,
        _ENVOY_CONFIG: configFile,
        _ENVOY_PID: pidFile,
      },
    });

    // Wait for envoy to start and write its PID
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (!fs.existsSync(pidFile)) {
      return {
        success: false,
        error: `Proxy process failed to start. Check logs: ${logFile}`,
        metadata: { serviceType: 'proxy', logFile }
      };
    }

    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());

    // Verify process is still running
    try {
      process.kill(pid, 0);
    } catch {
      return {
        success: false,
        error: `Proxy process failed to start. Check logs: ${logFile}`,
        metadata: { serviceType: 'proxy', logFile }
      };
    }

    const resources: PlatformResources = {
      platform: 'posix',
      data: {
        pid,
        port: proxyPort,
        command: `envoy -c ${configFile}`,
        logFile
      }
    };

    const endpoint = `http://localhost:${proxyPort}`;

    if (!service.quiet) {
      printSuccess(`Proxy service ${service.name} started successfully`);
      printInfo('');
      printInfo('Proxy details:');
      printInfo(`  PID: ${pid}`);
      printInfo(`  Proxy: ${endpoint}`);
      printInfo(`  Admin: http://localhost:${adminPort}`);
      printInfo(`  Logs: ${logFile}`);
    }

    return {
      success: true,
      endpoint,
      resources,
      metadata: {
        serviceType: 'proxy',
        pid,
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

const preflightProxyStart = async (context: PosixStartHandlerContext): Promise<PreflightResult> => {
  const config = context.service.config as ProxyServiceConfig;
  const proxyPort = config.port || 8080;
  const adminPort = config.adminPort || 9901;
  return preflightFromChecks([
    checkCommandAvailable('envoy'),
    await checkPortFree(proxyPort),
    await checkPortFree(adminPort),
  ]);
};

export const proxyStartDescriptor: HandlerDescriptor<PosixStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'proxy',
  handler: startProxyService,
  preflight: preflightProxyStart
};
