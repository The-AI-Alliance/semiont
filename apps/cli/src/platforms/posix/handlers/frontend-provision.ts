import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { getFrontendPaths, resolveFrontendNpmPackage } from './frontend-paths.js';
import type { FrontendServiceConfig } from '@semiont/core';
import { checkCommandAvailable, checkFileExists, checkConfigPort, checkConfigField, checkConfigUrl, preflightFromChecks, readSecret, writeSecret } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Provision handler for frontend services on POSIX systems
 *
 * Sets up the frontend runtime directory structure and prepares the build.
 */
const provisionFrontendService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, options } = context;

  const projectRoot = service.projectRoot;

  // Install @semiont/frontend npm package if not already available
  if (!resolveFrontendNpmPackage(projectRoot)) {
    if (!service.quiet) {
      printInfo('Installing @semiont/frontend...');
    }
    try {
      execFileSync('npm', ['install', '@semiont/frontend'], {
        cwd: projectRoot,
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
      if (!service.quiet) {
        printSuccess('Installed @semiont/frontend');
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to install @semiont/frontend: ${error}`,
        metadata: { serviceType: 'frontend' }
      };
    }
  }

  // Get frontend paths
  const paths = getFrontendPaths(context);
  const { sourceDir: frontendSourceDir, logsDir } = paths;

  if (!service.quiet) {
    printInfo(`Provisioning frontend service ${service.name}...`);
    printInfo(`Using installed npm package: ${frontendSourceDir}`);
  }

  // Create runtime directories
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.dirname(paths.pidFile), { recursive: true });

  if (!service.quiet) {
    printInfo(`Created runtime directories in: ${logsDir}`);
  }

  let nextAuthSecret = options.rotateSecret ? undefined : readSecret('JWT_SECRET');
  if (!nextAuthSecret) {
    nextAuthSecret = crypto.randomBytes(32).toString('base64');
    writeSecret('JWT_SECRET', nextAuthSecret);
    printInfo(options.rotateSecret ? 'Generated new JWT_SECRET (--rotate-secret)' : 'Generated new JWT_SECRET');
  } else {
    printInfo('Using existing JWT_SECRET from secrets file');
  }

  // npm package: pre-built, skip install/build steps
  if (!service.quiet) {
    printInfo('Using pre-built npm package — skipping install, build, and workspace steps');
  }

  const metadata = {
    serviceType: 'frontend',
    frontendSourceDir,
    logsDir,
    configured: true
  };

  if (!service.quiet) {
    printSuccess(`✅ Frontend service ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Frontend details:');
    printInfo(`  Source directory: ${frontendSourceDir}`);
    printInfo(`  Logs directory: ${logsDir}`);
    printInfo('');
    printInfo('Next steps:');
    printInfo(`  1. Ensure backend is running`);
    printInfo(`  3. Start frontend: semiont start --service frontend --environment ${service.environment}`);
  }

  return {
    success: true,
    metadata,
    resources: {
      platform: 'posix',
      data: {
        path: frontendSourceDir,
        workingDirectory: frontendSourceDir
      }
    }
  };
};

const preflightFrontendProvision = async (context: PosixProvisionHandlerContext): Promise<PreflightResult> => {
  const config = context.service.config as FrontendServiceConfig;
  const envConfig = context.service.environmentConfig;
  const paths = getFrontendPaths(context);
  const checks = [
    checkCommandAvailable('node'),
    checkFileExists(path.join(paths.sourceDir, '.next', 'standalone', 'apps', 'frontend', 'server.js'), 'frontend standalone server.js'),
  ];
  checks.push(
    checkConfigPort(config.port, 'frontend.port'),
    checkConfigField(config.siteName, 'frontend.siteName'),
    checkConfigPort(envConfig.services?.backend?.port, 'backend.port'),
    checkConfigUrl(envConfig.services?.frontend?.publicURL, 'frontend.publicURL'),
  );
  return preflightFromChecks(checks);
};

/**
 * Descriptor for frontend POSIX provision handler
 */
export const frontendProvisionDescriptor: HandlerDescriptor<PosixProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'posix',
  serviceType: 'frontend',
  handler: provisionFrontendService,
  preflight: preflightFrontendProvision
};
