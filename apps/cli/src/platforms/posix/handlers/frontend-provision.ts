import * as fs from 'fs';
import * as path from 'path';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { resolveFrontendNpmPackage, resolveFrontendServerScript, frontendXdgPaths } from './frontend-paths.js';
import type { FrontendServiceConfig } from '@semiont/core';
import { checkCommandAvailable, checkConfigPort, checkConfigField, checkConfigUrl, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Provision handler for frontend services on POSIX systems
 *
 * Creates the XDG runtime directories needed by the frontend service.
 * @semiont/frontend is bundled with the CLI and requires no separate installation.
 */
const provisionFrontendService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service } = context;

  const npmDir = resolveFrontendNpmPackage();
  if (!npmDir) {
    return {
      success: false,
      error: '@semiont/frontend not found. Reinstall @semiont/cli to restore it.',
      metadata: { serviceType: 'frontend' }
    };
  }

  const serverScript = resolveFrontendServerScript() ?? path.join(npmDir, 'server.js');
  const { pidFile, logsDir } = frontendXdgPaths();

  if (!service.quiet) {
    printInfo(`Provisioning frontend service ${service.name}...`);
    printInfo(`Using bundled package: ${serverScript}`);
  }

  // Create runtime directories
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });

  if (!service.quiet) {
    printInfo(`Created runtime directories in: ${logsDir}`);
  }

  const metadata = {
    serviceType: 'frontend',
    serverScript,
    logsDir,
    configured: true
  };

  if (!service.quiet) {
    printSuccess(`Frontend service ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Frontend details:');
    printInfo(`  Server script: ${serverScript}`);
    printInfo(`  Logs directory: ${logsDir}`);
    printInfo('');
    printInfo('Next steps:');
    printInfo(`  1. Ensure backend is running`);
    printInfo(`  2. Start frontend: semiont start --service frontend --environment ${service.environment}`);
  }

  return {
    success: true,
    metadata,
    resources: {
      platform: 'posix',
      data: {
        path: serverScript,
        workingDirectory: path.dirname(serverScript)
      }
    }
  };
};

const preflightFrontendProvision = async (context: PosixProvisionHandlerContext): Promise<PreflightResult> => {
  const config = context.service.config as FrontendServiceConfig;
  const envConfig = context.service.environmentConfig;
  const checks = [
    checkCommandAvailable('node'),
    checkConfigPort(config.port, 'frontend.port'),
    checkConfigField(config.siteName, 'frontend.siteName'),
    checkConfigPort(envConfig.services?.backend?.port, 'backend.port'),
    checkConfigUrl(envConfig.services?.frontend?.publicURL, 'frontend.publicURL'),
  ];
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
