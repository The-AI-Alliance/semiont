import * as path from 'path';
import { execSync } from 'child_process';
import { PosixPublishHandlerContext, PublishHandlerResult, HandlerDescriptor } from './types.js';
import type { FrontendServiceConfig } from '@semiont/core';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { getFrontendPaths } from './frontend-paths.js';

/**
 * Publish handler for frontend services on POSIX systems
 *
 * Builds the frontend application for production deployment.
 * Behavior is controlled by the devMode flag:
 * - devMode: true  → Skip build (dev server doesn't need it)
 * - devMode: false → Run npm run build for production
 */
const publishFrontendService = async (context: PosixPublishHandlerContext): Promise<PublishHandlerResult> => {
  const { service } = context;
  const config = service.config as FrontendServiceConfig;

  // Check if we're in dev mode
  if (config.devMode) {
    if (!service.quiet) {
      printInfo('Development mode enabled - skipping build');
    }
    return {
      success: true,
      metadata: { serviceType: 'frontend', devMode: true, skipped: true }
    };
  }

  // Production mode - run build
  const paths = getFrontendPaths(context);
  if (!paths) {
    return {
      success: false,
      error: 'Semiont repository path is required',
      metadata: { serviceType: 'frontend' }
    };
  }

  const { sourceDir } = paths;

  if (!service.quiet) {
    printInfo(`Building frontend service ${service.name}...`);
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
      printSuccess('Frontend built successfully');
    }

    return {
      success: true,
      metadata: { serviceType: 'frontend', devMode: false },
      artifacts: {
        buildPath: path.join(sourceDir, '.next')
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Build failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { serviceType: 'frontend' }
    };
  }
};

/**
 * Descriptor for frontend POSIX publish handler
 */
export const frontendPublishDescriptor: HandlerDescriptor<PosixPublishHandlerContext, PublishHandlerResult> = {
  command: 'publish',
  platform: 'posix',
  serviceType: 'frontend',
  handler: publishFrontendService
};
