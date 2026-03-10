import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import type { BackendServiceConfig } from '@semiont/core';
import { printInfo, printSuccess, printWarning, printError } from '../../../core/io/cli-logger.js';
import { getBackendPaths, resolveBackendNpmPackage } from './backend-paths.js';
import { getNodeEnvForEnvironment } from '@semiont/core';
import { checkCommandAvailable, checkFileExists, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Provision handler for backend services on POSIX systems
 *
 * Sets up the backend runtime directory structure, installs dependencies,
 * configures environment variables, and prepares the database.
 */
const provisionBackendService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, options } = context;

  // Type narrowing for backend service config
  const config = service.config as BackendServiceConfig;

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
  const { sourceDir: backendSourceDir, runtimeDir, envFile, logsDir, tmpDir } = paths;

  if (!service.quiet) {
    printInfo(`Provisioning backend service ${service.name}...`);
    if (paths.fromNpmPackage) {
      printInfo(`Using installed npm package: ${paths.sourceDir}`);
    } else {
      printInfo(`Using semiont repo: ${options.semiontRepo}`);
    }
    printInfo(`Runtime directory: ${runtimeDir}`);
  }

  // Create runtime directories under project root
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  if (!service.quiet) {
    printInfo(`Created runtime directories in: ${runtimeDir}`);
  }

  // Get environment configuration from service
  const envConfig = service.environmentConfig;
  const dbConfig = envConfig.services?.database;

  if (!dbConfig?.environment) {
    throw new Error('Database configuration not found in environment file');
  }

  const dbUser = dbConfig.environment.POSTGRES_USER;
  if (!dbUser) {
    throw new Error('POSTGRES_USER not configured');
  }

  const dbPassword = dbConfig.environment.POSTGRES_PASSWORD;
  if (!dbPassword) {
    throw new Error('POSTGRES_PASSWORD not configured');
  }

  const dbName = dbConfig.environment.POSTGRES_DB;
  if (!dbName) {
    throw new Error('POSTGRES_DB not configured');
  }

  const dbPort = dbConfig.port;
  if (!dbPort) {
    throw new Error('Database port not configured');
  }

  // Use database host from config if available, fallback to localhost
  const dbHost = dbConfig.host || 'localhost';
  const databaseUrl = `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;

  if (!service.quiet) {
    printInfo(`Using database configuration from ${service.environment}.json:`);
    printInfo(`  Database: ${dbName} on ${dbHost}:${dbPort}`);
    printInfo(`  User: ${dbUser}`);
  }
  
  // Check if .env already exists and backup if it does
  if (fs.existsSync(envFile)) {
    const backupPath = `${envFile}.backup.${Date.now()}`;
    fs.copyFileSync(envFile, backupPath);
    if (!service.quiet) {
      printWarning(`.env already exists, backing up to: ${path.basename(backupPath)}`);
      printInfo('Creating new .env with updated configuration...');
    }
  }
  
  // Get URLs from environment config
  const frontendService = service.environmentConfig.services?.frontend;
  if (!frontendService?.publicURL) {
    throw new Error('Frontend publicURL not configured in environment');
  }
  const frontendUrl = frontendService.publicURL;

  const backendUrl = config.publicURL;
  if (!backendUrl) {
    throw new Error('Backend publicURL not configured');
  }

  const port = config.port;
  if (!port) {
    throw new Error('Backend port not configured');
  }

  if (!service.environmentConfig.site) {
    throw new Error('Site configuration not found in environment file');
  }

  const siteDomain = service.environmentConfig.site.domain;
  if (!siteDomain) {
    throw new Error('Site domain not configured');
  }

  // Read OAuth allowed domains from site config
  const oauthAllowedDomains = service.environmentConfig.site.oauthAllowedDomains;
  if (!oauthAllowedDomains || oauthAllowedDomains.length === 0) {
    throw new Error('OAuth allowed domains not configured in site config');
  }

  const allowedDomains = oauthAllowedDomains.join(',');

  // Get NODE_ENV from environment config
  const nodeEnv = getNodeEnvForEnvironment(service.environmentConfig);

  // Get enableLocalAuth from app config, default to true for development
  const enableLocalAuth = service.environmentConfig.app?.security?.enableLocalAuth ??
    (nodeEnv === 'development');

  // Get JWT secret from config or generate a secure one
  const jwtSecret = service.environmentConfig.app?.security?.jwtSecret ??
    crypto.randomBytes(32).toString('base64');

  const envUpdates: Record<string, string> = {
    'NODE_ENV': nodeEnv,
    'PORT': port.toString(),
    'HOST': '0.0.0.0',  // Bind to all interfaces for Codespaces compatibility
    'DATABASE_URL': databaseUrl,
    'LOG_DIR': logsDir,
    'TMP_DIR': tmpDir,
    'JWT_SECRET': jwtSecret,
    'FRONTEND_URL': frontendUrl,
    'BACKEND_URL': backendUrl,
    'ENABLE_LOCAL_AUTH': enableLocalAuth.toString(),
    'SITE_DOMAIN': siteDomain,
    'OAUTH_ALLOWED_DOMAINS': allowedDomains
  };
  
  // Create .env from the single source of truth
  let envContent = '# Backend Environment Configuration\n';
  for (const [key, value] of Object.entries(envUpdates)) {
    envContent += `${key}=${value}\n`;
  }
  
  fs.writeFileSync(envFile, envContent);
  
  if (!service.quiet) {
    printSuccess('Created .env with configuration from environment file');
  }
  
  const prismaSchemaPath = path.join(backendSourceDir, 'prisma', 'schema.prisma');

  // Clean up stale .env in sourceDir (SEMIONT_REPO mode only).
  // The backend start handler passes env vars via spawn's env parameter,
  // but dotenv or --env-file could pick up a leftover .env in sourceDir.
  if (!paths.fromNpmPackage) {
    const staleEnv = path.join(backendSourceDir, '.env');
    if (fs.existsSync(staleEnv)) {
      const backupPath = `${staleEnv}.backup.${Date.now()}`;
      fs.renameSync(staleEnv, backupPath);
      if (!service.quiet) {
        printWarning(`Moved stale ${staleEnv} to ${path.basename(backupPath)}`);
        printInfo(`Runtime .env is now at: ${envFile}`);
      }
    }
  }

  if (paths.fromNpmPackage) {
    // npm package: pre-built, skip install/build steps
    if (!service.quiet) {
      printInfo('Using pre-built npm package — skipping install, build, and prisma generate');
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
        execFileSync('npx', ['prisma', 'generate'], {
          cwd: backendSourceDir,
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
      // Load env vars for migration
      const envVars: Record<string, string> = {};
      if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, 'utf-8');
        envContent.split('\n').forEach(line => {
          if (!line.startsWith('#') && line.includes('=')) {
            const [key, ...valueParts] = line.split('=');
            envVars[key.trim()] = valueParts.join('=').trim();
          }
        });
      }
      
      execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
        cwd: backendSourceDir,
        env: { ...process.env, ...envVars },
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
  
  // Create README in runtime directory
  const readmePath = path.join(runtimeDir, 'RUNTIME.md');
  if (!fs.existsSync(readmePath)) {
    const readmeContent = `# Backend Runtime Directory

