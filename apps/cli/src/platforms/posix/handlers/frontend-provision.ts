import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning, printError } from '../../../core/io/cli-logger.js';
import { getFrontendPaths, resolveFrontendNpmPackage } from './frontend-paths.js';
import type { FrontendServiceConfig } from '@semiont/core';
import { checkCommandAvailable, checkFileExists, checkConfigPort, checkConfigField, checkConfigUrl, preflightFromChecks, readSecret, writeSecret } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Provision handler for frontend services on POSIX systems
 * 
 * Sets up the frontend runtime directory structure, installs dependencies,
 * configures environment variables, and prepares the build.
 */
const provisionFrontendService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, options } = context;

  const projectRoot = service.projectRoot;

  // Install @semiont/frontend npm package if not already available and no SEMIONT_REPO
  if (!context.options?.semiontRepo && !resolveFrontendNpmPackage(projectRoot)) {
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
    if (paths.fromNpmPackage) {
      printInfo(`Using installed npm package: ${frontendSourceDir}`);
    } else {
      printInfo(`Using source directory: ${frontendSourceDir}`);
    }
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

  // Clean up stale .env.local in sourceDir (SEMIONT_REPO mode only).
  // Next.js auto-loads .env.local from cwd at startup — this cannot be suppressed
  // via spawn({ env }). Any pre-existing stale file would shadow CLI-injected vars.
  if (!paths.fromNpmPackage) {
    const staleEnvLocal = path.join(frontendSourceDir, '.env.local');
    if (fs.existsSync(staleEnvLocal)) {
      const backupPath = `${staleEnvLocal}.backup.${Date.now()}`;
      fs.renameSync(staleEnvLocal, backupPath);
      if (!service.quiet) {
        printWarning(`Moved stale ${staleEnvLocal} to ${path.basename(backupPath)}`);
      }
    }
  }

  if (paths.fromNpmPackage) {
    // npm package: pre-built, skip install/build steps
    if (!service.quiet) {
      printInfo('Using pre-built npm package — skipping install, build, and workspace steps');
    }
  } else {
    // Monorepo: install deps, build workspace deps, build app

    // Install npm dependencies
    if (!service.quiet) {
      printInfo('Installing npm dependencies...');
    }

    try {
      // For monorepo, install from the root
      const monorepoRoot = path.dirname(path.dirname(frontendSourceDir));
      const rootPackageJsonPath = path.join(monorepoRoot, 'package.json');

      if (fs.existsSync(rootPackageJsonPath)) {
        // Check if this is a monorepo with workspaces
        const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf-8'));
        if (rootPackageJson.workspaces) {
          // Install from monorepo root
          execFileSync('npm', ['install'], {
            cwd: monorepoRoot,
            stdio: service.verbose ? 'inherit' : 'pipe'
          });
        } else {
          execFileSync('npm', ['install'], {
            cwd: frontendSourceDir,
            stdio: service.verbose ? 'inherit' : 'pipe'
          });
        }
      } else {
        execFileSync('npm', ['install'], {
          cwd: frontendSourceDir,
          stdio: service.verbose ? 'inherit' : 'pipe'
        });
      }

      if (!service.quiet) {
        printSuccess('Dependencies installed successfully');
      }
    } catch (error) {
      printError(`Failed to install dependencies: ${error}`);
      return {
        success: false,
        error: `Failed to install dependencies: ${error}`,
        metadata: { serviceType: 'frontend', frontendSourceDir }
      };
    }

    // Build workspace packages that frontend depends on
    if (!service.quiet) {
      printInfo('Building workspace dependencies...');
    }

    try {
      const monorepoRoot = path.dirname(path.dirname(frontendSourceDir));
      const rootPackageJsonPath = path.join(monorepoRoot, 'package.json');

      if (fs.existsSync(rootPackageJsonPath)) {
        const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf-8'));
        if (rootPackageJson.workspaces) {
          // Build @semiont/react-ui package which frontend depends on
          execFileSync('npm', ['run', 'build', '--workspace=@semiont/react-ui', '--if-present'], {
            cwd: monorepoRoot,
            stdio: service.verbose ? 'inherit' : 'pipe'
          });

          if (!service.quiet) {
            printSuccess('Workspace dependencies built successfully');
          }
        }
      }
    } catch (error) {
      printWarning(`Failed to build workspace dependencies: ${error}`);
      printInfo('You may need to build manually: npm run build --workspace=@semiont/react-ui');
    }

    // Build frontend if in production mode
    if (service.environment === 'prod') {
      if (!service.quiet) {
        printInfo('Building frontend for production...');
      }

      try {
        const buildConfig = service.config as FrontendServiceConfig;
        const buildEnvConfig = service.environmentConfig;
        const buildFrontendService = buildEnvConfig.services['frontend']!;
        const buildFrontendUrl = buildFrontendService.publicURL!;
        const buildBackendPort = buildEnvConfig.services['backend']!.port!;
        const buildOauthDomains = buildEnvConfig.site?.oauthAllowedDomains || [];
        const buildAllowedOrigins: string[] = [...(buildFrontendService.allowedOrigins || [])];
        buildAllowedOrigins.push(new URL(buildFrontendUrl).host);

        execFileSync('npm', ['run', 'build'], {
          cwd: frontendSourceDir,
          env: {
            ...process.env,
            NODE_ENV: 'production',
            PORT: buildConfig.port.toString(),
            NEXTAUTH_URL: buildFrontendUrl,
            SERVER_API_URL: `http://127.0.0.1:${buildBackendPort}`,
            NEXT_PUBLIC_SITE_NAME: buildConfig.siteName,
            NEXT_PUBLIC_BASE_URL: buildFrontendUrl,
            NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS: buildOauthDomains.join(','),
            NEXT_PUBLIC_ALLOWED_ORIGINS: buildAllowedOrigins.join(','),
          },
          stdio: service.verbose ? 'inherit' : 'pipe'
        });

        if (!service.quiet) {
          printSuccess('Frontend built successfully');
        }
      } catch (error) {
        printWarning(`Failed to build frontend: ${error}`);
        printInfo('You may need to build manually: npm run build');
      }
    }
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
  const checks = paths.fromNpmPackage
    ? [
        checkFileExists(path.join(paths.sourceDir, 'standalone', 'apps', 'frontend', 'server.js'), 'frontend standalone server.js'),
      ]
    : [
        checkCommandAvailable('npm'),
        checkFileExists(path.join(paths.sourceDir, 'package.json'), 'frontend package.json'),
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