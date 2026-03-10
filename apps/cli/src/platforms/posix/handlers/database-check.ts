import * as fs from 'fs';
import { StateManager } from '../../../core/state-manager.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { execFileSync } from 'child_process';
import { PosixCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { DatabaseServiceConfig } from '@semiont/core';
import { checkPortLookupCommand, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import { getDatabasePaths } from './database-paths.js';

/**
 * Check handler for POSIX database services
 */
const checkDatabaseProcess = async (context: PosixCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service } = context;
  const config = service.config as DatabaseServiceConfig;

  const paths = getDatabasePaths(context);

  let status: 'running' | 'stopped' | 'unhealthy' = 'stopped';
  let pid: number | undefined;

  // 1. Check PID file
  if (fs.existsSync(paths.pidFile)) {
    try {
      pid = parseInt(fs.readFileSync(paths.pidFile, 'utf-8'));
      process.kill(pid, 0);
      status = 'running';
    } catch {
      // Stale PID file — process not running
      fs.unlinkSync(paths.pidFile);
      pid = undefined;
    }
  }

  // 2. Fall back to saved state
  if (!pid) {
    // Load saved state
    const savedState = await StateManager.load(
      service.projectRoot,
      service.environment,
      service.name
    );

    if (savedState?.resources?.platform === 'posix' &&
        savedState.resources.data.pid &&
        StateManager.isProcessRunning(savedState.resources.data.pid)) {
      pid = savedState.resources.data.pid;
      status = 'running';
    }
  }

  // 3. Fall back to port scan
  if (!pid) {
    const port = config.port;
    if (await isPortInUse(port)) {
      try {
        let output: string;
        if (process.platform === 'darwin') {
          output = execFileSync('lsof', ['-ti:' + port], { encoding: 'utf-8' });
        } else {
          output = execFileSync('fuser', [port + '/tcp'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
        }

        const foundPid = parseInt(output.trim());
        if (!isNaN(foundPid)) {
          pid = foundPid;
          status = 'running';
        } else {
          status = 'running';
        }
      } catch {
        status = 'running';
      }
    }
  }
  
  // Basic database health check - just check if port is responding
  let health = {
    healthy: status === 'running',
    details: {
      port: config.port,
      status: status === 'running' ? 'accepting connections' : 'not running'
    }
  };

  const platformResources = pid ? {
    platform: 'posix' as const,
    data: {
      pid,
      port: config.port
    }
  } : undefined;
  
  // Collect logs if running
  let logs: { recent: string[]; errors: string[] } | undefined = undefined;
  if (status === 'running' && platform && typeof platform.collectLogs === 'function') {
    const logEntries = await platform.collectLogs(service, { tail: 10 });
    if (logEntries) {
      logs = {
        recent: logEntries.map(entry => entry.message),
        errors: logEntries.filter(entry => entry.level === 'error').map(entry => entry.message)
      };
    }
  }
  
  return {
    success: true,
    status,
    platformResources,
    health,
    logs,
    metadata: {
      serviceType: 'database',
      stateVerified: true
    }
  };
};

const preflightDatabaseCheck = async () => preflightFromChecks([checkPortLookupCommand()]);

/**
 * Descriptor for POSIX database check handler
 */
export const databaseCheckDescriptor: HandlerDescriptor<PosixCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'database',
  handler: checkDatabaseProcess,
  preflight: preflightDatabaseCheck
};