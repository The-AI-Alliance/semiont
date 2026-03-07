import * as fs from 'fs';
import { PosixCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { StateManager } from '../../../core/state-manager.js';
import { getProxyPaths } from './proxy-paths.js';
import type { ProxyServiceConfig } from '@semiont/core';
import { checkCommandAvailable, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Check handler for proxy services on POSIX systems
 *
 * Checks if the proxy process is running and the port is listening.
 */
const checkProxyService = async (context: PosixCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service, savedState } = context;
  const config = service.config as ProxyServiceConfig;
  const paths = getProxyPaths(context);

  const proxyPort = config.port || 8080;
  const adminPort = config.adminPort || 9901;

  let status: 'running' | 'stopped' | 'unknown' | 'unhealthy' = 'stopped';
  let pid: number | undefined;
  let healthy = false;
  const details: Record<string, unknown> = {
    proxyPort,
    adminPort,
    runtimeDir: paths.runtimeDir
  };

  // Check for PID file
  if (fs.existsSync(paths.pidFile)) {
    try {
      pid = parseInt(fs.readFileSync(paths.pidFile, 'utf-8'));
      process.kill(pid, 0);
      status = 'running';
      details.pid = pid;
    } catch {
      status = 'stopped';
      details.message = 'Stale PID file found (process not running)';
      fs.unlinkSync(paths.pidFile);
    }
  } else if (savedState?.resources?.platform === 'posix' &&
             savedState.resources.data.pid &&
             StateManager.isProcessRunning(savedState.resources.data.pid)) {
    pid = savedState.resources.data.pid;
    status = 'running';
    details.pid = pid;
    details.fromSavedState = true;
  } else {
    // Check if port is in use (might be running outside of semiont)
    if (await isPortInUse(proxyPort)) {
      status = 'unknown';
      details.message = `Port ${proxyPort} is in use (proxy may be running outside of semiont)`;
    }
  }

  // If running, check admin endpoint for health
  if (status === 'running' || status === 'unknown') {
    try {
      const response = await fetch(`http://localhost:${adminPort}/clusters`, {
        signal: AbortSignal.timeout(2000)
      });
      if (response.ok) {
        healthy = true;
        details.message = 'Proxy is running and healthy';
      } else {
        if (status === 'running') {
          status = 'unhealthy';
          details.message = 'Process is running but admin endpoint returned error';
        }
      }
    } catch {
      if (status === 'running') {
        status = 'unhealthy';
        details.message = 'Process is running but admin endpoint unreachable';
      }
    }
  }

  const platformResources = pid ? {
    platform: 'posix' as const,
    data: {
      pid,
      port: proxyPort,
      logFile: paths.appLogFile
    }
  } : undefined;

  return {
    success: true,
    status,
    platformResources,
    health: { healthy, details },
    metadata: {
      serviceType: 'proxy',
      proxyPort,
      adminPort
    }
  };
};

const preflightProxyCheck = async (_context: PosixCheckHandlerContext): Promise<PreflightResult> => {
  return preflightFromChecks([
    checkCommandAvailable('envoy'),
  ]);
};

export const proxyCheckDescriptor: HandlerDescriptor<PosixCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'proxy',
  handler: checkProxyService,
  preflight: preflightProxyCheck
};