This directory contains runtime files for the backend service.

## Structure

- \`.env\` - Environment configuration
- \`logs/\` - Application logs
- \`tmp/\` - Temporary files
- \`backend.pid\` - Process ID when running

## Source Code

${paths.fromNpmPackage ? `Installed npm package: ${backendSourceDir}` : `Semiont repo: ${backendSourceDir}`}

## Commands

- Start: \`semiont start --service backend --environment ${service.environment}\`
- Check: \`semiont check --service backend --environment ${service.environment}\`
- Stop: \`semiont stop --service backend --environment ${service.environment}\`
- Logs: \`tail -f ${logsDir}/app.log\`
`;
    fs.writeFileSync(readmePath, readmeContent);
  }
  
  const metadata = {
    serviceType: 'backend',
    backendSourceDir,
    runtimeDir,
    envFile,
    logsDir,
    tmpDir,
    configured: true
  };

  if (!service.quiet) {
    printSuccess(`✅ Backend service ${service.name} provisioned successfully`);
    printInfo('');
    printInfo('Backend details:');
    printInfo(`  Source directory: ${backendSourceDir}`);
    printInfo(`  Runtime directory: ${runtimeDir}`);
    printInfo(`  Environment file: ${envFile}`);
    printInfo(`  Logs directory: ${logsDir}`);
    printInfo('');
    printInfo('Next steps:');
    printInfo(`  1. Review and update ${envFile}`);
    printInfo(`  2. Ensure database is running`);
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