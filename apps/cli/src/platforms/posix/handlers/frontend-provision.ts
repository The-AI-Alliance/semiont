import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { resolveFrontendNpmPackage } from './frontend-paths.js';
import { SemiontProject } from '@semiont/core/node';
import type { FrontendServiceConfig } from '@semiont/core';
import { checkCommandAvailable, checkConfigPort, checkConfigField, checkConfigUrl, preflightFromChecks, readSecret, writeSecret } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

// Injected by esbuild at build time via __SEMIONT_VERSION__ define
declare const __SEMIONT_VERSION__: string;
const SEMIONT_VERSION: string = __SEMIONT_VERSION__;

/**
 * Provision handler for frontend services on POSIX systems
 *
 * Sets up the frontend runtime directory structure and prepares the build.
 */
const provisionFrontendService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, options } = context;

  const projectRoot = service.projectRoot;

  // Install (or update) @semiont/frontend to the version matching the CLI
  const packageSpec = `@semiont/frontend@${SEMIONT_VERSION}`;

  if (!service.quiet) {
    printInfo(`Installing ${packageSpec}...`);
  }
  try {
    execFileSync('npm', ['install', packageSpec, '--prefix', projectRoot], {
      cwd: projectRoot,
      stdio: service.verbose ? 'inherit' : 'pipe'
    });
    if (!service.quiet) {
      printSuccess(`Installed ${packageSpec}`);
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to install ${packageSpec}: ${error}`,
      metadata: { serviceType: 'frontend' }
    };
  }

  const npmDir = resolveFrontendNpmPackage(projectRoot);
  if (!npmDir) {
    return {
      success: false,
      error: 'Cannot find @semiont/frontend after install',
      metadata: { serviceType: 'frontend' }
    };
  }

  const serverScript = path.join(npmDir, 'standalone', 'apps', 'frontend', 'server.js');
  const project = new SemiontProject(projectRoot);

  if (!service.quiet) {
    printInfo(`Provisioning frontend service ${service.name}...`);
    printInfo(`Using installed npm package: ${serverScript}`);
  }

  // Create runtime directories
  fs.mkdirSync(project.frontendLogsDir, { recursive: true });
  fs.mkdirSync(path.dirname(project.frontendPidFile), { recursive: true });

  if (!service.quiet) {
    printInfo(`Created runtime directories in: ${project.frontendLogsDir}`);
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
    serverScript,
    logsDir: project.frontendLogsDir,
    configured: true
  };

  if (!service.quiet) {
    printSuccess(`✅ Frontend service ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Frontend details:');
    printInfo(`  Server script: ${serverScript}`);
    printInfo(`  Logs directory: ${project.frontendLogsDir}`);
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
