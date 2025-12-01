import * as path from 'path';
import { execSync } from 'child_process';
import { PosixPublishHandlerContext, PublishHandlerResult, HandlerDescriptor } from './types.js';
import type { BackendServiceConfig } from '@semiont/core';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { getBackendPaths } from './backend-paths.js';

/**
 * Publish handler for backend services on POSIX systems
 *
 * Builds the backend application for production deployment.
 * Behavior is controlled by the devMode flag:
 * - devMode: true  → Skip build (dev server doesn't need it)
 * - devMode: false → Run npm run build for production
 */
const publishBackendService = async (context: PosixPublishHandlerContext): Promise<PublishHandlerResult> => {
  const { service } = context;
  const config = service.config as BackendServiceConfig;

  // Check if we're in dev mode
  if (config.devMode) {
    if (!service.quiet) {
      printInfo('Development mode enabled - skipping build');
    }
    return {
      success: true,
      metadata: { serviceType: 'backend', devMode: true, skipped: true }
    };
  }

  // Production mode - run build
  const paths = getBackendPaths(context);
  if (!paths) {
    return {
      success: false,
      error: 'Semiont repository path is required',
      metadata: { serviceType: 'backend' }
    };
  }

  const { sourceDir } = paths;

  if (!service.quiet) {
    printInfo(`Building backend service ${service.name}...`);
    printInfo(`Source: ${sourceDir}`);
  }

  try {
    // Run production build
    execSync('npm run build', {
      cwd: sourceDir,
      stdio: service.quiet ? 'pipe' : 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'production'
      }
    });

    if (!service.quiet) {
      printSuccess('Backend built successfully');
    }

    return {
      success: true,
      metadata: { serviceType: 'backend', devMode: false },
      artifacts: {
        buildPath: path.join(sourceDir, 'dist')
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Build failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { serviceType: 'backend' }
    };
  }
};

/**
 * Descriptor for backend POSIX publish handler
 */
export const backendPublishDescriptor: HandlerDescriptor<PosixPublishHandlerContext, PublishHandlerResult> = {
  command: 'publish',
  platform: 'posix',
  serviceType: 'backend',
  handler: publishBackendService
};
