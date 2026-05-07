import * as fs from 'fs';
import * as path from 'path';
import { PosixStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { killProcessGroupAndRelated, isProcessRunning } from '../utils/process-manager.js';
import { resolveFrontendNpmPackage, resolveFrontendServerScript, frontendXdgPaths } from './frontend-paths.js';
import { passingPreflight } from '../../../core/handlers/preflight-utils.js';

/**
 * Stop handler for frontend services on POSIX systems
 *
 * Stops the frontend Node.js process gracefully using the PID file.
 */
const stopFrontendService = async (context: PosixStopHandlerContext): Promise<StopHandlerResult> => {
  const { service } = context;

  const npmDir = resolveFrontendNpmPackage();
  const serverScript = resolveFrontendServerScript() ?? (npmDir ? path.join(npmDir, 'server.js') : null);
  const { pidFile, appLogFile, errorLogFile } = frontendXdgPaths();

  if (service.verbose) {
    printInfo(`Server script: ${serverScript}`);
  }

  // Check for PID file
  if (!fs.existsSync(pidFile)) {
    // Check if we have saved state with PID
    if (context.savedState?.resources?.platform === 'posix' &&
        context.savedState.resources.data.pid) {
      const pid = context.savedState.resources.data.pid;

      try {
        if (!isProcessRunning(pid)) {
          throw new Error('Process not running');
        }

        if (!service.quiet) {
          printInfo(`Stopping frontend process (PID ${pid} from saved state)...`);
        }

        await killProcessGroupAndRelated(pid, 'frontend', service.verbose);

        if (!service.quiet) {
          printSuccess(`Frontend service ${service.name} stopped successfully`);
        }

        return {
          success: true,
          metadata: {
            serviceType: 'frontend',
            pid,
            fromSavedState: true
          }
        };
      } catch {
        return {
          success: true,
          metadata: {
            serviceType: 'frontend',
            message: 'Frontend was not running'
          }
        };
      }
    }

    return {
      success: true,
      metadata: {
        serviceType: 'frontend',
        message: 'Frontend is not running (no PID file found)'
      }
    };
  }

  // Read PID from file
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf-8'));
  } catch (error) {
    return {
      success: false,
      error: `Failed to read PID file: ${error}`,
      metadata: { serviceType: 'frontend', pidFile }
    };
  }

  // Check if process is actually running
  if (!isProcessRunning(pid)) {
    fs.unlinkSync(pidFile);

    if (!service.quiet) {
      printInfo('Frontend was not running (stale PID file removed)');
    }

    return {
      success: true,
      metadata: {
        serviceType: 'frontend',
        message: 'Cleaned up stale PID file'
      }
    };
  }

  if (!service.quiet) {
    printInfo(`Stopping frontend service ${service.name} (PID ${pid})...`);
  }

  // Write shutdown marker to logs
  const shutdownMessage = `\n=== Frontend Shutdown Initiated at ${new Date().toISOString()} ===\n`;
  try {
    if (fs.existsSync(appLogFile)) {
      fs.appendFileSync(appLogFile, shutdownMessage);
    }
    if (fs.existsSync(errorLogFile)) {
      fs.appendFileSync(errorLogFile, shutdownMessage);
    }
  } catch {
    // Log writing is best-effort
  }

  try {
    const graceful = await killProcessGroupAndRelated(pid, 'frontend', service.verbose);

    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }

    const finalMessage = `\n=== Frontend Stopped at ${new Date().toISOString()} ===\n`;
    try {
      if (fs.existsSync(appLogFile)) {
        fs.appendFileSync(appLogFile, finalMessage);
      }
    } catch {
      // Log writing is best-effort
    }

    if (!service.quiet) {
      printSuccess(`Frontend service ${service.name} stopped successfully`);
      printInfo(`  App log: ${appLogFile}`);
      printInfo(`  Error log: ${errorLogFile}`);
    }

    return {
      success: true,
      metadata: {
        serviceType: 'frontend',
        pid,
        serverScript,
        graceful
      }
    };

  } catch (error) {
    return {
      success: false,
      error: `Failed to stop frontend: ${error}`,
      metadata: {
        serviceType: 'frontend',
        pid,
        error: (error as Error).toString()
      }
    };
  }
};

/**
 * Descriptor for frontend POSIX stop handler
 */
export const frontendStopDescriptor: HandlerDescriptor<PosixStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'posix',
  serviceType: 'frontend',
  handler: stopFrontendService,
  preflight: async () => passingPreflight()
};
