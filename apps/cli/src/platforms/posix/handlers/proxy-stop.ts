import * as fs from 'fs';
import { PosixStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { killProcessGroupAndRelated } from '../utils/process-manager.js';
import { getProxyPaths } from './proxy-paths.js';

/**
 * Stop handler for proxy services on POSIX systems
 *
 * Stops the proxy process gracefully using the PID file.
 */
const stopProxyService = async (context: PosixStopHandlerContext): Promise<StopHandlerResult> => {
  const { service } = context;
  const paths = getProxyPaths(context);

  // Check for PID file
  if (!fs.existsSync(paths.pidFile)) {
    // Check saved state
    if (context.savedState?.resources?.platform === 'posix' &&
        context.savedState.resources.data.pid) {
      const pid = context.savedState.resources.data.pid;

      try {
        process.kill(pid, 0);

        if (!service.quiet) {
          printInfo(`Stopping proxy process (PID ${pid} from saved state)...`);
        }

        await killProcessGroupAndRelated(pid, 'proxy', service.verbose);

        if (!service.quiet) {
          printSuccess(`Proxy service ${service.name} stopped successfully`);
        }

        return {
          success: true,
          metadata: { serviceType: 'proxy', pid, fromSavedState: true }
        };
      } catch {
        return {
          success: true,
          metadata: { serviceType: 'proxy', message: 'Proxy was not running' }
        };
      }
    }

    return {
      success: true,
      metadata: { serviceType: 'proxy', message: 'Proxy is not running (no PID file found)' }
    };
  }

  // Read PID from file
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(paths.pidFile, 'utf-8'));
  } catch (error) {
    return {
      success: false,
      error: `Failed to read PID file: ${error}`,
      metadata: { serviceType: 'proxy', pidFile: paths.pidFile }
    };
  }

  // Check if process is actually running
  try {
    process.kill(pid, 0);
  } catch {
    fs.unlinkSync(paths.pidFile);

    if (!service.quiet) {
      printInfo('Proxy was not running (stale PID file removed)');
    }

    return {
      success: true,
      metadata: { serviceType: 'proxy', message: 'Cleaned up stale PID file' }
    };
  }

  if (!service.quiet) {
    printInfo(`Stopping proxy service ${service.name} (PID ${pid})...`);
  }

  try {
    const killed = await killProcessGroupAndRelated(pid, 'proxy', service.verbose);

    if (fs.existsSync(paths.pidFile)) {
      fs.unlinkSync(paths.pidFile);
    }

    if (!service.quiet) {
      printSuccess(`Proxy service ${service.name} stopped successfully`);
    }

    return {
      success: true,
      metadata: { serviceType: 'proxy', pid, graceful: killed }
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to stop proxy: ${error}`,
      metadata: { serviceType: 'proxy', pid }
    };
  }
};

export const proxyStopDescriptor: HandlerDescriptor<PosixStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'posix',
  serviceType: 'proxy',
  handler: stopProxyService
};
