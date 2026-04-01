import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import type { BackendServiceConfig } from '@semiont/core';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import { resolveBackendNpmPackage, resolveBackendEntryPoint } from './backend-paths.js';
import { SemiontProject } from '@semiont/core/node';
import { checkCommandAvailable, checkEnvVarsInConfig, checkConfigPort, checkConfigUrl, checkConfigField, checkConfigNonEmptyArray, preflightFromChecks, readSecret, writeSecret } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

// Injected by esbuild at build time via __SEMIONT_VERSION__ define
declare const __SEMIONT_VERSION__: string;
const SEMIONT_VERSION: string = __SEMIONT_VERSION__;

/**
 * Provision handler for backend services on POSIX systems
 *
 * Sets up the backend runtime directory structure, installs dependencies,
 * configures environment variables, and prepares the database.
 */
const provisionBackendService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, options } = context;

  const projectRoot = service.projectRoot!;

  // Install (or update) @semiont/backend to the version matching the CLI
  const packageSpec = `@semiont/backend@${SEMIONT_VERSION}`;
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
      metadata: { serviceType: 'backend' }
    };
  }

  const npmDir = resolveBackendNpmPackage(projectRoot);
  if (!npmDir) {
    return {
      success: false,
      error: 'Cannot find @semiont/backend after install',
      metadata: { serviceType: 'backend' }
    };
  }

  const entryPoint = resolveBackendEntryPoint(projectRoot) ?? path.join(npmDir, 'dist', 'index.js');
  const project = new SemiontProject(projectRoot);

  if (!service.quiet) {
    printInfo(`Provisioning backend service ${service.name}...`);
    printInfo(`Using installed npm package: ${entryPoint}`);
  }

  // Create runtime directories
  fs.mkdirSync(project.backendLogsDir, { recursive: true });
  fs.mkdirSync(path.dirname(project.backendPidFile), { recursive: true });

  if (!service.quiet) {
    printInfo(`Created runtime directories in: ${project.backendLogsDir}`);
  }

  // Get environment configuration from service
  // All fields validated by preflight — safe to use ! assertions
  const envConfig = service.environmentConfig;
  const dbConfig = envConfig.services!.database!;

  if (!service.quiet) {
    const dbName = dbConfig.name!;
    const dbHost = dbConfig.host || 'localhost';
    const dbPort = dbConfig.port!;
    printInfo(`Using database configuration for environment '${service.environment}':`);
    printInfo(`  Database: ${dbName} on ${dbHost}:${dbPort}`);
    printInfo(`  User: ${dbConfig.user!}`);
  }

  let jwtSecret = options.rotateSecret ? undefined : readSecret('JWT_SECRET');
  if (!jwtSecret) {
    jwtSecret = service.environmentConfig.app?.security?.jwtSecret ?? crypto.randomBytes(32).toString('base64');
    writeSecret('JWT_SECRET', jwtSecret);
    printInfo(options.rotateSecret ? 'Generated new JWT_SECRET (--rotate-secret)' : 'Generated new JWT_SECRET');
  } else {
    printInfo('Using existing JWT_SECRET from secrets file');
  }

  // npm package: pre-built, skip install/build but still generate Prisma client
  // (the generated client is platform-specific and not shipped in the npm package)
  const packageDir = path.dirname(path.dirname(entryPoint)); // entryPoint is dist/index.js
  const prismaSchemaPath = path.join(packageDir, 'prisma', 'schema.prisma');

  if (!service.quiet) {
    printInfo('Using pre-built npm package — skipping install and build');
  }

  if (fs.existsSync(prismaSchemaPath)) {
    if (!service.quiet) {
      printInfo('Generating Prisma client...');
    }

    try {
      execFileSync('npx', ['prisma', 'generate', `--schema=${prismaSchemaPath}`], {
        cwd: packageDir,
        stdio: service.verbose ? 'inherit' : 'pipe'
      });

      if (!service.quiet) {
        printSuccess('Prisma client generated');
      }
    } catch (error) {
      printWarning(`Failed to generate Prisma client: ${error}`);
    }
  }

  const metadata = {
    serviceType: 'backend',
    entryPoint,
    logsDir: project.backendLogsDir,
    configured: true
  };

  if (!service.quiet) {
    printSuccess(`Backend service ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Backend details:');
    printInfo(`  Entry point: ${entryPoint}`);
    printInfo(`  Logs directory: ${project.backendLogsDir}`);
    printInfo('');
    printInfo('Next steps:');
    printInfo(`  1. Ensure database is running`);
    printInfo(`  3. Start backend: semiont start --service backend --environment ${service.environment}`);
  }

  return {
    success: true,
    metadata,
    resources: {
      platform: 'posix',
      data: {
        path: entryPoint,
        workingDirectory: path.dirname(entryPoint)
      }
    }
  };
};

const preflightBackendProvision = async (context: PosixProvisionHandlerContext): Promise<PreflightResult> => {
  const config = context.service.config as BackendServiceConfig;
  const envConfig = context.service.environmentConfig;
  const db = envConfig.services?.database;
  const checks = [
    checkCommandAvailable('npx'),
    checkConfigPort(config.port, 'backend.port'),
    checkConfigUrl(config.publicURL, 'backend.publicURL'),
    checkConfigField(db?.user, 'database.user'),
    checkConfigField(db?.password, 'database.password'),
    checkConfigField(db?.name, 'database.name'),
    checkConfigPort(db?.port, 'database.port'),
    checkConfigUrl(envConfig.services?.frontend?.publicURL, 'frontend.publicURL'),
    checkConfigField(envConfig.site?.domain, 'site.domain'),
    checkConfigNonEmptyArray(envConfig.site?.oauthAllowedDomains, 'site.oauthAllowedDomains'),
    ...checkEnvVarsInConfig(db as unknown as Record<string, unknown>),
  ];
  return preflightFromChecks(checks);
};

/**
 * Descriptor for backend POSIX provision handler
 */
export const backendProvisionDescriptor: HandlerDescriptor<PosixProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'posix',
  serviceType: 'backend',
  handler: provisionBackendService,
  preflight: preflightBackendProvision
};
