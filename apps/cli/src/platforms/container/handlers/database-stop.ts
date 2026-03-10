import { execFileSync } from 'child_process';
import { ContainerStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import { checkContainerRuntime, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Stop handler for database services in containers
 *
 * Gracefully shuts down database containers with proper connection draining
 */
const stopDatabaseContainer = async (context: ContainerStopHandlerContext): Promise<StopHandlerResult> => {
  const { service, runtime, containerName } = context;
  const { force, timeout = 30 } = context.options;

  if (!service.quiet) {
    printInfo(`Stopping database container: ${containerName}`);
  }

  try {
    // Check if container exists and is running
    const status = execFileSync(
      runtime, ['inspect', containerName, '--format', '{{.State.Status}}'],
      { encoding: 'utf-8', stdio: 'pipe' }
    ).trim();

    if (status !== 'running') {
      if (!service.quiet) {
        printWarning(`Database container ${containerName} is not running (status: ${status})`);
      }
      return {
        success: true,
        stopTime: new Date(),
        graceful: true,
        metadata: {
          serviceType: 'database',
          containerName,
          runtime,
          wasRunning: false,
          status
        }
      };
    }

    // Get container info for logging
    const containerId = execFileSync(
      runtime, ['inspect', containerName, '--format', '{{.Id}}'],
      { encoding: 'utf-8', stdio: 'pipe' }
    ).trim().substring(0, 12);

    if (force) {
      // Force kill without graceful shutdown
      if (!service.quiet) {
        printWarning('Force stopping database (may cause data corruption)...');
      }
      execFileSync(runtime, ['kill', containerName], { stdio: 'pipe' });
    } else {
      // Graceful shutdown with timeout
      if (!service.quiet) {
        printInfo(`Gracefully stopping database (timeout: ${timeout}s)...`);
      }

      // For databases, we should try to disconnect clients gracefully first
      const image = service.getImage();

      if (image.includes('postgres')) {
        // Send SIGTERM to PostgreSQL to trigger smart shutdown
        // This allows active connections to complete their work
        try {
          execFileSync(
            runtime, ['exec', containerName, 'su', '-c',
              `pg_ctl stop -D /var/lib/postgresql/data -m smart -t ${timeout}`, 'postgres'],
            { stdio: 'pipe', timeout: (timeout + 5) * 1000 }
          );
        } catch {
          // If pg_ctl fails, fall back to docker stop
          execFileSync(runtime, ['stop', '-t', timeout.toString(), containerName], { stdio: 'pipe' });
        }
      } else if (image.includes('mysql')) {
        // MySQL graceful shutdown
        try {
          execFileSync(
            runtime, ['exec', containerName, 'mysqladmin', 'shutdown'],
            { stdio: 'pipe', timeout: timeout * 1000 }
          );
        } catch {
          // Fall back to docker stop
          execFileSync(runtime, ['stop', '-t', timeout.toString(), containerName], { stdio: 'pipe' });
        }
      } else {
        // Generic database stop
        execFileSync(runtime, ['stop', '-t', timeout.toString(), containerName], { stdio: 'pipe' });
      }
    }

    // Verify container has stopped
    let stopped = false;
    let attempts = 0;
    const maxAttempts = 10;

    while (!stopped && attempts < maxAttempts) {
      try {
        const currentStatus = execFileSync(
          runtime, ['inspect', containerName, '--format', '{{.State.Status}}'],
          { encoding: 'utf-8', stdio: 'pipe' }
        ).trim();

        if (currentStatus === 'exited' || currentStatus === 'stopped') {
          stopped = true;
        } else {
          await new Promise(resolve => setTimeout(resolve, 1000));
          attempts++;
        }
      } catch {
        // Container doesn't exist anymore, consider it stopped
        stopped = true;
      }
    }

    if (!stopped) {
      return {
        success: false,
        error: 'Database container failed to stop within timeout',
        metadata: {
          serviceType: 'database',
          containerName,
          containerId,
          runtime
        }
      };
    }

    if (!service.quiet) {
      printSuccess(`Database container ${containerName} stopped successfully`);
    }

    return {
      success: true,
      stopTime: new Date(),
      graceful: !force,
      metadata: {
        serviceType: 'database',
        containerName,
        containerId,
        runtime,
        gracefulShutdown: !force
      }
    };

  } catch (error) {
    return {
      success: false,
      error: `Failed to stop database container: ${error}`,
      metadata: {
        serviceType: 'database',
        containerName,
        runtime
      }
    };
  }
};

/**
 * Descriptor for database container stop handler
 */
const preflightDatabaseStop = async (context: ContainerStopHandlerContext): Promise<PreflightResult> => {
  return preflightFromChecks([
    checkContainerRuntime(context.runtime),
  ]);
};

export const databaseStopDescriptor: HandlerDescriptor<ContainerStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'container',
  serviceType: 'database',
  handler: stopDatabaseContainer,
  preflight: preflightDatabaseStop
};
