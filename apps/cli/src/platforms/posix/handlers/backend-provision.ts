import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import type { BackendServiceConfig } from '@semiont/core';
import { printInfo, printSuccess, printWarning, printError } from '../../../core/io/cli-logger.js';
import { getBackendPaths, resolveBackendNpmPackage } from './backend-paths.js';
import { checkCommandAvailable, checkFileExists, checkConfigPort, checkConfigUrl, checkConfigField, checkConfigNonEmptyArray, preflightFromChecks, readSecret, writeSecret } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Provision handler for backend services on POSIX systems
 *
 * Sets up the backend runtime directory structure, installs dependencies,
 * configures environment variables, and prepares the database.
 */
const provisionBackendService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, options } = context;

  const projectRoot = service.projectRoot;

  // Install @semiont/backend npm package if not already available and no SEMIONT_REPO
  if (!context.options?.semiontRepo && !resolveBackendNpmPackage(projectRoot)) {
    if (!service.quiet) {
      printInfo('Installing @semiont/backend...');
    }
    try {
      execFileSync('npm', ['install', '@semiont/backend'], {
        cwd: projectRoot,
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
      if (!service.quiet) {
        printSuccess('Installed @semiont/backend');
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to install @semiont/backend: ${error}`,
        metadata: { serviceType: 'backend' }
      };
    }
  }

  // Get backend paths (throws if source cannot be found)
  const paths = getBackendPaths(context);
  const { sourceDir: backendSourceDir, logsDir } = paths;

  if (!service.quiet) {
    printInfo(`Provisioning backend service ${service.name}...`);
    if (paths.fromNpmPackage) {
      printInfo(`Using installed npm package: ${paths.sourceDir}`);
    } else {
      printInfo(`Using semiont repo: ${options.semiontRepo}`);
    }
  }

  // Create runtime directories
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.dirname(paths.pidFile), { recursive: true });

  if (!service.quiet) {
    printInfo(`Created runtime directories in: ${logsDir}`);
  }

  // Get environment configuration from service
  // All fields validated by preflight — safe to use ! assertions
  const envConfig = service.environmentConfig;
  const dbConfig = envConfig.services!.database!;

  const dbUser = dbConfig.user!;
  const dbPassword = dbConfig.password!;
  const dbName = dbConfig.name!;
  const dbPort = dbConfig.port!;

  // Use database host from config if available, fallback to localhost
  const dbHost = dbConfig.host || 'localhost';
  const databaseUrl = `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;

  if (!service.quiet) {
    printInfo(`Using database configuration for environment '${service.environment}':`);

    printInfo(`  Database: ${dbName} on ${dbHost}:${dbPort}`);
    printInfo(`  User: ${dbUser}`);
  }
  
  let jwtSecret = options.rotateSecret ? undefined : readSecret('JWT_SECRET');
  if (!jwtSecret) {
    jwtSecret = service.environmentConfig.app?.security?.jwtSecret ?? crypto.randomBytes(32).toString('base64');
    writeSecret('JWT_SECRET', jwtSecret);
    printInfo(options.rotateSecret ? 'Generated new JWT_SECRET (--rotate-secret)' : 'Generated new JWT_SECRET');
  } else {
    printInfo('Using existing JWT_SECRET from secrets file');
  }

  const prismaSchemaPath = path.join(backendSourceDir, 'prisma', 'schema.prisma');

  if (paths.fromNpmPackage) {
    // npm package: pre-built, skip install/build but still generate Prisma client
    // (the generated client is platform-specific and not shipped in the npm package)
    if (!service.quiet) {
      printInfo('Using pre-built npm package — skipping install and build');
    }

    if (fs.existsSync(prismaSchemaPath)) {
      if (!service.quiet) {
        printInfo('Generating Prisma client...');
      }

      try {
        execFileSync('npx', ['prisma', 'generate', `--schema=${prismaSchemaPath}`], {
          cwd: paths.project.stateDir,
          stdio: service.verbose ? 'inherit' : 'pipe'
        });

        if (!service.quiet) {
          printSuccess('Prisma client generated');
        }
      } catch (error) {
        printWarning(`Failed to generate Prisma client: ${error}`);
      }
    }
  } else {
    // Monorepo: install deps, generate prisma, build workspace deps, build app

    // Install npm dependencies
    if (!service.quiet) {
      printInfo('Installing npm dependencies...');
    }

    try {
      const semiontRepo = context.options?.semiontRepo;
      if (!semiontRepo) {
        throw new Error('SEMIONT_REPO not configured');
      }

      const monorepoRoot = path.resolve(semiontRepo);
      const rootPackageJsonPath = path.join(monorepoRoot, 'package.json');

      if (fs.existsSync(rootPackageJsonPath)) {
        const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf-8'));
        if (rootPackageJson.workspaces) {
          execFileSync('npm', ['install'], {
            cwd: monorepoRoot,
            stdio: service.verbose ? 'inherit' : 'pipe'
          });
        } else {
          execFileSync('npm', ['install'], {
            cwd: backendSourceDir,
            stdio: service.verbose ? 'inherit' : 'pipe'
          });
        }
      } else {
        execFileSync('npm', ['install'], {
          cwd: backendSourceDir,
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
        metadata: { serviceType: 'backend', backendSourceDir }
      };
    }

    // Generate Prisma client if schema exists
    if (fs.existsSync(prismaSchemaPath)) {
      if (!service.quiet) {
        printInfo('Generating Prisma client...');
      }

      try {
        execFileSync('npx', ['prisma', 'generate', `--schema=${prismaSchemaPath}`], {
          cwd: paths.project.stateDir,
          stdio: service.verbose ? 'inherit' : 'pipe'
        });

        if (!service.quiet) {
          printSuccess('Prisma client generated');
        }
      } catch (error) {
        printWarning(`Failed to generate Prisma client: ${error}`);
      }
    }

    // Build workspace packages that backend depends on
    if (!service.quiet) {
      printInfo('Building workspace dependencies...');
    }

    try {
      const monorepoRoot = path.dirname(path.dirname(backendSourceDir));
      const rootPackageJsonPath = path.join(monorepoRoot, 'package.json');

      if (fs.existsSync(rootPackageJsonPath)) {
        const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf-8'));
        if (rootPackageJson.workspaces) {
          execFileSync('npm', ['run', 'build', '--workspace=@semiont/core', '--if-present'], {
            cwd: monorepoRoot,
            stdio: service.verbose ? 'inherit' : 'pipe'
          });
          execFileSync('npm', ['run', 'build', '--workspace=@semiont/event-sourcing', '--if-present'], {
            cwd: monorepoRoot,
            stdio: service.verbose ? 'inherit' : 'pipe'
          });
          execFileSync('npm', ['run', 'build', '--workspace=@semiont/api-client', '--if-present'], {
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
      printInfo('You may need to build manually: npm run build --workspace=@semiont/core');
    }

    // Build backend application
    if (!service.quiet) {
      printInfo('Building backend application...');
    }

    try {
      execFileSync('npm', ['run', 'build'], {
        cwd: backendSourceDir,
        stdio: service.verbose ? 'inherit' : 'pipe'
      });

      if (!service.quiet) {
        printSuccess('Backend application built successfully');
      }
    } catch (error) {
      printError(`Failed to build backend application: ${error}`);
      return {
        success: false,
        error: `Failed to build backend application: ${error}`,
        metadata: { serviceType: 'backend', backendSourceDir }
      };
    }
  }

  // Check if we should run migrations
  if (options.migrate !== false && fs.existsSync(prismaSchemaPath)) {
    if (!service.quiet) {
      printInfo('Running database migrations...');
    }
    
    try {
      execFileSync('npx', ['prisma', 'migrate', 'deploy', `--schema=${prismaSchemaPath}`], {
        cwd: paths.project.stateDir,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: service.verbose ? 'inherit' : 'pipe'
      });
      
      if (!service.quiet) {
        printSuccess('Database migrations completed');
      }
    } catch (error) {
      printWarning(`Failed to run migrations: ${error}`);
      printInfo('You may need to run migrations manually: npx prisma migrate deploy');
    }
  }
  
  const metadata = {
    serviceType: 'backend',
    backendSourceDir,
    logsDir,
    configured: true
  };

  if (!service.quiet) {
    printSuccess(`✅ Backend service ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Backend details:');
    printInfo(`  Source directory: ${backendSourceDir}`);
    printInfo(`  Logs directory: ${logsDir}`);
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
        path: backendSourceDir,
        workingDirectory: backendSourceDir
      }
    }
  };
};

const preflightBackendProvision = async (context: PosixProvisionHandlerContext): Promise<PreflightResult> => {
  const config = context.service.config as BackendServiceConfig;
  const envConfig = context.service.environmentConfig;
  const db = envConfig.services?.database;
  const paths = getBackendPaths(context);
  const checks = paths.fromNpmPackage
    ? [
        checkFileExists(path.join(paths.sourceDir, 'dist', 'index.js'), 'backend dist/index.js'),
      ]
    : [
        checkCommandAvailable('npm'),
        checkCommandAvailable('npx'),
        checkFileExists(path.join(paths.sourceDir, 'package.json'), 'backend package.json'),
      ];
  checks.push(
    checkConfigPort(config.port, 'backend.port'),
    checkConfigUrl(config.publicURL, 'backend.publicURL'),
    checkConfigField(db?.user, 'database.user'),
    checkConfigField(db?.password, 'database.password'),
    checkConfigField(db?.name, 'database.name'),
    checkConfigPort(db?.port, 'database.port'),
    checkConfigUrl(envConfig.services?.frontend?.publicURL, 'frontend.publicURL'),
    checkConfigField(envConfig.site?.domain, 'site.domain'),
    checkConfigNonEmptyArray(envConfig.site?.oauthAllowedDomains, 'site.oauthAllowedDomains'),
  );
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